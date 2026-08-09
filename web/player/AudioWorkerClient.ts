// Main-thread client for the audio decode worker (audioDecodeWorker.ts).
//
// One module-level worker, reused across playback sessions (spawning per video
// would re-parse the multi-MB bundle every open). One active job at a time —
// starting a new job implicitly supersedes the old one, and messages are
// routed by jobId so a superseded job's in-flight samples are dropped.

export interface WorkerPcm {
    timestamp: number;       // media seconds
    duration: number;        // seconds
    sampleRate: number;
    numberOfChannels: number;
    numberOfFrames: number;
    // f32-planar: [ch0 frames][ch1 frames]...
    planar: Float32Array;
}

export interface AudioWorkerJob {
    // Raise the decode ceiling: the worker decodes + posts samples up to this
    // media time, then parks. Send audioClock + bufferAhead periodically.
    pull(untilMediaSec: number): void;
    stop(): void;
}

interface ActiveJob {
    id: number;
    onSample: (p: WorkerPcm) => void;
    onEnded: () => void;
    onError: (err: Error) => void;
}

let worker: Worker | undefined;
let active: ActiveJob | undefined;
let jobCounter = 0;

function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker("./audioDecodeWorker.js");
    w.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as any;
        if (!d) return;
        const a = active;
        if (!a || d.jobId !== a.id) return; // superseded job — drop
        if (d.type === "sample") {
            a.onSample({
                timestamp: d.timestamp, duration: d.duration, sampleRate: d.sampleRate,
                numberOfChannels: d.numberOfChannels, numberOfFrames: d.numberOfFrames,
                planar: new Float32Array(d.planar as ArrayBuffer),
            });
        } else if (d.type === "ended") {
            active = undefined;
            a.onEnded();
        } else if (d.type === "error") {
            active = undefined;
            const err = new Error(String(d.message));
            // Adopt the WORKER-side stack so console.error(err) shows where it
            // actually failed, not this rethrow site.
            if (typeof d.stack === "string" && d.stack) {
                err.stack = `[audioDecodeWorker] ${d.stack}`;
            }
            a.onError(err);
        }
    });
    w.addEventListener("error", e => {
        // Worker crashed — fail the active job (VideoPlayer falls back /
        // surfaces it) and drop the worker so the next job respawns a fresh one.
        console.warn(`[audioWorker] worker crashed:`, e.message || e);
        const a = active;
        active = undefined;
        try { w.terminate(); } catch { /* ignore */ }
        if (worker === w) worker = undefined;
        a?.onError(new Error(`audio decode worker crashed: ${e.message || "unknown"}`));
    });
    worker = w;
    return w;
}

export function startAudioWorkerJob(opts: {
    blob: Blob;
    startSec: number;
    initialUntilSec: number;
    onSample: (p: WorkerPcm) => void;
    onEnded: () => void;
    onError: (err: Error) => void;
}): AudioWorkerJob {
    const w = ensureWorker();
    const id = ++jobCounter;
    active = { id, onSample: opts.onSample, onEnded: opts.onEnded, onError: opts.onError };
    w.postMessage({ type: "start", jobId: id, blob: opts.blob, startSec: opts.startSec, untilMediaSec: opts.initialUntilSec });
    return {
        pull: (untilMediaSec: number) => {
            if (!active || active.id !== id) return;
            try { w.postMessage({ type: "pull", jobId: id, untilMediaSec }); } catch { /* worker gone */ }
        },
        stop: () => {
            if (active && active.id === id) active = undefined;
            try { w.postMessage({ type: "stop", jobId: id }); } catch { /* worker gone */ }
        },
    };
}
