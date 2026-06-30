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
    FileRecord, FaceFramesRecord, CharacterRecord,
    EMBEDDING_FLOATS, characterKey,
} from "../../web/appState";
import { FACES_VERSION, KEYFRAMES_VERSION } from "../../web/MetadataExtractor";
import { encodeKeyframes2 } from "../../web/scan/keyframes2";

// Buffer is a Uint8Array, and the storage serializer copies with the view's
// byteOffset/byteLength, so returning the decode directly is safe — no need to
// re-copy into a fresh array.
function b64ToBytes(b64: string): Uint8Array {
    return Buffer.from(b64, "base64");
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
        centroid_b64: string;
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
            centroid: b64ToFloat32(c.centroid_b64, EMBEDDING_FLOATS),
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

// Every FileRecord that needs face processing. Done-ness lives in the bulk DB:
// a file is "done" iff its facesVersion is at least FACES_VERSION. Anything
// missing the version, or stuck on an older one, is work — but a file already
// stamped with a *newer* version is left alone, so running an old script never
// drags the library back to an older version. `force` includes everything
// (useful after a FACES_VERSION bump). durationSec is a hint Python can use to
// sort / report progress.
export async function collectWork(force: boolean): Promise<WorkList> {
    const [relCol, versionCol, durationCol] = await Promise.all([
        files.getColumn("relativePath"),
        files.getColumn("facesVersion"),
        files.getColumn("durationSec"),
    ]);
    const versionByKey = new Map<string, number | undefined>();
    for (const { key, value } of versionCol) versionByKey.set(key, value);
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
        const v = versionByKey.get(key);
        if (!force && typeof v === "number" && v >= FACES_VERSION) continue;
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
