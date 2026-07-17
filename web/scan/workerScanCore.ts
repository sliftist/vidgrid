// Background scan orchestration — the loop that runs inside the single
// SharedWorker (scanWorker.ts). Standalone and appState-free: it opens the same
// BulkDatabase2 stores BY NAME (same bytes as the tabs, kept in sync by
// BulkDatabase2 itself) and drives the same nested metadataWorker the tab uses,
// via the now-appState-free MetadataExtractorClient.
//
// Phases, in order, each gated by a setting: file-walk (discover) → metadata +
// poster → keyframe strips. (Faces is default-off and still lives in the tab
// pipeline; it will move here once its image/blacklist helpers are decoupled
// from appState.) The loop runs continuously — never a 24h gate — pausing only
// when master scanning is off or there's no work, then re-checking on a timer.

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { findVideos, resolveFileHandle } from "./folderTraversal";
import { encodeKeyframes2 } from "./keyframes2";
import type { ReadableFile } from "./MetadataExtractorClient";
// Decode is delegated to the victim tab (a SharedWorker can't decode video); the
// remoteExtractor sends the request and awaits the result. Same call shape the
// loop used before, but it takes a relativePath (the victim opens the file).
import { remoteExtractor as extractor } from "./scanDelegate";
import { broadcastScanStatus, ScanPhase, ScanStatusState } from "./scanStatusBus";
import { clusterEmbeddings, SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";
import { l2Distance } from "../faceEmbed/arcface";
import { cropFaceAvatarJpeg, generateThumbsFromJpeg } from "./imageThumbs";
import { recordScanError } from "./scanErrors";
// Types only — erased at build time, so this does NOT pull appState into the
// worker bundle.
import type { FileRecord, ThumbnailRecord, KeyframesRecord, SettingRecord, CharacterRecord, FaceFramesRecord, BlacklistedFaceRecord } from "../appState";

// Same store names as appState — BulkDatabase2 keys storage by this string, so
// these instances read/write the very same data the tabs do.
const files = new BulkDatabase2<FileRecord>("vidgrid_index", { maxTriggerThrottleMs: 15_000 });
const thumbnails = new BulkDatabase2<ThumbnailRecord>("vidgrid_thumbnails", { maxTriggerThrottleMs: 15_000 });
const keyframes = new BulkDatabase2<KeyframesRecord>("vidgrid_keyframes3", { maxTriggerThrottleMs: 15_000 });
const characters = new BulkDatabase2<CharacterRecord>("vidgrid_characters3");
const faceFrames = new BulkDatabase2<FaceFramesRecord>("vidgrid_face_frames3");
const blacklistedFaces = new BulkDatabase2<BlacklistedFaceRecord>("vidgrid_blacklisted_faces");
const settingsDb = new BulkDatabase2<SettingRecord>("vidgrid_settings");
const settingsStrDb = new BulkDatabase2<{ key: string; value: string }>("vidgrid_settings_str");
const removedFiles = new BulkDatabase2<{ key: string; removedAt?: number }>("vidgrid_removed");
const ignoredFolders = new BulkDatabase2<{ key: string }>("vidgrid_ignored_folders");

// Setting keys — must match appState's constants. (The master toggle scanEnabled
// no longer lives in settingsDb; the tab pushes it to us via setCoordinatorMode.)
const KEYFRAMES_ENABLED = "keyframesScanEnabled";
const FACES_ENABLED = "facesScanEnabled";
const SCAN_SOFTWARE_DECODE = "scanSoftwareDecode";
const FACES_FP16 = "facesFp16";
// A folder with this many videos (or more) is a series; fewer is a standalone.
// Mirrors appState.SERIES_FOLDER_THRESHOLD.
const SERIES_FOLDER_THRESHOLD = 5;

// Face pipeline constants — mirror faces/faceExtraction.ts.
const EMBEDDING_FLOATS = 512;
const MAX_CHARACTERS_PER_FILE = 30;
const MIN_CLUSTER_MEMBERS = 3;
const TOP_N_FACE_FRAMES = 30;
// Must byte-match appState.characterKey: `${fileKey}#${pad(idx, 2)}`.
function characterKey(fileKey: string, idx: number): string {
    return `${fileKey}#${String(idx).padStart(2, "0")}`;
}

// Defaults mirror appState: scanning on, keyframes on, faces off.
async function readSetting(key: string, def: boolean): Promise<boolean> {
    const v = await settingsDb.getSingleField(key, "value");
    return v === undefined ? def : v === true;
}
async function readStrSetting(key: string, def: string): Promise<string> {
    const v = await settingsStrDb.getSingleField(key, "value");
    return typeof v === "string" ? v : def;
}

// Scan queue priority: a user "Q" click stamps files.scanPriority; among the
// eligible files for a phase we pick the highest scanPriority first (front of the
// queue), falling back to column order.
async function priorityMap(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    try {
        for (const r of await files.getColumn("scanPriority")) if (typeof r.value === "number") m.set(r.key, r.value);
    } catch { /* ignore */ }
    return m;
}
async function blacklistedSet(): Promise<Set<string>> {
    const set = new Set<string>();
    try { for (const r of await files.getColumn("scanBlacklisted")) if (r.value === true) set.add(r.key); } catch { /* ignore */ }
    return set;
}
// Files whose metadata phase terminally FAILED (version stamped as done, but with
// an error — gave-up-after-N-attempts, file-not-found, or blacklisted). If we
// couldn't even read a file's metadata it's almost certainly corrupt/unsupported,
// so the automatic keyframe + face pickers skip it (and its keyframe/face counts
// drop the moment metadata fails). The user can still force it per-file — the
// Queue / per-phase force buttons clear extractionError, lifting this gate.
async function metaFailedSet(): Promise<Set<string>> {
    const set = new Set<string>();
    try { for (const r of await files.getColumn("extractionError")) if (typeof r.value === "string" && r.value !== "") set.add(r.key); } catch { /* ignore */ }
    return set;
}
function pickPriority(keys: string[], pmap: Map<string, number>): string {
    let best = keys[0];
    let bestP = pmap.get(best) ?? 0;
    for (const k of keys) { const p = pmap.get(k) ?? 0; if (p > bestP) { bestP = p; best = k; } }
    return best;
}

function folderOf(relativePath: string): string {
    const i = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
    return i < 0 ? "" : relativePath.slice(0, i);
}
// Number of videos in the same folder as `key` (inclusive) — tells a series from
// a standalone for the "auto" face-thumbnail mode. Mirrors appState.countFolderVideos.
async function countFolderVideos(key: string): Promise<number> {
    const relativePath = await files.getSingleField(key, "relativePath");
    if (typeof relativePath !== "string") return 1;
    const folder = folderOf(relativePath);
    let count = 0;
    for (const { value } of await files.getColumn("relativePath")) {
        if (typeof value === "string" && folderOf(value) === folder) count++;
    }
    return count;
}

// A file missing from disk this long (soft-deleted first) gets hard-removed.
const DAY_MS = 24 * 60 * 60 * 1000;
const MISSING_DELETE_TTL_MS = 30 * DAY_MS;
// File discovery runs DAILY — a cheap filename-only walk to add new files (and
// reconcile removed ones). It's separate from the heavy metadata/keyframe/face
// phases and runs regardless of the master toggle; the user can also force it now.
const FILE_WALK_INTERVAL_MS = DAY_MS;
// Idle poll cadence when there's nothing to do (files may appear, settings flip).
const IDLE_POLL_MS = 30_000;
// Decode failures that are NOT the file's fault — the victim tab switched, went
// away, or started playing video (so it aborts + refuses). These must never be
// recorded as errors, stamp the file, or count against the crash cap; the loop
// just retries the file (on the next-appointed victim).
function isTransientDecodeError(msg: string): boolean {
    return /victim changed|no decode victim|victim is playing|Scan aborted/i.test(msg);
}

// The file forced the decode worker to be killed — either it went unresponsive
// (ping watchdog) or extraction exceeded its timeout. Both mean a retry would
// just wedge the worker again, so we blacklist the file at once.
function isHangError(msg: string): boolean {
    return /unresponsive|hung|decoder is stuck/i.test(msg);
}

// A file that crashes the worker mid-extraction never gets its version stamped,
// so it'd be retried (and crash again) forever. We bump a persisted per-phase
// attempt counter BEFORE extracting; after this many attempts the file is marked
// bad instead of retried.
const MAX_ATTEMPTS = 3;

let root: FileSystemDirectoryHandle | undefined;
let started = false;
let lastWalkAt = 0;
// Set true while we're deliberately aborting the in-flight extraction (scanning
// was just disabled) so the phase's catch doesn't record it as a file error.
let aborting = false;

// ── Coordinator-mode state ────────────────────────────────────────────────────
// The coordinator SharedWorker can't read localStorage — a tab tells it the
// current master-toggle state on connect (and again when the user flips it via
// the settings BroadcastChannel). Until we hear from a tab, treat as "unknown"
// and don't try to run heavy work (so a coordinator that spawned just to hear
// "you're disabled" doesn't burn a metadata run first).
//
// oneShot is set when a tab spawned us for a "Scan Now" click while master
// scanning was OFF. In that mode we run through all pending work and then
// notify the coordinator so it can self-close. oneShot is sticky (once
// granted, only the coordinator's death revokes it).
let coordEnabled = false;
let coordOneShot = false;
let coordInitialized = false;
let onOneShotFinished: (() => void) | undefined;
export function setCoordinatorMode(m: { enabled?: boolean; oneShot?: boolean }): void {
    if (m.enabled !== undefined) coordEnabled = m.enabled;
    if (m.oneShot === true) coordOneShot = true;
    coordInitialized = true;
    // If master scanning just got disabled AND we were mid-flight (not one-shot),
    // stop right now — matches the previous notifyScanSettingsChanged semantics.
    if (!coordEnabled && !coordOneShot) { aborting = true; try { extractor.abort(); } catch { /* ignore */ } }
    wakeFn?.();
}

export function setScanRoot(handle: FileSystemDirectoryHandle): void {
    root = handle;
}

// ── Wake / command seam (driven by scanWorker.ts port messages) ───────────────
let wakeFn: (() => void) | undefined;
function interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const t = setTimeout(() => { wakeFn = undefined; resolve(); }, ms);
        wakeFn = () => { clearTimeout(t); wakeFn = undefined; resolve(); };
    });
}
// Force the daily file walk to run now.
export function requestWalkNow(): void {
    lastWalkAt = 0;
    wakeFn?.();
}
// Nudge the loop (e.g. a decode victim just became available, so decode phases
// that were idling can resume immediately).
export function wakeScanCore(): void {
    wakeFn?.();
}
// A sub-phase toggle (keyframes / faces) changed. The master toggle is now the
// coord-mode setter's job; sub-phase reads still hit settingsDb, so we just
// wake the loop so the next tick honors them.
export async function notifyScanSettingsChanged(): Promise<void> { wakeFn?.(); }

