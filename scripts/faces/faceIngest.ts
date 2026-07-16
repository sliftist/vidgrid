// Shared face-pipeline DB logic, used by both the long-lived writeServer.ts
// and the standalone getWork.ts / writeResult.ts debug CLIs. Keeping the
// ingest + work-collection here means there is exactly one implementation of
// "what a result payload turns into on disk" and "what counts as work".
//
// IMPORTANT: callers must `process.chdir(<data_root>)` before invoking these —
// the BulkDatabase2 collections in appState resolve their storage lazily, so
// the cwd at first read/write is what decides where the databases live.

import {
    files, faceFrames, characters, thumbnails, keyframes,
    ignoredFolders, removedFiles,
    FileRecord, FaceFramesRecord, CharacterRecord,
    EMBEDDING_FLOATS, characterKey, selectFaceWorkKeys,
} from "../../web/appState";
import { FACES_VERSION, KEYFRAMES_VERSION, METADATA_VERSION } from "../../web/MetadataExtractor";
import { encodeKeyframes2 } from "../../web/scan/keyframes2";

// Buffer is a Uint8Array, and the storage serializer copies with the view's
// byteOffset/byteLength, so returning the decode directly is safe — no need to
// re-copy into a fresh array.
function b64ToBytes(b64: string): Uint8Array {
    return Buffer.from(b64, "base64");
}

// ── File-registration batch ingest ──────────────────────────────────────────
// The file-system walk itself runs in Python (run.py) — it's better suited to
// walk a large tree, and doing it there keeps the DB-writer process (this
// one) doing only what it exists to do: write. Python streams batches of
// discovered videos here via the writeServer's `registerFiles` message and
// this function does the DB merge. Preserves existing rows so scan progress
// (metadataVersion, facesVersion, keyframes, characters, etc.) survives a
// re-walk untouched — only seenAt is refreshed; addedAt is set on new rows.

export interface FileRegistrationItem {
    key: string;
    name: string;
    relativePath: string;
}

export interface RegisterFilesResult {
    added: number;   // new keys inserted this batch
    updated: number; // existing keys touched this batch
}

// Pre-walk lookup for the Python side: the same two exclusions the browser
// walk honors (workerScanCore.runFileWalk). Any folder key here is pruned
// from the traversal; any file key here is skipped even if it exists on
// disk. Returned as arrays for a plain JSON round-trip.
export interface WalkExclusions {
    ignoredFolders: string[]; // relative folder paths the user marked ignored
    removedFiles: string[];   // relative file paths (== FileRecord keys) the user removed
}

export async function getWalkExclusions(): Promise<WalkExclusions> {
    const [folderKeys, fileKeys] = await Promise.all([
        ignoredFolders.getKeys(),
        removedFiles.getKeys(),
    ]);
    return { ignoredFolders: folderKeys, removedFiles: fileKeys };
}

// ── Metadata phase (separate loop, mirrors the browser scan) ────────────────
// Runs after the walk, before keyframes/faces. Same phase boundary the
// browser's coordinator uses (workerScanCore.runOneMetadata → runOneKeyframes
// → runOneFaces). Python side extracts via PyAV + os.stat and streams payloads
// through here.

export interface MetadataWorkItem {
    key: string;
    relativePath: string;
}

export interface MetadataWorkList {
    version: number;
    total: number;
    items: MetadataWorkItem[];
}

