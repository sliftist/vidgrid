// Main-thread client for the metadata-extraction worker.
//
// Owns a single worker, serializes extraction requests, and applies a 30s
// per-file timeout. If the timeout fires (worker is stuck demuxing a
// pathological file) it terminates the worker, fails that job, and spawns a
// fresh worker so the next file can start. The file handle stays here on the
// main thread the whole time — the worker asks for byte ranges via postMessage
// and we slice the File and post the bytes back.

import { ExtractedInfo, KeyframeBundle } from "../MetadataExtractor";
import { throttleScanRead } from "./scanThrottle";

// Minimal surface this client needs from a file: enough bytes to feed the
// worker's read-bridge, plus size/lastModified for the extract message. Kept as
// a local structural interface (NOT an import of appState's MediaFile) so this
// module stays free of appState — it must be importable from the background
// SharedWorker, which cannot load appState's DOM/UI surface. appState's
// MediaFile is structurally assignable to this.
export interface ReadableFile {
    name: string;
    size: number;
    lastModified: number;
    read(start: number, end: number): Promise<Uint8Array>;
}

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

// Plain-language timeout message per phase. NB: this is a NO-RESPONSE timeout —
// it's reset by any activity (byte reads, progress, decoded frames), so a
// slow-but-working file is fine; it only fires when the worker goes silent for
// the whole window (stuck/hung). Surfaced in the Scanning table's error column,
// so it must be understandable without knowing the internals.
function timeoutMessage(kind: JobKind, seconds: number): string {
    if (kind === "extract") return `No response for ${seconds}s while reading this video's metadata (the decoder is stuck) — the file is likely corrupt, truncated, or an unsupported format/codec.`;
    if (kind === "extractKeyframes") return `No response for ${seconds}s while generating keyframe thumbnails (the decoder is stuck) — the file is likely corrupt or an unsupported format/codec.`;
    return `No video frame decoded for ${seconds}s (the decoder is stuck) — the file is likely corrupt or an unsupported format/codec.`;
}

interface QueuedJob {
    kind: JobKind;
    file: ReadableFile;
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
    // Only for extractFaceFrames — selects the float16 model variants. Passed
    // in per-call (was read from appState's facesFp16 box; this module is now
    // appState-free so the caller supplies it).
    fp16?: boolean;
    // Prefer CPU (software) decode for this job — the scan's scanSoftwareDecode
    // setting (independent of the player's own softwareDecode).
    softwareDecode?: boolean;
    // Stretches every timeout for this job (inactivity + ping watchdog). The
    // coordinator passes 4 when the phase backlog is tiny (maintenance mode —
    // worth waiting much longer on a hard file), 1 for a big queue.
    timeoutMultiplier?: number;
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
    // ReturnType<typeof setTimeout> rather than number: this module now uses the
    // global setTimeout (was window.setTimeout) so it works in the SharedWorker
    // too, and the global's return type differs between DOM and Node typings.
    timeoutId: ReturnType<typeof setTimeout>;
    framesSeen: number;
}

export class MetadataExtractorClient {
    private worker: Worker | undefined;
    private jobIdCounter = 0;
    private active: ActiveJob | undefined;
    private queue: QueuedJob[] = [];
    // Liveness watchdog: ping the worker every 15s while a job is active. A pong
    // resets the miss counter; if it misses more than 3 in a row (~a minute of a
    // frozen event loop — a bad file hanging the decoder synchronously), we assume
    // it's dead, terminate it, and fail the active job so the file is retried /
    // eventually blacklisted.
    private pingInterval: ReturnType<typeof setInterval> | undefined;
    private awaitingPong = false;
    private missedPings = 0;