// User hit "Cancel Scan". Kill any in-flight decode immediately (the phase's
// catch classifies "Scan aborted" as transient so no error is recorded, no
// version stamped, no attempt counter bumped) and flip the loop to disabled so
// it won't pick another file before the coordinator gets a chance to close.
export function cancelInFlightScan(): void {
    console.log("[scanWorker] cancelling in-flight scan");
    aborting = true;
    coordEnabled = false;
    coordOneShot = false;
    try { extractor.abort(); } catch { /* ignore */ }
    wakeFn?.();
}

// Kick the loop (idempotent). Call once the storage-root override + handle are
// set. The optional callback fires when a one-shot pass completes (used by the
// coordinator to self-close after "Scan Now" finishes).
export function startScanCore(opts?: { onOneShotFinished?: () => void }): void {
    if (started) return;
    started = true;
    onOneShotFinished = opts?.onOneShotFinished;
    void runLoop();
}

type TickResult = "worked" | "idle" | "waiting";

async function runLoop(): Promise<void> {
    // Never resolves under normal (background) operation — the SharedWorker
    // lives as long as any tab is connected. In one-shot mode we exit and
    // signal completion, so the coordinator can self-close.
    for (;;) {
        try {
            await refreshCounts();      // always publish counts + walk timing
            const result = await tick();
            if (result === "worked") continue;
            if (result === "idle" && coordOneShot) {
                // "Scan Now" finished all pending work — tell the coordinator so
                // it can shut down. `!coordEnabled` is the case that matters
                // (background off; we spawned only to burn through the queue).
                await publishIdle();
                console.log("[scanWorker] one-shot pass complete — signaling coordinator to close");
                try { onOneShotFinished?.(); } catch { /* ignore */ }
                return;
            }
            await publishIdle();
            await interruptibleSleep(IDLE_POLL_MS);
        } catch (err) {
            console.warn("[scanWorker] loop error:", err);
            void recordScanError({ phase: "loop", message: (err as Error)?.message ?? String(err), at: Date.now() });
            await interruptibleSleep(IDLE_POLL_MS);
        }
    }
}

