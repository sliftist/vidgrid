// STYLE: no rounded corners anywhere in this project — never call .borderRadius
// on any element. Keep edges sharp.

import { observable, runInAction, computed } from "mobx";
import {
    setFileAPIKey,
    getDirectoryHandle,
    resetStorageLocation,
    getFileURL,
    FileWrapper,
} from "sliftutils/storage/FileFolderAPI";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { findVideos, resolveFileHandle, TraversalProgress } from "./scan/folderTraversal";
import { encodeScanReport } from "./scan/scanReport";
import * as Scan from "./scan/ScanCoordinator";
import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "./MetadataExtractor";
import type { MediaInfo } from "./MetadataExtractor";
import { metadataExtractorClient } from "./scan/MetadataExtractorClient";
import { extractFacesForKey } from "./faces/faceExtraction";
import { encodeKeyframes2 } from "./scan/keyframes2";
import { currentVideo } from "./router";
import { isMissingPointerInput } from "./platform";
import { formatTime } from "socket-function/src/formatting/format";
import type { ProgressInfo } from "./scan/MetadataExtractorClient";
import { recordReadStart, recordReadDone } from "./player/ioStats";
import { beginThrottledScan, endThrottledScan, cancelThrottle, throttleDutyCycle, throttleHeavyItem } from "./scan/scanThrottle";
import { isTabHidden, onVisibilityChange } from "./visibility";

// SliftUtils owns the file handle. Calling `getDirectoryHandle()` shows its
// built-in picker UI on first use and persists the pointer; subsequent loads
// auto-restore. We grab the raw FileSystemDirectoryHandle from the wrapper to
// drive our own scan + per-file handle resolution. BulkDatabase2 routes through
// the same `getDirectoryHandle` internally so its data lives in the same
// shared folder.

setFileAPIKey("vidgrid");

export type PlayerEngine = "mediabunny" | "tv-hack" | "native" | "web-demuxer";
export type GridSize = "small" | "medium" | "large" | "huge";
export type SortOrder = "date" | "name" | "duration" | "watched" | "shuffle";

// Backend-agnostic file handle the players + extractors take. Lets
// us swap the underlying storage (local FileSystemAccess File, a
// sliftutils FileWrapper, a network range-reader, …) without
// touching VideoPlayer / MetadataExtractor.
//
// - read(start,end) is the minimum surface a mediabunny CustomSource
//   needs and is the one path every backend can implement.
// - blob is optional: only set when the backend actually has a local
//   Blob handy. NativeVideoPlayer / WebDemuxerPlayer need it
//   (they go through URL.createObjectURL / WebDemuxer.load(file));
//   network-backed sources will leave it undefined and those engines
//   will refuse, but the mediabunny engine works fine without it.
// - url is the same idea: a stable URL the <video> tag can hit
//   directly. Used by NativeVideoPlayer when present.
export interface MediaFile {
    name: string;
    size: number;
    lastModified: number;
    read(start: number, end: number): Promise<Uint8Array>;
    blob?: Blob;
    url?: string;
    // Resolves a URL the native <video> can load directly: a blob: URL for
    // local files, a range-capable https URL for remote-backed ones. Always
    // pass the result to disposeFileURL when done (no-op for non-blob URLs).
    getURL?: () => Promise<string>;
}

// Loose shape used internally — matches both the browser File (which is
// a Blob with a `name`) and the sliftutils FileWrapper.getFile() return
// value (a plain object with the same slice/arrayBuffer surface, no
// blob nature). `name` lives one level up on the FileWrapper itself in
// that case, so callers pass it explicitly here.
interface FileLike {
    size: number;
    lastModified: number;
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

// Wrap a FileLike into our MediaFile interface. `blob` is only set when
// the source actually IS a Blob; remote-backed sources leave it
// undefined, which is what makes them refuse to drive the native /
// web-demuxer engines (those need a real Blob/URL) while still working
// fine through the mediabunny CustomSource read path.
export function fileToMediaFile(name: string, file: FileLike): MediaFile {
    return {
        name,
        size: file.size,
        lastModified: file.lastModified,
        read: async (start, end) => {
            const want = Math.max(0, end - start);
            recordReadStart(want);
            try {
                const buf = await file.slice(start, end).arrayBuffer();
                recordReadDone(want, true);
                return new Uint8Array(buf);
            } catch (e) {
                recordReadDone(want, false);
                throw e;
            }
        },
        blob: file instanceof Blob ? file : undefined,
    };
}
// Re-exported here so existing imports keep compiling — the real
// definition + URLParam wrapper live in router.ts.
import type { ViewMode } from "./router";
export type DisplayMode = ViewMode;
export { viewMode as displayMode } from "./router";

// READ RULE: sync reads (`getSingleFieldSync`, `getColumnSync`) only work
// inside reactive contexts (render methods, mobx reactions). In async code,
// always use the Promise variants (`getSingleField`, `getColumn`).
export interface FileRecord {
    key: string;             // pathKey(relativePath) — stable identifier
    name: string;            // filename only (for display)
    relativePath: string;    // path relative to scan root (no root name)
    size?: number;
    seenAt: number;          // last time the scan saw this file
    addedAt?: number;        // first time the scan saw this file
    // First-seen-as-missing timestamp. Set by the scan when a previously
    // known file is no longer in the folder; cleared the moment the file
    // reappears. Records that stay marked beyond MISSING_DELETE_TTL_MS
    // get hard-deleted on a subsequent scan.
    missingSinceMs?: number;
    // Position resume state.
    positionSec?: number;
    positionUpdatedAt?: number;
    // Per-video preferences.
    engine?: PlayerEngine;
    // Loop region, restored when the video is reopened. Both seconds; only
    // meaningful (and only persisted) when loopEnabled is true.
    loopEnabled?: boolean;
    loopStartSec?: number;
    loopEndSec?: number;
    // Extracted metadata (Mediabunny one-shot).
    durationSec?: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    // Full per-track detail (every track, all codec/color/channel fields
    // Mediabunny exposes). The flat fields above stay for the hot grid path;
    // the info modal renders this. See MetadataExtractor.MediaInfo.
    mediaInfo?: MediaInfo;
    fileModifiedAt?: number;
    metadataExtractedAt?: number;
    metadataExtractionMs?: number;
    // Cache invalidation — re-extract when this doesn't match the current
    // MetadataExtractor.METADATA_VERSION.
    metadataVersion?: number;
    // Thumbnail / keyframe payloads live in separate BulkDatabases
    // (vidgrid_thumbnails / vidgrid_keyframes) keyed by the same file
    // key. They were originally columns on this record but the JPEG
    // payloads dominated the file collection's size, and a cell that
    // never renders a thumbnail or keyframe should pay nothing for
    // their storage. See ThumbnailRecord / KeyframesRecord below.
    // Per-frame face bookkeeping. The actual face records / characters /
    // frame thumbnails live in separate BulkDatabases (see below) so that
    // a cell that doesn't show faces never pays for that storage.
    facesVersion?: number;
    facesExtractedAt?: number;
    facesExtractionMs?: number;
    facesError?: string;
    // Cheap counts so the UI knows whether to show face UI without
    // hitting the per-face DBs.
    characterCount?: number;
    faceCount?: number;
    // Last per-file scan/extract error. Empty string = cleared by success;
    // undefined = never failed.
    extractionError?: string;
}

export const EMBEDDING_FLOATS = 512;

// One per cluster per video — the searchable per-character summary. Key:
// `${fileKey}#${paddedCharIdx}`. Light enough to scan wholesale during a
// face search; the heavy per-frame embeddings live in FaceFramesRecord
// under the same key, read lazily only once a character matches.
export interface CharacterRecord {
    key: string;
    fileKey: string;
    characterIdx: number;
    // Unit-length centroid for distance queries.
    centroid: Float32Array;
    // Media time of the representative ("best") face — the medoid of the
    // cluster. Kept for display (e.g. "best at 12.3s"); the frame it came
    // from is not stored.
    bestFaceTimeMs: number;
    // Embedding of that representative face — used as the query vector when
    // the user clicks the avatar to search for this character.
    bestFaceEmbedding: Float32Array;
    memberCount: number;
    // Pre-cropped square JPEG of the best face — rendered directly as the
    // character's avatar. Stored here (one tiny image per character) instead
    // of cropping a full frame at render time, so we don't need to keep a
    // per-frame image collection around just for avatars.
    avatarJpeg?: Uint8Array;
}

// Per-character frame data: every face embedding for one character in one
// file, concatenated into a single Float32Array. Key is the same
// `${fileKey}#${characterIdx}` as the CharacterRecord. Heavy — read
// per-key (lazily) once a character matches a search, never scanned.
export interface FaceFramesRecord {
    key: string;
    // embeddingCount × EMBEDDING_FLOATS floats; frame i is the slice
    // [i * EMBEDDING_FLOATS, (i + 1) * EMBEDDING_FLOATS).
    embeddings: Float32Array;
    embeddingCount: number;
    // ms timestamps parallel to `embeddings`.
    frameTimes: Float32Array;
}

// Thumbnail JPEGs at three widths. Key = file key (pathKey). Lives
// off the main FileRecord so reading file metadata doesn't drag in
// every cell's JPEG payload.
export interface ThumbnailRecord {
    key: string;
    thumb160?: Uint8Array;
    thumb320?: Uint8Array;
    thumb640?: Uint8Array;
    // Dimensions of the source canvas the three thumbnails were
    // rendered from (post-letterbox-crop). Used for the hover-area
    // aspect ratio so the cropped thumbnail fits without being
    // further cropped sideways by backgroundSize:cover.
    thumbW?: number;
    thumbH?: number;
    // Provenance of the current thumbnail. "auto" = default from the
    // metadata scan, "face" = picked from the most-common character's
    // largest-face frame, "user" = explicitly chosen via the picker.
    // A "user" thumbnail is never overwritten by the auto/face paths.
    thumbSource?: "auto" | "user" | "face";
}

// Keyframe preview strip: packed JPEGs + an index of byte offsets
// and media times. Key = file key. Same rationale as ThumbnailRecord
// — the packed-JPEG buffer dwarfs the metadata that needs to be
// scanned hot.
export interface KeyframesRecord {
    key: string;
    // Self-describing strip: index header + packed JPEGs in one value, so the
    // offsets/times can never diverge from the bytes they describe. See
    // web/scan/keyframes2.ts for the layout.
    keyframes2?: Uint8Array;
    keyframesVersion?: number;
    keyframesExtractedAt?: number;
    keyframesExtractionMs?: number;
    keyframesError?: string;
}

// During a scan we're writing to these collections hundreds of times a
// second. Without throttling, every write fires a reactive trigger that
// cascades into mobx invalidations + grid re-renders, which pegs the
// main thread (and lags sibling tabs of the same origin). 15s is
// generous enough that progress still feels live (next batch will fire
// well before the user gets bored) while collapsing scan-time bursts.
const SCAN_HEAVY_THROTTLE_MS = 15_000;

export const files = new BulkDatabase2<FileRecord>("vidgrid_index", { maxTriggerThrottleMs: SCAN_HEAVY_THROTTLE_MS });
// Bulky-payload collections keyed by the same file key as `files`. Kept
// separate so a cell that doesn't render its thumbnail (or doesn't have
// a keyframe strip) never reads those bytes off disk.
export const thumbnails = new BulkDatabase2<ThumbnailRecord>("vidgrid_thumbnails", { maxTriggerThrottleMs: SCAN_HEAVY_THROTTLE_MS });
export const keyframes = new BulkDatabase2<KeyframesRecord>("vidgrid_keyframes3", { maxTriggerThrottleMs: SCAN_HEAVY_THROTTLE_MS });
// Cascading face-extraction storage. Loading `files` alone never touches
// these collections, so a cell that doesn't render faces pays nothing.
// `characters` is the scanned summary; `faceFrames` holds the heavy
// per-character embeddings, read only per matching key.
export const characters = new BulkDatabase2<CharacterRecord>("vidgrid_characters3");
export const faceFrames = new BulkDatabase2<FaceFramesRecord>("vidgrid_face_frames3");

// User-removed files. A row here is a tombstone: the scan skips any path
// whose key is present, so a removed file never reappears even though it's
// still on disk. We write the tombstone BEFORE deleting the metadata row so a
// scan racing the removal can't re-add it in the gap.
interface RemovedRecord {
    key: string;
    removedAt?: number;
}
export const removedFiles = new BulkDatabase2<RemovedRecord>("vidgrid_removed");

export async function removeFromLibrary(key: string): Promise<void> {
    await removedFiles.write({ key, removedAt: Date.now() });
    await files.delete(key);
}

export async function removeManyFromLibrary(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const removedAt = Date.now();
    await removedFiles.writeBatch(keys.map(key => ({ key, removedAt })));
    await files.deleteBatch(keys);
}

// User-ignored folders. Like removedFiles but folder-level: the file walk
// never descends into a folder whose relativePath has a row here, so its
// contents fall out of the library via the normal missing-file reconcile.
interface IgnoredFolderRecord {
    key: string;
    ignoredAt?: number;
    // Subtree scan stats snapshotted at ignore time. Future scans skip the
    // folder entirely, so this is the last information we'll ever have about
    // what's inside — the scan-report UI shows it (frozen) for ignored rows.
    scannedAt?: number;
    totalTimeMs?: number;
    totalFiles?: number;
    totalVideos?: number;
    folderCount?: number;
}
export interface IgnoredFolderStats {
    scannedAt?: number;
    totalTimeMs?: number;
    totalFiles?: number;
    totalVideos?: number;
    folderCount?: number;
}
export const ignoredFolders = new BulkDatabase2<IgnoredFolderRecord>("vidgrid_ignored_folders");

export async function ignoreFolder(relativePath: string, stats?: IgnoredFolderStats): Promise<void> {
    await ignoredFolders.write({ key: relativePath, ignoredAt: Date.now(), ...stats });
}
export async function unignoreFolder(relativePath: string): Promise<void> {
    await ignoredFolders.delete(relativePath);
}

// The last file walk's per-folder breakdown, as ONE binary bundle (see
// web/scan/scanReport.ts for the layout) — a single record read loads the
// whole report. Key is always "last"; each completed walk overwrites it.
export interface ScanReportRecord {
    key: string;
    rootName?: string;
    scannedAt?: number;
    totalMs?: number;
    bundle?: Uint8Array;
}
export const scanReports = new BulkDatabase2<ScanReportRecord>("vidgrid_scan_report");
export const SCAN_REPORT_KEY = "last";

// ────────────────────────────────────────────────────────────────────────────
// Keyframes gating
//
// The keyframes collection holds multi-MB packed-JPEG strips per video.
// Reading ANY column on it (even a number-only column like
// keyframesVersion) loads the whole stream file the writes are buffered
// into — tens of MB on a healthy library. Three layers gate access:
//
// 1. `keyframePreviewDisabled()` — user setting (inverted). Off entirely
//    (hover preview, accurate thumbnails, toolbar counter) when disabled.
//    Remote libraries default to disabled.
// 2. `isStorageRemote` — async probe of the keyframes collection. Drives
//    the per-device default above and, while still pending, blocks
//    auto-load so a remote backend can't be hit before we know the answer.
//    (Explicit user-triggered extraction still runs because the scan code
//    path calls in directly.)
// 3. `keyframesHasBeenAccessed` — sticky. Once any cell has been
//    hovered (or auto-flip / accurate-thumbs is on), the toolbar
//    counter is free to subscribe to the version column. Without this
//    we'd hit the stream file on first paint.
//
// `keyframesCollectionAllowed()` is the master gate every render-time
// keyframes read goes through.

// "Disable keyframe preview" — inverted setting (off = preview on). Stored
// tri-state (undefined = never chosen) so Settings can tell a user's explicit
// choice apart from the per-device default. Remote-served libraries default to
// disabled, since the device is usually just a viewer; local libraries default
// to enabled.
const DISABLE_KEYFRAME_PREVIEW_KEY = "vidgrid.disableKeyframePreview";
function readDisableKeyframePreview(): string | undefined {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(DISABLE_KEYFRAME_PREVIEW_KEY) || undefined;
}
export const disableKeyframePreviewRaw = observable.box<string | undefined>(readDisableKeyframePreview());
export function disableKeyframePreviewDefault(): boolean {
    return isStorageRemote.get() === true;
}
export function disableKeyframePreviewExplicit(): boolean {
    return !!disableKeyframePreviewRaw.get();
}
export function keyframePreviewDisabled(): boolean {
    const raw = disableKeyframePreviewRaw.get();
    if (!raw) return disableKeyframePreviewDefault();
    return raw === "1";
}
export function setDisableKeyframePreview(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISABLE_KEYFRAME_PREVIEW_KEY, v ? "1" : "0");
    runInAction(() => disableKeyframePreviewRaw.set(v ? "1" : "0"));
}

