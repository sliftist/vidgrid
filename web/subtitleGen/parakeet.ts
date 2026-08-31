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
import { ORT_CDN_BASE, ORT_CDN_WASM_URL, ORT_CDN_WEBGPU_URL, SPEECH_MODEL, SPEECH_SAMPLE_RATE } from "./models";
import { ensureTarballExtracted, readExtractedFile, TarProgress } from "./tarball";

// Guard against the decoder never emitting blank on a frame -- without it a
// pathological chunk loops forever instead of moving the cursor.
const MAX_TOKENS_PER_STEP = 10;

// How many chunks to decode in lockstep. Measured on the fp32 decoder over
// WASM: one stream costs 3.70 ms a step, sixteen cost 16.6 ms -- so past this
// the per-call overhead is already amortised and the returns flatten.
const DECODE_BATCH = 16;

// One chunk after the acoustic model: the embeddings, and how many of the
// frames in them are real.
interface EncodedChunk {
    data: Float32Array;
    featDim: number;
    frames: number;
    length: number;
}
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

    // Hand the weights back. On WebGPU each session holds its tensors in GPU
    // buffers, and nothing reclaims those when the last reference drops --
    // onnxruntime frees them when the session is released and not before, so a
    // session left alive is VRAM held for as long as the tab is open.
    async dispose(): Promise<void> {
        for (const session of [this.prep, this.enc, this.dj]) {
            try { await session?.release?.(); } catch { /* already gone */ }
        }
        this.prep = this.enc = this.dj = undefined;
    }

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
            const adapter = gpu
                ? await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => undefined)
                : undefined;
            // The acoustic model is fp16, so an adapter without shader-f16 is
            // no use: the session is created happily and then every run fails
            // on "Program Cast requires f16 but the device does not support
            // it". Checked here, where the answer is a fallback rather than a
            // failed transcript.
            const hasF16 = !!adapter?.features?.has?.("shader-f16");
            wantGpu = !!adapter && hasF16;
            if (!adapter) {
                console.warn("[parakeet] WebGPU was requested but no adapter is available; using CPU.");
            } else if (!hasF16) {
                console.warn("[parakeet] this GPU does not expose shader-f16, which the fp16 "
                    + "acoustic model needs; using CPU.");
            }
        }
        loadOrt(wantGpu);

        await ensureTarballExtracted(
            SPEECH_MODEL.tarball, `${SPEECH_MODEL.label} speech model`, onProgress);

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

        // The two halves want different hardware, and forcing them onto the
        // same one is what made this slow. Measured in Chrome on an RTX 4090,
        // 30 s of audio:
        //
        //   acoustic model   int8 on WASM    10476 ms     2.9x realtime
        //                    fp32 on WebGPU    117 ms   256.4x realtime
        //   decode step      fp32 on WASM     3.70 ms
        //                    int8 on WebGPU  64.98 ms
        //
        // The acoustic model is 600M parameters of dense matmul: exactly what
        // a GPU is for, once it is a dtype the GPU has kernels for -- the old
        // int8 build had its matmuls fall back to the CPU with a round-trip
        // each, which is why the GPU used to LOSE. The decoder is the
        // opposite: a tiny graph called once per 80 ms frame, where per-call
        // dispatch and readback dwarf the arithmetic.
        //
        // So the acoustic model goes to the GPU and the decoder stays on the
        // CPU, rather than both following one setting.
        const encEps: string[][] = wantGpu ? [["webgpu"], ["wasm"]] : [["wasm"]];

        // The mel frontend and the decoder always run on the CPU; only the
        // acoustic model is worth a GPU, and only it is allowed to fail over.
        const cpuOpts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
        onProgress?.("Starting speech model...", undefined);
        const prep = await ort().InferenceSession.create(
            new Uint8Array(await (await read(SPEECH_MODEL.files.preprocessor)).arrayBuffer()), cpuOpts);
        const dj = await ort().InferenceSession.create(
            new Uint8Array(await (await read(SPEECH_MODEL.files.decoderJoint)).arrayBuffer()), cpuOpts);

        // The acoustic model can arrive as one file or as a graph plus a
        // separate weights file; ORT wants the second handed to it explicitly.
        const encBytes = new Uint8Array(await (await read(SPEECH_MODEL.files.encoder)).arrayBuffer());
        const encDataName = SPEECH_MODEL.files.encoderData;
        const externalData = encDataName
            ? [{
                path: encDataName.split("/").pop()!,
                data: new Uint8Array(await (await read(encDataName)).arrayBuffer()),
            }]
            : undefined;

        let lastErr: any;
        for (const executionProviders of encEps) {
            try {
                onProgress?.(`Starting speech model (${executionProviders[0]})...`, undefined);
                const enc = await ort().InferenceSession.create(encBytes, {
                    executionProviders, graphOptimizationLevel: "all",
                    ...(externalData ? { externalData } : {}),
                });
                return new ParakeetModel(
                    prep, enc, dj, vocab, blankIdx,
                    metaShape(dj, "input_states_1"),
                    metaShape(dj, "input_states_2"),
                    (inputMeta(dj, "targets").type ?? "int32") === "int64",
                    executionProviders[0]);
            } catch (e) {
                lastErr = e;
                console.warn(`[parakeet] acoustic model on ${executionProviders[0]} failed:`, e);
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

    // Transcribes many chunks, decoding several of them at once.
    //
    // The transducer decode is one session call per encoder frame -- 80 ms of
    // audio each -- and that call costs far more in fixed overhead than in
    // arithmetic: measured on this graph, 3.70 ms for one stream and 16.6 ms
    // for sixteen, so the sixteenth stream costs about 0.9 ms. Running B
    // chunks in lockstep through one batched call therefore buys most of a
    // factor of B:
    //
    //     batch 1    3.70 ms/stream    21x realtime
    //     batch 4    1.57 ms/stream    51x
    //     batch 8    1.24 ms/stream    65x
    //     batch 16   1.04 ms/stream    76x
    //
    // Each stream keeps its own decoder state and time cursor; the batch is a
    // way to pay the call overhead once, not a change to the decoding.
    async transcribeChunks(
        chunks: AudioChunk[], baseSec: number,
        onChunk?: (index: number, words: AsrWord[]) => void,
        // Named phases with their own fractions, because these two stages have
        // very different speeds -- the acoustic model runs on the GPU and the
        // decode on the CPU -- and one blended number would crawl through the
        // half that is fast and race through the half that is slow.
        onProgress?: (message: string, fraction: number) => void,
    ): Promise<AsrWord[][]> {
        const out: AsrWord[][] = chunks.map(() => []);
        const total = chunks.length;
        const audioSec = chunks.reduce((n, c) => n + c.pcm.length / SPEECH_SAMPLE_RATE, 0);

        // The acoustic model is one call per chunk, and used to run for every
        // chunk in the span before anything was reported -- minutes of silence
        // on an hour of audio.
        const encStarted = Date.now();
        const encoded: EncodedChunk[] = [];
        for (let i = 0; i < total; i++) {
            onProgress?.(`Analysing speech (${i + 1} of ${total})`, i / total);
            encoded.push(await this.encodeChunk(chunks[i]));
        }
        const encodeMs = Date.now() - encStarted;
        const decodeStarted = Date.now();

        for (let at = 0; at < encoded.length; at += DECODE_BATCH) {
            const slice = encoded.slice(at, at + DECODE_BATCH);
            const words = await this.decodeBatch(
                slice, chunks.slice(at, at + DECODE_BATCH), baseSec,
                within => onProgress?.(
                    `Transcribing (${Math.min(at + slice.length, total)} of ${total})`,
                    (at + within * slice.length) / total));
            for (let i = 0; i < words.length; i++) {
                out[at + i] = words[i];
                onChunk?.(at + i, words[i]);
            }
        }

        // The split, not just the total: these two stages run on different
        // hardware and scale differently, so one number cannot say which one
        // to attack next.
        const decodeMs = Date.now() - decodeStarted;
        const x = (ms: number) => (audioSec / Math.max(ms / 1000, 0.001)).toFixed(0);
        console.log(`[parakeet] ${audioSec.toFixed(0)} s of audio, ${total} chunk(s): `
            + `acoustic model ${(encodeMs / 1000).toFixed(1)} s (${x(encodeMs)}x) on ${this.backend}, `
            + `decode ${(decodeMs / 1000).toFixed(1)} s (${x(decodeMs)}x) on wasm, `
            + `total ${((encodeMs + decodeMs) / 1000).toFixed(1)} s (${x(encodeMs + decodeMs)}x)`);
        return out;
    }

    // Mel frontend + acoustic model for one chunk.
    private async encodeChunk(chunk: AudioChunk): Promise<EncodedChunk> {
        const T = ort().Tensor;
        const pcm = chunk.pcm;
        const pOut = await this.prep.run({
            waveforms: new T("float32", pcm.slice(), [1, pcm.length]),
            waveforms_lens: new T("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]),
        });
        const eOut = await this.enc.run({
            audio_signal: pOut.features,
            length: new T("int64", BigInt64Array.from([BigInt(pOut.features_lens.data[0])]), [1]),
        });
        const encOut = eOut.outputs;                       // [1, F, T]
        return {
            data: encOut.data as Float32Array,
            featDim: encOut.dims[1],
            frames: encOut.dims[2],
            length: Number(eOut.encoded_lengths.data[0]),
        };
    }

    // Greedy TDT decode over several chunks at once. Mirrors the single-stream
    // decode exactly -- state advances only on a non-blank token and the
    // duration head drives the time cursor -- but every lane of the batch is a
    // different chunk with its own cursor.
    private async decodeBatch(
        enc: EncodedChunk[], chunks: AudioChunk[], baseSec: number,
        onProgress?: (fraction: number) => void,
    ): Promise<AsrWord[][]> {
        const T = ort().Tensor;
        const B = enc.length;
        const featDim = enc[0].featDim;
        const vocabSize = this.vocab.length;
        const stateSize = (this.state1Shape[0] || 2) * (this.state1Shape[2] || 640);
        const perLayer = this.state1Shape[2] || 640;
        const layers = this.state1Shape[0] || 2;

        const words: AsrWord[][] = enc.map(() => []);
        const ti = new Int32Array(B), emitted = new Int32Array(B);
        const lastToken = new Int32Array(B).fill(this.blankIdx);
        const active = enc.map(() => true);
        // States live as flat per-stream arrays and are packed into the batch
        // tensor each step, because only the lanes that emitted a token get
        // their state carried forward.
        const st1 = enc.map(() => new Float32Array(stateSize));
        const st2 = enc.map(() => new Float32Array(stateSize));

        const encBuf = new Float32Array(B * featDim);
        const tgtBuf = this.targetsInt64 ? new BigInt64Array(B) : new Int32Array(B);
        const lenBuf = this.targetsInt64 ? new BigInt64Array(B) : new Int32Array(B);
        const s1Buf = new Float32Array(layers * B * perLayer);
        const s2Buf = new Float32Array(layers * B * perLayer);

        let steps = 0;
        for (; ;) {
            let any = false;
            for (let b = 0; b < B; b++) {
                if (active[b] && ti[b] < enc[b].length) any = true;
                else active[b] = false;
            }
            if (!any) break;

            for (let b = 0; b < B; b++) {
                const e = enc[b];
                const base = b * featDim;
                if (active[b]) {
                    for (let f = 0; f < featDim; f++) encBuf[base + f] = e.data[f * e.frames + ti[b]];
                } else {
                    encBuf.fill(0, base, base + featDim);
                }
                if (this.targetsInt64) {
                    (tgtBuf as BigInt64Array)[b] = BigInt(lastToken[b]);
                    (lenBuf as BigInt64Array)[b] = BigInt(1);
                } else {
                    (tgtBuf as Int32Array)[b] = lastToken[b];
                    (lenBuf as Int32Array)[b] = 1;
                }
                // [layers, batch, hidden]: stream b is a column, not a block.
                for (let l = 0; l < layers; l++) {
                    s1Buf.set(st1[b].subarray(l * perLayer, (l + 1) * perLayer), (l * B + b) * perLayer);
                    s2Buf.set(st2[b].subarray(l * perLayer, (l + 1) * perLayer), (l * B + b) * perLayer);
                }
            }

            const r = await this.dj.run({
                encoder_outputs: new T("float32", encBuf.slice(), [B, featDim, 1]),
                targets: this.targetsInt64
                    ? new T("int64", (tgtBuf as BigInt64Array).slice(), [B, 1])
                    : new T("int32", (tgtBuf as Int32Array).slice(), [B, 1]),
                target_length: this.targetsInt64
                    ? new T("int64", (lenBuf as BigInt64Array).slice(), [B])
                    : new T("int32", (lenBuf as Int32Array).slice(), [B]),
                input_states_1: new T("float32", s1Buf.slice(), [layers, B, perLayer]),
                input_states_2: new T("float32", s2Buf.slice(), [layers, B, perLayer]),
            });
            steps++;
            const logits = r.outputs.data as Float32Array;
            const width = logits.length / B;
            const o1 = r.output_states_1.data as Float32Array;
            const o2 = r.output_states_2.data as Float32Array;

            for (let b = 0; b < B; b++) {
                if (!active[b]) continue;
                const row = b * width;
                let best = 0, bestV = -Infinity;
                for (let i = 0; i < vocabSize; i++) {
                    const v = logits[row + i];
                    if (v > bestV) { bestV = v; best = i; }
                }
                let dur = 0, durV = -Infinity;
                for (let i = vocabSize; i < width; i++) {
                    const v = logits[row + i];
                    if (v > durV) { durV = v; dur = i - vocabSize; }
                }

                if (best !== this.blankIdx) {
                    for (let l = 0; l < layers; l++) {
                        st1[b].set(o1.subarray((l * B + b) * perLayer, (l * B + b + 1) * perLayer), l * perLayer);
                        st2[b].set(o2.subarray((l * B + b) * perLayer, (l * B + b + 1) * perLayer), l * perLayer);
                    }
                    lastToken[b] = best;
                    emitted[b]++;
                    const piece = this.vocab[best] ?? "";
                    const at = baseSec + chunks[b].offsetSec + ti[b] * SEC_PER_ENC_FRAME;
                    const end = at + SEC_PER_ENC_FRAME;
                    const list = words[b];
                    if (piece.startsWith(" ") || !list.length) {
                        const text = piece.trim();
                        if (text) list.push({ word: text, start: at, end });
                    } else {
                        list[list.length - 1].word += piece;
                        list[list.length - 1].end = end;
                    }
                }

                if (dur > 0) { ti[b] += dur; emitted[b] = 0; }
                else if (best === this.blankIdx || emitted[b] === MAX_TOKENS_PER_STEP) {
                    ti[b] += 1; emitted[b] = 0;
                }
            }

            // A batch of sixteen 25 s chunks is minutes of audio and hundreds
            // of steps; reporting only when it finishes is the same silence
            // this is meant to remove. Every 16th step is often enough to look
            // continuous and rare enough to cost nothing.
            if (onProgress && (steps & 15) === 0) {
                let done = 0, all = 0;
                for (let b = 0; b < B; b++) { done += Math.min(ti[b], enc[b].length); all += enc[b].length; }
                onProgress(all > 0 ? done / all : 1);
            }
        }
        onProgress?.(1);
        return words;
    }

    // Transcribes one chunk. `chunk.offsetSec` is the chunk's position in the
    // buffer; `baseSec` is that buffer's position in the file. Every returned
    // timestamp is already media time.
    async transcribeChunk(chunk: AudioChunk, baseSec: number): Promise<AsrWord[]> {
        const T = ort().Tensor;
        const pcm = chunk.pcm;

        const tPrep = Date.now();
        const pOut = await this.prep.run({
            // slice(), not subarray(): ORT takes ownership of the backing
            // buffer, and these views are windows into a much larger one.
            waveforms: new T("float32", pcm.slice(), [1, pcm.length]),
            waveforms_lens: new T("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]),
        });

        const tEnc = Date.now();
        const eOut = await this.enc.run({
            audio_signal: pOut.features,
            length: new T("int64", BigInt64Array.from([BigInt(pOut.features_lens.data[0])]), [1]),
        });
        const tDecode = Date.now();
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
        let ti = 0, emitted = 0, steps = 0;

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
            steps++;
        }
        // Where the time actually goes. The decode loop is one session call per
        // step and the encoder is one call for the whole chunk, so these two
        // numbers say which of them is worth attacking.
        const done = Date.now();
        console.log(`[parakeet] ${(pcm.length / SPEECH_SAMPLE_RATE).toFixed(1)} s chunk on `
            + `${this.backend}: prep ${tEnc - tPrep} ms, encoder ${tDecode - tEnc} ms, `
            + `decode ${done - tDecode} ms over ${steps} steps `
            + `(${((done - tDecode) / Math.max(steps, 1)).toFixed(2)} ms/step), `
            + `total ${done - tPrep} ms`);
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

// Release the model and forget it, so the next load starts clean.
//
// "One model per worker, ever" was a rule about not loading it TWICE; it was
// never a reason to hold 650 MB of GPU memory after the transcript is
// finished. A tab that generated subtitles once kept that memory for as long
// as it stayed open, and several tabs multiplied it.
export async function unloadParakeet(): Promise<void> {
    const pending = modelPromise;
    modelPromise = undefined;
    if (!pending) return;
    try {
        await (await pending).dispose();
    } catch { /* a model that failed to load has nothing to free */ }
}