// One unit of progress. "worked" → the loop keeps going at full speed; "idle" →
// nothing more to do (in one-shot mode this triggers self-close); "waiting" →
// an external condition (no victim tab, no handle) blocks us — sleep and retry.
async function tick(): Promise<TickResult> {
    if (!root) return "waiting";
    if (!coordInitialized) return "waiting"; // haven't heard from a tab yet
    aborting = false;

    // File discovery: cheap, filename-only, DAILY — runs regardless of the
    // master toggle (discovering files isn't "scanning" them). Skip for one-shot
    // spawns while master is off: the user asked for a scan-now sweep of what we
    // KNOW about, not a fresh disk walk that could dominate the pass.
    if (coordEnabled && Date.now() - lastWalkAt > FILE_WALK_INTERVAL_MS) {
        lastWalkAt = Date.now();
        // Publish "walking" so the metadata cell can render a distinct state —
        // files are being discovered but nothing is being scanned yet.
        status.running = true;
        status.walking = true;
        status.phase = undefined;
        status.currentKey = undefined;
        status.fileFraction = undefined;
        status.fileDetail = "discovering files...";
        writeStatus(true);
        try {
            await runFileWalk(root);
        } finally {
            status.walking = false;
            status.fileDetail = undefined;
            writeStatus(true);
        }
        await refreshCounts();
        return "worked";
    }

    // Heavy extraction phases are gated by the master toggle OR the one-shot
    // allowance the tab granted for "Scan Now" while master was off.
    if (!coordEnabled && !coordOneShot) return "waiting";

    // Decode phases need a victim tab to do the actual decoding. Without one we
    // wait (not idle — idle would end a one-shot pass prematurely).
    if (!extractor.hasVictim()) return "waiting";

    // Metadata: always-on whenever scanning is enabled.
    if (await runOneMetadata(root)) return "worked";

    // Keyframes: opt-in (default on).
    if (await readSetting(KEYFRAMES_ENABLED, true)) {
        if (await runOneKeyframes(root)) return "worked";
    }

    // Faces: opt-in (default off). Requires keyframes (cascade).
    if (await readSetting(FACES_ENABLED, false) && await readSetting(KEYFRAMES_ENABLED, true)) {
        if (await runOneFaces(root)) return "worked";
    }

    return "idle";
}

// ── Status publishing ─────────────────────────────────────────────────────────
// ONE in-memory state object. Everything below mutates it, and writeStatus
// broadcasts the WHOLE object over the status BroadcastChannel (at most once
// per second unless forced). Tabs render exclusively from these broadcasts —
// there is no database involved, and no partial updates on the wire.
const status: ScanStatusState = {};
let lastStatusWriteAt = 0;
function writeStatus(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastStatusWriteAt < 1_000) return;
    lastStatusWriteAt = now;
    status.updatedAt = now;
    broadcastScanStatus(status);
}
// A tab just connected — send it the current full state immediately instead of
// making it wait for the next heartbeat/loop broadcast.
export function rebroadcastScanStatus(): void {
    writeStatus(true);
}
async function publishIdle(): Promise<void> {
    status.running = false;
    status.phase = undefined;
    status.currentKey = undefined;
    status.fileFraction = undefined;
    status.fileDetail = undefined;
    status.walking = false;
    // Clear the live-ETA context — the next publish() sets it fresh.
    activePhaseRate = undefined;
    writeStatus(true);
}
// Recompute remaining-work counts + walk timing and publish them. This is the
// ONLY source the UI has for these numbers — every tab renders the coordinator's
// published state verbatim (no tab-side derivation), so the counts can never
// disagree with what the coordinator is actually scanning. Each count uses the
// SAME eligibility rules its phase picker uses (blacklist + metadata-failure
// exclusions), so a count hits 0 exactly when its phase goes idle, and finishing
// a file decrements it on the next write.
async function refreshCounts(): Promise<void> {
    try {
        const nameCol = await files.getColumn("name");
        const total = nameCol.length;
        const blacklisted = await blacklistedSet();
        const metaFailed = await metaFailedSet();
        const metaCol = await files.getColumn("metadataVersion");
        const metaDoneSet = new Set(metaCol.filter(r => r.value === METADATA_VERSION).map(r => r.key));
        const kfCol = await keyframes.getColumn("keyframesVersion");
        const kfDoneSet = new Set(kfCol.filter(r => r.value === KEYFRAMES_VERSION).map(r => r.key));
        // Keep the light files-record mirror EXACTLY in sync with the (heavy)
        // keyframes stream — set it for done files, CLEAR it for files that are no
        // longer done (e.g. re-queued).
        const mirrorCol = await files.getColumn("keyframesDoneVersion");
        const mirrored = new Set(mirrorCol.filter(r => r.value === KEYFRAMES_VERSION).map(r => r.key));
        const updates: { key: string; keyframesDoneVersion: number | undefined }[] = [];
        for (const k of kfDoneSet) if (!mirrored.has(k)) updates.push({ key: k, keyframesDoneVersion: KEYFRAMES_VERSION });
        for (const k of mirrored) if (!kfDoneSet.has(k)) updates.push({ key: k, keyframesDoneVersion: undefined });
        if (updates.length > 0) {
            try { await files.updateBatch(updates); }
            catch (err) { console.warn("[scan-coordinator] keyframes mirror sync failed:", err); }
        }
        const facesCol = await files.getColumn("facesVersion");
        const facesDoneSet = new Set(facesCol.filter(r => r.value === FACES_VERSION).map(r => r.key));
        let metaRemaining = 0, kfRemaining = 0, facesRemaining = 0;
        for (const r of nameCol) {
            const k = r.key;
            if (blacklisted.has(k)) continue;
            if (!metaDoneSet.has(k)) metaRemaining++;
            if (metaFailed.has(k)) continue;
            if (!kfDoneSet.has(k)) kfRemaining++;
            if (!facesDoneSet.has(k)) facesRemaining++;
        }
        status.filesTotal = total;
        status.metadataRemaining = metaRemaining;
        status.keyframesRemaining = kfRemaining;
        status.facesRemaining = facesRemaining;
        status.lastWalkAt = lastWalkAt || undefined;
        status.nextWalkAt = lastWalkAt ? lastWalkAt + FILE_WALK_INTERVAL_MS : undefined;
        writeStatus(false);
    } catch (err) {
        console.warn("[scanWorker] refreshCounts failed:", err);
    }
}