// Tri-state: undefined while the probe is in flight. We treat the
// pending window as "don't auto-load" so a remote backend can't be
// hammered before we know the answer.
export const isStorageRemote = observable.box<boolean | undefined>(undefined);
// LAZY ON PURPOSE: probing touches the keyframes bulk DB, which resolves its
// storage path from the cwd on first access. The offline writer (writeServer.ts)
// imports this module and only afterwards chdir's into the data root, so probing
// at import time would bind the DB to the wrong directory. Memoize so the first
// caller (browser render gate / scan orchestrator) runs it exactly once.
let storageRemoteProbe: Promise<boolean> | undefined;
function runStorageRemoteProbe(): Promise<boolean> {
    if (storageRemoteProbe) return storageRemoteProbe;
    storageRemoteProbe = (async () => {
        try {
            const remote = await keyframes.isRemote();
            runInAction(() => isStorageRemote.set(remote));
            if (remote) console.log("[keyframes] backend is remote — keyframes preview disabled");
            return remote;
        } catch (err) {
            console.warn("[keyframes] isRemote probe failed:", err);
            // Conservative on failure: treat as remote, skip auto-load.
            runInAction(() => isStorageRemote.set(true));
            return true;
        }
    })();
    return storageRemoteProbe;
}

// Awaitable form of the remote probe, for code paths (like the scan
// orchestrators) that must know the answer before acting rather than
// reacting to the observable.
export function isStorageRemoteAsync(): Promise<boolean> {
    return runStorageRemoteProbe();
}

// Opt-in override: scan even when the backend is remote. Off by default
// — a network-served library is normally built elsewhere and this device
// is just a viewer. Surfaced both in Settings and beside the scan buttons.
const FORCE_SCAN_ON_REMOTE_KEY = "vidgrid.forceScanOnRemote";
function readForceScanOnRemote(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FORCE_SCAN_ON_REMOTE_KEY) === "1";
}
export const forceScanOnRemote = observable.box<boolean>(readForceScanOnRemote());
export function setForceScanOnRemote(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(FORCE_SCAN_ON_REMOTE_KEY, v ? "1" : "0");
    runInAction(() => forceScanOnRemote.set(v));
}

// True when a scan should be skipped: the backend is remote and the user
// hasn't opted into scanning remote libraries.
export async function scanBlockedByRemote(): Promise<boolean> {
    if (forceScanOnRemote.get()) return false;
    return await isStorageRemoteAsync();
}

// Sticky flag — true once any cell has been hovered. The global mouse
// tracker in SearchPage sets this so the toolbar's done-count read can
// kick in without paying for it at first paint.
export const keyframesHasBeenAccessed = observable.box<boolean>(false);
export function markKeyframesAccessed(): void {
    if (keyframesHasBeenAccessed.get()) return;
    runInAction(() => keyframesHasBeenAccessed.set(true));
}

// Master gate read by every render-time keyframes-collection touch.
export function keyframesCollectionAllowed(): boolean {
    if (keyframePreviewDisabled()) return false;
    // Wait for the remote probe before allowing any auto-load — the per-device
    // default depends on knowing whether the backend is remote. Kick the
    // (lazy) probe here so the browser resolves it without import-time DB access.
    if (isStorageRemote.get() === undefined) {
        void runStorageRemoteProbe();
        return false;
    }
    return true;
}

// Key helpers — zero-padded so the alphabetical order of keys matches the
// natural numeric order (important for prefix scans + getColumn ordering).
function pad(n: number, width: number): string {
    const s = String(n);
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
}
export function characterKey(fileKey: string, characterIdx: number): string {
    return `${fileKey}#${pad(characterIdx, 2)}`;
}

// The file key IS the relative path, verbatim. It used to be
// encodeURIComponent(relativePath); that escaping was never required by any
// storage/URL layer (BulkDatabase2 keys are CBOR; URLSearchParams escapes on
// its own), it only forced every writer to replicate it and made keys
// unreadable in logs.
export function pathKey(relativePath: string): string {
    return relativePath;
}

// ────────────────────────────────────────────────────────────────────────────
// Grid size — small / medium / large, persisted in localStorage.

const GRID_SIZE_KEY = "vidgrid.gridSize";
const DEFAULT_GRID_SIZE: GridSize = "medium";

function readGridSize(): GridSize {
    // Guarded — this module is evaluated under Node during the sliftutils
    // bundler's enumeration pass, where `localStorage` doesn't exist.
    if (typeof localStorage === "undefined") return DEFAULT_GRID_SIZE;
    const v = localStorage.getItem(GRID_SIZE_KEY);
    if (v === "small" || v === "medium" || v === "large" || v === "huge") return v;
    return DEFAULT_GRID_SIZE;
}

export const gridSize = observable.box<GridSize>(readGridSize());

// displayMode is now a URLParam (`viewMode` in router.ts) re-exported
// from the top of this file. setDisplayMode just writes through it so
// browser back/forward restores the user's previously visited view.
import { viewMode as _viewMode, seriesPath as _seriesPath } from "./router";
import { batchURLParamUpdate } from "sliftutils/render-utils/URLParam";
export function setDisplayMode(mode: DisplayMode): void {
    // Switching the top-level view backs out of any drilled-into series (the series contents only make
    // sense within the view you opened them from). Batched so it's a single history entry.
    batchURLParamUpdate([
        [_viewMode, mode],
        [_seriesPath, ""],
    ]);
}

// Keyboard nav state: when set, the grid cell with this key is rendered in
// the "hovered" / inspect state. Cleared on Escape or page switch.
export const keyboardHoveredKey = observable.box<string | undefined>(undefined);

// "Auto-flip" — when true, every grid cell cycles through its keyframe
// preview strip continuously (not just the hovered one). Persisted via
// setAutoFlipPreview below.
function readAutoFlipPreview(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("vidgrid.autoFlipPreview") === "1";
}
export const autoFlipPreview = observable.box<boolean>(readAutoFlipPreview());

// "Accurate thumbnails" — when true, a cell with a saved positionSec AND
// a keyframe strip uses the nearest keyframe at-or-before positionSec
// instead of the standard saved thumbnail. Off by default. Persisted
// via setAccurateThumbnails below.
function readAccurateThumbnails(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("vidgrid.accurateThumbnails") === "1";
}
export const accurateThumbnails = observable.box<boolean>(readAccurateThumbnails());

// Player volume in [0, 1], persisted globally so a level set in one video
// carries to every other video (and across reloads).
const PLAYER_VOLUME_KEY = "vidgrid.playerVolume";
function readPlayerVolume(): number {
    if (typeof localStorage === "undefined") return 1;
    const v = parseFloat(localStorage.getItem(PLAYER_VOLUME_KEY) ?? "");
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    return 1;
}
export const playerVolume = observable.box<number>(readPlayerVolume());
export function setPlayerVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    if (typeof localStorage !== "undefined") localStorage.setItem(PLAYER_VOLUME_KEY, String(clamped));
    runInAction(() => playerVolume.set(clamped));
}

// Dual-monitor fullscreen letterboxing. When the player is fullscreen across a
// span that covers two physical monitors, the user can confine all rendering to
// one monitor (the other shows pure black) and drag the divide to sit on the
// physical seam between the two screens — which need not be the pixel midpoint
// when the monitors differ in size. `monitorSide` picks which side gets the
// content; `monitorSplit` is the fraction of the viewport width at the seam.
// Both persist so the setup is remembered between sessions; they only take
// effect while actually fullscreen (see PlayerPage).
export type MonitorSide = "off" | "left" | "right";
const MONITOR_SIDE_KEY = "vidgrid.monitorSide";
const MONITOR_SPLIT_KEY = "vidgrid.monitorSplit";
function readMonitorSide(): MonitorSide {
    if (typeof localStorage === "undefined") return "off";
    const v = localStorage.getItem(MONITOR_SIDE_KEY);
    return v === "left" || v === "right" ? v : "off";
}
function readMonitorSplit(): number {
    if (typeof localStorage === "undefined") return 0.5;
    const v = parseFloat(localStorage.getItem(MONITOR_SPLIT_KEY) ?? "");
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.95) return v;
    return 0.5;
}
export const monitorSide = observable.box<MonitorSide>(readMonitorSide());
export const monitorSplit = observable.box<number>(readMonitorSplit());
export function setMonitorSide(s: MonitorSide): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(MONITOR_SIDE_KEY, s);
    runInAction(() => monitorSide.set(s));
}
export function setMonitorSplit(f: number): void {
    const clamped = Math.max(0.05, Math.min(0.95, f));
    if (typeof localStorage !== "undefined") localStorage.setItem(MONITOR_SPLIT_KEY, String(clamped));
    runInAction(() => monitorSplit.set(clamped));
}

