// Whisper large-v3-turbo, through transformers.js.
//
// Parakeet (parakeet.ts) is still here and still works; this is the engine the
// app uses now. Two reasons to switch:
//
//   Languages. Parakeet TDT v3 covers 25 European languages and nothing else,
//   and it does not fail on Japanese -- it renders it as European phonetics,
//   which reads as short English gibberish. It also takes no language input at
//   all, so there is nothing to hint with. Whisper is multilingual and accepts
//   an explicit language.
//
//   Machinery. Parakeet is three ONNX graphs driven by hand: a mel frontend, an
//   encoder, and a transducer loop that calls a session once per 80 ms frame.
//   transformers.js owns all of that for Whisper -- feature extraction, the
//   KV cache, the sliding 30 s window, timestamps -- so this file is a
//   configuration and a translation of its output into our word shape.
//
// large-v3-turbo is large-v3's encoder with the decoder cut from 32 layers to
// 4: close to large-v3 quality at roughly medium's speed, which matters here
// because Whisper's decoder is autoregressive and was always going to be the
// expensive half in a browser.

import { WHISPER_MODEL, MODEL_BASE_URL, TRANSFORMERS_CDN_URL, SPEECH_SAMPLE_RATE } from "./models";
import { ensureTarballExtracted, modelTarCache, TarProgress } from "./tarball";
import { AsrWord } from "./asr";

// CLAUDE.md's sanctioned runtime import: a pinned external URL, hidden from the
// bundler. Never a path into this repo.
const dynImport: (u: string) => Promise<any> = new Function("u", "return import(u)") as any;

let transformersPromise: Promise<any> | undefined;
async function loadTransformers(): Promise<any> {
    if (!transformersPromise) {
        transformersPromise = (async () => {
            const mod = await dynImport(TRANSFORMERS_CDN_URL);
            mod.env.allowLocalModels = false;
            mod.env.remoteHost = MODEL_BASE_URL;
            mod.env.remotePathTemplate = "{model}";
            // Everything real comes out of the unpacked tarball; remoteHost only
            // ever sees requests for optional files the archive lacks.
            mod.env.useCustomCache = true;
            mod.env.customCache = modelTarCache;
            return mod;
        })().catch(e => { transformersPromise = undefined; throw e; });
    }
    return transformersPromise;
}

export class WhisperModel {
    private constructor(private pipe: any, public readonly backend: string) { }

    static async load(useWebGpu: boolean, onProgress?: TarProgress): Promise<WhisperModel> {
        const { pipeline } = await loadTransformers();

        // The encoder is fp16, so an adapter without shader-f16 cannot run it:
        // the session is created and then every run fails inside a shader.
        // Checked here, where the answer is the CPU rather than a failed job.
        let backend = "wasm";
        if (useWebGpu) {
            const gpu = (self as any).navigator?.gpu;
            const adapter = gpu
                ? await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => undefined)
                : undefined;
            if (!adapter) {
                console.warn("[whisper] WebGPU requested but no adapter is available; using CPU.");
            } else if (!adapter.features?.has?.("shader-f16")) {
                console.warn("[whisper] this GPU does not expose shader-f16; using CPU.");
            } else {
                backend = "webgpu";
            }
        }

        modelTarCache.registerRepo(WHISPER_MODEL.repo);
        await ensureTarballExtracted(WHISPER_MODEL.tarball, `${WHISPER_MODEL.label} speech model`, onProgress);

