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
import { MetadataExtractorClient, ReadableFile, ExtractedFrame } from "./MetadataExtractorClient";
import { publishScanProgress, publishScanIdle, ScanPhase } from "./scanStatusBus";
import { clusterEmbeddings, SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";
import { l2Distance } from "../faceEmbed/arcface";
import { cropFaceAvatarJpeg, generateThumbsFromJpeg } from "./imageThumbs";
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

// Setting keys — must match appState's constants.
const SCAN_ENABLED = "scanEnabled";
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
// How often to re-walk the folder for added/removed files while otherwise idle.
const FILE_WALK_INTERVAL_MS = 5 * 60 * 1000;
// Idle poll cadence when there's nothing to do (settings may flip, files appear).
const IDLE_POLL_MS = 10_000;

// One extractor client (spawns/owns the nested metadataWorker) for the loop.
const extractor = new MetadataExtractorClient();

let root: FileSystemDirectoryHandle | undefined;
let started = false;
let lastWalkAt = 0;

export function setScanRoot(handle: FileSystemDirectoryHandle): void {
    root = handle;
}

// Kick the loop (idempotent). Call once the storage-root override + handle are set.
export function startScanCore(): void {
    if (started) return;
    started = true;
    void runLoop();
}

async function runLoop(): Promise<void> {
    // Never resolves — the SharedWorker lives as long as any tab is connected.
    for (;;) {
        try {
            const did = await tick();
            if (!did) {
                await publishScanIdle();
                await sleep(IDLE_POLL_MS);
            }
        } catch (err) {
            console.warn("[scanWorker] loop error:", err);
            await sleep(IDLE_POLL_MS);
        }
    }
}

// One unit of progress. Returns true if it did work (so the loop keeps going at
// full speed), false if there was nothing to do (so the loop idles).
async function tick(): Promise<boolean> {
    if (!root) return false;
    if (!(await readSetting(SCAN_ENABLED, true))) return false;

    // Discover files periodically (and once at startup).
    const now = Date.now();
    if (now - lastWalkAt > FILE_WALK_INTERVAL_MS) {
        lastWalkAt = now;
        await runFileWalk(root);
    }

    // Metadata: the always-on phase whenever scanning is enabled.
    if (await runOneMetadata(root)) return true;

    // Keyframes: opt-in (default on).
    if (await readSetting(KEYFRAMES_ENABLED, true)) {
        if (await runOneKeyframes(root)) return true;
    }

    // Faces: opt-in (default off). Requires keyframes to be enabled (cascade),
    // matching the tab's phase ordering.
    if (await readSetting(FACES_ENABLED, false) && await readSetting(KEYFRAMES_ENABLED, true)) {
        if (await runOneFaces(root)) return true;
    }

    return false;
}

// ── File walk ───────────────────────────────────────────────────────────────
async function runFileWalk(handle: FileSystemDirectoryHandle): Promise<void> {
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

let lastStatusAt = 0;
async function publish(phase: ScanPhase, currentKey: string, done: number, total: number, rate: PhaseRate): Promise<void> {
    const now = Date.now();
    // Throttle status writes so we don't churn the store per file, but always
    // emit the first one of a run.
    if (now - lastStatusAt < 3_000 && done > 0) return;
    lastStatusAt = now;
    await publishScanProgress({
        running: true,
        phase,
        currentKey,
        done,
        total,
        ratePerItemMs: rate.perItemMs,
        etaMs: rate.etaMs(total - done),
    });
}

// ── Metadata phase ────────────────────────────────────────────────────────────
async function runOneMetadata(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const versionCol = await files.getColumn("metadataVersion");
    const total = versionCol.length;
    const done = versionCol.filter(r => r.value === METADATA_VERSION).length;
    const next = versionCol.find(r => r.value !== METADATA_VERSION);
    if (!next) return false;

    const key = next.key;
    await publish("metadata", key, done, total, metaRate);
    const file = await openFileByKey(handle, key);
    if (!file) {
        // File vanished — mark done-at-version so we don't spin on it.
        await files.update({ key, metadataVersion: METADATA_VERSION, extractionError: "file not found" });
        return true;
    }
    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const info = await extractor.extract(file, `[scan meta ${file.name}]`, sw);
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
        console.warn(`[scanWorker] metadata failed for ${key}:`, msg);
        // Stamp at current version even on failure so we don't re-hit the same
        // pathological file every pass (matches appState behaviour).
        await files.update({ key, metadataExtractedAt: Date.now(), metadataVersion: METADATA_VERSION, extractionError: msg });
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

    let target: string | undefined;
    for (const k of metaDone) { if (!kfDone.has(k)) { target = k; break; } }
    if (!target) return false;

    await publish("keyframes", target, kfDone.size, metaDone.size, kfRate);
    const file = await openFileByKey(handle, target);
    if (!file) {
        await keyframes.write({ key: target, keyframesVersion: KEYFRAMES_VERSION, keyframesError: "file not found" });
        return true;
    }
    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const bundle = await extractor.extractKeyframes(file, `[scan kf ${file.name}]`, undefined, sw);
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
        console.warn(`[scanWorker] keyframes failed for ${target}:`, msg);
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
    const target = metaDone.find(k => facesVer.get(k) !== FACES_VERSION);
    if (!target) return false;

    await publish("faces", target, done, total, facesRate);
    const file = await openFileByKey(handle, target);
    if (!file) {
        await files.update({ key: target, facesVersion: FACES_VERSION, facesError: "file not found", facesEmpty: false });
        return true;
    }

    const t0 = Date.now();
    try {
        const sw = await readSetting(SCAN_SOFTWARE_DECODE, false);
        const fp16 = await readSetting(FACES_FP16, false);
        const allFaces: ClusterMember[] = [];
        const frameJpegs = new Map<number, Uint8Array>();
        await extractor.extractFaceFrames(file, `[scan faces ${file.name}]`, (frame: ExtractedFrame) => {
            if (frame.faces.length === 0) return;
            frameJpegs.set(frame.timeMs, frame.jpeg);
            for (const f of frame.faces) allFaces.push({ embedding: f.embedding, timeMs: frame.timeMs, bbox: f.bbox, score: f.score });
        }, undefined, fp16, sw);

        if (allFaces.length === 0) {
            await files.update({
                key: target, facesExtractedAt: Date.now(), facesExtractionMs: Date.now() - t0,
                facesVersion: FACES_VERSION, characterCount: 0, faceCount: 0, facesError: "", facesEmpty: true,
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
            facesVersion: FACES_VERSION, characterCount: kept.length, faceCount: keptFaceCount,
            facesError: "", facesEmpty: false,
        });
    } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.warn(`[scanWorker] faces failed for ${target}:`, msg);
        await files.update({ key: target, facesExtractedAt: Date.now(), facesVersion: FACES_VERSION, facesError: msg, facesEmpty: false });
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
