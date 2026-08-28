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
//     { type: "ready", backend }
//     { type: "words", jobId, words, processedToSec }
//     { type: "drained", jobId, processedToSec }
//     { type: "error", jobId, message }
//
// Backpressure is the caller's job: it raises the decoder's ceiling off the
// `processedToSec` we report, so audio never piles up faster than we consume
// it. See generator.ts.

import { chunkAudio, downmixToMono, Resampler } from "./subtitleGen/asr";
import { SPEECH_SAMPLE_RATE } from "./subtitleGen/models";
import { loadParakeet, ParakeetModel } from "./subtitleGen/parakeet";

// How much 16 kHz audio to gather before looking for chunk boundaries. Below
// this there is not enough silence to choose a good seam; far above it, the
// first subtitle takes needlessly long to appear.
const WINDOW_SEC = 20;

// The bundler executes this entry under Node to enumerate modules; the worker
// wiring must stay dormant there (same guard as audioDecodeWorker).
declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    const ctx: DedicatedWorkerGlobalScope = self as any;

    let jobId = 0;
    let resampler: Resampler | undefined;
    // 16 kHz mono, not yet handed to the model, plus where it starts in the file.
    let pending: Float32Array[] = [];
    let pendingSamples = 0;
    let pendingStartSec = 0;
    let haveStart = false;
    let processedToSec = 0;
    // Chunk processing is serialised: the model is one set of sessions, and
    // running two chunks through it at once interleaves their decoder state.
    let chain: Promise<void> = Promise.resolve();

    const post = (message: any) => ctx.postMessage(message);

    const reset = () => {
        resampler = undefined;
        pending = [];
        pendingSamples = 0;
        pendingStartSec = 0;
        haveStart = false;
        processedToSec = 0;
        chain = Promise.resolve();
    };

    const takePending = (): Float32Array => {
        const out = new Float32Array(pendingSamples);
        let at = 0;
        for (const p of pending) { out.set(p, at); at += p.length; }
        return out;
    };

    // Fixed once the model exists: the sessions are built against one execution
    // provider. Changing the setting means a new worker, not a reload here.
    let useWebGpu = false;

    let modelPromise: Promise<ParakeetModel> | undefined;
    const ensureModel = (): Promise<ParakeetModel> => {
        if (!modelPromise) {
            modelPromise = loadParakeet(useWebGpu, (message, fraction) => post({ type: "progress", message, fraction }))
                .then(m => {
                    post({ type: "ready", backend: m.backend });
                    return m;
                })
                .catch(e => { modelPromise = undefined; throw e; });
        }
        return modelPromise;
    };

    // Turns what is buffered into chunks and runs them. `final` drains
    // everything; otherwise the trailing piece stays buffered, because more
    // audio may still extend it into a better chunk.
    const drain = (id: number, final: boolean): void => {
        chain = chain.then(async () => {
            if (id !== jobId) return;
            if (!final && pendingSamples < WINDOW_SEC * SPEECH_SAMPLE_RATE) return;
            if (!pendingSamples) {
                if (final) post({ type: "drained", jobId: id, processedToSec });
                return;
            }

            const model = await ensureModel();
            if (id !== jobId) return;

            const buf = takePending();
            const chunks = chunkAudio(buf, SPEECH_SAMPLE_RATE);
            const runCount = final ? chunks.length : Math.max(0, chunks.length - 1);
            const bufStartSec = pendingStartSec;

            for (let i = 0; i < runCount; i++) {
                if (id !== jobId) return;
                const chunk = chunks[i];
                const words = await model.transcribeChunk(chunk, bufStartSec);
                if (id !== jobId) return;
                processedToSec = bufStartSec + chunk.offsetSec + chunk.pcm.length / SPEECH_SAMPLE_RATE;
                post({ type: "words", jobId: id, words, processedToSec });
            }

            // Whatever we did not run stays buffered, rebased.
            const tail = chunks[runCount];
            if (tail) {
                pending = [tail.pcm.slice()];
                pendingSamples = tail.pcm.length;
                pendingStartSec = bufStartSec + tail.offsetSec;
            } else {
                pending = [];
                pendingSamples = 0;
                pendingStartSec = bufStartSec + buf.length / SPEECH_SAMPLE_RATE;
            }
            if (final) post({ type: "drained", jobId: id, processedToSec });
        }).catch(e => {
            if (id !== jobId) return;
            console.error("[asrWorker] failed:", e);
            post({ type: "error", jobId: id, message: e?.message ?? String(e) });
        });
    };

    ctx.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as any;
        if (!d) return;

        if (d.type === "load") {
            if (!modelPromise) useWebGpu = !!d.useWebGpu;
            void ensureModel().catch(err =>
                post({ type: "error", jobId: 0, message: err?.message ?? String(err) }));
            return;
        }

        if (d.type === "start") {
            jobId = d.jobId;
            reset();
            if (!modelPromise) useWebGpu = !!d.useWebGpu;
            void ensureModel().catch(err =>
                post({ type: "error", jobId: d.jobId, message: err?.message ?? String(err) }));
            return;
        }

        if (d.type === "stop") {
            if (d.jobId === jobId) { jobId = 0; reset(); }
            return;
        }

        if (d.type === "pcm") {
            if (d.jobId !== jobId) return;                 // superseded job -- drop
            const planar = new Float32Array(d.planar as ArrayBuffer);
            const mono = downmixToMono(planar, d.numberOfChannels, d.numberOfFrames);
            if (!resampler) resampler = new Resampler(d.sampleRate);
            if (!haveStart) {
                // The first packet's timestamp is where this buffer sits in the
                // file. Everything downstream is measured from here, so a run
                // that starts at 20:00 does not label its cues 0:00.
                haveStart = true;
                pendingStartSec = d.timestamp;
                processedToSec = d.timestamp;
            }
            const out = resampler.push(mono);
            if (out.length) { pending.push(out); pendingSamples += out.length; }
            drain(d.jobId, false);
            return;
        }

        if (d.type === "flush") {
            if (d.jobId !== jobId) return;
            if (resampler) {
                const out = resampler.flush();
                if (out.length) { pending.push(out); pendingSamples += out.length; }
            }
            drain(d.jobId, true);
            return;
        }
    });
}