// ── File walk ───────────────────────────────────────────────────────────────
async function runFileWalk(handle: FileSystemDirectoryHandle): Promise<void> {
    console.log("[scan-coordinator] walking folder for new/removed files");
    const seenAt = Date.now();
    const existingKeys = new Set(await files.getKeys());
    const removedKeys = new Set(await removedFiles.getKeys());
    const ignoredFolderKeys = new Set(await ignoredFolders.getKeys());
    const missingSinceByKey = new Map<string, number | undefined>();
    for (const { key, value } of await files.getColumn("missingSinceMs")) missingSinceByKey.set(key, value);

    const seenKeys = new Set<string>();
    const batch: FileRecord[] = [];
    const flush = async () => {
        if (batch.length === 0) return;
        const out = batch.splice(0);
        try { await files.writeBatch(out); } catch (err) { console.warn("[scanWorker] file writeBatch failed:", err); }
    };

    await findVideos(handle, {
        shouldSkipFolder: p => ignoredFolderKeys.has(p),
        onFile: video => {
            const k = video.relativePath; // pathKey is identity
            if (removedKeys.has(k)) return;
            seenKeys.add(k);
            const isNew = !existingKeys.has(k);
            const wasMissing = missingSinceByKey.get(k) !== undefined;
            batch.push({
                key: k,
                name: video.name,
                relativePath: video.relativePath,
                seenAt,
                ...(isNew ? { addedAt: seenAt } : {}),
                ...(wasMissing ? { missingSinceMs: undefined } : {}),
            });
            if (batch.length >= 64) void flush();
        },
    });
    await flush();

    // Reconcile: soft-mark files we didn't see, hard-delete ones missing past TTL.
    const toMark: (Partial<FileRecord> & { key: string })[] = [];
    const toDelete: string[] = [];
    for (const k of existingKeys) {
        if (seenKeys.has(k)) continue;
        const since = missingSinceByKey.get(k);
        if (since === undefined) toMark.push({ key: k, missingSinceMs: seenAt });
        else if (seenAt - since > MISSING_DELETE_TTL_MS) toDelete.push(k);
    }
    if (toMark.length > 0) { try { await files.updateBatch(toMark); } catch (err) { console.warn("[scanWorker] mark-missing failed:", err); } }
    if (toDelete.length > 0) { try { await files.deleteBatch(toDelete); } catch (err) { console.warn("[scanWorker] delete-missing failed:", err); } }
}

// ── Per-phase rate/ETA tracking ───────────────────────────────────────────────
class PhaseRate {
    private emaMs: number | undefined;
    sample(ms: number) {
        this.emaMs = this.emaMs === undefined ? ms : this.emaMs * 0.7 + ms * 0.3;
    }
    get perItemMs(): number | undefined { return this.emaMs; }
    etaMs(remaining: number): number | undefined {
        return this.emaMs === undefined ? undefined : this.emaMs * Math.max(0, remaining);
    }
}
const metaRate = new PhaseRate();
const kfRate = new PhaseRate();

// Live-ETA context: captured when a file starts so publishFileProgress can
// recompute the WHOLE-PHASE ETA on every progress heartbeat (~1/s) — the
// visible ETA number should tick down as the current file's fraction fills,
// not sit frozen for the entire file. The per-file ETA lives in fileDetail
// (the worker's own progress line, shown in the tooltip).
let activePhaseRate: PhaseRate | undefined;
let activeRemainingAfter = 0;
let activeFileStartMs = 0;

// Publish live work-progress for the active phase into the shared status row
// (writeStatus throttles the actual broadcast).
async function publish(phase: ScanPhase, currentKey: string, done: number, total: number, rate: PhaseRate): Promise<void> {
    console.log(`[scan-coordinator] ${phase} ${done}/${total}: ${currentKey}`);
    status.running = true;
    status.phase = phase;
    status.currentKey = currentKey;
    status.done = done;
    status.total = total;
    status.ratePerItemMs = rate.perItemMs;
    // Initial whole-phase ETA using the (possibly still-undefined) learned
    // per-item rate. publishFileProgress refines this as heartbeats arrive.
    status.etaMs = rate.etaMs(total - done);
    activePhaseRate = rate;
    activeRemainingAfter = Math.max(0, total - done - 1);
    activeFileStartMs = Date.now();
    // A new file is starting — clear the previous file's sub-progress so the
    // filling bar resets to empty (climbs again as this file's heartbeats arrive).
    status.fileFraction = undefined;
    status.fileDetail = undefined;
    status.walking = false;
    // Force: every file boundary pushes the COMPLETE state (counts just
    // refreshed by the loop, new phase/file, cleared sub-progress) immediately,
    // so the finished file's count decrement is visible right away instead of
    // waiting out the heartbeat throttle.
    writeStatus(true);
}

