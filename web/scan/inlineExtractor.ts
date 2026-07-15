// In-process extractor for the background SharedWorker.
//
// The SharedWorker cannot spawn a nested dedicated Worker (`Worker` is not
// defined in a SharedWorkerGlobalScope in browsers we target — that's the
// "Worker is not defined" scan failure). But it doesn't need to: a SharedWorker
// has WebCodecs + WebGPU + OffscreenCanvas, and it owns the directory handle, so
// it can run mediabunny + the face pipeline directly and read bytes straight
// from the file — no postMessage read-bridge. This mirrors metadataWorker.ts but
// runs inline, exposing the same method surface MetadataExtractorClient did so
// workerScanCore just swaps one for the other.

import { CustomSource } from "mediabunny/dist/bundles/mediabunny.cjs";
import {
    extractMetadataAndThumbs, extractKeyframes, iterateFacesFrames, encodeFrameJpeg,
    ExtractedInfo, KeyframeBundle,
} from "../MetadataExtractor";
import { getPipeline, MAX_FACES_PER_FRAME, DetectedFace } from "../faceEmbed/index";
import type { ReadableFile, ExtractedFrame, ProgressInfo } from "./MetadataExtractorClient";

// Face-embedding batch windows (match metadataWorker.ts): most frames have 1-2
// faces, so we detect+align frame-by-frame and embed a window in one GPU call.
const FACE_EMBED_BATCH = 16;
const FRAME_EMBED_BATCH = 24;

export class InlineExtractor {
    // Set true to stop an in-flight face extraction (scanning was disabled). The
    // metadata/keyframes calls are single awaits and finish on their own.
    private aborted = false;

    abort(): void {
        this.aborted = true;
    }

    private makeSource(file: ReadableFile): CustomSource {
        return new CustomSource({
            getSize: () => file.size,
            read: (start, end) => file.read(start, end),
            prefetchProfile: "fileSystem",
        });
    }

    async extract(file: ReadableFile, label: string, softwareDecode?: boolean): Promise<ExtractedInfo> {
        this.aborted = false;
        return extractMetadataAndThumbs(this.makeSource(file), file.lastModified, label, softwareDecode === true);
    }

    async extractKeyframes(file: ReadableFile, label: string, onProgress?: (info: ProgressInfo) => void, softwareDecode?: boolean): Promise<KeyframeBundle> {
        this.aborted = false;
        return extractKeyframes(this.makeSource(file), label, (i, total, tMs, durationMs) => {
            // Abort between keyframes so a play-triggered abort stops promptly.
            if (this.aborted) throw new Error("Scan aborted");
            try { onProgress?.({ message: `keyframe ${i}/${total}`, currentMs: tMs, durationMs }); } catch { /* non-fatal */ }
        }, softwareDecode === true);
    }

    // Streamed face-frame extraction. Per frame: decode → detect → align → embed
    // (batched) → onFrame. Resolves with the number of frames that had faces.
    async extractFaceFrames(
        file: ReadableFile,
        label: string,
        onFrame: (f: ExtractedFrame) => Promise<void> | void,
        onProgress?: (info: ProgressInfo) => void,
        fp16?: boolean,
        softwareDecode?: boolean,
    ): Promise<number> {
        this.aborted = false;
        const source = this.makeSource(file);
        const { detector, embedder } = await getPipeline(undefined, { fp16: fp16 === true });
        let count = 0;
        let facesTotal = 0;

        interface Buffered { timeMs: number; width: number; height: number; jpeg: Uint8Array; faces: DetectedFace[]; tensors: Float32Array[]; }
        let buffer: Buffered[] = [];
        let bufferedFaces = 0;

        const flush = async () => {
            if (buffer.length === 0) return;
            const window = buffer; buffer = []; bufferedFaces = 0;
            let embeddings: Float32Array[];
            try {
                embeddings = await embedder.embedTensors(window.flatMap(b => b.tensors));
            } catch (err) {
                console.warn(`[inline faces] batched embed failed, dropping ${window.length} frames:`, err);
                return;
            }
            let k = 0;
            for (const b of window) {
                const faces = b.faces.map((f, i) => ({
                    bbox: { x1: f.bbox.x1, y1: f.bbox.y1, x2: f.bbox.x2, y2: f.bbox.y2 },
                    score: f.score,
                    embedding: embeddings[k + i],
                }));
                k += b.faces.length;
                await onFrame({ timeMs: b.timeMs, jpeg: b.jpeg, width: b.width, height: b.height, faces });
                count++;
            }
        };

        for await (const frame of iterateFacesFrames(source, label, softwareDecode === true)) {
            if (this.aborted) throw new Error("Scan aborted");
            try { onProgress?.({ message: `face frame ${count}`, currentMs: frame.timeMs, durationMs: frame.durationMs }); } catch { /* non-fatal */ }
            let detected: DetectedFace[] = [];
            try {
                detected = (await detector.detect(frame.canvas)).slice().sort((a, b) => b.score - a.score).slice(0, MAX_FACES_PER_FRAME);
            } catch (err) {
                console.warn(`[inline faces] detect failed at ${frame.timeMs}ms:`, err);
                continue;
            }
            if (detected.length === 0) continue;
            facesTotal += detected.length;
            // Align + JPEG eagerly (the canvas may be recycled next iteration).
            const tensors = detected.map(f => embedder.alignToTensor(frame.canvas, f.landmarks).tensor);
            const jpeg = await encodeFrameJpeg(frame.canvas);
            buffer.push({ timeMs: frame.timeMs, width: frame.width, height: frame.height, jpeg, faces: detected, tensors });
            bufferedFaces += detected.length;
            if (bufferedFaces >= FACE_EMBED_BATCH || buffer.length >= FRAME_EMBED_BATCH) await flush();
        }
        await flush();
        return count;
    }
}
