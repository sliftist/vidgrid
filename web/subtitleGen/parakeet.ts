// Parakeet TDT 0.6B v3 on raw onnxruntime-web.
//
// Three graphs, run in sequence per chunk:
//   nemo128.onnx          PCM -> 128-bin mel features   (the frontend is ONNX,
//                                                        so no JS spectrogram)
//   encoder-model.int8    features -> 1024-dim frames at 80 ms
//   decoder_joint.int8    one encoder frame + LSTM state -> token + duration
//
// TDT means Token-and-Duration Transducer: the joint network emits vocab
// logits AND duration logits, and the argmax of the duration tail says how far
// the time cursor jumps. That is what makes it fast -- most steps skip several
// frames instead of grinding one at a time like a plain RNN-T.
//
// This module is imported by asrWorker.ts and expects a worker global scope
// (importScripts). It is never loaded on the main thread.

import { AsrWord, AudioChunk } from "./asr";
import { ORT_CDN_BASE, ORT_CDN_WASM_URL, ORT_CDN_WEBGPU_URL, SPEECH_MODEL } from "./models";
import { ensureTarballExtracted, readExtractedFile, TarProgress } from "./tarball";

// Guard against the decoder never emitting blank on a frame -- without it a
// pathological chunk loops forever instead of moving the cursor.
const MAX_TOKENS_PER_STEP = 10;
// Encoder frame rate: 10 ms mel hop x 8 subsampling.
const SEC_PER_ENC_FRAME = 0.08;

declare function importScripts(...urls: string[]): void;

function ort(): any {
    return (self as any).ort;
}

// Loading the runtime is a classic-worker importScripts of a pinned CDN URL --
// the sanctioned runtime-load pattern from CLAUDE.md, and the reason we pull
// the UMD build rather than the ESM one.
// Reported to the UI, because "why is this slow" has exactly two answers and
// this is one of them: without cross-origin isolation there is no
// SharedArrayBuffer, so ORT runs on ONE core no matter how many the machine
// has. A function, not an exported `let` -- a live binding read from another
// module is at the mercy of how the bundler transpiles it.
let ortThreads = 1;
export function getOrtThreads(): number { return ortThreads; }

let ortLoaded = false;
function loadOrt(useWebGpu: boolean): void {
    if (ortLoaded) return;
    // Deliberately NOT always the webgpu bundle: see models.ts. It drags in the
    // asyncify WASM binary, which is slower at pure CPU work.
    importScripts(useWebGpu ? ORT_CDN_WEBGPU_URL : ORT_CDN_WASM_URL);
    if (!ort()) throw new Error("onnxruntime-web failed to load from the CDN.");
    const env = ort().env;
    env.wasm.wasmPaths = ORT_CDN_BASE;
    // Threads need SharedArrayBuffer, which needs COOP/COEP, which we do not
    // send. Asking for them anyway makes ORT warn and fall back; asking for one
    // is honest. Single-threaded WASM still runs ~4.6x faster than realtime.
    env.wasm.numThreads = (self as any).crossOriginIsolated
        ? Math.min(8, navigator.hardwareConcurrency || 2)
        : 1;
    ortThreads = env.wasm.numThreads;
    env.wasm.simd = true;
    env.logLevel = "warning";
    ortLoaded = true;
}

// ORT exposes input metadata differently across versions (array in some, keyed
// object in others), and the state tensors' shapes have to come from somewhere.
function inputMeta(session: any, name: string): any {
    return session.inputMetadata?.find?.((x: any) => x.name === name)
        ?? session.inputMetadata?.[name]
        ?? {};
}

function metaShape(session: any, name: string): number[] {
    const m = inputMeta(session, name);
    return (m.shape ?? m.dimensions ?? []).map(Number);
}

export class ParakeetModel {
    private constructor(
        private prep: any,
        private enc: any,
        private dj: any,
        private vocab: string[],
        private blankIdx: number,
        private state1Shape: number[],
        private state2Shape: number[],
        private targetsInt64: boolean,
        public readonly backend: string,
    ) { }