// Per-file sub-progress from the decode worker (~1/s). Media-time based, so we
// can only draw a determinate bar when the file's duration is known (keyframes +
// faces both know it; metadata emits nothing). `detail` is the worker's own line
// — shown verbatim in the phase cell's tooltip.
function publishFileProgress(info: { message: string; currentMs?: number; durationMs?: number }): void {
    const frac = info.durationMs && info.durationMs > 0 && info.currentMs !== undefined
        ? Math.min(1, Math.max(0, info.currentMs / info.durationMs))
        : undefined;
    status.fileFraction = frac;
    status.fileDetail = info.message;
    // Recompute the whole-phase ETA off this heartbeat so it visibly ticks
    // down. Two ingredients:
    //   currentFileRemainingMs — projected from media progress (elapsed *
    //     durationMs/currentMs, minus elapsed). Falls back to the learned
    //     per-item rate minus elapsed when we don't have media progress.
    //   queueRemainingMs       — (files after this one) * per-item rate.
    // If no files have completed yet, use the CURRENT file's projected
    // total as the per-item rate — a stopgap that gets more accurate as
    // fileFraction climbs, so the number is available immediately instead
    // of blank for the whole first file.
    if (activePhaseRate) {
        const elapsed = Date.now() - activeFileStartMs;
        const projectedFileTotalMs = (frac !== undefined && frac > 0.01) ? elapsed / frac : undefined;
        // The displayed rate must never claim less than the file we're literally
        // watching: once the current file's projection (or raw elapsed time)
        // exceeds the learned average, IT is the live per-item rate — otherwise
        // the number freezes at the historical average while a slow file drags
        // on. It settles back down once faster files complete and the EMA wins.
        const learnedMs = activePhaseRate.perItemMs ?? 0;
        const perItemMs = Math.max(learnedMs, projectedFileTotalMs ?? 0, projectedFileTotalMs === undefined ? elapsed : 0);
        if (perItemMs > 0) {
            const currentFileRemainingMs = projectedFileTotalMs !== undefined
                ? Math.max(0, projectedFileTotalMs - elapsed)
                : Math.max(0, perItemMs - elapsed);
            // ETA uses the SAME per-item rate the cell displays, so rate x
            // remaining always multiplies out to roughly the shown ETA.
            status.etaMs = currentFileRemainingMs + activeRemainingAfter * perItemMs;
            status.ratePerItemMs = perItemMs;
        }
    }
    writeStatus(false);
}

// ── Metadata phase ────────────────────────────────────────────────────────────
async function runOneMetadata(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const versionCol = await files.getColumn("metadataVersion");
    const total = versionCol.length;
    const done = versionCol.filter(r => r.value === METADATA_VERSION).length;
    const blacklisted = await blacklistedSet();
    const eligibleKeys = versionCol.filter(r => r.value !== METADATA_VERSION && !blacklisted.has(r.key)).map(r => r.key);
    if (eligibleKeys.length === 0) return false;

    const key = pickPriority(eligibleKeys, await priorityMap());
    const relativePath = await files.getSingleField(key, "relativePath");
    await publish("metadata", key, done, total, metaRate);
    // openFileByKey here is decode-free (getFile → size/name) and detects a
    // vanished file; the actual DECODE is delegated to the victim by relativePath.
    const file = relativePath ? await openFileByKey(handle, key) : undefined;
    if (!file || !relativePath) {
        // File vanished — mark done-at-version so we don't spin on it.
        await files.update({ key, metadataVersion: METADATA_VERSION, extractionError: "file not found" });
        return true;
    }
    // Crash guard: count this attempt before doing the risky work.
    const attempts = ((await files.getSingleField(key, "metaAttempts")) ?? 0) + 1;
    await files.update({ key, metaAttempts: attempts });
    if (attempts > MAX_ATTEMPTS) {
        const msg = `gave up after ${MAX_ATTEMPTS} attempts — this file repeatedly crashes the scanner`;
        console.warn(`[scanWorker] metadata giving up on ${key}: ${msg}`);
        void recordScanError({ file: key, phase: "metadata", message: msg, at: Date.now() });
        await files.update({ key, metadataExtractedAt: Date.now(), metadataVersion: METADATA_VERSION, extractionError: msg, metaAttempts: undefined });
        return true;
    }
    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const info = await extractor.extract(relativePath, `[scan meta ${file.name}]`, sw);
        await files.update({
            key,
            size: file.size,
            durationSec: info.durationSec,
            width: info.width,
            height: info.height,
            videoCodec: info.videoCodec,
            audioCodec: info.audioCodec,
            mediaInfo: info.mediaInfo,
            fileModifiedAt: info.fileModifiedAt,
            metadataExtractedAt: Date.now(),
            metadataExtractionMs: info.metadataExtractionMs,
            metadataVersion: METADATA_VERSION,
            extractionError: "",
            metaAttempts: undefined,
        });
        await thumbnails.write({
            key,
            thumb160: info.thumb160,
            thumb320: info.thumb320,
            thumb640: info.thumb640,
            thumbW: info.thumbW,
            thumbH: info.thumbH,
            thumbSource: "auto",
        });
    } catch (err) {
        const msg = (err as Error).message ?? String(err);
        // Scanning disabled, or the victim switched / started playing — not the
        // file's fault. Revert the attempt bump and leave it unstamped to retry.
        if (aborting || isTransientDecodeError(msg)) {
            await files.update({ key, metaAttempts: undefined });
            return true;
        }
        if (isHangError(msg)) {
            console.warn(`[scan-coordinator] ${key} hung the decoder (metadata); blacklisting`);
            void recordScanError({ file: key, phase: "metadata", message: `blacklisted: ${msg}`, at: Date.now() });
            await files.update({ key, scanBlacklisted: true, metadataExtractedAt: Date.now(), metadataVersion: METADATA_VERSION, extractionError: `blacklisted: ${msg}`, metaAttempts: undefined });
            return true;
        }
        console.warn(`[scanWorker] metadata failed for ${key}:`, msg);
        void recordScanError({ file: key, phase: "metadata", message: msg, at: Date.now() });
        // Stamp at current version even on failure so we don't re-hit the same
        // pathological file every pass (matches appState behaviour).
        await files.update({ key, metadataExtractedAt: Date.now(), metadataVersion: METADATA_VERSION, extractionError: msg, metaAttempts: undefined });
    }
    metaRate.sample(Date.now() - t0);
    return true;
}

