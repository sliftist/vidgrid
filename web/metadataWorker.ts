// Worker entry: hosts Mediabunny so we can kill and restart it when a pathological
// file hangs the demuxer. The worker doesn't own the file handle — the main
// thread does — so every byte read goes back across postMessage. That sounds
// expensive but Mediabunny only reads what it actually needs (index + the
// keyframe region around the target timestamp), and it's the price we pay for
// being able to terminate a stuck extraction without losing the file handle.

// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import { CustomSource } from "mediabunny/dist/bundles/mediabunny.cjs";
import { extractMetadataAndThumbs, extractKeyframes, iterateFacesFrames, encodeFrameJpeg, ExtractedInfo, KeyframeBundle } from "./MetadataExtractor";
// Face pipeline now lives in the worker — keeps ORT, the SCRFD/ArcFace
// inference, and all model loading off the main thread. The main bundle
// only sees `extractFaces` for the live paste-image search.
import { getPipeline, MAX_FACES_PER_FRAME, DetectedFace } from "./faceEmbed/index";
import { formatTime } from "socket-function/src/formatting/format";

// One-line progress label with current media position, percent of total
// duration, ETA, and a 'realtime multiplier' (video-seconds processed
// per wall-clock second — i.e. how much faster than playback we are).
// ETA is a linear extrapolation off elapsed wall-clock.
function fmtProgressSuffix(t0: number, currentMs: number, durationMs: number): string {
    const elapsed = performance.now() - t0;
    const rateStr = elapsed > 0 ? `${(currentMs / elapsed).toFixed(1)}× realtime` : "?× realtime";
    if (durationMs <= 0) {
        // We don't know the file's duration so no % or ETA — but we can
        // still show the rate, which is what the user actually cares
        // about while watching the console.
        return ` at ${(currentMs / 1000).toFixed(1)}s (${rateStr})`;
    }
    const pct = (currentMs / durationMs) * 100;
    const etaMs = currentMs > 0 ? elapsed * (durationMs - currentMs) / currentMs : 0;
    const etaStr = currentMs > 0 ? formatTime(etaMs) : "?";
    return ` at ${(currentMs / 1000).toFixed(1)}s/${(durationMs / 1000).toFixed(1)}s (${pct.toFixed(1)}%, ETA ${etaStr}, ${rateStr})`;
}

interface ExtractMsg {
    type: "extract";
    jobId: number;
    label: string;
    size: number;
    fileLastModified: number;
    // Prefer CPU (software) decode — the scan's scanSoftwareDecode setting.
    softwareDecode?: boolean;
}
interface ExtractKeyframesMsg {
    type: "extractKeyframes";
    jobId: number;
    label: string;
    size: number;
    softwareDecode?: boolean;
}
interface ExtractFaceFramesMsg {
    type: "extractFaceFrames";
    jobId: number;
    label: string;
    size: number;
    // Use the float16 model variants (from the "Face models: float16" setting).
    fp16?: boolean;
    softwareDecode?: boolean;
}
interface ReadReplyMsg {
    type: "readReply";
    reqId: number;
    bytes: ArrayBuffer | undefined;
    error?: string;
}
type Inbound = ExtractMsg | ExtractKeyframesMsg | ExtractFaceFramesMsg | ReadReplyMsg;

interface ReadRequestMsg {
    type: "read";
    reqId: number;
    start: number;
    end: number;
}
interface ResultMsg {
    type: "result";
    jobId: number;
    info: ExtractedInfo;
}
interface KeyframesResultMsg {
    type: "kfResult";
    jobId: number;
    bundle: KeyframeBundle;
}
// Wire shape for one detected face inside a streamed faceFrame message.
interface WireFace {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    score: number;
    // Float32Array buffer transferred to the main thread; main side
    // reconstructs via `new Float32Array(buf)`.
    embedding: ArrayBuffer;
}

// Heartbeat-style progress emitted at most once per
// WORKER_PROGRESS_INTERVAL_MS during long-running phases. Consumed by
// MetadataExtractorClient and forwarded to whoever passed onProgress.
// currentMs / durationMs are optional metadata that lets the scan-loop
// aggregate per-phase ETAs by summing video-seconds across files.
interface ProgressMsg {
    type: "progress";
    jobId: number;
    message: string;
    currentMs?: number;
    durationMs?: number;
}

