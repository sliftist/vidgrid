// Main-thread client for the speech-to-text worker (asrWorker.ts).
//
// One module-level worker, created on first use so tabs that never generate
// subtitles never pay for it -- and never disposed, because it holds a 650 MB
// model whose whole point is to be loaded once.

import { BUILD_TIMESTAMP } from "../../buildVersion";
import { asrEngine, asrLanguage, ensureFolder } from "../appState";
import { AsrWord } from "./asr";

export interface AsrJobHandlers {
    // `fraction` is progress through the span currently being transcribed.
    onWords: (words: AsrWord[], processedToSec: number, fraction: number) => void;
    // One handed-over span has been transcribed end to end.
    onSpanDone: (processedToSec: number) => void;
    onProgress: (message: string, fraction: number | undefined) => void;
    onError: (err: Error) => void;
}

export interface AsrJob {
    // Hand over a whole span of 16 kHz mono audio. One message, one transfer.
    transcribe(pcm: Float32Array, startSec: number): void;
    stop(): void;
}

interface ActiveJob extends AsrJobHandlers { id: number; }

let worker: Worker | undefined;
let active: ActiveJob | undefined;
let jobCounter = 0;
// Resolvers for preloadSpeechModel(); the worker reports one "ready" for the
// single model it owns, so everyone waiting is satisfied at once.
let readyWaiters: { resolve: (r: SpeechRuntime) => void; reject: (e: Error) => void; onProgress?: (m: string, f: number | undefined) => void }[] = [];
let modelReady = false;
// Which execution provider the worker actually ended up on -- not what was
// asked for. ORT drops an unavailable provider and carries on, so these differ.
let readyBackend = "";
let readyThreads = 1;

export interface SpeechRuntime { backend: string; threads: number; }
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
    // The worker stores the speech model in the shared folder, and can't run
    // the picker itself, so hand it the already-resolved root. Sent even when
    // undefined -- the worker waits for this message before loading.
    void ensureFolder().then(handle => w.postMessage({ type: "storageRoot", handle }));
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
            readyThreads = Number(d.threads) || 1;
            console.log(`[asr] speech model running on: ${readyBackend}, ${readyThreads} thread(s), `
                + `crossOriginIsolated=${(self as any).crossOriginIsolated}`);
            const waiters = readyWaiters;
            readyWaiters = [];
            for (const r of waiters) r.resolve({ backend: readyBackend, threads: readyThreads });
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
        if (d.type === "unloaded") { modelReady = false; return; }
        if (!active || d.jobId !== active.id) return;      // superseded job
        if (d.type === "words") {
            active.onWords(d.words as AsrWord[], d.processedToSec, Number(d.fraction) || 0);
        } else if (d.type === "spanDone") active.onSpanDone(d.processedToSec);
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
// Resolves with what the model ACTUALLY loaded on -- provider and thread count
// -- rather than what was requested.
export function preloadSpeechModel(
    useWebGpu: boolean,
    onProgress?: (message: string, fraction: number | undefined) => void,
): Promise<SpeechRuntime> {
    const w = ensureWorker(useWebGpu);
    if (modelReady) return Promise.resolve({ backend: readyBackend, threads: readyThreads });
    return new Promise<SpeechRuntime>((resolve, reject) => {
        readyWaiters.push({ resolve, reject, onProgress });
        w.postMessage({
            type: "load", useWebGpu,
            engine: asrEngine.get(), language: asrLanguage.get(),
        });
    });
}

export function startAsrJob(useWebGpu: boolean, handlers: AsrJobHandlers): AsrJob {
    const w = ensureWorker(useWebGpu);
    const id = ++jobCounter;
    active = { id, ...handlers };
    w.postMessage({
        type: "start", jobId: id, useWebGpu,
        engine: asrEngine.get(), language: asrLanguage.get(),
    });
    const send = (message: any, transfer?: Transferable[]) => {
        if (!active || active.id !== id) return;
        try { w.postMessage(message, (transfer ?? []) as any); } catch { /* worker gone */ }
    };
    return {
        transcribe: (pcm, startSec) => send(
            { type: "transcribe", jobId: id, pcm: pcm.buffer, startSec }, [pcm.buffer]),
        stop: () => {
            if (active && active.id === id) active = undefined;
            try { w.postMessage({ type: "stop", jobId: id }); } catch { /* worker gone */ }
        },
    };
}

// Release the speech model's sessions, which is the only thing that gives its
// GPU memory back. Kept separate from terminating the worker: the worker is
// cheap and its ORT wasm module is expensive to re-instantiate, so a second
// transcript in the same tab should reload only the weights.
export function unloadSpeechModel(): void {
    if (!worker) return;
    active = undefined;
    modelReady = false;
    try { worker.postMessage({ type: "unload" }); } catch { /* worker gone */ }
}
