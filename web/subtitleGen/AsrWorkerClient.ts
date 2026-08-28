// Main-thread client for the speech-to-text worker (asrWorker.ts).
//
// One module-level worker, created on first use so tabs that never generate
// subtitles never pay for it -- and never disposed, because it holds a 650 MB
// model whose whole point is to be loaded once.

import { BUILD_TIMESTAMP } from "../../buildVersion";
import { WorkerPcm } from "../player/AudioWorkerClient";
import { AsrWord } from "./asr";

export interface AsrJobHandlers {
    onWords: (words: AsrWord[], processedToSec: number) => void;
    // Every buffered sample has been transcribed after a flush().
    onDrained: (processedToSec: number) => void;
    onProgress: (message: string, fraction: number | undefined) => void;
    onError: (err: Error) => void;
}

export interface AsrJob {
    pcm(p: WorkerPcm): void;
    // End of audio: transcribe the tail rather than waiting for a full window.
    flush(): void;
    stop(): void;
}

interface ActiveJob extends AsrJobHandlers { id: number; }

let worker: Worker | undefined;
let active: ActiveJob | undefined;
let jobCounter = 0;
// Resolvers for preloadSpeechModel(); the worker reports one "ready" for the
// single model it owns, so everyone waiting is satisfied at once.
let readyWaiters: { resolve: (backend: string) => void; reject: (e: Error) => void; onProgress?: (m: string, f: number | undefined) => void }[] = [];
let modelReady = false;
// Which execution provider the worker actually ended up on -- not what was
// asked for. ORT drops an unavailable provider and carries on, so these differ.
let readyBackend = "";
// Which execution provider the live worker's sessions were built against. The
// choice is baked into the ONNX sessions, so changing the setting means
// throwing the worker away -- there is no cheaper way to switch.
let workerUseWebGpu = false;

function ensureWorker(useWebGpu: boolean): Worker {
    if (worker && workerUseWebGpu !== useWebGpu) {
        try { worker.terminate(); } catch { /* already gone */ }
        worker = undefined;
        active = undefined;
        modelReady = false;
        readyBackend = "";
        const stale = readyWaiters;
        readyWaiters = [];
        for (const r of stale) r.reject(new Error("Speech backend changed; retry."));
    }
    workerUseWebGpu = useWebGpu;
    if (worker) return worker;
    // ?v= build stamp: the static server caches .js for a year (immutable), so
    // an unversioned URL keeps serving a stale worker across deploys.
    const w = new Worker(`./asrWorker.js?v=${encodeURIComponent(BUILD_TIMESTAMP)}`);
    w.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as any;
        if (!d) return;

        if (d.type === "progress") {
            active?.onProgress(d.message, d.fraction);
            for (const r of readyWaiters) r.onProgress?.(d.message, d.fraction);
            return;
        }
        if (d.type === "ready") {
            modelReady = true;
            readyBackend = String(d.backend || "");
            console.log(`[asr] speech model running on: ${readyBackend}`);
            const waiters = readyWaiters;
            readyWaiters = [];
            for (const r of waiters) r.resolve(readyBackend);
            return;
        }
        if (d.type === "error") {
            const err = new Error(String(d.message));
            const waiters = readyWaiters;
            readyWaiters = [];
            for (const r of waiters) r.reject(err);
            if (active && d.jobId === active.id) active.onError(err);
            return;
        }
        if (!active || d.jobId !== active.id) return;      // superseded job
        if (d.type === "words") active.onWords(d.words as AsrWord[], d.processedToSec);
        else if (d.type === "drained") active.onDrained(d.processedToSec);
    });
    w.addEventListener("error", e => {
        const err = new Error(`speech worker crashed: ${e.message || "unknown"}`);
        console.warn("[asrWorker] crashed:", e.message || e);
        const a = active;
        active = undefined;
        modelReady = false;
        const waiters = readyWaiters;
        readyWaiters = [];
        for (const r of waiters) r.reject(err);
        try { w.terminate(); } catch { /* already gone */ }
        if (worker === w) worker = undefined;
        a?.onError(err);
    });
    worker = w;
    return w;
}

// Downloads and instantiates the model without transcribing anything. Used by
// the settings panel so the first real use is not a multi-minute stall.
// Resolves with the execution provider the model actually loaded on.
export function preloadSpeechModel(
    useWebGpu: boolean,
    onProgress?: (message: string, fraction: number | undefined) => void,
): Promise<string> {
    const w = ensureWorker(useWebGpu);
    if (modelReady) return Promise.resolve(readyBackend);
    return new Promise<string>((resolve, reject) => {
        readyWaiters.push({ resolve, reject, onProgress });
        w.postMessage({ type: "load", useWebGpu });
    });
}

export function startAsrJob(useWebGpu: boolean, handlers: AsrJobHandlers): AsrJob {
    const w = ensureWorker(useWebGpu);
    const id = ++jobCounter;
    active = { id, ...handlers };
    w.postMessage({ type: "start", jobId: id, useWebGpu });
    const send = (message: any, transfer?: Transferable[]) => {
        if (!active || active.id !== id) return;
        try { w.postMessage(message, (transfer ?? []) as any); } catch { /* worker gone */ }
    };
    return {
        pcm: p => send({
            type: "pcm", jobId: id, timestamp: p.timestamp, sampleRate: p.sampleRate,
            numberOfChannels: p.numberOfChannels, numberOfFrames: p.numberOfFrames,
            planar: p.planar.buffer,
        }, [p.planar.buffer]),
        flush: () => send({ type: "flush", jobId: id }),
        stop: () => {
            if (active && active.id === id) active = undefined;
            try { w.postMessage({ type: "stop", jobId: id }); } catch { /* worker gone */ }
        },
    };
}
