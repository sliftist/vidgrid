// Main-thread client for the metadata-extraction worker.
//
// Owns a single worker, serializes extraction requests, and applies a 30s
// per-file timeout. If the timeout fires (worker is stuck demuxing a
// pathological file) it terminates the worker, fails that job, and spawns a
// fresh worker so the next file can start. The file handle stays here on the
// main thread the whole time — the worker asks for byte ranges via postMessage
// and we slice the File and post the bytes back.

import { ExtractedInfo, KeyframeBundle } from "../MetadataExtractor";
import { MediaFile, facesFp16 } from "../appState";

// Streamed payload from the face-frames worker job. Matches the wire
// format emitted by metadataWorker.ts. Per face, embedding has been
// reconstructed from the transferred ArrayBuffer.
export interface ExtractedFrame {
    timeMs: number;
    jpeg: Uint8Array;
    width: number;
    height: number;
    faces: {
        bbox: { x1: number; y1: number; x2: number; y2: number };
        score: number;
        embedding: Float32Array;
    }[];
}

const EXTRACTION_TIMEOUT_MS = 30_000;
// Face-frame jobs run for the whole video — minutes, not seconds. Use a
// per-frame inactivity timeout instead of a single global one.
const FACE_FRAMES_INACTIVITY_MS = 60_000;
const WORKER_URL = "./metadataWorker.js";

type JobKind = "extract" | "extractKeyframes" | "extractFaceFrames";

interface QueuedJob {
    kind: JobKind;
    file: MediaFile;
    label: string;
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    // Only set for extractFaceFrames — called for each frame as it
    // arrives so the caller can run face detection while the worker is
    // still decoding later frames.
    onFrame?: (f: ExtractedFrame) => Promise<void> | void;
    // Optional throttled heartbeat from the worker (~once per 10s)
    // describing what it's currently chewing on. Used for UI status
    // strings and console logging. currentMs/durationMs let the scan
    // loop aggregate a phase-wide ETA off media-time.
    onProgress?: (info: ProgressInfo) => void;
}

// Public progress payload — what onProgress callers see. The `message`
// is the worker's human-readable summary; currentMs/durationMs (when
// present) describe the in-flight file's media position.
export interface ProgressInfo {
    message: string;
    currentMs?: number;
    durationMs?: number;
}

interface ActiveJob extends QueuedJob {
    jobId: number;
    timeoutId: number;
    framesSeen: number;
}

class MetadataExtractorClient {
    private worker: Worker | undefined;
    private jobIdCounter = 0;
    private active: ActiveJob | undefined;
    private queue: QueuedJob[] = [];