// ── Keyframes phase ───────────────────────────────────────────────────────────
async function runOneKeyframes(handle: FileSystemDirectoryHandle): Promise<boolean> {
    // Only files that have finished metadata are eligible for keyframes.
    const metaCol = await files.getColumn("metadataVersion");
    const metaDone = new Set(metaCol.filter(r => r.value === METADATA_VERSION).map(r => r.key));
    if (metaDone.size === 0) return false;
    const kfCol = await keyframes.getColumn("keyframesVersion");
    const kfDone = new Set(kfCol.filter(r => r.value === KEYFRAMES_VERSION).map(r => r.key));

    const blacklisted = await blacklistedSet();
    const metaFailed = await metaFailedSet();
    const eligibleKeys = [...metaDone].filter(k => !kfDone.has(k) && !blacklisted.has(k) && !metaFailed.has(k));
    if (eligibleKeys.length === 0) return false;
    const target = pickPriority(eligibleKeys, await priorityMap());

    await publish("keyframes", target, kfDone.size, metaDone.size, kfRate);
    const relativePath = await files.getSingleField(target, "relativePath");
    const file = relativePath ? await openFileByKey(handle, target) : undefined;
    if (!file || !relativePath) {
        await keyframes.write({ key: target, keyframesVersion: KEYFRAMES_VERSION, keyframesError: "file not found" });
        return true;
    }
    // Crash guard (see MAX_ATTEMPTS). update() so a re-scan doesn't wipe the
    // existing keyframes payload just to bump the counter.
    const kfAttempts = ((await keyframes.getSingleField(target, "kfAttempts")) ?? 0) + 1;
    await keyframes.update({ key: target, kfAttempts });
    if (kfAttempts > MAX_ATTEMPTS) {
        const msg = `gave up after ${MAX_ATTEMPTS} attempts — this file repeatedly crashes the scanner`;
        console.warn(`[scanWorker] keyframes giving up on ${target}: ${msg}`);
        void recordScanError({ file: target, phase: "keyframes", message: msg, at: Date.now() });
        await keyframes.update({ key: target, keyframesVersion: KEYFRAMES_VERSION, keyframesError: msg, kfAttempts: undefined });
        return true;
    }
    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const bundle = await extractor.extractKeyframes(relativePath, `[scan kf ${file.name}]`, sw, publishFileProgress);
        await keyframes.write({
            key: target,
            keyframes2: encodeKeyframes2(bundle),
            keyframesVersion: KEYFRAMES_VERSION,
            keyframesExtractedAt: Date.now(),
            keyframesExtractionMs: bundle.keyframesExtractionMs,
            keyframesError: "",
        });
    } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (aborting || isTransientDecodeError(msg)) {
            await keyframes.update({ key: target, kfAttempts: undefined });
            return true;
        }
        if (isHangError(msg)) {
            console.warn(`[scan-coordinator] ${target} hung the decoder (keyframes); blacklisting`);
            void recordScanError({ file: target, phase: "keyframes", message: `blacklisted: ${msg}`, at: Date.now() });
            await keyframes.update({ key: target, keyframesVersion: KEYFRAMES_VERSION, keyframesError: `blacklisted: ${msg}`, kfAttempts: undefined });
            await files.update({ key: target, scanBlacklisted: true });
            return true;
        }
        console.warn(`[scanWorker] keyframes failed for ${target}:`, msg);
        void recordScanError({ file: target, phase: "keyframes", message: msg, at: Date.now() });
        await keyframes.write({ key: target, keyframesExtractedAt: Date.now(), keyframesVersion: KEYFRAMES_VERSION, keyframesError: msg });
    }
    kfRate.sample(Date.now() - t0);
    return true;
}

// ── Faces phase ───────────────────────────────────────────────────────────────
const facesRate = new PhaseRate();
type BBox = { x1: number; y1: number; x2: number; y2: number };
interface ClusterMember { embedding: Float32Array; timeMs: number; bbox: BBox; score: number; }
const bboxArea = (b: BBox): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
// Representative = the cluster's largest detected face (a REAL member, never an
// averaged/centroid vector — mirrors faceExtraction.ts).
function pickRepresentative(members: ClusterMember[]): ClusterMember {
    let best = members[0];
    let bestA = bboxArea(best.bbox);
    for (let i = 1; i < members.length; i++) {
        const a = bboxArea(members[i].bbox);
        if (a > bestA) { best = members[i]; bestA = a; }
    }
    return best;
}
async function loadBlacklistEmbeddings(): Promise<Float32Array[]> {
    try {
        const col = await blacklistedFaces.getColumn("embedding");
        return col.map(r => r.value).filter((e): e is Float32Array => !!e);
    } catch { return []; }
}
function isBlacklisted(emb: Float32Array, bl: Float32Array[]): boolean {
    for (const b of bl) { if (l2Distance(emb, b) < SAME_CHARACTER_THRESHOLD) return true; }
    return false;
}

// Minimum face width (detection-frame px) and earliest runtime fraction for a
// face to be eligible as the poster. Mirrors faceExtraction.ts.
const THUMB_MIN_FACE_W = 128;
const THUMB_MIN_TIME_FRACTION = 0.3;