// Master kill-switch for the background face-extraction phase. Face scan
// does GPU work (SCRFD + ArcFace) and on weaker machines that can hurt
// playback / paint perf, so we let the user disable it entirely. Live
// face *search* (paste image / click avatar) still works either way —
// it just consumes already-extracted data.
// Default player engine — used by PlayerPage when the per-video
// `engine` column is unset. Per-video preference still wins so a
// video the user explicitly switched stays on that engine.
const DEFAULT_PLAYER_ENGINE_KEY = "vidgrid.defaultPlayerEngine";
function readStoredDefaultPlayerEngine(): PlayerEngine | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const v = localStorage.getItem(DEFAULT_PLAYER_ENGINE_KEY);
    if (v === "native" || v === "tv-hack" || v === "web-demuxer" || v === "mediabunny") return v;
    return undefined;
}
const storedDefaultPlayerEngine = observable.box<PlayerEngine | undefined>(readStoredDefaultPlayerEngine());
// undefined until the lazy probe resolves. requestAdapter is async, so we
// can't know WebGPU support at module load — the probe sets this and the
// WebGPU-aware default below reacts to it.
export const webGpuSupported = observable.box<boolean | undefined>(undefined);
let webGpuProbe: Promise<boolean> | undefined;
export function runWebGpuProbe(): Promise<boolean> {
    if (!webGpuProbe) {
        webGpuProbe = (async () => {
            let ok = false;
            try {
                if (typeof navigator !== "undefined" && navigator.gpu) {
                    ok = !!(await navigator.gpu.requestAdapter());
                }
            } catch {
                ok = false;
            }
            runInAction(() => webGpuSupported.set(ok));
            return ok;
        })();
    }
    return webGpuProbe;
}
// WebGPU-aware default player engine. An explicit user choice always wins;
// otherwise derive from WebGPU support: no WebGPU → tv-hack (native <video>
// for picture, our own re-synced audio), the best bet when the mediabunny
// renderer would fall back to the slow 2D canvas. The probe is async, so the
// value starts at mediabunny and flips to tv-hack once the probe confirms
// WebGPU is absent — consumers reading this observable update reactively.
export const defaultPlayerEngine = computed<PlayerEngine>(() => {
    const stored = storedDefaultPlayerEngine.get();
    if (stored !== undefined) return stored;
    const supported = webGpuSupported.get();
    // Kick the lazy probe on first read. Async, so it won't mutate state
    // synchronously inside this computed.
    if (supported === undefined) {
        void runWebGpuProbe();
        return "mediabunny";
    }
    return supported && "mediabunny" || "tv-hack";
});
export function setDefaultPlayerEngine(v: PlayerEngine): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(DEFAULT_PLAYER_ENGINE_KEY, v);
    runInAction(() => storedDefaultPlayerEngine.set(v));
}

// Auto face-thumbnail: which clustered character's representative face is
// promoted to the file thumbnail after face extraction. "second" (the
// default) tends to frame better than the protagonist; "first" uses the
// most-common character; "off" disables it (existing thumbnail kept).
// "auto" is folder-aware: a folder with SERIES_FOLDER_THRESHOLD+ videos is
// treated as a series (the recurring protagonist is uninteresting, so use the
// 2nd character); a smaller folder is a standalone where the main character
// (1st) is the interesting one. "first"/"second" force a character; "off"
// disables auto face thumbnails entirely.
export type FaceThumbnailMode = "off" | "first" | "second" | "auto";
const FACE_THUMBNAIL_MODE_KEY = "vidgrid.faceThumbnailMode";
function readFaceThumbnailMode(): FaceThumbnailMode {
    if (typeof localStorage === "undefined") return "auto";
    const v = localStorage.getItem(FACE_THUMBNAIL_MODE_KEY);
    if (v === "off" || v === "first" || v === "second" || v === "auto") return v;
    return "auto";
}
export const faceThumbnailMode = observable.box<FaceThumbnailMode>(readFaceThumbnailMode());
export function setFaceThumbnailMode(v: FaceThumbnailMode): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(FACE_THUMBNAIL_MODE_KEY, v);
    runInAction(() => faceThumbnailMode.set(v));
}

// A folder with this many videos (or more) is a series; fewer is a standalone.
export const SERIES_FOLDER_THRESHOLD = 5;

function folderOf(relativePath: string): string {
    const i = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
    return i < 0 ? "" : relativePath.slice(0, i);
}

// Number of videos in the same folder as `key` (inclusive). Used by the
// "auto" face-thumbnail mode to tell a series from a standalone video.
export async function countFolderVideos(key: string): Promise<number> {
    const relativePath = await files.getSingleField(key, "relativePath");
    if (typeof relativePath !== "string") return 1;
    const folder = folderOf(relativePath);
    let count = 0;
    for (const { value } of await files.getColumn("relativePath")) {
        if (typeof value === "string" && folderOf(value) === folder) count++;
    }
    return count;
}

const FACES_SCAN_ENABLED_KEY = "vidgrid.facesScanEnabled";
function readFacesScanEnabled(): boolean {
    if (typeof localStorage === "undefined") return false;
    const v = localStorage.getItem(FACES_SCAN_ENABLED_KEY);
    // Default off — opt-in. Face scanning is GPU-heavy and the model
    // downloads are large; new users shouldn't pay that cost until they
    // explicitly turn it on.
    return v === "1";
}
export const facesScanEnabled = observable.box<boolean>(readFacesScanEnabled());
export function setFacesScanEnabled(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(FACES_SCAN_ENABLED_KEY, v ? "1" : "0");
    runInAction(() => facesScanEnabled.set(v));
}

const KEYFRAMES_SCAN_ENABLED_KEY = "vidgrid.keyframesScanEnabled";
function readKeyframesScanEnabled(): boolean {
    if (typeof localStorage === "undefined") return false;
    // Default off — opt-in. Keyframe extraction decodes frames across every
    // video, which is slow on large libraries; users turn it on when they want
    // hover previews / accurate thumbnails (and it's a prerequisite for face
    // scanning, which streams the extracted keyframes).
    return localStorage.getItem(KEYFRAMES_SCAN_ENABLED_KEY) === "1";
}
export const keyframesScanEnabled = observable.box<boolean>(readKeyframesScanEnabled());
export function setKeyframesScanEnabled(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEYFRAMES_SCAN_ENABLED_KEY, v ? "1" : "0");
    runInAction(() => keyframesScanEnabled.set(v));
}

// Experimental: run the face models in float16. Half-precision weights can be
// faster on some GPUs (and are neutral on others); detection/embedding quality
// is essentially unchanged. Off by default — turn it on to see if your GPU
// benefits. Loads separate ~half-size fp16 model files on first use.
const FACES_FP16_KEY = "vidgrid.facesFp16";
function readFacesFp16(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FACES_FP16_KEY) === "1";
}
export const facesFp16 = observable.box<boolean>(readFacesFp16());
export function setFacesFp16(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(FACES_FP16_KEY, v ? "1" : "0");
    runInAction(() => facesFp16.set(v));
}

// Prefer CPU (software) video decoding in the mediabunny engine. Useful when
// the GPU is busy or wedged by another app — hardware decode then stutters
// while a modern CPU can decode 1080p+ in real time. Read when the decode
// pipeline is (re)built, so toggling requires a playback restart to apply.
const SOFTWARE_DECODE_KEY = "vidgrid.softwareDecode";
function readSoftwareDecode(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SOFTWARE_DECODE_KEY) === "1";
}
export const softwareDecode = observable.box<boolean>(readSoftwareDecode());
export function setSoftwareDecode(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SOFTWARE_DECODE_KEY, v ? "1" : "0");
    runInAction(() => softwareDecode.set(v));
}

// "Disable hover-expand" — inverted master switch for the cell expansion
// that fires when the mouse hovers a grid cell. Off by default (so cells
// expand on hover). When disabled, cells stay at their slot size and gain a
// "?" button in the corner that expands the cell on click — the same view
// hover would show. Stored tri-state (undefined = never chosen) so the
// per-device default reads indeterminate in Settings. Pointer-less devices
// (e.g. a TV remote) can't hover, so they default to disabled.
const DISABLE_HOVER_EXPAND_KEY = "vidgrid.disableHoverExpand";
function readDisableHoverExpand(): string | undefined {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(DISABLE_HOVER_EXPAND_KEY) || undefined;
}
export const disableHoverExpandRaw = observable.box<string | undefined>(readDisableHoverExpand());
export function disableHoverExpandDefault(): boolean {
    return isMissingPointerInput();
}
export function disableHoverExpandExplicit(): boolean {
    return !!disableHoverExpandRaw.get();
}
export function hoverExpandDisabled(): boolean {
    const raw = disableHoverExpandRaw.get();
    if (!raw) return disableHoverExpandDefault();
    return raw === "1";
}
export function hoverExpandEnabled(): boolean {
    return !hoverExpandDisabled();
}
export function setDisableHoverExpand(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISABLE_HOVER_EXPAND_KEY, v ? "1" : "0");
    runInAction(() => disableHoverExpandRaw.set(v ? "1" : "0"));
}

// "Fast-open series" — when on, clicking a series tile jumps straight
// into the player on the last-played video (or the first, if none
// played), instead of drilling into the series view. Off by default
// so the existing behaviour is preserved for everyone who relies on it.
const FAST_OPEN_SERIES_KEY = "vidgrid.fastOpenSeries";
function readFastOpenSeries(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FAST_OPEN_SERIES_KEY) === "1";
}
export const fastOpenSeries = observable.box<boolean>(readFastOpenSeries());
export function setFastOpenSeries(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(FAST_OPEN_SERIES_KEY, v ? "1" : "0");
    runInAction(() => fastOpenSeries.set(v));
}

// "Disable theme backgrounds" — when on, a theme's wallpaper scene image is
// dropped and the page falls back to the theme's bare gradient (some scene
// images can be busy/obnoxious). Toggles the `no-bg` class on the App root.
const DISABLE_THEME_BG_KEY = "vidgrid.disableThemeBackgrounds";
function readDisableThemeBackgrounds(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(DISABLE_THEME_BG_KEY) === "1";
}
export const disableThemeBackgrounds = observable.box<boolean>(readDisableThemeBackgrounds());
export function setDisableThemeBackgrounds(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISABLE_THEME_BG_KEY, v ? "1" : "0");
    runInAction(() => disableThemeBackgrounds.set(v));
}

// Same persistence pattern for the two toggles that used to live as
// chips in the toolbar — accurate thumbnails + auto-flip previews —
// so the settings modal can read/write them via localStorage like the
// rest of the settings. The observables themselves are already declared
// above (autoFlipPreview, accurateThumbnails); these wrap setters
// that mirror to localStorage.
const ACCURATE_THUMBNAILS_KEY = "vidgrid.accurateThumbnails";
const AUTO_FLIP_PREVIEW_KEY = "vidgrid.autoFlipPreview";
export function setAccurateThumbnails(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(ACCURATE_THUMBNAILS_KEY, v ? "1" : "0");
    runInAction(() => accurateThumbnails.set(v));
}
export function setAutoFlipPreview(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(AUTO_FLIP_PREVIEW_KEY, v ? "1" : "0");
    runInAction(() => autoFlipPreview.set(v));
}

export function setGridSize(size: GridSize): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(GRID_SIZE_KEY, size);
    runInAction(() => gridSize.set(size));
}

// Detailed grid view — every cell renders in its expanded (hover) form
// laid out statically in the grid at 2× the slot width, instead of the
// compact tile that pops open only on hover. Persisted in localStorage.
const DETAILED_GRID_VIEW_KEY = "vidgrid.detailedGridView";
function readDetailedGridView(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(DETAILED_GRID_VIEW_KEY) === "1";
}
export const detailedGridView = observable.box<boolean>(readDetailedGridView());
export function setDetailedGridView(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(DETAILED_GRID_VIEW_KEY, v ? "1" : "0");
    runInAction(() => detailedGridView.set(v));
}

// Subtitles — whether the player shows subtitles by default, and which
// language code to prefer (e.g. "eng") when a video has several sidecar
// tracks (`Foo.eng.srt`, `Foo.spa.srt`, …). Both persisted in localStorage.
const SUBTITLES_ON_KEY = "vidgrid.subtitlesOnByDefault";
const SUBTITLE_LANG_KEY = "vidgrid.subtitleLanguage";
function readSubtitlesOnByDefault(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SUBTITLES_ON_KEY) === "1";
}
function readSubtitleLanguage(): string {
    if (typeof localStorage === "undefined") return "eng";
    return localStorage.getItem(SUBTITLE_LANG_KEY) ?? "eng";
}
export const subtitlesOnByDefault = observable.box<boolean>(readSubtitlesOnByDefault());
export const subtitleLanguage = observable.box<string>(readSubtitleLanguage());
export function setSubtitlesOnByDefault(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SUBTITLES_ON_KEY, v ? "1" : "0");
    runInAction(() => subtitlesOnByDefault.set(v));
}
export function setSubtitleLanguage(v: string): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SUBTITLE_LANG_KEY, v);
    runInAction(() => subtitleLanguage.set(v));
}