    extract(file: MediaFile, label: string): Promise<ExtractedInfo> {
        return new Promise<ExtractedInfo>((resolve, reject) => {
            const job: QueuedJob = { kind: "extract", file, label, resolve, reject };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    extractKeyframes(file: MediaFile, label: string, onProgress?: (info: ProgressInfo) => void): Promise<KeyframeBundle> {
        return new Promise<KeyframeBundle>((resolve, reject) => {
            const job: QueuedJob = { kind: "extractKeyframes", file, label, resolve, reject, onProgress };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    // Streaming variant. Worker emits one frame at a time; the supplied
    // `onFrame` callback runs against each. Resolves with the total frame
    // count when the worker reports done.
    extractFaceFrames(file: MediaFile, label: string, onFrame: (f: ExtractedFrame) => Promise<void> | void, onProgress?: (info: ProgressInfo) => void): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const job: QueuedJob = { kind: "extractFaceFrames", file, label, resolve, reject, onFrame, onProgress };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    private startJob(job: QueuedJob) {
        const worker = this.ensureWorker();
        const jobId = ++this.jobIdCounter;
        const timeoutMs = job.kind === "extractFaceFrames" ? FACE_FRAMES_INACTIVITY_MS : EXTRACTION_TIMEOUT_MS;
        const timeoutId = window.setTimeout(() => {
            console.warn(`[extractor-client] job ${jobId} (${job.label}) timed out after ${timeoutMs}ms; killing worker`);
            this.failActive(new Error(`Extraction timed out after ${timeoutMs / 1000}s`));
            this.respawnWorker();
        }, timeoutMs);
        this.active = { ...job, jobId, timeoutId, framesSeen: 0 };
        if (job.kind === "extract") {
            worker.postMessage({
                type: "extract",
                jobId,
                label: job.label,
                size: job.file.size,
                fileLastModified: job.file.lastModified,
            });
        } else if (job.kind === "extractKeyframes") {
            worker.postMessage({
                type: "extractKeyframes",
                jobId,
                label: job.label,
                size: job.file.size,
            });
        } else {
            worker.postMessage({
                type: "extractFaceFrames",
                jobId,
                label: job.label,
                size: job.file.size,
                fp16: facesFp16.get(),
            });
        }
    }

    private resetActivityTimeout() {
        if (!this.active) return;
        window.clearTimeout(this.active.timeoutId);
        const job = this.active;
        const timeoutMs = job.kind === "extractFaceFrames" ? FACE_FRAMES_INACTIVITY_MS : EXTRACTION_TIMEOUT_MS;
        job.timeoutId = window.setTimeout(() => {
            console.warn(`[extractor-client] job ${job.jobId} (${job.label}) inactivity timeout (${timeoutMs}ms); killing worker`);
            this.failActive(new Error(`Inactivity timeout (${timeoutMs / 1000}s)`));
            this.respawnWorker();
        }, timeoutMs);
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const w = new Worker(WORKER_URL);
        w.addEventListener("message", this.onMessage);
        w.addEventListener("error", e => {
            console.warn(`[extractor-client] worker crashed:`, e.message || e);
            if (this.active) this.failActive(new Error(`Worker crashed: ${e.message || "unknown"}`));
            this.respawnWorker();
        });
        this.worker = w;
        return w;
    }

    private onMessage = async (e: MessageEvent) => {
        const data = e.data;
        if (!this.active) return;

        if (data.type === "read") {
            const { reqId, start, end } = data;
            try {
                const bytes = await this.active.file.read(start, end);
                // The active job could have been replaced while the read was
                // resolving (timeout fired). Drop the reply if so.
                if (!this.active || !this.worker) return;
                // Transfer the underlying buffer if Uint8Array covers it
                // exactly (zero-copy); otherwise copy to a fresh buffer
                // so we don't ship more than the slice the worker asked
                // for. The worker wraps whatever ArrayBuffer it gets.
                let buf: ArrayBuffer;
                if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
                    buf = bytes.buffer as ArrayBuffer;
                } else {
                    buf = bytes.slice().buffer as ArrayBuffer;
                }
                this.worker.postMessage({ type: "readReply", reqId, bytes: buf }, [buf]);
            } catch (err) {
                if (!this.worker) return;
                this.worker.postMessage({
                    type: "readReply",
                    reqId,
                    bytes: undefined,
                    error: (err as Error).message ?? String(err),
                });
            }
            return;
        }

        if (data.type === "progress" && data.jobId === this.active.jobId) {
            try {
                this.active.onProgress?.({
                    message: data.message as string,
                    currentMs: data.currentMs,
                    durationMs: data.durationMs,
                });
            } catch (err) {
                console.warn(`[extractor-client] onProgress threw (non-fatal):`, err);
            }
            return;
        }

        if (data.type === "result" && data.jobId === this.active.jobId && this.active.kind === "extract") {
            this.completeActive(undefined, data.info);
            return;
        }
        if (data.type === "kfResult" && data.jobId === this.active.jobId && this.active.kind === "extractKeyframes") {
            this.completeActive(undefined, data.bundle);
            return;
        }
        if (data.type === "faceFrame" && data.jobId === this.active.jobId && this.active.kind === "extractFaceFrames") {
            this.active.framesSeen++;
            this.resetActivityTimeout();
            const frame: ExtractedFrame = {
                timeMs: data.timeMs,
                jpeg: new Uint8Array(data.jpeg),
                width: data.width,
                height: data.height,
                faces: (data.faces as { x1: number; y1: number; x2: number; y2: number; score: number; embedding: ArrayBuffer }[]).map(f => ({
                    bbox: { x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2 },
                    score: f.score,
                    embedding: new Float32Array(f.embedding),
                })),
            };
            try {
                await this.active.onFrame?.(frame);
            } catch (err) {
                console.warn(`[extractor-client] onFrame threw, failing job:`, err);
                this.completeActive(err instanceof Error ? err : new Error(String(err)), undefined);
            }
            return;
        }
        if (data.type === "faceFramesDone" && data.jobId === this.active.jobId && this.active.kind === "extractFaceFrames") {
            this.completeActive(undefined, data.totalFrames);
            return;
        }
        if (data.type === "error" && data.jobId === this.active.jobId) {
            this.completeActive(new Error(data.message), undefined);
            return;
        }
    };

    private completeActive(err: Error | undefined, result: ExtractedInfo | KeyframeBundle | undefined) {
        if (!this.active) return;
        const job = this.active;
        window.clearTimeout(job.timeoutId);
        this.active = undefined;
        if (err) job.reject(err);
        else if (result) job.resolve(result);
        else job.reject(new Error("Extraction returned no result"));
        this.drainQueue();
    }

    private failActive(err: Error) {
        this.completeActive(err, undefined);
    }

    private respawnWorker() {
        if (this.worker) {
            try { this.worker.terminate(); } catch { }
            this.worker = undefined;
        }
        // ensureWorker() will start a fresh one on the next extract.
    }

    private drainQueue() {
        const next = this.queue.shift();
        if (next) this.startJob(next);
    }
}

export const metadataExtractorClient = new MetadataExtractorClient();