// Promote a clustered character's largest real face to the file thumbnail,
// honouring the faceThumbnailMode setting (off/first/second/auto). Best-effort:
// failures are logged, never fatal. Ported from faceExtraction.maybeSetFaceThumbnail.
async function maybeSetFaceThumbnail(
    key: string,
    clusters: { members: ClusterMember[] }[],
    frameJpegs: Map<number, Uint8Array>,
): Promise<void> {
    try {
        const mode = await readStrSetting("faceThumbnailMode", "auto");
        if (mode === "off") return;
        let useSecond: boolean;
        if (mode === "auto") useSecond = (await countFolderVideos(key)) >= SERIES_FOLDER_THRESHOLD;
        else useSecond = mode === "second";
        const top = useSecond ? (clusters[1] ?? clusters[0]) : clusters[0];
        if (!top || top.members.length === 0) return;

        const existingSource = await thumbnails.getSingleField(key, "thumbSource");
        if (existingSource === "user") return;

        const durationSec = await files.getSingleField(key, "durationSec");
        let endMs = (durationSec ?? 0) * 1000;
        if (!(endMs > 0)) for (const m of top.members) endMs = Math.max(endMs, m.timeMs);
        const minTimeMs = endMs * THUMB_MIN_TIME_FRACTION;

        const eligible = top.members.filter(m =>
            m.timeMs >= minTimeMs && (m.bbox.x2 - m.bbox.x1) >= THUMB_MIN_FACE_W);
        if (eligible.length === 0) return;

        const best = pickRepresentative(eligible);
        const jpeg = frameJpegs.get(best.timeMs);
        if (!jpeg) return;
        const thumbs = await generateThumbsFromJpeg(jpeg);
        await thumbnails.write({ key, ...thumbs, thumbSource: "face" });
    } catch (err) {
        console.warn(`[scanWorker] could not set face thumbnail for ${key}:`, err);
    }
}