    static async load(useWebGpu: boolean, onProgress?: TarProgress): Promise<ParakeetModel> {
        onProgress?.("Loading speech runtime...", undefined);

        // Ask the GPU for an adapter BEFORE committing to a backend. ORT will
        // happily accept "webgpu", fail to get an adapter, drop the provider
        // with a console warning, and run on CPU while still reporting itself
        // as the webgpu session -- which is exactly how you end up believing
        // you are on the GPU while timing a CPU run.
        let wantGpu = false;
        if (useWebGpu) {
            const gpu = (self as any).navigator?.gpu;
            const adapter = gpu ? await gpu.requestAdapter().catch(() => undefined) : undefined;
            wantGpu = !!adapter;
            if (!wantGpu) {
                console.warn("[parakeet] WebGPU was requested but no adapter is available; using CPU.");
            }
        }
        loadOrt(wantGpu);

        await ensureTarballExtracted(
            SPEECH_MODEL.tarball, `${SPEECH_MODEL.label} speech model`, onProgress,
            SPEECH_MODEL.unpackedBytes);

        const read = async (path: string): Promise<Response> => {
            const res = await readExtractedFile(path);
            if (!res) throw new Error(`Speech model file missing from the archive: ${path}`);
            return res;
        };

        // "id" per line, split at the LAST space because some tokens are a
        // space themselves. U+2581 is sentencepiece's word-start marker.
        const vocabTxt = await (await read(SPEECH_MODEL.files.vocab)).text();
        const vocab: string[] = [];
        for (const line of vocabTxt.split("\n")) {
            if (!line) continue;
            const at = line.lastIndexOf(" ");
            vocab[Number(line.slice(at + 1))] = line.slice(0, at).replace(/▁/g, " ");
        }
        const blankIdx = vocab.indexOf("<blk>");
        if (blankIdx < 0) throw new Error("Speech model vocab has no blank token.");

        // WASM by default, WebGPU only when asked for. Measured on the same
        // 66 s clip: WASM 0.254x realtime, WebGPU 1.122x -- more than four
        // times SLOWER. The model is dynamically quantized int8, and ORT-web's
        // WebGPU backend has no MatMulInteger/ConvInteger kernels, so the
        // int8-heavy nodes bounce back to CPU with a copy each way. A real
        // discrete GPU may well win; that is what the setting is for.
        const eps: string[][] = wantGpu ? [["webgpu", "wasm"], ["wasm"]] : [["wasm"]];

        let lastErr: any;
        for (const executionProviders of eps) {
            try {
                onProgress?.(`Starting speech model (${executionProviders[0]})...`, undefined);
                const opts = { executionProviders, graphOptimizationLevel: "all" };
                const prep = await ort().InferenceSession.create(
                    new Uint8Array(await (await read(SPEECH_MODEL.files.preprocessor)).arrayBuffer()), opts);
                onProgress?.("Starting speech model (encoder)...", undefined);
                const enc = await ort().InferenceSession.create(
                    new Uint8Array(await (await read(SPEECH_MODEL.files.encoder)).arrayBuffer()), opts);
                const dj = await ort().InferenceSession.create(
                    new Uint8Array(await (await read(SPEECH_MODEL.files.decoderJoint)).arrayBuffer()), opts);

                return new ParakeetModel(
                    prep, enc, dj, vocab, blankIdx,
                    metaShape(dj, "input_states_1"),
                    metaShape(dj, "input_states_2"),
                    (inputMeta(dj, "targets").type ?? "int32") === "int64",
                    executionProviders[0]);
            } catch (e) {
                lastErr = e;
                console.warn(`[parakeet] ${executionProviders[0]} backend failed:`, e);
            }
        }
        throw new Error(`Could not start the speech model: ${lastErr?.message ?? String(lastErr)}`);
    }

    private zeroState(shape: number[]): any {
        // Shape is [layers, batch, hidden] with a symbolic batch; we run one
        // stream at a time, so batch is 1.
        const layers = shape[0] || 2, hidden = shape[2] || 640;
        return new (ort().Tensor)("float32", new Float32Array(layers * hidden), [layers, 1, hidden]);
    }