// Result sort order — "date" (file mtime newest first), "name" (filename A→Z),
// "duration", or "watched". `sortReversed` flips whichever order is active.
// Both persisted in localStorage.
const SORT_ORDER_KEY = "vidgrid.sortOrder";
const SORT_REVERSED_KEY = "vidgrid.sortReversed";
function readSortOrder(): SortOrder {
    if (typeof localStorage === "undefined") return "date";
    const v = localStorage.getItem(SORT_ORDER_KEY);
    if (v === "date" || v === "name" || v === "duration" || v === "watched" || v === "shuffle") return v;
    return "date";
}
function readSortReversed(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SORT_REVERSED_KEY) === "1";
}
export const sortOrder = observable.box<SortOrder>(readSortOrder());
export const sortReversed = observable.box<boolean>(readSortReversed());
export function setSortOrder(v: SortOrder): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SORT_ORDER_KEY, v);
    runInAction(() => sortOrder.set(v));
}
export function setSortReversed(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SORT_REVERSED_KEY, v ? "1" : "0");
    runInAction(() => sortReversed.set(v));
}

// Shuffle seed for "shuffle" sort: items order by hash(key + seed), so a given
// seed gives a stable-but-arbitrary order. Defaults to today's date (YYYY-MM-DD)
// so a fresh shuffle reshuffles daily; the user can set it to any string.
const SHUFFLE_SEED_KEY = "vidgrid.shuffleSeed";
function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
}
function readShuffleSeed(): string {
    if (typeof localStorage === "undefined") return todayStamp();
    const v = localStorage.getItem(SHUFFLE_SEED_KEY);
    return v === null ? todayStamp() : v;
}
export const shuffleSeed = observable.box<string>(readShuffleSeed());
export function setShuffleSeed(v: string): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHUFFLE_SEED_KEY, v);
    runInAction(() => shuffleSeed.set(v));
}

// Duration filter (minutes). Either bound is optional; undefined means "no
// limit on that end". Both persisted; an empty/invalid stored value reads as
// undefined so the bound is inactive.
const DURATION_MIN_KEY = "vidgrid.durationMinMinutes";
const DURATION_MAX_KEY = "vidgrid.durationMaxMinutes";
function readDurationBound(key: string): number | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
}
export const durationMinMinutes = observable.box<number | undefined>(readDurationBound(DURATION_MIN_KEY));
export const durationMaxMinutes = observable.box<number | undefined>(readDurationBound(DURATION_MAX_KEY));
function writeDurationBound(key: string, v: number | undefined): void {
    if (typeof localStorage === "undefined") return;
    if (v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(v));
}
export function setDurationMinMinutes(v: number | undefined): void {
    writeDurationBound(DURATION_MIN_KEY, v);
    runInAction(() => durationMinMinutes.set(v));
}
export function setDurationMaxMinutes(v: number | undefined): void {
    writeDurationBound(DURATION_MAX_KEY, v);
    runInAction(() => durationMaxMinutes.set(v));
}

// Attribute filters — each, when on, restricts the grid to files that HAVE
// the named attribute: a non-empty extractionError ("Errors"), an extracted
// keyframe strip ("Keyframes"), or at least one detected face ("Faces").
// They combine (AND). `filterInvert` flips every active filter's sense, so
// the same toggles also express "no errors / no keyframes / no faces".
// All persisted.
function readFilterFlag(key: string): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(key) === "1";
}
function writeFilterFlag(key: string, v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, v ? "1" : "0");
}

const FILTER_ERRORS_KEY = "vidgrid.errorOnly";
export const filterErrors = observable.box<boolean>(readFilterFlag(FILTER_ERRORS_KEY));
export function setFilterErrors(v: boolean): void {
    writeFilterFlag(FILTER_ERRORS_KEY, v);
    runInAction(() => filterErrors.set(v));
}

// NOTE: reading the keyframes column forces the keyframes stream-file load,
// so turning this on counts as an explicit opt-in (see
// keyframesCollectionAllowed / keyframesHasBeenAccessed).
const FILTER_KEYFRAMES_KEY = "vidgrid.hasKeyframesOnly";
export const filterKeyframes = observable.box<boolean>(readFilterFlag(FILTER_KEYFRAMES_KEY));
export function setFilterKeyframes(v: boolean): void {
    writeFilterFlag(FILTER_KEYFRAMES_KEY, v);
    if (v) markKeyframesAccessed();
    runInAction(() => filterKeyframes.set(v));
}

const FILTER_FACES_KEY = "vidgrid.hasFacesOnly";
export const filterFaces = observable.box<boolean>(readFilterFlag(FILTER_FACES_KEY));
export function setFilterFaces(v: boolean): void {
    writeFilterFlag(FILTER_FACES_KEY, v);
    runInAction(() => filterFaces.set(v));
}

// Inverts the sense of every active attribute filter above (errors →
// no-errors, keyframes → no-keyframes, faces → no-faces). Persisted.
const FILTER_INVERT_KEY = "vidgrid.filterInvert";
export const filterInvert = observable.box<boolean>(readFilterFlag(FILTER_INVERT_KEY));
export function setFilterInvert(v: boolean): void {
    writeFilterFlag(FILTER_INVERT_KEY, v);
    runInAction(() => filterInvert.set(v));
}

// Show small media-presence icons in the grid cell corners: one when the
// file has extracted keyframes, one when it has detected faces. Off by
// default. Persisted. Like the keyframes filter, turning this on opts the
// session into loading the keyframes column for presence checks.
const SHOW_MEDIA_ICONS_KEY = "vidgrid.showMediaIcons";
function readShowMediaIcons(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SHOW_MEDIA_ICONS_KEY) === "1";
}
export const showMediaIcons = observable.box<boolean>(readShowMediaIcons());
export function setShowMediaIcons(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHOW_MEDIA_ICONS_KEY, v ? "1" : "0");
    if (v) markKeyframesAccessed();
    runInAction(() => showMediaIcons.set(v));
}

// Show each video's duration before its name in the grid cell title. Off by
// default. Persisted. Reads the already-loaded durationSec column, so no extra
// data load.
const SHOW_DURATION_IN_TITLE_KEY = "vidgrid.showDurationInTitle";
function readShowDurationInTitle(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SHOW_DURATION_IN_TITLE_KEY) === "1";
}
export const showDurationInTitle = observable.box<boolean>(readShowDurationInTitle());
export function setShowDurationInTitle(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHOW_DURATION_IN_TITLE_KEY, v ? "1" : "0");
    runInAction(() => showDurationInTitle.set(v));
}

// On reload, a persisted keyframes filter / icon setting should re-open the
// keyframes access gate (mirrors a fresh toggle) so presence reads work
// without first hovering a cell. Observable-only — no DB/disk touch.
if (filterKeyframes.get() || showMediaIcons.get()) markKeyframesAccessed();

// Global animation duration (ms). The single source of truth every CSS
// transition in the app reads via `globalTransition()` so the user can
// scrub it from Settings — handy for debugging where elements are
// supposed to end up versus where they actually go mid-flight.
const ANIMATION_MS_KEY = "vidgrid.animationMs";
const ANIMATION_MS_DEFAULT = 250;
function readAnimationMs(): number {
    if (typeof localStorage === "undefined") return ANIMATION_MS_DEFAULT;
    const raw = localStorage.getItem(ANIMATION_MS_KEY);
    if (raw === null) return ANIMATION_MS_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return ANIMATION_MS_DEFAULT;
    return Math.round(n);
}
export const animationMs = observable.box<number>(readAnimationMs());
export function setAnimationMs(v: number): void {
    const clamped = Math.max(0, Math.min(100000, Math.round(v)));
    if (typeof localStorage !== "undefined") localStorage.setItem(ANIMATION_MS_KEY, String(clamped));
    runInAction(() => animationMs.set(clamped));
}

// Hover grace: how long an expanded grid cell stays expanded after the
// mouse moves off it (and during which no other cell expands). The
// document-level mouse tracker in SearchPage reads this. Configurable
// 0–3000ms in 50ms steps.
const HOVER_GRACE_MS_KEY = "vidgrid.hoverGraceMs";
const HOVER_GRACE_MS_DEFAULT = 350;
function readHoverGraceMs(): number {
    if (typeof localStorage === "undefined") return HOVER_GRACE_MS_DEFAULT;
    const raw = localStorage.getItem(HOVER_GRACE_MS_KEY);
    if (raw === null) return HOVER_GRACE_MS_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return HOVER_GRACE_MS_DEFAULT;
    return Math.round(n);
}
export const hoverGraceMs = observable.box<number>(readHoverGraceMs());
export function setHoverGraceMs(v: number): void {
    const clamped = Math.max(0, Math.min(100000, Math.round(v)));
    if (typeof localStorage !== "undefined") localStorage.setItem(HOVER_GRACE_MS_KEY, String(clamped));
    runInAction(() => hoverGraceMs.set(clamped));
}

// Preview cycle speed: delay between keyframe-preview frames when a cell is
// cycling (hovered or auto-flip). The cell's interval timer reads this.
// Configurable 50–3000ms.
const PREVIEW_CYCLE_MS_KEY = "vidgrid.previewCycleMs";
const PREVIEW_CYCLE_MS_DEFAULT = 250;
function readPreviewCycleMs(): number {
    if (typeof localStorage === "undefined") return PREVIEW_CYCLE_MS_DEFAULT;
    const raw = localStorage.getItem(PREVIEW_CYCLE_MS_KEY);
    if (raw === null) return PREVIEW_CYCLE_MS_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return PREVIEW_CYCLE_MS_DEFAULT;
    return Math.round(n);
}
export const previewCycleMs = observable.box<number>(readPreviewCycleMs());
export function setPreviewCycleMs(v: number): void {
    const clamped = Math.max(1, Math.min(100000, Math.round(v)));
    if (typeof localStorage !== "undefined") localStorage.setItem(PREVIEW_CYCLE_MS_KEY, String(clamped));
    runInAction(() => previewCycleMs.set(clamped));
}

// HDR tone-map exposure: scales the browser's (over-bright) HDR output into the
// ACES rolloff in WebGpuRenderer's approximate tone map. Lower = darker, higher
// = brighter. Range 0–1; the renderer reads this at render time.
const HDR_EXPOSURE_KEY = "vidgrid.hdrExposure";
const HDR_EXPOSURE_DEFAULT = 0.5;
function readHdrExposure(): number {
    if (typeof localStorage === "undefined") return HDR_EXPOSURE_DEFAULT;
    const raw = localStorage.getItem(HDR_EXPOSURE_KEY);
    if (raw === null) return HDR_EXPOSURE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return HDR_EXPOSURE_DEFAULT;
    return Math.max(0, Math.min(1, n));
}
export const hdrExposure = observable.box<number>(readHdrExposure());
export function setHdrExposure(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    if (typeof localStorage !== "undefined") localStorage.setItem(HDR_EXPOSURE_KEY, String(clamped));
    runInAction(() => hdrExposure.set(clamped));
}

// Result page size: how many grid results to show before infinite scroll
// (and how many more each scroll / "Show more" press reveals). SearchPage
// reads this for its display window.
const RESULT_PAGE_SIZE_KEY = "vidgrid.resultPageSize";
const RESULT_PAGE_SIZE_DEFAULT = 50;
function readResultPageSize(): number {
    if (typeof localStorage === "undefined") return RESULT_PAGE_SIZE_DEFAULT;
    const raw = localStorage.getItem(RESULT_PAGE_SIZE_KEY);
    if (raw === null) return RESULT_PAGE_SIZE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return RESULT_PAGE_SIZE_DEFAULT;
    return Math.round(n);
}
export const resultPageSize = observable.box<number>(readResultPageSize());
export function setResultPageSize(v: number): void {
    const clamped = Math.max(1, Math.min(100000, Math.round(v)));
    if (typeof localStorage !== "undefined") localStorage.setItem(RESULT_PAGE_SIZE_KEY, String(clamped));
    runInAction(() => resultPageSize.set(clamped));
}

// Minimum number of videos a folder must directly contain to be treated as a
// series (grouped into one tile). Configurable so users can tune how
// aggressively the grid collapses folders. Read at every getSeries() call site.
const SERIES_MIN_VIDEOS_KEY = "vidgrid.seriesMinVideos";
export const SERIES_MIN_VIDEOS_DEFAULT = 5;
function readSeriesMinVideos(): number {
    if (typeof localStorage === "undefined") return SERIES_MIN_VIDEOS_DEFAULT;
    const raw = localStorage.getItem(SERIES_MIN_VIDEOS_KEY);
    if (raw === null) return SERIES_MIN_VIDEOS_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 2) return SERIES_MIN_VIDEOS_DEFAULT;
    return Math.round(n);
}
export const seriesMinVideos = observable.box<number>(readSeriesMinVideos());
export function setSeriesMinVideos(v: number): void {
    const clamped = Math.max(2, Math.min(100, Math.round(v)));
    if (typeof localStorage !== "undefined") localStorage.setItem(SERIES_MIN_VIDEOS_KEY, String(clamped));
    runInAction(() => seriesMinVideos.set(clamped));
}