async function runOneFaces(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const metaCol = await files.getColumn("metadataVersion");
    const metaDone = metaCol.filter(r => r.value === METADATA_VERSION).map(r => r.key);
    if (metaDone.length === 0) return false;
    // facesEmpty / facesError files are stamped at the current FACES_VERSION, so
    // the version check alone skips them (they won't re-run until a bump).
    const facesVerCol = await files.getColumn("facesVersion");
    const facesVer = new Map(facesVerCol.map(r => [r.key, r.value] as const));
    const total = metaDone.length;
    const done = metaDone.filter(k => facesVer.get(k) === FACES_VERSION).length;
    const blacklisted = await blacklistedSet();
    const metaFailed = await metaFailedSet();
    const eligibleKeys = metaDone.filter(k => facesVer.get(k) !== FACES_VERSION && !blacklisted.has(k) && !metaFailed.has(k));
    if (eligibleKeys.length === 0) return false;
    const target = pickPriority(eligibleKeys, await priorityMap());

    await publish("faces", target, done, total, facesRate);
    const relativePath = await files.getSingleField(target, "relativePath");
    const file = relativePath ? await openFileByKey(handle, target) : undefined;
    if (!file || !relativePath) {
        await files.update({ key: target, facesVersion: FACES_VERSION, facesError: "file not found", facesEmpty: false });
        return true;
    }
    // Crash guard (see MAX_ATTEMPTS).
    const facesAttempts = ((await files.getSingleField(target, "facesAttempts")) ?? 0) + 1;
    await files.update({ key: target, facesAttempts });
    if (facesAttempts > MAX_ATTEMPTS) {
        const msg = `gave up after ${MAX_ATTEMPTS} attempts — this file repeatedly crashes the scanner`;
        console.warn(`[scanWorker] faces giving up on ${target}: ${msg}`);
        void recordScanError({ file: target, phase: "faces", message: msg, at: Date.now() });
        await files.update({ key: target, facesExtractedAt: Date.now(), facesVersion: FACES_VERSION, facesError: msg, facesEmpty: false, facesAttempts: undefined });
        return true;
    }

    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const fp16 = await readSetting(FACES_FP16, false);
        const allFaces: ClusterMember[] = [];
        const frameJpegs = new Map<number, Uint8Array>();
        // Two guardrails on face scan wall-clock time. Both trip the same
        // path: set `capReason`, abort the extractor (rejects the pending
        // decode), and after the awaited call throw the hang-shaped error so
        // the outer catch blacklists this file (isHangError matches
        // "decoder is stuck").
        //   - HARD cap: unconditional 360s ceiling (a face scan that hasn't
        //     finished by then is bad news regardless of activity).
        //   - EARLY projection: after 30s of decoding, project total time
        //     from media progress (currentMs/durationMs). If we're on track
        //     to exceed 500s (very generous, to absorb startup slowness),
        //     abort now — no point burning 6 minutes to confirm the same
        //     answer 30 seconds already gave us.
        const HARD_CAP_MS = 360_000;
        const EARLY_WINDOW_MS = 30_000;
        const EARLY_PROJECTED_LIMIT_MS = 500_000;
        let capReason: string | undefined;
        const tripCap = (reason: string): void => {
            if (capReason) return;
            capReason = reason;
            console.warn(`[scanWorker] ${target} face scan cap tripped — ${reason}; aborting`);
            try { extractor.abort(); } catch { /* ignore */ }
        };
        const hardCapTimer = setTimeout(
            () => tripCap(`face scan exceeded ${HARD_CAP_MS / 1000}s cap — the decoder is stuck on this file`),
            HARD_CAP_MS);
        try {
            await extractor.extractFaceFrames(relativePath, `[scan faces ${file.name}]`, (frame) => {
                if (frame.faces.length === 0) return;
                frameJpegs.set(frame.timeMs, frame.jpeg);
                for (const f of frame.faces) allFaces.push({ embedding: f.embedding, timeMs: frame.timeMs, bbox: f.bbox, score: f.score });
            }, fp16, sw, (info) => {
                publishFileProgress(info);
                if (capReason) return;
                const elapsed = Date.now() - t0;
                if (elapsed <= EARLY_WINDOW_MS) return;
                const cur = info.currentMs;
                const dur = info.durationMs;
                if (!cur || cur <= 0 || !dur || dur <= 0) return;
                const projected = elapsed * (dur / cur);
                if (projected > EARLY_PROJECTED_LIMIT_MS) {
                    tripCap(`face scan projected to take ${Math.round(projected / 1000)}s after ${Math.round(elapsed / 1000)}s of decoding (${(cur / elapsed).toFixed(2)}x realtime) — the decoder is stuck on this file`);
                }
            });
        } catch (err) {
            // If the extractor rejected because WE aborted it, translate that
            // into the cap-reason so the outer catch classifies as a hang and
            // blacklists. Any other rejection propagates as-is.
            if (capReason) throw new Error(capReason);
            throw err;
        } finally {
            clearTimeout(hardCapTimer);
        }
        if (capReason) throw new Error(capReason);

        if (allFaces.length === 0) {
            await files.update({
                key: target, facesExtractedAt: Date.now(), facesExtractionMs: Date.now() - t0,
                facesVersion: FACES_VERSION, characterCount: 0, faceCount: 0, facesError: "", facesEmpty: true, facesAttempts: undefined,
            });
            facesRate.sample(Date.now() - t0);
            return true;
        }

        const clusters = clusterEmbeddings(allFaces, SAME_CHARACTER_THRESHOLD, item => item.embedding);
        const solid = clusters.filter(c => c.members.length >= MIN_CLUSTER_MEMBERS);
        const blacklist = await loadBlacklistEmbeddings();
        const allowed = blacklist.length === 0 ? solid
            : solid.filter(c => !isBlacklisted(pickRepresentative(c.members).embedding, blacklist));
        allowed.sort((a, b) => b.members.length - a.members.length);
        const kept = allowed.slice(0, MAX_CHARACTERS_PER_FILE);
        const keptFaceCount = kept.reduce((sum, c) => sum + c.members.length, 0);

        const charsToWrite: CharacterRecord[] = [];
        const framesToWrite: FaceFramesRecord[] = [];
        for (let ci = 0; ci < kept.length; ci++) {
            const c = kept[ci];
            const bestMember = pickRepresentative(c.members);
            let avatarJpeg: Uint8Array | undefined;
            const bestFrame = ci < TOP_N_FACE_FRAMES ? frameJpegs.get(bestMember.timeMs) : undefined;
            if (bestFrame) {
                try { avatarJpeg = await cropFaceAvatarJpeg(bestFrame, bestMember.bbox); }
                catch (err) { console.warn(`[scanWorker] avatar crop failed ${target}#${ci}:`, err); }
            }
            charsToWrite.push({
                key: characterKey(target, ci),
                fileKey: target,
                characterIdx: ci,
                bestFaceTimeMs: bestMember.timeMs,
                bestFaceEmbedding: bestMember.embedding,
                bestFaceScore: bestMember.score,
                memberCount: c.members.length,
                avatarJpeg,
            });
            const embeddings = new Float32Array(c.members.length * EMBEDDING_FLOATS);
            const frameTimes = new Float32Array(c.members.length);
            for (let m = 0; m < c.members.length; m++) {
                embeddings.set(c.members[m].embedding, m * EMBEDDING_FLOATS);
                frameTimes[m] = c.members[m].timeMs;
            }
            framesToWrite.push({ key: characterKey(target, ci), embeddings, embeddingCount: c.members.length, frameTimes });
        }
        await characters.writeBatch(charsToWrite);
        await faceFrames.writeBatch(framesToWrite);
        // Promote a character's face to the file poster (unless the user picked
        // one or disabled it) — same behaviour as the tab pipeline.
        await maybeSetFaceThumbnail(target, kept, frameJpegs);
        await files.update({
            key: target, facesExtractedAt: Date.now(), facesExtractionMs: Date.now() - t0,
            facesVersion: FACES_VERSION, characterCount: kept.length, faceCount: keptFaceCount, facesAttempts: undefined,
            facesError: "", facesEmpty: false,
        });
    } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (aborting || isTransientDecodeError(msg)) {
            await files.update({ key: target, facesAttempts: undefined });
            return true;
        }
        if (isHangError(msg)) {
            console.warn(`[scan-coordinator] ${target} hung the decoder (faces); blacklisting`);
            void recordScanError({ file: target, phase: "faces", message: `blacklisted: ${msg}`, at: Date.now() });
            await files.update({ key: target, scanBlacklisted: true, facesExtractedAt: Date.now(), facesVersion: FACES_VERSION, facesError: `blacklisted: ${msg}`, facesEmpty: false, facesAttempts: undefined });
            return true;
        }
        console.warn(`[scanWorker] faces failed for ${target}:`, msg);
        void recordScanError({ file: target, phase: "faces", message: msg, at: Date.now() });
        await files.update({ key: target, facesExtractedAt: Date.now(), facesVersion: FACES_VERSION, facesError: msg, facesEmpty: false, facesAttempts: undefined });
    }
    facesRate.sample(Date.now() - t0);
    return true;
}

// ── File access ───────────────────────────────────────────────────────────────
async function openFileByKey(handle: FileSystemDirectoryHandle, key: string): Promise<ReadableFile | undefined> {
    const relativePath = await files.getSingleField(key, "relativePath");
    if (!relativePath) return undefined;
    try {
        const fh = await resolveFileHandle(handle, relativePath);
        const f = await fh.getFile();
        return {
            name: f.name || relativePath.split("/").pop() || relativePath,
            size: f.size,
            lastModified: f.lastModified,
            read: async (start, end) => new Uint8Array(await f.slice(start, end).arrayBuffer()),
        };
    } catch (err) {
        if ((err as { name?: string })?.name === "NotFoundError") return undefined;
        throw err;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