    // Transcribes one chunk. `chunk.offsetSec` is the chunk's position in the
    // buffer; `baseSec` is that buffer's position in the file. Every returned
    // timestamp is already media time.
    async transcribeChunk(chunk: AudioChunk, baseSec: number): Promise<AsrWord[]> {
        const T = ort().Tensor;
        const pcm = chunk.pcm;

        const pOut = await this.prep.run({
            // slice(), not subarray(): ORT takes ownership of the backing
            // buffer, and these views are windows into a much larger one.
            waveforms: new T("float32", pcm.slice(), [1, pcm.length]),
            waveforms_lens: new T("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]),
        });

        const eOut = await this.enc.run({
            audio_signal: pOut.features,
            length: new T("int64", BigInt64Array.from([BigInt(pOut.features_lens.data[0])]), [1]),
        });
        const encOut = eOut.outputs;                       // [1, F, T]
        const encLen = Number(eOut.encoded_lengths.data[0]);
        const featDim = encOut.dims[1], frames = encOut.dims[2];
        const encData = encOut.data as Float32Array;

        // Greedy TDT decode. Mirrors onnx_asr's transducer decoding: state
        // advances only on a non-blank token, and the duration head drives the
        // time cursor. State resets per chunk, which is the whole point of
        // cutting on silence -- no word straddles the reset.
        let st1 = this.zeroState(this.state1Shape);
        let st2 = this.zeroState(this.state2Shape);
        const mkTarget = (v: number) => this.targetsInt64
            ? new T("int64", BigInt64Array.from([BigInt(v)]), [1, 1])
            : new T("int32", Int32Array.from([v]), [1, 1]);
        const mkLen = (v: number) => this.targetsInt64
            ? new T("int64", BigInt64Array.from([BigInt(v)]), [1])
            : new T("int32", Int32Array.from([v]), [1]);

        const vocabSize = this.vocab.length;
        const words: AsrWord[] = [];
        const frameBuf = new Float32Array(featDim);
        let lastToken = this.blankIdx;
        let ti = 0, emitted = 0;

        while (ti < encLen) {
            for (let f = 0; f < featDim; f++) frameBuf[f] = encData[f * frames + ti];

            const r = await this.dj.run({
                encoder_outputs: new T("float32", frameBuf.slice(), [1, featDim, 1]),
                targets: mkTarget(lastToken),
                target_length: mkLen(1),
                input_states_1: st1,
                input_states_2: st2,
            });
            const out = r.outputs.data as Float32Array;

            let best = 0, bestV = -Infinity;
            for (let i = 0; i < vocabSize; i++) if (out[i] > bestV) { bestV = out[i]; best = i; }
            let dur = 0, durV = -Infinity;
            for (let i = vocabSize; i < out.length; i++) if (out[i] > durV) { durV = out[i]; dur = i - vocabSize; }

            if (best !== this.blankIdx) {
                st1 = r.output_states_1;
                st2 = r.output_states_2;
                lastToken = best;
                emitted++;

                // Detokenise inline. A piece that starts with the word-start
                // marker opens a new word; anything else (including bare
                // punctuation) glues onto the one before it.
                const piece = this.vocab[best] ?? "";
                const at = baseSec + chunk.offsetSec + ti * SEC_PER_ENC_FRAME;
                const end = at + SEC_PER_ENC_FRAME;
                if (piece.startsWith(" ") || !words.length) {
                    const text = piece.trim();
                    if (text) words.push({ word: text, start: at, end });
                    // A lone word-start marker with nothing after it is a
                    // boundary, not a word -- drop it rather than emitting "".
                } else {
                    words[words.length - 1].word += piece;
                    words[words.length - 1].end = end;
                }
            }

            if (dur > 0) { ti += dur; emitted = 0; }
            else if (best === this.blankIdx || emitted === MAX_TOKENS_PER_STEP) { ti += 1; emitted = 0; }
        }
        return words;
    }
}

// One model per worker, ever. Each session holds its weights in the WASM heap;
// a second copy of a 650 MB encoder is not a slowdown, it is an out-of-memory.
// Memoising the PROMISE (not the resolved value) is what keeps two concurrent
// callers from both starting one.
// Because of that, the execution provider is fixed for the worker's lifetime:
// flipping the setting takes a fresh worker, which AsrWorkerClient does.
let modelPromise: Promise<ParakeetModel> | undefined;
export function loadParakeet(useWebGpu: boolean, onProgress?: TarProgress): Promise<ParakeetModel> {
    if (!modelPromise) {
        modelPromise = ParakeetModel.load(useWebGpu, onProgress).catch(e => {
            modelPromise = undefined;
            throw e;
        });
    }
    return modelPromise;
}
