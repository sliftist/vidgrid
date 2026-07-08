// Per-file face extraction: stream frames from the worker, run the face
// pipeline on each, write per-face / per-frame / per-character records
// across the three new BulkDatabases.
//
// Cascading storage means a cell that doesn't render faces never pays
// for them — see appState.ts for the key formats.

import {
    files, faceFrames, characters, thumbnails,
    CharacterRecord, FaceFramesRecord, EMBEDDING_FLOATS,
    characterKey,
    openFileByKey, faceThumbnailMode, countFolderVideos, SERIES_FOLDER_THRESHOLD,
    isTimeoutError, markTimedOut, clearTimedOut, isScanAborting,
} from "../appState";
import { FACES_VERSION } from "../MetadataExtractor";
import { metadataExtractorClient, ProgressInfo } from "../scan/MetadataExtractorClient";
import { clusterEmbeddings, SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";
import { generateThumbsFromJpeg, cropFaceAvatarJpeg } from "../scan/thumbnails";

// Per spec: at most 30 characters per video. The per-frame face cap
// (MAX_FACES_PER_FRAME = 10) is enforced inside the worker before it
// streams faces back.
const MAX_CHARACTERS_PER_FILE = 30;

// Only the top N characters (by member count) get a stored face image; the
// rest keep their embeddings but leave the avatar blank to save space.
const TOP_N_FACE_FRAMES = 30;

type BBox = { x1: number; y1: number; x2: number; y2: number };
type ClusterMember = { embedding: Float32Array; timeMs: number; bbox: BBox };
type ClusterT = { sum: Float32Array; count: number; members: ClusterMember[] };

const bboxArea = (b: BBox): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

// Representative face of a cluster = the member with the largest detected
// bbox (biggest → clearest, highest-resolution crop). A REAL member face,
// never an averaged/centroid vector.
function pickRepresentative(members: ClusterMember[]): ClusterMember {
    let best = members[0];
    let bestA = bboxArea(best.bbox);
    for (let i = 1; i < members.length; i++) {
        const a = bboxArea(members[i].bbox);
        if (a > bestA) { best = members[i]; bestA = a; }
    }
    return best;
}

// Minimum face width (in detection-frame pixels) for a thumbnail face.
// Face frames are scaled to ≤640px wide, so 128 means a face filling at
// least ~a fifth of the width — prominent enough to make a good poster.
const THUMB_MIN_FACE_W = 128;
// Ignore the opening credits: only faces past this fraction of the
// runtime are eligible, so a giant title-card face can't be picked.
const THUMB_MIN_TIME_FRACTION = 0.3;

// Promote a representative face of a clustered character to the file
// thumbnail. Which character is controlled by the faceThumbnailMode
// setting: "auto" (default) picks the 2nd character for series folders
// (5+ videos, where the recurring protagonist is uninteresting) and the
// 1st for standalone folders; "second" always uses the second most-common
// character, "first" the most-common, "off" disables this entirely.
// Clusters are pre-sorted by member count descending, so the second
// character is clusters[1] — falling back to the most common when there's
// only one character. "Representative" = the largest real face, restricted
// to faces that are (a) past the first 30% of the runtime and (b) at least
// 128px wide. If nothing qualifies we
// leave the existing thumbnail alone. Skipped entirely when the user
// picked the thumbnail — their pick always wins. Failures here are logged
// but never fail the surrounding extraction.
async function maybeSetFaceThumbnail(
    key: string,
    clusters: ClusterT[],
    frameJpegs: Map<number, Uint8Array>,
): Promise<void> {
    try {
        const mode = faceThumbnailMode.get();
        if (mode === "off") return;
        // "auto": series folders (5+ videos) use the 2nd character, standalone
        // folders use the 1st. "first"/"second" force the choice.
        let useSecond: boolean;
        if (mode === "auto") {
            useSecond = (await countFolderVideos(key)) >= SERIES_FOLDER_THRESHOLD;
        } else {
            useSecond = mode === "second";
        }
        const top = useSecond ? (clusters[1] ?? clusters[0]) : clusters[0];
        if (!top || top.members.length === 0) return;

        const existingSource = await thumbnails.getSingleField(key, "thumbSource");
        if (existingSource === "user") return;

        // Credits cutoff from the video duration; fall back to the latest
        // observed face time if the duration isn't recorded yet.
        const durationSec = await files.getSingleField(key, "durationSec");
        let endMs = (durationSec ?? 0) * 1000;
        if (!(endMs > 0)) {
            for (const m of top.members) endMs = Math.max(endMs, m.timeMs);
        }
        const minTimeMs = endMs * THUMB_MIN_TIME_FRACTION;

        const eligible = top.members.filter(m =>
            m.timeMs >= minTimeMs &&
            (m.bbox.x2 - m.bbox.x1) >= THUMB_MIN_FACE_W
        );
        if (eligible.length === 0) return;

        // Poster face = the largest eligible face (biggest bbox → clearest,
        // highest-resolution crop). A REAL face, never an averaged vector.
        const best = pickRepresentative(eligible);

        const jpeg = frameJpegs.get(best.timeMs);
        if (!jpeg) return;
        const thumbs = await generateThumbsFromJpeg(jpeg);
        await thumbnails.write({ key, ...thumbs, thumbSource: "face" });
    } catch (err) {
        console.warn(`[face-extract] could not set face thumbnail for ${key}:`, err);
    }
}

// Run the whole face-extraction pipeline for one file:
//   1. Stream face-frames from the worker.
//   2. For each frame: decode → detect → embed → keep top-N by score.
//   3. Keep faces + their frame JPEGs in memory for this file only.
//   4. After last frame: cluster all faces, write up to 30 characters —
//      a CharacterRecord summary + a FaceFramesRecord (all member
//      embeddings + times) per cluster — set the file thumbnail, update
//      the FileRecord summary.
//
// onProgress receives the worker's heartbeat string (~once per 10s),
// suitable for logging or displaying in a status line. Fast files just
// don't emit — the entire scan can finish before the first heartbeat.
export async function extractFacesForKey(
    key: string,
    onProgress?: (info: ProgressInfo) => void,
): Promise<{ frameCount: number; faceCount: number; characterCount: number } | undefined> {
    const file = await openFileByKey(key);
    if (!file) return undefined;

    const t0 = performance.now();
    const allFaces: ClusterMember[] = [];
    // Frame JPEGs held in memory for this file only — used after clustering
    // to crop each character's avatar and the file thumbnail, then dropped.
    const frameJpegs = new Map<number, Uint8Array>();
    let framesKept = 0;

    try {
        await metadataExtractorClient.extractFaceFrames(file, `[face-extract ${file.name}]`, async (frame) => {
            // Worker pre-filters frames with no detected faces and caps
            // the per-frame count — we just record what it gave us.
            if (frame.faces.length === 0) return;
            // (no per-frame onProgress here — throttled heartbeat comes
            // from the worker via the onProgress channel below.)

            // Keep the frame JPEG around in memory — faces from the same
            // frame share it; we crop avatars / the thumbnail from it later.
            frameJpegs.set(frame.timeMs, frame.jpeg);

            for (const f of frame.faces) {
                allFaces.push({ embedding: f.embedding, timeMs: frame.timeMs, bbox: f.bbox });
            }
            framesKept++;
        }, onProgress);

        if (allFaces.length === 0) {
            await files.update({
                key,
                facesExtractedAt: Date.now(),
                facesExtractionMs: Math.round(performance.now() - t0),
                facesVersion: FACES_VERSION,
                characterCount: 0,
                faceCount: 0,
                facesError: "",
            });
            return { frameCount: framesKept, faceCount: 0, characterCount: 0 };
        }

        // Cluster the per-video face set into characters (cap 30).
        const clusters = clusterEmbeddings(allFaces, SAME_CHARACTER_THRESHOLD, item => item.embedding);
        clusters.sort((a, b) => b.members.length - a.members.length);
        const keptClusters = clusters.slice(0, MAX_CHARACTERS_PER_FILE);
        // faceCount reflects only the faces we actually persist — the members
        // of the kept (top-N) characters. Faces in clusters past the cap are
        // dropped and never stored, so they don't count.
        const keptFaceCount = keptClusters.reduce((sum, c) => sum + c.members.length, 0);

        // One CharacterRecord (the summary) + one FaceFramesRecord (the
        // heavy per-frame embeddings) per kept cluster, sharing the key.
        const charsToWrite: CharacterRecord[] = [];
        const framesToWrite: FaceFramesRecord[] = [];
        for (let ci = 0; ci < keptClusters.length; ci++) {
            const c = keptClusters[ci];
            // Representative ("best") face = the cluster's largest detected
            // face (biggest bbox → clearest, highest-resolution crop). A REAL
            // face, never an average — averaged embeddings are meaningless and
            // must not be stored or searched.
            const bestMember = pickRepresentative(c.members);
            // Crop the avatar from the best face's frame. Best-effort — a
            // missing frame (shouldn't happen) just leaves the avatar unset.
            let avatarJpeg: Uint8Array | undefined;
            const bestFrame = ci < TOP_N_FACE_FRAMES ? frameJpegs.get(bestMember.timeMs) : undefined;
            if (bestFrame) {
                try {
                    avatarJpeg = await cropFaceAvatarJpeg(bestFrame, bestMember.bbox);
                } catch (err) {
                    console.warn(`[face-extract] avatar crop failed for ${key}#${ci}:`, err);
                }
            }
            charsToWrite.push({
                key: characterKey(key, ci),
                fileKey: key,
                characterIdx: ci,
                bestFaceTimeMs: bestMember.timeMs,
                bestFaceEmbedding: bestMember.embedding,
                memberCount: c.members.length,
                avatarJpeg,
            });
            // Concatenate every member embedding + its time into one record.
            const embeddings = new Float32Array(c.members.length * EMBEDDING_FLOATS);
            const frameTimes = new Float32Array(c.members.length);
            for (let m = 0; m < c.members.length; m++) {
                embeddings.set(c.members[m].embedding, m * EMBEDDING_FLOATS);
                frameTimes[m] = c.members[m].timeMs;
            }
            framesToWrite.push({
                key: characterKey(key, ci),
                embeddings,
                embeddingCount: c.members.length,
                frameTimes,
            });
        }

        await characters.writeBatch(charsToWrite);
        await faceFrames.writeBatch(framesToWrite);

        // Use the most-common character's largest face-frame as the file
        // thumbnail — unless the user already picked one explicitly.
        await maybeSetFaceThumbnail(key, keptClusters, frameJpegs);

        const elapsed = Math.round(performance.now() - t0);
        await files.update({
            key,
            facesExtractedAt: Date.now(),
            facesExtractionMs: elapsed,
            facesVersion: FACES_VERSION,
            characterCount: keptClusters.length,
            faceCount: keptFaceCount,
            facesError: "",
        });
        clearTimedOut(key);
        console.log(`[face-extract] ${file.name}: ${framesKept} frames, ${keptFaceCount} faces, ${keptClusters.length} characters in ${elapsed}ms`);
        return { frameCount: framesKept, faceCount: keptFaceCount, characterCount: keptClusters.length };
    } catch (err) {
        // Scan abort (tab hidden) terminated the worker — not a real failure.
        // Skip recording so the file stays eligible and retries on resume.
        if (isScanAborting()) return undefined;
        const msg = err instanceof Error ? err.message : String(err);
        if (isTimeoutError(msg)) markTimedOut(key);
        console.warn(`[face-extract] failed for ${key}:`, err);
        try {
            await files.update({
                key,
                facesExtractedAt: Date.now(),
                facesVersion: FACES_VERSION,
                facesError: msg,
            });
        } catch (writeErr) {
            console.warn(`[face-extract] could not record error:`, writeErr);
        }
        return undefined;
    }
}