        onProgress?.(`Starting ${WHISPER_MODEL.label} (${backend})...`, undefined);
        const started = Date.now();
        // Per-session dtypes, the same split the model's own WebGPU demo uses:
        // the encoder runs once per 30 s window and is worth fp16, the decoder
        // runs once per token and is worth being small.
        const pipe = await pipeline("automatic-speech-recognition", WHISPER_MODEL.repo, {
            dtype: backend === "webgpu"
                ? { encoder_model: "fp16", decoder_model_merged: "q4" }
                : { encoder_model: "q8", decoder_model_merged: "q8" },
            device: backend,
        });
        console.log(`[whisper] ${WHISPER_MODEL.label} ready on ${backend} in `
            + `${((Date.now() - started) / 1000).toFixed(1)} s`);
        return new WhisperModel(pipe, backend);
    }

    // Whisper holds its weights in onnxruntime sessions like anything else, and
    // nothing reclaims GPU buffers when the last reference drops.
    async dispose(): Promise<void> {
        try { await this.pipe?.dispose?.(); } catch { /* already gone */ }
        this.pipe = undefined;
    }

    // Transcribe one span of 16 kHz mono audio.
    //
    // `language` is an explicit hint ("japanese", "italian", ...) or undefined
    // to let Whisper detect it. Detection is per 30 s window and can wander on
    // short or noisy speech, which is exactly the case a hint is for.
    async transcribe(
        pcm: Float32Array, startSec: number, language: string | undefined,
        onProgress?: (fraction: number) => void,
    ): Promise<AsrWord[]> {
        const spanSec = pcm.length / SPEECH_SAMPLE_RATE;
        const started = Date.now();

        const out = await this.pipe(pcm, {
            // Word timings, because cues are built from word boundaries
            // (generator.ts) rather than from whole utterances.
            return_timestamps: "word",
            // Whisper's window. The overlap is what lets a word crossing a
            // window boundary be recovered rather than split.
            chunk_length_s: 30,
            stride_length_s: 5,
            language,
            task: "transcribe",
            // Greedy. Beam search costs several decoder passes per token for a
            // transcript that is then translated by another model anyway.
            num_beams: 1,
            do_sample: false,
            callback_function: onProgress
                ? (items: any) => {
                    // transformers.js reports the beam it is working on; the
                    // useful part is how far into the audio it has reached.
                    const at = items?.[0]?.output_token_ids?.length;
                    if (typeof at === "number") onProgress(Math.min(1, at / 448));
                }
                : undefined,
        });

        const words = whisperWords(out, startSec);
        const elapsed = (Date.now() - started) / 1000;
        console.log(`[whisper] ${spanSec.toFixed(0)} s of audio in ${elapsed.toFixed(1)} s = `
            + `${(spanSec / Math.max(elapsed, 0.001)).toFixed(1)}x realtime on ${this.backend}, `
            + `${words.length} word(s), language=${language ?? "auto"}`);
        return words;
    }
}

// transformers.js returns { text, chunks: [{ text, timestamp: [start, end] }] }
// with timestamps in seconds from the start of what it was given.
function whisperWords(out: any, startSec: number): AsrWord[] {
    const chunks: any[] = Array.isArray(out?.chunks) ? out.chunks : [];
    const words: AsrWord[] = [];
    let last = 0;
    for (const c of chunks) {
        const text = String(c?.text ?? "").trim();
        if (!text) continue;
        const from = Number(c?.timestamp?.[0]);
        const to = Number(c?.timestamp?.[1]);
        // A missing end timestamp is common on the last word of a window; a
        // missing start is not, but both are better repaired than dropped.
        const start = Number.isFinite(from) ? from : last;
        const end = Number.isFinite(to) && to > start ? to : start + 0.2;
        last = end;
        words.push({ word: text, start: startSec + start, end: startSec + end });
    }
    return words;
}

let modelPromise: Promise<WhisperModel> | undefined;
export function loadWhisper(useWebGpu: boolean, onProgress?: TarProgress): Promise<WhisperModel> {
    if (!modelPromise) {
        modelPromise = WhisperModel.load(useWebGpu, onProgress).catch(e => {
            modelPromise = undefined;
            throw e;
        });
    }
    return modelPromise;
}

export async function unloadWhisper(): Promise<void> {
    const pending = modelPromise;
    modelPromise = undefined;
    if (!pending) return;
    try { await (await pending).dispose(); } catch { /* never finished loading */ }
}