    private startWatchdog(): void {
        if (this.pingInterval) return;
        this.awaitingPong = false;
        this.missedPings = 0;
        this.pingInterval = setInterval(() => {
            if (!this.worker || !this.active) return;
            if (this.awaitingPong) {
                this.missedPings++;
                if (this.missedPings > 3 * (this.active.timeoutMultiplier ?? 1)) {
                    console.warn(`[extractor-client] worker unresponsive (missed ${this.missedPings} pings); killing`);
                    this.failActive(new Error("Worker unresponsive — hung on a bad file"));
                    this.respawnWorker();
                    return;
                }
            }
            this.awaitingPong = true;
            try { this.worker.postMessage({ type: "ping" }); } catch { /* respawn handles it */ }
        }, 15_000);
    }
    private stopWatchdog(): void {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = undefined; }
        this.awaitingPong = false;
        this.missedPings = 0;
    }

    extract(file: ReadableFile, label: string, softwareDecode?: boolean, timeoutMultiplier?: number): Promise<ExtractedInfo> {
        return new Promise<ExtractedInfo>((resolve, reject) => {
            const job: QueuedJob = { kind: "extract", file, label, resolve, reject, softwareDecode, timeoutMultiplier };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    extractKeyframes(file: ReadableFile, label: string, onProgress?: (info: ProgressInfo) => void, softwareDecode?: boolean, timeoutMultiplier?: number): Promise<KeyframeBundle> {
        return new Promise<KeyframeBundle>((resolve, reject) => {
            const job: QueuedJob = { kind: "extractKeyframes", file, label, resolve, reject, onProgress, softwareDecode, timeoutMultiplier };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    // Streaming variant. Worker emits one frame at a time; the supplied
    // `onFrame` callback runs against each. Resolves with the total frame
    // count when the worker reports done.
    extractFaceFrames(file: ReadableFile, label: string, onFrame: (f: ExtractedFrame) => Promise<void> | void, onProgress?: (info: ProgressInfo) => void, fp16?: boolean, softwareDecode?: boolean, timeoutMultiplier?: number): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const job: QueuedJob = { kind: "extractFaceFrames", file, label, resolve, reject, onFrame, onProgress, fp16, softwareDecode, timeoutMultiplier };
            if (this.active) this.queue.push(job);
            else this.startJob(job);
        });
    }

    // Hard-stop everything: reject queued jobs, fail the active one, and
    // terminate the worker so any in-flight disk read stops immediately. Used
    // when the tab is backgrounded — a hidden tab must not touch the disk.
    abort(): void {
        const pending = this.queue.splice(0);
        for (const job of pending) job.reject(new Error("Scan aborted"));
        if (this.active) {
            this.failActive(new Error("Scan aborted"));
            this.respawnWorker();
        }
    }

    private jobTimeoutMs(job: QueuedJob): number {
        return (job.kind === "extractFaceFrames" ? FACE_FRAMES_INACTIVITY_MS : EXTRACTION_TIMEOUT_MS) * (job.timeoutMultiplier ?? 1);
    }

    private startJob(job: QueuedJob) {
        const worker = this.ensureWorker();
        const jobId = ++this.jobIdCounter;
        const timeoutMs = this.jobTimeoutMs(job);
        const timeoutId = setTimeout(() => {
            console.warn(`[extractor-client] job ${jobId} (${job.label}) timed out after ${timeoutMs}ms; killing worker`);
            this.failActive(new Error(timeoutMessage(job.kind, timeoutMs / 1000)));
            this.respawnWorker();
        }, timeoutMs);
        this.active = { ...job, jobId, timeoutId, framesSeen: 0 };
        this.startWatchdog();
        this.awaitingPong = false;
        this.missedPings = 0;
        if (job.kind === "extract") {
            worker.postMessage({
                type: "extract",
                jobId,
                label: job.label,
                size: job.file.size,
                fileLastModified: job.file.lastModified,
                softwareDecode: job.softwareDecode === true,
            });
        } else if (job.kind === "extractKeyframes") {
            worker.postMessage({
                type: "extractKeyframes",
                jobId,
                label: job.label,
                size: job.file.size,
                softwareDecode: job.softwareDecode === true,
            });
        } else {
            worker.postMessage({
                type: "extractFaceFrames",
                jobId,
                label: job.label,
                size: job.file.size,
                fp16: job.fp16 === true,
                softwareDecode: job.softwareDecode === true,
            });
        }
    }

    private resetActivityTimeout() {
        if (!this.active) return;
        clearTimeout(this.active.timeoutId);
        const job = this.active;
        const timeoutMs = this.jobTimeoutMs(job);
        job.timeoutId = setTimeout(() => {
            console.warn(`[extractor-client] job ${job.jobId} (${job.label}) inactivity timeout (${timeoutMs}ms); killing worker`);
            this.failActive(new Error(timeoutMessage(job.kind, timeoutMs / 1000)));
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
        if (data && data.type === "pong") { this.awaitingPong = false; this.missedPings = 0; return; }
        if (!this.active) return;

        if (data.type === "read") {
            const { reqId, start, end } = data;
            try {
                const bytes = await this.active.file.read(start, end);
                // The active job could have been replaced while the read was
                // resolving (timeout fired). Drop the reply if so.
                if (!this.active || !this.worker) return;
                // Auto-scan disk throttle: the scan may deliberately rest here
                // to give the disk a breather. Refresh the watchdog around the
                // pause so a throttle rest isn't mistaken for a stuck worker.
                if (await throttleScanRead(bytes.byteLength, () => this.resetActivityTimeout())) {
                    if (!this.active || !this.worker) return;
                    this.resetActivityTimeout();
                }
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
            // A progress heartbeat is a sign of life — reset the inactivity timeout
            // so a slow-but-working extraction is never killed for taking a while.
            this.resetActivityTimeout();
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
        clearTimeout(job.timeoutId);
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
        else this.stopWatchdog(); // nothing left to run — stop pinging
    }
}

export const metadataExtractorClient = new MetadataExtractorClient();