// Sidebar width on the grid page. Stored as a user-editable formula evaluated
// against the viewport width `vw` (px), so the sidebar can grow with the screen
// while never dropping below a usable minimum. Helpers min/max/clamp/round are
// exposed to the expression. The default is "a fifth of the screen, clamped to
// [220, 380]px".
const SIDEBAR_WIDTH_FORMULA_KEY = "vidgrid.sidebarWidthFormula";
export const DEFAULT_SIDEBAR_WIDTH_FORMULA = "clamp(220, vw * 0.2, 380)";
function readSidebarWidthFormula(): string {
    if (typeof localStorage === "undefined") return DEFAULT_SIDEBAR_WIDTH_FORMULA;
    return localStorage.getItem(SIDEBAR_WIDTH_FORMULA_KEY) || DEFAULT_SIDEBAR_WIDTH_FORMULA;
}
export const sidebarWidthFormula = observable.box<string>(readSidebarWidthFormula());
export function setSidebarWidthFormula(v: string): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(SIDEBAR_WIDTH_FORMULA_KEY, v);
    runInAction(() => sidebarWidthFormula.set(v));
}
export function resetSidebarWidthFormula(): void {
    setSidebarWidthFormula(DEFAULT_SIDEBAR_WIDTH_FORMULA);
}

// heygoogle ("Hey Google" voice control) opt-in. When on, the app connects to
// the heygoogle broker on load to fetch status and accept device-calls. Set
// automatically when the user arrives via the Google Home OAuth setup, or
// manually from the management page.
const HEYGOOGLE_ENABLED_KEY = "vidgrid.heygoogleEnabled";
function readHeygoogleEnabled(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(HEYGOOGLE_ENABLED_KEY) === "1";
}
export const heygoogleEnabled = observable.box<boolean>(readHeygoogleEnabled());
export function setHeygoogleEnabled(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(HEYGOOGLE_ENABLED_KEY, v ? "1" : "0");
    runInAction(() => heygoogleEnabled.set(v));
}
// Evaluate the current formula for a given viewport width. Falls back to the
// minimum (220) when the expression is empty, throws, or yields a non-positive
// number — so a half-typed formula in Settings never collapses the sidebar.
export function evalSidebarWidth(vw: number): number {
    const formula = sidebarWidthFormula.get();
    const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi));
    try {
        const fn = new Function("vw", "min", "max", "clamp", "round",
            `"use strict"; return (${formula});`);
        const result = fn(vw, Math.min, Math.max, clamp, Math.round);
        if (typeof result === "number" && Number.isFinite(result) && result > 0) {
            return Math.round(result);
        }
    } catch {
        // fall through to the minimum
    }
    return 220;
}

// Properties every animated panel in the grid transitions on. `bottom`
// is in here so panels anchored from the bottom (e.g. the cell title
// strip) don't snap when their distance-from-bottom changes between
// states — otherwise the strip flies through the image area before
// the card height catches up.
const GLOBAL_TRANSITION_PROPS = [
    "top", "left", "right", "bottom",
    "width", "height", "opacity",
];
export function globalTransition(): string {
    const ms = animationMs.get();
    return GLOBAL_TRANSITION_PROPS.map(p => `${p} ${ms}ms ease-out`).join(", ");
}

// ────────────────────────────────────────────────────────────────────────────
// Session-scoped state — the parts of UI state that don't belong in the DB.

export interface MetadataScanProgress {
    done: number;
    total: number;
    currentKey?: string;
    // True when currentKey is a file that has previously timed out (so it's
    // being processed last, and the UI can flag it). See timedOutKeys.
    currentFilePreviouslyTimedOut?: boolean;
    // Short human-readable ETA + rate for the *whole phase*, mirrored
    // here from the scan loop's ETA helper so the UI can display it
    // alongside the done/total. e.g. "ETA 14m21s (4.6× realtime)" for
    // media-time phases or "ETA 8m04s (0.39 files/s)" for the metadata
    // phase. Undefined until the first heartbeat / first completion.
    etaText?: string;
}

export interface SharedState {
    rootName: string | undefined;
    scanning: boolean;
    scanProgress: TraversalProgress | undefined;
    // Part B of the file-scan phase: per-file getFile() for size +
    // fileModifiedAt. Cheap OS-level metadata, no media demux. Set during
    // that pass, undefined before/after.
    fileInfoProgress: MetadataScanProgress | undefined;
    scanError: string | undefined;
    metadataScanning: boolean;
    metadataScanProgress: MetadataScanProgress | undefined;
    keyframesScanning: boolean;
    keyframesScanProgress: MetadataScanProgress | undefined;
    facesScanning: boolean;
    facesScanProgress: MetadataScanProgress | undefined;
    otherTabScanning: boolean;
    folderError: string | undefined;
}

export const state: SharedState = observable({
    rootName: undefined,
    scanning: false,
    scanProgress: undefined,
    fileInfoProgress: undefined,
    scanError: undefined,
    metadataScanning: false,
    metadataScanProgress: undefined,
    keyframesScanning: false,
    keyframesScanProgress: undefined,
    facesScanning: false,
    facesScanProgress: undefined,
    otherTabScanning: false,
    folderError: undefined,
});

// Per-file metadata-extraction in-flight tracker. Observable so UI shows the
// "Generating…" state per cell.
const extractingKeys = observable(new Map<string, true>());

export function isExtracting(key: string): boolean {
    return extractingKeys.has(key);
}


// ────────────────────────────────────────────────────────────────────────────
// Prioritization for the metadata scan.
//
// Two signals, in priority order:
//   1. `visibleNow`  — the keys currently rendered in the grid, ordered top→
//      bottom. Highest priority — the user is looking at these right this
//      second.
//   2. `recentSeen`  — a recency-ordered history of keys that have been
//      rendered. Falls in priority below visibleNow but ahead of "anything
//      else". Lets us re-pick recent-viewing work when the viewport changes.
// Anything not in either falls through to whatever ordering the eligibility
// set iterates in (alphabetical-ish).

let visibleNow: readonly string[] = [];
// The whole current filter/result set (flattened to member video keys), even
// the part scrolled past the display limit. Sits below visibleNow/recentSeen
// but above unrelated files, so the user's active view finishes generating
// before the rest of the library.
let filteredNow: readonly string[] = [];
const recentSeen: string[] = [];
const recentSet = new Set<string>();
const MAX_RECENT = 1000;

export function noteFilteredKeys(keys: readonly string[]): void {
    filteredNow = keys;
}