// Streamed per-frame message during a face-frames job. JPEG buffer is
// transferred so the worker doesn't hold onto it.
interface FaceFrameMsg {
    type: "faceFrame";
    jobId: number;
    timeMs: number;
    jpeg: ArrayBuffer;
    width: number;
    height: number;
    faces: WireFace[];
}
interface FaceFramesDoneMsg {
    type: "faceFramesDone";
    jobId: number;
    totalFrames: number;
}
interface ErrorMsg {
    type: "error";
    jobId: number;
    message: string;
}
interface ReadyMsg {
    type: "ready";
}
type Outbound = ReadRequestMsg | ResultMsg | KeyframesResultMsg | FaceFrameMsg | FaceFramesDoneMsg | ProgressMsg | ErrorMsg | ReadyMsg;

// Worker-side throttle interval. Keyframe / face phases can each run for
// minutes per movie; we don't want to flood postMessage. 10s feels right
// — fast jobs emit nothing, slow ones emit a steady heartbeat.
const WORKER_PROGRESS_INTERVAL_MS = 10_000;

// Face-embedding batch window. ArcFace barely uses the GPU at batch=1 and most
// frames have only 1-2 faces, so we detect+align frame-by-frame (SCRFD can't
// batch) and accumulate aligned faces across frames, then embed them all in
// ONE call. Flush when we hit either budget — faces fills the GPU, frames caps
// the wait so the faceFrame heartbeat keeps the worker's inactivity timer alive
// on sparse-face stretches.
const FACE_EMBED_BATCH = 16;
const FRAME_EMBED_BATCH = 24;