// Files that haven't been metadata-scanned at the current METADATA_VERSION.
// Skips scanBlacklisted files (same rule the browser picker uses).
export async function collectMetadataWork(force: boolean): Promise<MetadataWorkList> {
    const [relCol, versionCol, blCol] = await Promise.all([
        files.getColumn("relativePath"),
        files.getColumn("metadataVersion"),
        files.getColumn("scanBlacklisted"),
    ]);
    const versionByKey = new Map<string, number | undefined>();
    for (const { key, value } of versionCol) versionByKey.set(key, typeof value === "number" ? value : undefined);
    const blacklisted = new Set<string>();
    for (const { key, value } of blCol) if (value === true) blacklisted.add(key);
    const items: MetadataWorkItem[] = [];
    for (const { key, value: relativePath } of relCol) {
        if (typeof relativePath !== "string") continue;
        if (blacklisted.has(key)) continue;
        if (!force && versionByKey.get(key) === METADATA_VERSION) continue;
        items.push({ key, relativePath });
    }
    // Same ordering as the face phase — filename ascending.
    const baseNameOf = (p: string): string => {
        const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        return i < 0 ? p : p.slice(i + 1);
    };
    items.sort((a, b) => baseNameOf(a.relativePath).localeCompare(baseNameOf(b.relativePath), undefined, { sensitivity: "base" }));
    return { version: METADATA_VERSION, total: items.length, items };
}

// Payload from Python for one metadata-extraction result. Matches the field
// set web/scan/workerScanCore.runOneMetadata writes on success. On error,
// only `fileKey` and `error` are set; everything else is stamped at the
// current version so we don't re-attempt.
export interface MetadataPayload {
    fileKey: string;
    error?: string;
    // Present on success (from PyAV probe + os.stat).
    size?: number;
    fileModifiedAt?: number;
    durationSec?: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    metadataExtractionMs?: number;
}

export async function ingestMetadata(payload: MetadataPayload): Promise<void> {
    if (!payload.fileKey) throw new Error("Missing fileKey in metadata payload");
    const filePatch: Partial<FileRecord> & { key: string } = {
        key: payload.fileKey,
        metadataVersion: METADATA_VERSION,
        metadataExtractedAt: Date.now(),
    };
    if (payload.error) {
        filePatch.extractionError = payload.error;
    } else {
        filePatch.extractionError = "";
        if (payload.size !== undefined) filePatch.size = payload.size;
        if (payload.fileModifiedAt !== undefined) filePatch.fileModifiedAt = payload.fileModifiedAt;
        if (payload.durationSec !== undefined) filePatch.durationSec = payload.durationSec;
        if (payload.width !== undefined) filePatch.width = payload.width;
        if (payload.height !== undefined) filePatch.height = payload.height;
        if (payload.videoCodec !== undefined) filePatch.videoCodec = payload.videoCodec;
        if (payload.audioCodec !== undefined) filePatch.audioCodec = payload.audioCodec;
        if (payload.metadataExtractionMs !== undefined) filePatch.metadataExtractionMs = payload.metadataExtractionMs;
    }
    await files.update(filePatch);
}

export async function registerFilesBatch(items: FileRegistrationItem[]): Promise<RegisterFilesResult> {
    if (items.length === 0) return { added: 0, updated: 0 };
    const existingKeys = new Set(await files.getKeys());
    const now = Date.now();
    const batch: (Partial<FileRecord> & { key: string })[] = new Array(items.length);
    let added = 0;
    let updated = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const isNew = !existingKeys.has(it.key);
        // writeBatch merges by key, so leaving off fields we don't want to
        // touch (metadataVersion, facesVersion, keyframes payload, etc.)
        // preserves them. addedAt is only in the write on NEW rows so an
        // existing row's original addedAt survives every re-walk.
        batch[i] = {
            key: it.key,
            name: it.name,
            relativePath: it.relativePath,
            seenAt: now,
            ...(isNew ? { addedAt: now } : {}),
        };
        if (isNew) added++; else updated++;
    }
    await files.writeBatch(batch as FileRecord[]);
    return { added, updated };
}