export function noteVisibleKeys(keys: readonly string[]): void {
    visibleNow = keys;
    for (const k of keys) {
        if (recentSet.has(k)) {
            const idx = recentSeen.indexOf(k);
            if (idx >= 0) recentSeen.splice(idx, 1);
        } else {
            recentSet.add(k);
        }
        recentSeen.unshift(k);
    }
    while (recentSeen.length > MAX_RECENT) {
        const removed = recentSeen.pop();
        if (removed !== undefined) recentSet.delete(removed);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Previously-timed-out files. Any file whose extraction (metadata / keyframes
// / faces) was abandoned because it hit the worker's timeout is recorded here
// persistently. These are pushed to the very END of every scan phase (see
// pickPriorityKey), in any mode — forced or not — so one pathological file
// can't stall the queue ahead of the rest of the library. A later success on
// the same file clears the flag.
const TIMED_OUT_STORAGE_KEY = "vidgrid.timedOutKeys";
let timedOutKeysCache: Set<string> | undefined;
function timedOutKeys(): Set<string> {
    if (timedOutKeysCache) return timedOutKeysCache;
    const set = new Set<string>();
    if (typeof localStorage !== "undefined") {
        try {
            const raw = localStorage.getItem(TIMED_OUT_STORAGE_KEY);
            if (raw) for (const k of JSON.parse(raw) as string[]) set.add(k);
        } catch { /* corrupt / unavailable → start empty */ }
    }
    timedOutKeysCache = set;
    return set;
}
function persistTimedOutKeys(): void {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(TIMED_OUT_STORAGE_KEY, JSON.stringify([...timedOutKeys()])); }
    catch { /* quota / unavailable → skip */ }
}
export function hasTimedOut(key: string): boolean {
    return timedOutKeys().has(key);
}
// The worker reports timeouts as "Extraction timed out after Xs" or
// "Inactivity timeout" — match either.
export function isTimeoutError(msg: string): boolean {
    return /timed out|inactivity timeout/i.test(msg);
}
export function markTimedOut(key: string): void {
    const set = timedOutKeys();
    if (set.has(key)) return;
    set.add(key);
    persistTimedOutKeys();
}
export function clearTimedOut(key: string): void {
    if (!timedOutKeys().delete(key)) return;
    persistTimedOutKeys();
}

function pickPriorityKey(eligible: Set<string>): string | undefined {
    const timedOut = timedOutKeys();
    // First pass: prefer files that have NOT previously timed out, in the
    // usual view-priority order.
    for (const k of visibleNow) if (eligible.has(k) && !timedOut.has(k)) return k;
    for (const k of recentSeen) if (eligible.has(k) && !timedOut.has(k)) return k;
    for (const k of filteredNow) if (eligible.has(k) && !timedOut.has(k)) return k;
    for (const k of eligible) if (!timedOut.has(k)) return k;
    // Only previously-timed-out files remain — do them last, still honoring
    // view priority amongst themselves.
    for (const k of visibleNow) if (eligible.has(k)) return k;
    for (const k of recentSeen) if (eligible.has(k)) return k;
    for (const k of filteredNow) if (eligible.has(k)) return k;
    for (const k of eligible) return k;
    return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-file metadata extraction (one-shot, called by user button OR the
// background scan loop).

export async function extractMetadataForKey(key: string): Promise<boolean> {
    if (extractingKeys.has(key)) return false;
    const handle = await ensureFolder();
    if (!handle) return false;
    const file = await openFileByKey(key);
    if (!file) return false;

    runInAction(() => { extractingKeys.set(key, true); });
    try {
        const info = await metadataExtractorClient.extract(file, `[extract ${file.name}]`);
        await files.update({
            key,
            // Size is captured here, not in the file walk — we already have
            // the File object open for Mediabunny, so reading file.size is
            // free, and the walk gets to stay handle-only.
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
        // Thumbnails go into their own collection — same key as the
        // file record. write() (not update()) so a brand-new file's
        // first extraction lands a row to update later.
        await thumbnails.write({
            key,
            thumb160: info.thumb160,
            thumb320: info.thumb320,
            thumb640: info.thumb640,
            thumbW: info.thumbW,
            thumbH: info.thumbH,
            thumbSource: "auto",
        });
        clearTimedOut(key);
        return true;
    } catch (err) {
        // Scan abort (tab hidden) terminated the worker mid-extract — this isn't
        // a real failure. Skip recording it so the file stays eligible and gets
        // retried when the scan resumes.
        if (scanCancelled) return false;
        const msg = (err as Error).message ?? String(err);
        if (isTimeoutError(msg)) markTimedOut(key);
        console.warn(`[extract] failed for ${key}:`, err);
        try {
            // Mark this file as "done at the current extractor version" even
            // on failure — otherwise the eligibility check (v !== METADATA_VERSION)
            // re-queues it on every subsequent non-force scan and we re-hit
            // the same timeout on every pathological file. The error message
            // is still recorded in extractionError, and per-cell Regenerate
            // is the explicit path back in if the user wants to retry.
            await files.update({
                key,
                metadataExtractedAt: Date.now(),
                metadataVersion: METADATA_VERSION,
                extractionError: msg,
            });
        } catch (writeErr) {
            console.warn(`[extract] could not record error:`, writeErr);
        }
        return false;
    } finally {
        runInAction(() => { extractingKeys.delete(key); });
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Folder loading.
//
// `ensureFolder()` is the single lazy, memoised accessor for the root directory
// handle. The handle is never mirrored into observable shared state — anything
// that needs it (all async contexts: scans, per-file opens, subtitle loading)
// awaits this. The first call shows the picker (or silently restores a granted
// folder); every later call returns the same resolved handle. `state.rootName`
// is the reactive "a folder is loaded" signal for render code.

let folderInitPromise: Promise<FileSystemDirectoryHandle | undefined> | undefined;

export function ensureFolder(): Promise<FileSystemDirectoryHandle | undefined> {
    if (folderInitPromise) return folderInitPromise;
    folderInitPromise = (async () => {
        try {
            const wrapper = await getDirectoryHandle();
            const handle = wrapper as unknown as FileSystemDirectoryHandle;
            runInAction(() => { state.rootName = handle.name; });
            return handle;
        } catch (err) {
            runInAction(() => { state.folderError = `Folder load failed: ${(err as Error).message}`; });
            folderInitPromise = undefined;
            return undefined;
        }
    })();
    return folderInitPromise;
}

let lockPollTimer: number | undefined;
let scanInitialTimer: number | undefined;
let scanRecheckTimer: number | undefined;
// Don't scan the instant a tab appears — a tab the user flicks to for a few
// seconds shouldn't kick off disk-heavy work. Only after it's been continuously
// visible this long do we do the first scan check, then re-check on this cadence
// for as long as it stays visible. Going hidden cancels both timers (and aborts
// any in-flight scan), so the next visible stretch restarts the 5-minute clock.
const SCAN_INITIAL_VISIBLE_DELAY_MS = 5 * 60 * 1000;
const SCAN_RECHECK_MS = 30 * 60 * 1000;

function startScanSchedule() {
    if (scanInitialTimer !== undefined || scanRecheckTimer !== undefined) return;
    scanInitialTimer = window.setTimeout(() => {
        scanInitialTimer = undefined;
        // maybeScan is idempotent and self-guards (hidden tab, cross-tab lock,
        // 24h freshness), so it no-ops unless this tab should actually scan.
        void maybeScan();
        scanRecheckTimer = window.setInterval(() => void maybeScan(), SCAN_RECHECK_MS);
    }, SCAN_INITIAL_VISIBLE_DELAY_MS);
}

function stopScanSchedule() {
    if (scanInitialTimer !== undefined) {
        window.clearTimeout(scanInitialTimer);
        scanInitialTimer = undefined;
    }
    if (scanRecheckTimer !== undefined) {
        window.clearInterval(scanRecheckTimer);
        scanRecheckTimer = undefined;
    }
}

export function startLockPolling() {
    if (lockPollTimer !== undefined) return;
    // Tab visibility drives scanning. Hidden → abort in-flight work + cancel the
    // schedule. Visible → (re)start the 5-minute warm-up before the first check.
    onVisibilityChange(hidden => {
        if (hidden) {
            abortScan();
            stopScanSchedule();
        } else {
            startScanSchedule();
        }
    });
    if (!isTabHidden()) startScanSchedule();
    // Separately, mirror the cross-tab scan lock into UI state so both pages can
    // show "another tab is scanning" without each having to try to acquire it.
    const tick = () => {
        const otherTabScanning = !!Scan.getActiveLockOwner();
        if (state.otherTabScanning !== otherTabScanning) {
            runInAction(() => { state.otherTabScanning = otherTabScanning; });
        }
    };
    tick();
    lockPollTimer = window.setInterval(tick, 2000);
}

// ────────────────────────────────────────────────────────────────────────────
// Scan cancellation. `stopScan()` sets the flag AND marks both phases complete
// in localStorage so the 24h-freshness gate keeps us from immediately re-
// running on next load.

let scanCancelled = false;

// Soft-delete TTL for files the scan no longer sees. The first
// scan-missing transition just marks the record; only after this
// long does a subsequent scan actually delete it. Tolerates
// temporary unmounts / sync hiccups without losing user metadata.
const DAY_MS = 24 * 60 * 60 * 1000;
const MISSING_DELETE_TTL_MS = 3 * DAY_MS;

export function stopScan(): void {
    scanCancelled = true;
    cancelThrottle();
    const name = state.rootName;
    if (name) {
        Scan.markFileScanComplete(name);
        Scan.markMetadataScanComplete(name);
        Scan.markKeyframesScanComplete(name);
        Scan.markFacesScanComplete(name);
    }
    console.log(`[scan] cancelled by user; marked all phases complete`);
}

// Tab went to the background mid-scan. Abort completely: terminate the
// extractor worker (stops all disk reads at once), wake any throttle sleep,
// and set the cancel flag so the phase loops exit and maybeScan's finally
// releases the lock. Unlike stopScan(), we do NOT mark phases complete — the
// scan is still "due", so it picks up again when the tab is refocused (the
// visibility hook or the periodic recheck in startLockPolling).
export function abortScan(): void {
    if (!state.scanning && !state.metadataScanning && !state.keyframesScanning && !state.facesScanning) return;
    scanCancelled = true;
    cancelThrottle();
    metadataExtractorClient.abort();
    console.log(`[scan] tab hidden — aborting scan (will resume when focused)`);
}

// True while a scan is being cancelled/aborted. Per-key extractors check this
// in their catch so a worker termination mid-extract isn't recorded as a real
// extraction error (lives in appState because scanCancelled is module-private).
export function isScanAborting(): boolean {
    return scanCancelled;
}

// ────────────────────────────────────────────────────────────────────────────
// Scan orchestration — two phases.
//
// Phase 1: file walk. Populates name / relativePath / size / seenAt / addedAt.
// Phase 2: metadata + thumbnails. Iterates eligible files (where
//          metadataVersion ≠ METADATA_VERSION), one at a time, picking next via
//          the prioritization helper.
//
// Each phase has its own "completed at" timestamp in localStorage so a refresh
// mid-metadata-scan resumes exactly there without redoing the file walk.

export async function maybeScan(opts?: { force?: boolean }): Promise<void> {
    // Only the focused tab scans. A hidden tab doesn't even acquire the lock,
    // so it can't block a visible tab from doing the work; becoming visible
    // re-kicks this (see startLockPolling). An already-running scan that gets
    // backgrounded is aborted outright (see abortScan / the visibility hook).
    if (isTabHidden()) {
        console.log("[scan] tab is hidden — deferring scan until focused");
        return;
    }
    const handle = await ensureFolder();
    if (!handle) return;
    // Never scan a network-served library — the data is already built
    // elsewhere and this device is just a viewer (e.g. a TV). Unless the
    // user has explicitly opted into scanning remote libraries.
    if (await scanBlockedByRemote()) {
        console.log("[scan] storage backend is remote — skipping scan");
        return;
    }
    if (state.scanning || state.metadataScanning || state.keyframesScanning || state.facesScanning) return;

    const force = !!opts?.force;
    const needFile = force || !Scan.isFileScanFresh(handle.name);
    const needMeta = force || !Scan.isMetadataScanFresh(handle.name);
    const needKf = force || !Scan.isKeyframesScanFresh(handle.name);
    const needFaces = force || !Scan.isFacesScanFresh(handle.name);
    if (!needFile && !needMeta && !needKf && !needFaces) {
        console.log(`[scan] all phases fresh for ${handle.name} (<24h), skipping`);
        return;
    }
    if (!Scan.tryAcquireScanLock()) {
        runInAction(() => { state.otherTabScanning = true; });
        console.log(`[scan] another tab holds the lock, deferring`);
        return;
    }

    scanCancelled = false;
    // Only an auto-started scan (page load, force=false) gets throttled to spare
    // the disk; an explicit Scan/Force run goes full speed.
    const throttled = !force;
    if (throttled) beginThrottledScan();
    const heartbeatTimer = window.setInterval(() => Scan.heartbeat(), 2000);
    try {
        if (needFile && !scanCancelled) await runFileScan(handle);
        if (needMeta && !scanCancelled) await runMetadataScan(handle, { mode: force ? "force" : "auto" });
        if (needKf && !scanCancelled) await runKeyframesScan(handle, { force });
        if (needFaces && !scanCancelled) await runFacesScan(handle, { force });
    } finally {
        window.clearInterval(heartbeatTimer);
        Scan.releaseScanLock();
        if (throttled) endThrottledScan();
    }
}

// Skips the file walk and runs only the metadata + thumbnail phase in "auto"
// mode — already-extracted files at the current METADATA_VERSION are skipped
// (including the ones that failed extraction, which still count as done). This
// is for picking up new/stale files without re-extracting everything. Per-cell
// Regenerate, or the forced variant below, is the path back in for retrying a
// file that previously errored out.
export async function runThumbnailScanOnly(): Promise<void> {
    await runThumbnailScan("auto");
}

// Forced thumbnail scan ("F" button). Re-extracts EVERY file unconditionally
// (mode "force") — that's the point of the force button: a full re-run, not
// just the files missing/erroring at the current version.
export async function runThumbnailScanForced(): Promise<void> {
    await runThumbnailScan("force");
}

async function runThumbnailScan(mode: "auto" | "missing" | "force"): Promise<void> {
    const handle = await ensureFolder();
    if (!handle) return;
    if (await scanBlockedByRemote()) { console.log("[scan] storage backend is remote — skipping scan"); return; }
    if (state.scanning || state.metadataScanning || state.keyframesScanning) return;
    if (!Scan.tryAcquireScanLock()) {
        runInAction(() => { state.otherTabScanning = true; });
        return;
    }
    scanCancelled = false;
    const heartbeatTimer = window.setInterval(() => Scan.heartbeat(), 2000);
    try {
        await runMetadataScan(handle, { mode });
    } finally {
        window.clearInterval(heartbeatTimer);
        Scan.releaseScanLock();
    }
}

// File-existence scan only — walks the folder, reconciles the
// missing-since marks (per the soft-delete TTL), captures fresh
// size/modtime. None of the heavy per-file extraction phases run.
// Useful after a folder move/rename without forcing a re-extract
// of metadata/thumbnails/keyframes/faces.
export async function runFileScanOnly(): Promise<void> {
    const handle = await ensureFolder();
    if (!handle) return;
    if (await scanBlockedByRemote()) { console.log("[scan] storage backend is remote — skipping scan"); return; }
    if (state.scanning || state.metadataScanning || state.keyframesScanning) return;
    if (!Scan.tryAcquireScanLock()) {
        runInAction(() => { state.otherTabScanning = true; });
        return;
    }
    scanCancelled = false;
    const heartbeatTimer = window.setInterval(() => Scan.heartbeat(), 2000);
    try {
        await runFileScan(handle);
        if (!scanCancelled) Scan.markFileScanComplete(handle.name);
    } finally {
        window.clearInterval(heartbeatTimer);
        Scan.releaseScanLock();
    }
}

async function runFileScan(handle: FileSystemDirectoryHandle): Promise<void> {
    runInAction(() => {
        state.scanning = true;
        state.scanError = undefined;
        state.scanProgress = undefined;
        state.otherTabScanning = false;
    });

    const seenAt = Date.now();
    const batch: FileRecord[] = [];
    const FLUSH_EVERY = 64;
    const flush = async () => {
        if (batch.length === 0) return;
        const out = batch.splice(0);
        try {
            await files.writeBatch(out);
        } catch (err) {
            console.warn(`[scan] writeBatch failed:`, err);
        }
    };

    console.log(`[scan] file phase starting root=${handle.name}`);
    const t0 = performance.now();
    try {
        // Part A: walk for filenames only. As cheap as the FS lets us go —
        // one directory-entries call per folder, zero per file. Hold onto
        // each file's handle keyed by pathKey so Part B can hit getFile()
        // without re-resolving paths.
        const existingKeys = new Set(await files.getKeys());
        // Tombstones for files the user removed from the library — never re-add
        // them even though they're still on disk.
        const removedKeys = new Set(await removedFiles.getKeys());
        // Folder-level tombstones: the walk never descends into these.
        const ignoredFolderKeys = new Set(await ignoredFolders.getKeys());
        // Pre-load existing missing-since marks so we can both clear
        // them when a file reappears AND, in the reconcile below, decide
        // whether an absent file has been gone long enough to hard-delete.
        const missingSinceByKey = new Map<string, number | undefined>();
        for (const { key, value } of await files.getColumn("missingSinceMs")) {
            missingSinceByKey.set(key, value);
        }
        const seenKeys = new Set<string>();
        const handlesByKey = new Map<string, FileSystemFileHandle>();
        const walkResult = await findVideos(handle, {
            onProgress: p => runInAction(() => { state.scanProgress = p; }),
            shouldCancel: () => scanCancelled,
            shouldSkipFolder: p => ignoredFolderKeys.has(p),
            onFile: async video => {
                await throttleDutyCycle();
                const k = pathKey(video.relativePath);
                if (removedKeys.has(k)) return;
                seenKeys.add(k);
                handlesByKey.set(k, video.handle);
                const isNew = !existingKeys.has(k);
                // Clear any prior missing mark — file is back. Only
                // include the column when there's actually a mark to
                // clear so we don't add a write per file every scan.
                const wasMarkedMissing = missingSinceByKey.get(k) !== undefined;
                batch.push({
                    key: k,
                    name: video.name,
                    relativePath: video.relativePath,
                    seenAt,
                    ...(isNew ? { addedAt: seenAt } : {}),
                    ...(wasMarkedMissing ? { missingSinceMs: undefined } : {}),
                });
                if (batch.length >= FLUSH_EVERY) void flush();
            },
        });
        await flush();
        // Reconcile: any previously-known file we didn't see this scan
        // is "missing". Soft-delete first — set missingSinceMs to the
        // current scan time — so a temporary unmount, sync hiccup, or
        // renamed-folder-in-progress doesn't trash metadata the user
        // depends on. Only hard-delete records whose missing-since
        // already exceeded MISSING_DELETE_TTL_MS.
        // Skip if cancelled — partial walks shouldn't nuke rows they
        // never reached.
        if (!scanCancelled) {
            const toMark: (Partial<FileRecord> & { key: string })[] = [];
            const toDelete: string[] = [];
            for (const k of existingKeys) {
                if (seenKeys.has(k)) continue;
                const since = missingSinceByKey.get(k);
                if (since === undefined) {
                    toMark.push({ key: k, missingSinceMs: seenAt });
                } else if (seenAt - since > MISSING_DELETE_TTL_MS) {
                    toDelete.push(k);
                }
            }
            if (toMark.length > 0) {
                console.log(`[scan] marking ${toMark.length} entries missing (hard-delete after ${MISSING_DELETE_TTL_MS / DAY_MS} days)`);
                try {
                    await files.updateBatch(toMark);
                } catch (err) {
                    console.warn(`[scan] updateBatch for missing marks failed:`, err);
                }
            }
            if (toDelete.length > 0) {
                console.log(`[scan] removing ${toDelete.length} entries missing for > ${MISSING_DELETE_TTL_MS / DAY_MS} days`);
                try {
                    await files.deleteBatch(toDelete);
                } catch (err) {
                    console.warn(`[scan] deleteBatch failed:`, err);
                }
            }
        }
        console.log(`[scan] file phase Part A ${scanCancelled ? "cancelled" : "complete"} in ${(performance.now() - t0).toFixed(0)}ms (${seenKeys.size} files seen)`);

        // Persist the walk breakdown (one binary bundle, overwritten each
        // scan). Skipped on cancel — a partial walk would understate every
        // folder it never reached.
        if (!scanCancelled) {
            try {
                await scanReports.write({
                    key: SCAN_REPORT_KEY,
                    rootName: handle.name,
                    scannedAt: seenAt,
                    totalMs: Math.round(performance.now() - t0),
                    bundle: encodeScanReport(walkResult.folders),
                });
            } catch (err) {
                console.warn(`[scan] could not write scan report:`, err);
            }
        }

        // Part B: cheap OS-level metadata (size, lastModified) via getFile()
        // per file. Skip files that already have both — refreshes happen via
        // the metadata phase when a real re-extract runs.
        if (!scanCancelled) {
            const tB = performance.now();
            const [sizeCol, modCol] = await Promise.all([
                files.getColumn("size"),
                files.getColumn("fileModifiedAt"),
            ]);
            const sizeByKey = new Map<string, number | undefined>();
            for (const { key, value } of sizeCol) sizeByKey.set(key, value);
            const modByKey = new Map<string, number | undefined>();
            for (const { key, value } of modCol) modByKey.set(key, value);

            const needsInfo: { key: string; handle: FileSystemFileHandle }[] = [];
            for (const [k, h] of handlesByKey) {
                if (sizeByKey.get(k) !== undefined && modByKey.get(k) !== undefined) continue;
                needsInfo.push({ key: k, handle: h });
            }
            console.log(`[scan] file phase Part B: ${needsInfo.length} files need size/modTime (of ${handlesByKey.size} seen)`);
            runInAction(() => { state.fileInfoProgress = { done: 0, total: needsInfo.length }; });

            const infoBatch: (Partial<FileRecord> & { key: string })[] = [];
            const flushInfo = async () => {
                if (infoBatch.length === 0) return;
                const out = infoBatch.splice(0);
                try {
                    await files.writeBatch(out as FileRecord[]);
                } catch (err) {
                    console.warn(`[scan] file-info writeBatch failed:`, err);
                }
            };
            let done = 0;
            for (const { key: k, handle: h } of needsInfo) {
                if (scanCancelled) break;
                await throttleDutyCycle();
                try {
                    const f = await h.getFile();
                    infoBatch.push({ key: k, size: f.size, fileModifiedAt: f.lastModified });
                } catch (err) {
                    console.warn(`[scan] getFile failed for ${k}:`, (err as Error).message);
                }
                done++;
                if (infoBatch.length >= FLUSH_EVERY) await flushInfo();
                if (done % 16 === 0 || done === needsInfo.length) {
                    runInAction(() => { state.fileInfoProgress = { done, total: needsInfo.length, currentKey: k }; });
                }
            }
            await flushInfo();
            runInAction(() => { state.fileInfoProgress = undefined; });
            console.log(`[scan] file phase Part B ${scanCancelled ? "cancelled" : "complete"} in ${(performance.now() - tB).toFixed(0)}ms`);
        }

        if (!scanCancelled) {
            Scan.markFileScanComplete(handle.name);
        }
    } catch (err) {
        console.error(`[scan] file phase failed:`, err);
        runInAction(() => { state.scanError = (err as Error).message ?? String(err); });
        throw err;
    } finally {
        runInAction(() => {
            state.scanning = false;
            state.fileInfoProgress = undefined;
        });
    }
}

async function runMetadataScan(handle: FileSystemDirectoryHandle, opts: { mode: "auto" | "missing" | "force" }): Promise<void> {
    runInAction(() => {
        state.metadataScanning = true;
        state.metadataScanProgress = { done: 0, total: 0 };
    });
    console.log(`[scan] metadata phase starting root=${handle.name} mode=${opts.mode}`);
    const t0 = performance.now();
    try {
        // Two eligibility modes (plus the nuclear "force"):
        //
        //  - "auto":    file's metadataVersion !== METADATA_VERSION. A file
        //               that failed extraction still records the current
        //               version (see extractMetadataForKey's catch), so it
        //               counts as DONE and is NOT re-queued — that's what
        //               stops every auto-scan re-hitting the same broken
        //               file. New files (no version) and stale-schema files
        //               are picked up.
        //  - "missing": file has no thumbnail. This DOES re-queue the
        //               errored-but-versioned files — a retry path for when
        //               media handling improves enough to crack a
        //               previously-failing file.
        //  - "force":   everything, unconditionally. The "F" button: a full
        //               re-run over every file, no eligibility filter.
        //
        // Read thumbW (a number) instead of thumb160 (the JPEG blob) —
        // they're written together every time so the count is the same,
        // but this avoids pulling every JPEG into memory just to ask
        // "how many cells are done".
        const [keys, thumbCol, versionCol] = await Promise.all([
            files.getKeys(),
            thumbnails.getColumn("thumbW"),
            files.getColumn("metadataVersion"),
        ]);
        const hasThumb = new Set<string>();
        for (const { key, value } of thumbCol) {
            if (typeof value === "number" && value > 0) hasThumb.add(key);
        }
        const doneAtVersion = new Set<string>();
        for (const { key, value } of versionCol) {
            if (value === METADATA_VERSION) doneAtVersion.add(key);
        }
        const eligible = new Set<string>();
        for (const k of keys) {
            const needed = opts.mode === "force"
                ? true
                : opts.mode === "missing"
                    ? !hasThumb.has(k)
                    : !doneAtVersion.has(k);
            if (needed) eligible.add(k);
        }
        const total = eligible.size;
        let done = 0;
        runInAction(() => {
            state.metadataScanProgress = { done, total };
        });
        console.log(`[scan] metadata phase: ${total} files need work (out of ${keys.length})`);

        const eta = buildFileCountEta(total);
        while (eligible.size > 0 && !scanCancelled) {
            const next = pickPriorityKey(eligible);
            if (next === undefined) break;
            eligible.delete(next);
            runInAction(() => {
                state.metadataScanProgress = { done, total, currentKey: next, currentFilePreviouslyTimedOut: hasTimedOut(next), etaText: state.metadataScanProgress?.etaText };
            });
            await extractMetadataForKey(next);
            await throttleDutyCycle();
            done++;
            const etaText = eta.onFileComplete();
            console.log(`[metadata-scan ${done}/${total}] ${next}: done | ${etaText}`);
            runInAction(() => {
                state.metadataScanProgress = { done, total, etaText };
            });
        }
        if (!scanCancelled) {
            Scan.markMetadataScanComplete(handle.name);
        }
        console.log(`[scan] metadata phase ${scanCancelled ? "cancelled" : "complete"} in ${(performance.now() - t0).toFixed(0)}ms (${done}/${total})`);
    } catch (err) {
        console.error(`[scan] metadata phase failed:`, err);
        runInAction(() => { state.scanError = (err as Error).message ?? String(err); });
    } finally {
        runInAction(() => {
            state.metadataScanning = false;
            state.metadataScanProgress = undefined;
        });
    }
}

// Per-file keyframe extraction. Same shape as extractMetadataForKey but uses
// the worker's extractKeyframes operation, writes the packed buffer + index
// into the DB, and gates the result against KEYFRAMES_VERSION for cache
// invalidation. On failure still marks done-at-version so we don't re-hit
// the same broken file every scan.
export async function extractKeyframesForKey(key: string, onProgress?: (info: ProgressInfo) => void): Promise<boolean> {
    const handle = await ensureFolder();
    if (!handle) return false;
    const file = await openFileByKey(key);
    if (!file) return false;
    try {
        const bundle = await metadataExtractorClient.extractKeyframes(file, `[kf-extract ${file.name}]`, onProgress);
        await keyframes.write({
            key,
            keyframes2: encodeKeyframes2(bundle),
            keyframesVersion: KEYFRAMES_VERSION,
            keyframesExtractedAt: Date.now(),
            keyframesExtractionMs: bundle.keyframesExtractionMs,
            keyframesError: "",
        });
        clearTimedOut(key);
        return true;
    } catch (err) {
        if (scanCancelled) return false;
        const msg = (err as Error).message ?? String(err);
        if (isTimeoutError(msg)) markTimedOut(key);
        console.warn(`[kf-extract] failed for ${key}:`, err);
        try {
            await keyframes.write({
                key,
                keyframesExtractedAt: Date.now(),
                keyframesVersion: KEYFRAMES_VERSION,
                keyframesError: msg,
            });
        } catch (writeErr) {
            console.warn(`[kf-extract] could not record error:`, writeErr);
        }
        return false;
    }
}

// Slow phases (keyframes, faces) start with a small delay so loading the
// app doesn't immediately kick off bandwidth-heavy work that competes
// with the static asset / first-paint requests. Keyframes is short — the
// worker is already spawned for the metadata phase, so a brief breath is
// enough. Faces is longer because it has to spawn a *second* job in that
// same worker that pulls in ORT + 191 MB of models on first use, plus it
// does GPU work that can stutter the player.
const KEYFRAMES_STARTUP_DELAY_MS = 5_000;
const FACES_STARTUP_DELAY_MS = 15_000;

// Returns true if the delay completed without being aborted. `shouldAbort`
// is polled every tick — used by the faces phase to bail out if the user
// navigated to the player while we were waiting. The abort is silent: the
// phase just doesn't run, and the next time SearchPage mounts it'll get
// another chance.
async function delayUnlessCancelled(
    ms: number,
    label: string,
    shouldAbort?: () => boolean,
): Promise<boolean> {
    if (scanCancelled) return false;
    if (ms <= 0) return true;
    console.log(`[scan] ${label} startup delay ${ms}ms`);
    const tick = 200;
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (scanCancelled) return false;
        if (shouldAbort && shouldAbort()) {
            console.log(`[scan] ${label} aborted during startup delay (page changed)`);
            return false;
        }
        await new Promise(r => setTimeout(r, Math.min(tick, ms - (Date.now() - start))));
    }
    return true;
}

// Phase-wide ETA helper for media-time phases (keyframes, faces).
//
// Rate is *video-seconds processed per real-second*. We get a live
// signal from the worker's currentMs/durationMs heartbeat, and we know
// each file's durationSec ahead of time from the metadata column.
//
// Remaining = current file's remaining seconds + sum of not-yet-started
// files' durations. Multiply by 1/rate and you have a wall-clock ETA.
// Honest enough — early-phase rate is noisy until a real file finishes,
// but it stabilizes within a couple of files. Caller pulls a status
// string per heartbeat (or per file completion).
function buildMediaPhaseEta(eligible: Set<string>): {
    onBeforeFile(key: string): void;
    onProgress(currentMs: number | undefined, fileDurationMs: number | undefined): string;
    onAfterFile(key: string): void;
} {
    const durationCol = files.getColumnSync("durationSec") ?? [];
    const durationByKey = new Map<string, number>();
    for (const { key, value } of durationCol) {
        if (typeof value === "number") durationByKey.set(key, value);
    }
    const t0 = performance.now();
    let videoSecCompleted = 0;
    let filesCompleted = 0;
    let currentFileSec = 0;
    // Fallback for when getColumnSync didn't have durationSec for this
    // file — the worker reports durationMs on every heartbeat so we can
    // use that instead.
    let lastSeenFileDurationSec = 0;

    // Format whatever we know into a status string. Three tiers, falling
    // back in order:
    //   1. media-time rate (video-sec processed / real-sec elapsed) →
    //      ETA from remaining video seconds. Unknown-duration eligible
    //      files use the running average of files we *do* know.
    //   2. file-count rate (files done / real-sec elapsed) → ETA from
    //      remaining file count. Used when we have no media-time
    //      signal yet (no heartbeat fired and no file completed with a
    //      known duration).
    //   3. nothing yet — return "ETA ?".
    function format(currentMs: number | undefined): string {
        const elapsedSec = (performance.now() - t0) / 1000;
        if (elapsedSec <= 0) return "ETA ?";

        const effectiveFileSec = currentFileSec > 0 ? currentFileSec : lastSeenFileDurationSec;
        const rawInFlightSec = Math.max(0, (currentMs ?? 0) / 1000);
        const inFlightSec = effectiveFileSec > 0
            ? Math.min(rawInFlightSec, effectiveFileSec)
            : rawInFlightSec;
        const processedSec = videoSecCompleted + inFlightSec;

        // Average duration across files we know something about —
        // completed-with-known-duration + the current file + any
        // eligible files with a column entry. Used to extrapolate the
        // duration of eligible files we have *no* info on.
        let knownDurSum = videoSecCompleted;
        let knownDurCount = filesCompleted;
        if (effectiveFileSec > 0) { knownDurSum += effectiveFileSec; knownDurCount++; }
        for (const k of eligible) {
            const d = durationByKey.get(k);
            if (typeof d === "number" && d > 0) { knownDurSum += d; knownDurCount++; }
        }
        const avgFileSec = knownDurCount > 0 ? knownDurSum / knownDurCount : 0;

        // Remaining video seconds: current file's leftover + sum of
        // eligible files' durations (real if known, avg if not).
        let remainingSec = Math.max(0, effectiveFileSec - inFlightSec);
        for (const k of eligible) {
            const d = durationByKey.get(k);
            if (typeof d === "number" && d > 0) remainingSec += d;
            else if (avgFileSec > 0) remainingSec += avgFileSec;
        }

        if (processedSec > 0) {
            const rate = processedSec / elapsedSec;
            return `ETA ${formatTime((remainingSec / rate) * 1000)} (${rate.toFixed(1)}× realtime)`;
        }
        if (filesCompleted > 0) {
            // Media-time signal hasn't arrived yet (no heartbeat
            // happened for this file). Use file-count rate.
            const rateFiles = filesCompleted / elapsedSec;
            const remainingFiles = eligible.size + (currentFileSec > 0 || effectiveFileSec > 0 ? 1 : 0);
            return `ETA ${formatTime((remainingFiles / rateFiles) * 1000)} (${rateFiles.toFixed(2)} files/s)`;
        }
        return "ETA ?";
    }

    return {
        onBeforeFile(key) {
            currentFileSec = durationByKey.get(key) ?? 0;
            lastSeenFileDurationSec = 0;
        },
        onProgress(currentMs, fileDurationMs) {
            if (typeof fileDurationMs === "number" && fileDurationMs > 0) {
                lastSeenFileDurationSec = fileDurationMs / 1000;
            }
            return format(currentMs);
        },
        onAfterFile(key) {
            const fileSec = durationByKey.get(key) ?? lastSeenFileDurationSec;
            videoSecCompleted += fileSec;
            filesCompleted++;
            currentFileSec = 0;
            lastSeenFileDurationSec = 0;
        },
    };
}

// Phase-wide ETA helper for file-count phases (metadata + thumbnails).
// We don't know durations ahead of time — that's what this phase is
// extracting — so just track files-per-real-second across completed
// files and project linearly across the remaining count.
function buildFileCountEta(eligibleStart: number): {
    onFileComplete(): string;
} {
    const t0 = performance.now();
    let done = 0;
    return {
        onFileComplete() {
            done++;
            const remaining = Math.max(0, eligibleStart - done);
            const elapsedSec = (performance.now() - t0) / 1000;
            if (done <= 0 || elapsedSec <= 0) return "ETA ?";
            const rate = done / elapsedSec;
            return `ETA ${formatTime((remaining / rate) * 1000)} (${rate.toFixed(2)} files/s)`;
        },
    };
}

async function runKeyframesScan(handle: FileSystemDirectoryHandle, opts: { force: boolean; delay?: boolean }): Promise<void> {
    if (!keyframesScanEnabled.get()) {
        console.log(`[scan] keyframes phase disabled by user preference`);
        return;
    }
    // Auto-triggered scans wait so they don't compete with first paint /
    // static-asset requests; user-initiated ones (the "Keyframes only"
    // button) jump in immediately.
    if (opts.delay !== false) {
        if (!(await delayUnlessCancelled(KEYFRAMES_STARTUP_DELAY_MS, "keyframes"))) return;
    }
    runInAction(() => {
        state.keyframesScanning = true;
        state.keyframesScanProgress = { done: 0, total: 0 };
    });
    console.log(`[scan] keyframes phase starting root=${handle.name}`);
    const t0 = performance.now();
    try {
        const [keys, versionCol] = await Promise.all([
            files.getKeys(),
            keyframes.getColumn("keyframesVersion"),
        ]);
        const versionByKey = new Map<string, number | undefined>();
        for (const { key, value } of versionCol) versionByKey.set(key, value);
        const eligible = new Set<string>();
        for (const k of keys) {
            const v = versionByKey.get(k);
            if (opts.force || v !== KEYFRAMES_VERSION) eligible.add(k);
        }
        const total = eligible.size;
        let done = 0;
        runInAction(() => {
            state.keyframesScanProgress = { done, total };
        });
        console.log(`[scan] keyframes phase: ${total} files need work (out of ${keys.length})`);

        const eta = buildMediaPhaseEta(eligible);
        while (eligible.size > 0 && !scanCancelled) {
            const next = pickPriorityKey(eligible);
            if (next === undefined) break;
            eligible.delete(next);
            eta.onBeforeFile(next);
            runInAction(() => {
                state.keyframesScanProgress = { done, total, currentKey: next, currentFilePreviouslyTimedOut: hasTimedOut(next), etaText: state.keyframesScanProgress?.etaText };
            });
            await extractKeyframesForKey(next, info => {
                const etaText = eta.onProgress(info.currentMs, info.durationMs);
                console.log(`[keyframes-scan ${done + 1}/${total}] ${next}: ${info.message} | ${etaText}`);
                runInAction(() => {
                    if (state.keyframesScanProgress) state.keyframesScanProgress = { ...state.keyframesScanProgress, etaText };
                });
            });
            eta.onAfterFile(next);
            await throttleHeavyItem();
            done++;
            const etaText = eta.onProgress(undefined, undefined);
            console.log(`[keyframes-scan ${done}/${total}] ${next}: done | ${etaText}`);
            runInAction(() => {
                state.keyframesScanProgress = { done, total, etaText };
            });
        }
        if (!scanCancelled) {
            Scan.markKeyframesScanComplete(handle.name);
        }
        console.log(`[scan] keyframes phase ${scanCancelled ? "cancelled" : "complete"} in ${(performance.now() - t0).toFixed(0)}ms (${done}/${total})`);
    } catch (err) {
        console.error(`[scan] keyframes phase failed:`, err);
        runInAction(() => { state.scanError = (err as Error).message ?? String(err); });
    } finally {
        runInAction(() => {
            state.keyframesScanning = false;
            state.keyframesScanProgress = undefined;
        });
    }
}

export async function runKeyframesScanOnly(): Promise<void> {
    const handle = await ensureFolder();
    if (!handle) return;
    if (await scanBlockedByRemote()) { console.log("[scan] storage backend is remote — skipping scan"); return; }
    if (state.scanning || state.metadataScanning || state.keyframesScanning) return;
    if (!Scan.tryAcquireScanLock()) {
        runInAction(() => { state.otherTabScanning = true; });
        return;
    }
    scanCancelled = false;
    const heartbeatTimer = window.setInterval(() => Scan.heartbeat(), 2000);
    try {
        await runKeyframesScan(handle, { force: false, delay: false });
    } finally {
        window.clearInterval(heartbeatTimer);
        Scan.releaseScanLock();
    }
}

// ──────────────────────────────────────────────────────────────────────
// Phase 4: face extraction. For each file lacking facesVersion ===
// FACES_VERSION, stream every keyframe (≥1s apart) through the face
// pipeline, cluster into characters, write to the three face DBs.
async function runFacesScan(handle: FileSystemDirectoryHandle, opts: { force: boolean; delay?: boolean }): Promise<void> {
    if (!facesScanEnabled.get()) {
        console.log(`[scan] faces phase disabled by user preference`);
        return;
    }
    // Auto-triggered scans wait 15s + bail if the user has navigated to
    // the player (face scan is GPU-heavy). User-initiated ones (the
    // "Faces only" button) skip the delay entirely — the user just
    // clicked the button, they obviously want it now.
    if (opts.delay !== false) {
        const ok = await delayUnlessCancelled(FACES_STARTUP_DELAY_MS, "faces", () => {
            if (!facesScanEnabled.get()) return true;
            if (currentVideo.value) return true;
            return false;
        });
        if (!ok) return;
    }
    runInAction(() => {
        state.facesScanning = true;
        state.facesScanProgress = { done: 0, total: 0 };
    });
    console.log(`[scan] faces phase starting root=${handle.name}`);
    const t0 = performance.now();
    try {
        const [keys, versionCol] = await Promise.all([
            files.getKeys(),
            files.getColumn("facesVersion"),
        ]);
        const versionByKey = new Map<string, number | undefined>();
        for (const { key, value } of versionCol) versionByKey.set(key, value);
        const eligible = new Set<string>();
        for (const k of keys) {
            const v = versionByKey.get(k);
            if (opts.force || v !== FACES_VERSION) eligible.add(k);
        }
        const total = eligible.size;
        let done = 0;
        runInAction(() => { state.facesScanProgress = { done, total }; });
        console.log(`[scan] faces phase: ${total} files need work (out of ${keys.length})`);

        const eta = buildMediaPhaseEta(eligible);
        while (eligible.size > 0 && !scanCancelled) {
            const next = pickPriorityKey(eligible);
            if (next === undefined) break;
            eligible.delete(next);
            eta.onBeforeFile(next);
            runInAction(() => {
                state.facesScanProgress = { done, total, currentKey: next, currentFilePreviouslyTimedOut: hasTimedOut(next), etaText: state.facesScanProgress?.etaText };
            });
            await extractFacesForKey(next, info => {
                const etaText = eta.onProgress(info.currentMs, info.durationMs);
                console.log(`[faces-scan ${done + 1}/${total}] ${next}: ${info.message} | ${etaText}`);
                runInAction(() => {
                    if (state.facesScanProgress) state.facesScanProgress = { ...state.facesScanProgress, etaText };
                });
            });
            eta.onAfterFile(next);
            await throttleHeavyItem();
            done++;
            const etaText = eta.onProgress(undefined, undefined);
            console.log(`[faces-scan ${done}/${total}] ${next}: done | ${etaText}`);
            runInAction(() => { state.facesScanProgress = { done, total, etaText }; });
        }
        if (!scanCancelled) Scan.markFacesScanComplete(handle.name);
        console.log(`[scan] faces phase ${scanCancelled ? "cancelled" : "complete"} in ${(performance.now() - t0).toFixed(0)}ms (${done}/${total})`);
    } catch (err) {
        console.error(`[scan] faces phase failed:`, err);
        runInAction(() => { state.scanError = (err as Error).message ?? String(err); });
    } finally {
        runInAction(() => {
            state.facesScanning = false;
            state.facesScanProgress = undefined;
        });
    }
}

export async function runFacesScanOnly(): Promise<void> {
    const handle = await ensureFolder();
    if (!handle) return;
    if (await scanBlockedByRemote()) { console.log("[scan] storage backend is remote — skipping scan"); return; }
    if (state.scanning || state.metadataScanning || state.keyframesScanning || state.facesScanning) return;
    if (!Scan.tryAcquireScanLock()) {
        runInAction(() => { state.otherTabScanning = true; });
        return;
    }
    scanCancelled = false;
    const heartbeatTimer = window.setInterval(() => Scan.heartbeat(), 2000);
    try {
        await runFacesScan(handle, { force: false, delay: false });
    } finally {
        window.clearInterval(heartbeatTimer);
        Scan.releaseScanLock();
    }
}

// Clear the saved pointer + reload, so SliftUtils re-prompts for a folder.
export function switchFolder() {
    resetStorageLocation();
}

export async function openFileByKey(key: string): Promise<MediaFile | undefined> {
    const handle = await ensureFolder();
    if (!handle) return undefined;
    const relativePath = await files.getSingleField(key, "relativePath");
    if (!relativePath) return undefined;
    // The recorded handle may name a file or directory the user
    // deleted/moved since the scan ran. Surface that as "missing"
    // rather than an exception so the metadata loop logs it,
    // records extractionError on the row, and moves on.
    try {
        const fileHandle = await resolveFileHandle(handle, relativePath);
        const fileLike = await fileHandle.getFile();
        // Browser File carries `name` directly; the sliftutils
        // FileWrapper.getFile() result doesn't. Use whichever is
        // present, then fall back to the path basename.
        const baseName = relativePath.split(/[\\/]/).pop() ?? relativePath;
        const name = (fileLike as { name?: string }).name ?? baseName;
        const mediaFile = fileToMediaFile(name, fileLike);
        // The handle (native FileSystemFileHandle or sliftutils FileWrapper)
        // is what getFileURL needs to produce a directly-loadable URL.
        mediaFile.getURL = () => getFileURL(fileHandle as unknown as FileWrapper);
        return mediaFile;
    } catch (err) {
        if (isNotFoundError(err)) {
            console.warn(`[openFileByKey] no longer present: ${relativePath}`);
            return undefined;
        }
        throw err;
    }
}

// FileSystem Access API throws NotFoundError as a DOMException; the
// name is the only reliable cross-browser discriminator.
function isNotFoundError(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof DOMException && err.name === "NotFoundError") return true;
    const name = (err as { name?: string }).name;
    if (name === "NotFoundError") return true;
    const msg = (err as { message?: string }).message ?? "";
    return /could not be found|no such file|not found/i.test(msg);
}

export function fmtMB(bytes: number): string {
    return (bytes / 1_048_576).toFixed(1) + " MB";
}
