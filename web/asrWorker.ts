// Speech-to-text worker: Parakeet TDT runs here, not on the main thread.
//
// This is not tidiness. Without cross-origin isolation onnxruntime-web has no
// SharedArrayBuffer, so it runs single-threaded and its WASM kernels block
// whatever thread they are on for seconds at a time. On the main thread that
// froze the player while it transcribed. Here it competes with nothing.
//
// Protocol (one active job at a time; a new "start" supersedes the old):
//   main -> worker:
//     { type: "load", useWebGpu }            // preload the model, no job
//     { type: "start", jobId, useWebGpu }
//     { type: "pcm", jobId, timestamp, sampleRate, numberOfChannels,
//       numberOfFrames, planar /* transferred ArrayBuffer, f32-planar */ }
//     { type: "flush", jobId }               // end of audio: drain the tail
//     { type: "stop", jobId }
//   worker -> main:
//     { type: "progress", message, fraction }
//     { type: "ready", backend, threads }
//     { type: "words", jobId, words, processedToSec }
//     { type: "drained", jobId, processedToSec }
//     { type: "error", jobId, message }
//
// Backpressure is the caller's job: it raises the decoder's ceiling off the
// `processedToSec` we report, so audio never piles up faster than we consume
// it. See generator.ts.

import { setStorageRootOverride } from "sliftutils/storage/FileFolderAPI";
import { chunkAudio } from "./subtitleGen/asr";
import { SPEECH_SAMPLE_RATE } from "./subtitleGen/models";
import { getOrtThreads, loadParakeet, ParakeetModel, unloadParakeet } from "./subtitleGen/parakeet";

// The bundler executes this entry under Node to enumerate modules; the worker
// wiring must stay dormant there (same guard as audioDecodeWorker).
declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    const ctx: DedicatedWorkerGlobalScope = self as any;

    let jobId = 0;
    // Chunk processing is serialised: the model is one set of sessions, and
    // running two chunks through it at once interleaves their decoder state.
    let chain: Promise<void> = Promise.resolve();

    const post = (message: any) => ctx.postMessage(message);

    // Fixed once the model exists: the sessions are built against one execution
    // provider. Changing the setting means a new worker, not a reload here.
    let useWebGpu = false;

    // A worker cannot run the folder picker, so the model can't be stored until
    // the main thread hands over its resolved root.
    let markRootReady!: () => void;
    const rootReady = new Promise<void>(resolve => { markRootReady = resolve; });

    let modelPromise: Promise<ParakeetModel> | undefined;
    const ensureModel = (): Promise<ParakeetModel> => {
        if (!modelPromise) {
            modelPromise = rootReady
                .then(() => loadParakeet(useWebGpu, (message, fraction) => post({ type: "progress", message, fraction })))
                .then(m => {
                    post({ type: "ready", backend: m.backend, threads: getOrtThreads() });
                    return m;
                })
                .catch(e => { modelPromise = undefined; throw e; });
        }
        return modelPromise;
    };

    // Transcribe one span of already-decoded audio, start to finish.
    //
    // The span arrives whole rather than as a stream of packets, so the chunk
    // boundaries can be chosen across all of it at once -- no trailing piece
    // held back in case more audio arrives to extend it, and no window's worth
    // of latency before the first chunk can run.
    const transcribeBuffer = (id: number, pcm: Float32Array, startSec: number): void => {
        chain = chain.then(async () => {
            if (id !== jobId) return;
            const model = await ensureModel();
            if (id !== jobId) return;

            const chunks = chunkAudio(pcm, SPEECH_SAMPLE_RATE);
            const spanSec = pcm.length / SPEECH_SAMPLE_RATE;
            let processedToSec = startSec;
            for (let i = 0; i < chunks.length; i++) {
                if (id !== jobId) return;
                const chunk = chunks[i];
                const words = await model.transcribeChunk(chunk, startSec);
                if (id !== jobId) return;
                processedToSec = startSec + chunk.offsetSec + chunk.pcm.length / SPEECH_SAMPLE_RATE;
                post({
                    type: "words", jobId: id, words, processedToSec,
                    fraction: spanSec > 0 ? Math.min(1, (processedToSec - startSec) / spanSec) : 1,
                });
            }
            post({ type: "spanDone", jobId: id, processedToSec: startSec + spanSec });
        }).catch(e => {
            if (id !== jobId) return;
            console.error("[asrWorker] failed:", e);
            post({ type: "error", jobId: id, message: e?.message ?? String(e) });
        });
    };

    ctx.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as any;
        if (!d) return;

        if (d.type === "storageRoot") {
            if (d.handle) setStorageRootOverride(d.handle as FileSystemDirectoryHandle);
            markRootReady();
            return;
        }

        if (d.type === "load") {
            if (!modelPromise) useWebGpu = !!d.useWebGpu;
            void ensureModel().catch(err =>
                post({ type: "error", jobId: 0, message: err?.message ?? String(err) }));
            return;
        }

        if (d.type === "start") {
            jobId = d.jobId;
            chain = Promise.resolve();
            if (!modelPromise) useWebGpu = !!d.useWebGpu;
            void ensureModel().catch(err =>
                post({ type: "error", jobId: d.jobId, message: err?.message ?? String(err) }));
            return;
        }

        if (d.type === "stop") {
            if (d.jobId === jobId) { jobId = 0; chain = Promise.resolve(); }
            return;
        }

        if (d.type === "transcribe") {
            if (d.jobId !== jobId) return;                 // superseded job -- drop
            transcribeBuffer(d.jobId, new Float32Array(d.pcm as ArrayBuffer), d.startSec as number);
            return;
        }

        // Give back the GPU. The sessions are what hold the weights, so this
        // has to reach onnxruntime -- dropping our reference frees nothing.
        if (d.type === "unload") {
            jobId = 0;
            chain = Promise.resolve();
            modelPromise = undefined;
            void unloadParakeet()
                .catch(err => console.warn("[asrWorker] unload failed:", err))
                .then(() => post({ type: "unloaded" }));
            return;
        }
    });
}