// Decode base64-packed little-endian float32 bytes into a Float32Array. The
// DB stores Float32Array columns natively, so this is the on-disk form too.
// `expectedFloats` (when given) guards against a truncated/garbled payload.
function b64ToFloat32(b64: string, expectedFloats?: number): Float32Array {
    const buf = Buffer.from(b64, "base64");
    if (buf.byteLength % 4 !== 0) {
        throw new Error(`Float32 base64 decodes to ${buf.byteLength} bytes, not a multiple of 4`);
    }
    const floats = buf.byteLength / 4;
    if (expectedFloats !== undefined && floats !== expectedFloats) {
        throw new Error(`Float32 base64 decodes to ${floats} floats, expected ${expectedFloats}`);
    }
    const out = new Float32Array(floats);
    for (let i = 0; i < floats; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
}

// Result JSON shape (all bytes are base64 strings on the wire — TS
// reconstitutes ArrayBuffers / Float32Arrays). Produced by Python's
// process_one.py.
export interface ResultPayload {
    fileKey: string;
    durationMs?: number;
    characters?: {
        characterIdx: number;
        memberCount: number;
        bestFaceTimeMs: number;
        bestFaceEmbedding_b64: string;
        // Every member embedding concatenated (memberCount × 512 floats) plus
        // a parallel frame-time array (memberCount floats). These are the heavy
        // per-frame data, written to the faceFrames collection.
        embeddings_b64: string;
        frameTimes_b64: string;
        // Pre-cropped square face JPEG for the avatar (base64). Absent when
        // the best-face frame couldn't be cropped.
        avatarJpeg_b64?: string;
    }[];
    // Auto thumbnail (see process_one.py). "face" = the second most-common
    // character's frame; "auto" = the regular faceless fallback picked nearest
    // the standard timestamp when no face qualified. Stored with the matching
    // thumbSource so the browser's user-pick guard stays consistent.
    thumbnail?: {
        thumb160_b64: string;
        thumb320_b64: string;
        thumb640_b64: string;
        thumbW: number;
        thumbH: number;
        source: "face" | "auto";
    };
    // Keyframe-preview strip (the scrub thumbnails) — produced alongside faces
    // by process_one.py since the decode is "right there". Packed into the
    // browser's KeyframesRecord shape (one contiguous buffer + offset/time
    // index) on ingest. null/absent when extraction produced nothing.
    keyframes?: {
        intervalSec: number;
        keyframesExtractionMs?: number;
        frames: { timeSec: number; jpeg_b64: string }[];
    } | null;
    // Reason the preview strip is absent (extractor threw or produced nothing).
    // Recorded so a keyframes record still lands on disk and the failure is
    // visible instead of silently leaving the file un-stamped (which made it
    // look like the offline pipeline never touched keyframes at all).
    keyframesError?: string;
    stats?: {
        faceCount?: number;
        characterCount?: number;
        facesExtractionMs?: number;
    };
    // If set, only updates the FileRecord with facesError + facesVersion.
    error?: string;
    // Set by the SITE that decided this file shouldn't be scanned again (e.g.
    // run.py's TimeoutError handler after our own deadline elapsed). Stamps
    // scanBlacklisted so the file lands in the same TIMED-OUT state as
    // browser-side failures — same badge, same skip behavior for the runtime
    // picker. No re-detection or classification here.
    blacklist?: boolean;
}

export interface IngestCounts {
    faces: number;
    characters: number;
    keyframes: number;
    error?: string;
}

// Ingests a single video's face-processing result into the bulk DBs — mirrors
// what extractFacesForKey does on the browser side (one CharacterRecord summary
// + one FaceFramesRecord of all member embeddings per character, each character
// with a cropped-face avatar, then patches the FileRecord with the version
// stamp and counts).
export async function ingestResult(payload: ResultPayload): Promise<IngestCounts> {
    const { fileKey } = payload;
    if (!fileKey) throw new Error(`Missing fileKey in payload`);

    const filePatch: Partial<FileRecord> & { key: string } = {
        key: fileKey,
        facesVersion: FACES_VERSION,
        facesExtractedAt: Date.now(),
    };

    if (payload.error) {
        filePatch.facesError = payload.error;
        filePatch.facesEmpty = false;
        if (payload.blacklist === true) filePatch.scanBlacklisted = true;
        await files.update(filePatch);
        return { faces: 0, characters: 0, keyframes: 0, error: payload.error };
    }

    const charRows: CharacterRecord[] = [];
    const frameRows: FaceFramesRecord[] = [];
    let faceTotal = 0;
    for (const c of payload.characters ?? []) {
        const key = characterKey(fileKey, c.characterIdx);
        charRows.push({
            key,
            fileKey,
            characterIdx: c.characterIdx,
            bestFaceTimeMs: c.bestFaceTimeMs,
            bestFaceEmbedding: b64ToFloat32(c.bestFaceEmbedding_b64, EMBEDDING_FLOATS),
            memberCount: c.memberCount,
            avatarJpeg: c.avatarJpeg_b64 ? b64ToBytes(c.avatarJpeg_b64) : undefined,
        });
        frameRows.push({
            key,
            embeddings: b64ToFloat32(c.embeddings_b64, c.memberCount * EMBEDDING_FLOATS),
            embeddingCount: c.memberCount,
            frameTimes: b64ToFloat32(c.frameTimes_b64, c.memberCount),
        });
        faceTotal += c.memberCount;
    }

    if (charRows.length > 0) await characters.writeBatch(charRows);
    if (frameRows.length > 0) await faceFrames.writeBatch(frameRows);

    // Auto thumbnail (already downscaled by Python — a face frame, or the
    // regular faceless fallback). Never clobber a thumbnail the user picked
    // explicitly — same rule as the browser path.
    if (payload.thumbnail) {
        const existingSource = await thumbnails.getSingleField(fileKey, "thumbSource");
        if (existingSource !== "user") {
            await thumbnails.write({
                key: fileKey,
                thumb160: b64ToBytes(payload.thumbnail.thumb160_b64),
                thumb320: b64ToBytes(payload.thumbnail.thumb320_b64),
                thumb640: b64ToBytes(payload.thumbnail.thumb640_b64),
                thumbW: payload.thumbnail.thumbW,
                thumbH: payload.thumbnail.thumbH,
                thumbSource: payload.thumbnail.source,
            });
        }
    }

    // Keyframe-preview strip. Packed into the browser's KeyframesRecord shape:
    // one contiguous JPEG buffer with an offsets index (length n+1, last entry
    // is the buffer length) and a parallel times[] in seconds — identical to
    // extractKeyframes + extractKeyframesForKey on the browser side, so the
    // KEYFRAMES_VERSION cache treats offline- and browser-produced strips the
    // same. Stamped with the current version so the browser's keyframes phase
    // skips files we already covered.
    // Never downgrade: if a newer KEYFRAMES_VERSION is already on disk (a newer
    // browser/script ran since), leave it alone — the same "only write when our
    // version is at least as new" rule collectWork applies to faces.
    let keyframeCount = 0;
    const existingKfVersion = await keyframes.getSingleField(fileKey, "keyframesVersion");
    if (typeof existingKfVersion === "number" && existingKfVersion > KEYFRAMES_VERSION) {
        // Stored keyframes are newer than ours — skip the keyframe write entirely.
    } else if (payload.keyframes && payload.keyframes.frames.length > 0) {
        const kf = payload.keyframes;
        const jpegs = kf.frames.map(f => b64ToBytes(f.jpeg_b64));
        const totalBytes = jpegs.reduce((s, j) => s + j.byteLength, 0);
        const data = new Uint8Array(totalBytes);
        const offsets: number[] = [];
        const times: number[] = [];
        let pos = 0;
        for (let i = 0; i < jpegs.length; i++) {
            offsets.push(pos);
            times.push(kf.frames[i].timeSec);
            data.set(jpegs[i], pos);
            pos += jpegs[i].byteLength;
        }
        offsets.push(pos);
        await keyframes.write({
            key: fileKey,
            keyframes2: encodeKeyframes2({ data, offsets, times, intervalSec: kf.intervalSec }),
            keyframesVersion: KEYFRAMES_VERSION,
            keyframesExtractedAt: Date.now(),
            keyframesExtractionMs: kf.keyframesExtractionMs,
            keyframesError: "",
        });
        keyframeCount = jpegs.length;
    } else if (payload.keyframesError) {
        // No strip this pass — stamp an error record (same shape the browser's
        // keyframe phase writes on failure) so the file is marked done-at-version
        // and the reason is visible, rather than leaving no keyframes record.
        await keyframes.write({
            key: fileKey,
            keyframesVersion: KEYFRAMES_VERSION,
            keyframesExtractedAt: Date.now(),
            keyframesError: payload.keyframesError,
        });
    }

    filePatch.faceCount = payload.stats?.faceCount ?? faceTotal;
    filePatch.characterCount = payload.stats?.characterCount ?? charRows.length;
    filePatch.facesExtractionMs = payload.stats?.facesExtractionMs;
    filePatch.facesError = "";
    // A clean run that found nobody. Recorded so the missing-rows check below doesn't read it as lost data and requeue the video forever.
    filePatch.facesEmpty = charRows.length === 0;
    await files.update(filePatch);

    return { faces: faceTotal, characters: charRows.length, keyframes: keyframeCount };
}

export interface WorkItem {
    key: string;
    relativePath: string;
    durationSec?: number;
    // Number of videos in the same folder (inclusive). Drives the offline
    // face-thumbnail choice: series folders (5+) use the 2nd character,
    // standalone folders use the 1st. Mirrors web/appState countFolderVideos.
    folderVideoCount: number;
}

export interface WorkList {
    version: number;
    total: number;
    items: WorkItem[];
}

// Every FileRecord that needs face processing. Done-ness lives in the bulk DB
// and is decided by selectFaceWorkKeys, shared with the browser scan so the two
// pipelines can't disagree. `force` includes everything (useful after a
// FACES_VERSION bump). durationSec is a hint Python can use to sort / report
// progress.
export async function collectWork(force: boolean): Promise<WorkList> {
    const [relCol, durationCol] = await Promise.all([
        files.getColumn("relativePath"),
        files.getColumn("durationSec"),
    ]);
    const workKeys = await selectFaceWorkKeys(relCol.map(e => e.key), force);
    const durationByKey = new Map<string, number | undefined>();
    for (const { key, value } of durationCol) {
        if (typeof value === "number") durationByKey.set(key, value);
    }

    // Count videos per folder across the whole library (not just the work
    // set) so the series/standalone decision is stable as files get processed.
    const folderOf = (p: string): string => {
        const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        return i < 0 ? "" : p.slice(0, i);
    };
    const folderCounts = new Map<string, number>();
    for (const { value } of relCol) {
        if (typeof value !== "string") continue;
        const f = folderOf(value);
        folderCounts.set(f, (folderCounts.get(f) ?? 0) + 1);
    }

    const items: WorkItem[] = [];
    for (const { key, value: relativePath } of relCol) {
        if (typeof relativePath !== "string") continue;
        if (!workKeys.has(key)) continue;
        items.push({
            key,
            relativePath,
            durationSec: durationByKey.get(key),
            folderVideoCount: folderCounts.get(folderOf(relativePath)) ?? 1,
        });
    }

    // Process in alphabetical order of the file's basename (not the full path),
    // so the worker walks files in a predictable, name-sorted order regardless
    // of which folders they live in.
    const baseNameOf = (p: string): string => {
        const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        return i < 0 ? p : p.slice(i + 1);
    };
    items.sort((a, b) =>
        baseNameOf(a.relativePath).localeCompare(baseNameOf(b.relativePath), undefined, { sensitivity: "base" }));

    return { version: FACES_VERSION, total: items.length, items };
}

// Flush buffered stream writes to disk for all four collections. In Node the
// default flush delay is 0 (every write is durable immediately), so this is a
// safety barrier before shutdown rather than the main durability mechanism.
export async function flushAll(): Promise<void> {
    await Promise.all([files.flush(), faceFrames.flush(), characters.flush(), keyframes.flush()]);
}

// Fold each collection's append-log stream files into compressed columnar
// bulk files. Reads the whole collection into memory (the design's accepted
// soft bound), so it's an explicit opt-in step, not run by default.
export async function compactAll(): Promise<void> {
    await Promise.all([files.compact(), faceFrames.compact(), characters.compact(), keyframes.compact()]);
}