// Guard: the bundler executes this entry under Node to enumerate modules. In
// that environment `importScripts` is undefined, so the message wiring stays
// dormant and we don't try to wire up a worker scope that doesn't exist.
declare const importScripts: ((...urls: string[]) => void) | undefined;
if (typeof importScripts === "function") {
    const post = (msg: Outbound, transfer?: Transferable[]) => {
        if (transfer && transfer.length > 0) (self as any).postMessage(msg, transfer);
        else (self as any).postMessage(msg);
    };

    let reqCounter = 0;
    const pendingReads = new Map<number, (bytes: Uint8Array | undefined, err?: string) => void>();

    // Per-job throttle. Resets at job start so a long job followed by a
    // short job doesn't get its progress swallowed by stale state.
    let lastProgressAt = 0;
    function maybePostProgress(jobId: number, message: string, currentMs?: number, durationMs?: number) {
        const now = Date.now();
        if (now - lastProgressAt < WORKER_PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        post({ type: "progress", jobId, message, currentMs, durationMs });
    }

    self.addEventListener("message", async (e: MessageEvent) => {
        const data = e.data as Inbound;

        if (data.type === "readReply") {
            const cb = pendingReads.get(data.reqId);
            if (!cb) return;
            pendingReads.delete(data.reqId);
            cb(data.bytes ? new Uint8Array(data.bytes) : undefined, data.error);
            return;
        }

        if (data.type !== "extract" && data.type !== "extractKeyframes" && data.type !== "extractFaceFrames") return;
        const { jobId, label, size } = data;
        const fileLastModified = data.type === "extract" ? data.fileLastModified : 0;
        const preferSoftware = data.softwareDecode === true;
        // Reset the throttle so the new job's first progress emit happens
        // ~10s into the job, not gated by whatever the previous job did.
        lastProgressAt = Date.now();

        const source = new CustomSource({
            getSize: () => size,
            read: (start, end) => new Promise<Uint8Array>((resolve, reject) => {
                const reqId = ++reqCounter;
                pendingReads.set(reqId, (bytes, err) => {
                    if (bytes) resolve(bytes);
                    else reject(new Error(err || "Read failed"));
                });
                post({ type: "read", reqId, start, end });
            }),
            prefetchProfile: "fileSystem",
        });

        try {
            if (data.type === "extract") {
                const info = await extractMetadataAndThumbs(source, fileLastModified, label, preferSoftware);
                const transfers: ArrayBuffer[] = [];
                if (info.thumb160) transfers.push(info.thumb160.buffer as ArrayBuffer);
                if (info.thumb320) transfers.push(info.thumb320.buffer as ArrayBuffer);
                if (info.thumb640) transfers.push(info.thumb640.buffer as ArrayBuffer);
                post({ type: "result", jobId, info }, transfers);
            } else if (data.type === "extractKeyframes") {
                const tPhase = performance.now();
                const bundle = await extractKeyframes(source, label, (i, total, tMs, durationMs) => {
                    maybePostProgress(jobId, `keyframe ${i}/${total}${fmtProgressSuffix(tPhase, tMs, durationMs)}`, tMs, durationMs);
                }, preferSoftware);
                post({ type: "kfResult", jobId, bundle }, [bundle.data.buffer]);
            } else {
                // Streamed face-frame extraction. Per frame:
                //   1. Decode + letterbox crop + scale (canvas).
                //   2. Detect faces (SCRFD) and align each — eagerly, while the
                //      frame canvas is valid; encode JPEG too (only if faces).
                //   3. Buffer the aligned faces; once a window's worth has
                //      accumulated across frames, embed them ALL in one ArcFace
                //      call and stream each frame's results to main.
                const fp16 = data.fp16 === true;
                const { detector, embedder } = await getPipeline(undefined, { fp16 });
                let count = 0;
                let facesTotal = 0;
                const tPhase = performance.now();

                // Frames that have faces, awaiting a batched embed. Alignment +
                // JPEG are already done (copies), so the frame canvas can be
                // recycled by the generator without affecting buffered work.
                interface Buffered {
                    timeMs: number; width: number; height: number; jpeg: Uint8Array;
                    faces: DetectedFace[]; tensors: Float32Array[];
                }
                let buffer: Buffered[] = [];
                let bufferedFaces = 0;

                const flush = async () => {
                    if (buffer.length === 0) return;
                    const window = buffer; buffer = []; bufferedFaces = 0;
                    let embeddings: Float32Array[];
                    try {
                        embeddings = await embedder.embedTensors(window.flatMap(b => b.tensors));
                    } catch (err) {
                        console.warn(`[worker faces] batched embed failed, dropping ${window.length} frames:`, err);
                        return;
                    }
                    let k = 0;
                    for (const b of window) {
                        const transfers: ArrayBuffer[] = [b.jpeg.buffer as ArrayBuffer];
                        const faces: WireFace[] = b.faces.map((f, i) => {
                            const emb = embeddings[k + i];
                            const buf = emb.buffer.slice(emb.byteOffset, emb.byteOffset + emb.byteLength) as ArrayBuffer;
                            transfers.push(buf as ArrayBuffer);
                            return { x1: f.bbox.x1, y1: f.bbox.y1, x2: f.bbox.x2, y2: f.bbox.y2, score: f.score, embedding: buf };
                        });
                        k += b.faces.length;
                        post({ type: "faceFrame", jobId, timeMs: b.timeMs, jpeg: b.jpeg.buffer as ArrayBuffer, width: b.width, height: b.height, faces }, transfers);
                        count++;
                    }
                };

                for await (const frame of iterateFacesFrames(source, label, preferSoftware)) {
                    // Heartbeat per frame regardless of whether faces were
                    // found — otherwise long faceless passages look stuck.
                    maybePostProgress(jobId, `face frame ${count}${fmtProgressSuffix(tPhase, frame.timeMs, frame.durationMs)} (${facesTotal} faces so far)`, frame.timeMs, frame.durationMs);
                    let detected: DetectedFace[] = [];
                    try {
                        detected = (await detector.detect(frame.canvas))
                            .slice()
                            .sort((a, b) => b.score - a.score)
                            .slice(0, MAX_FACES_PER_FRAME);
                    } catch (err) {
                        console.warn(`[worker faces] detect failed at ${frame.timeMs}ms:`, err);
                        continue;
                    }
                    if (detected.length === 0) continue;
                    facesTotal += detected.length;
                    // Align + JPEG eagerly (the canvas may be recycled next iter).
                    const tensors = detected.map(f => embedder.alignToTensor(frame.canvas, f.landmarks).tensor);
                    const jpeg = await encodeFrameJpeg(frame.canvas);
                    buffer.push({ timeMs: frame.timeMs, width: frame.width, height: frame.height, jpeg, faces: detected, tensors });
                    bufferedFaces += detected.length;
                    if (bufferedFaces >= FACE_EMBED_BATCH || buffer.length >= FRAME_EMBED_BATCH) await flush();
                }
                await flush();
                post({ type: "faceFramesDone", jobId, totalFrames: count });
            }
        } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            post({ type: "error", jobId, message });
        }
    });

    post({ type: "ready" });
}
