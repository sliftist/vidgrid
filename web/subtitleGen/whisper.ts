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

    // Whisper's own language detection, which transformers.js does not do.
    //
    // Its Whisper generate() forces the prompt tokens and, when no language is
    // given, warns "No language specified - defaulting to English (en)" and
    // transcribes as English. That is not the model's limitation: the model
    // predicts the language as its first token, which is exactly what the
    // procedure below reads.
    //
    // Feed the encoder one window, prime the decoder with just
    // <|startoftranscript|>, and generate a single token. Passing
    // decoder_input_ids is what stops generate() from forcing English -- it
    // uses the ids it is given instead of building its own prompt.
    private async detectLanguage(pcm: Float32Array): Promise<string | undefined> {
        try {
            const model = this.pipe.model;
            const cfg = model?.generation_config ?? {};
            const langToId: Record<string, number> = cfg.lang_to_id ?? {};
            const sot = cfg.decoder_start_token_id;
            if (!sot || !Object.keys(langToId).length) return undefined;

            // A window from a bit into the span: files often open on silence or
            // music, and a language guessed from either is a coin flip.
            const window = pickSpeechWindow(pcm);
            const { input_features } = await this.pipe.processor(window);
            const out = await model.generate({
                inputs: input_features,
                decoder_input_ids: [[sot]],
                max_new_tokens: 1,
            });
            const ids: number[] = (out?.tolist?.() ?? out)?.[0] ?? [];
            const langId = Number(ids[ids.length - 1]);
            for (const [token, id] of Object.entries(langToId)) {
                if (id === langId) {
                    const code = token.replace(/[<|>]/g, "");
                    console.log(`[whisper] detected language: ${code}`);
                    return code;
                }
            }
        } catch (e) {
            console.warn("[whisper] language detection failed; letting it default:", e);
        }
        return undefined;
    }

    // Transcribe one span of 16 kHz mono audio.
    //
    // Windowed here rather than inside transformers.js: its chunking reports no
    // progress at all (there is no chunk_callback in this version), and on an
    // hour of audio that is an hour of silence in the UI. Windows overlap so a
    // word spoken across a boundary is still heard whole in one of them, and
    // segments that start inside ground already covered are dropped.
    async transcribe(
        pcm: Float32Array, startSec: number, language: string | undefined,
        onProgress?: (fraction: number, message: string) => void,
        // Called as each window finishes, so cues appear while the rest of the
        // span is still running rather than an hour later.
        onWords?: (words: AsrWord[], toSec: number) => void,
    ): Promise<AsrWord[]> {
        const spanSec = pcm.length / SPEECH_SAMPLE_RATE;
        const started = Date.now();

        let lang = language;
        if (!lang) {
            onProgress?.(0, "Whisper: detecting language");
            lang = await this.detectLanguage(pcm);
        }

        const words: AsrWord[] = [];
        const step = WINDOW_SEC - WINDOW_OVERLAP_SEC;
        const windows = Math.max(1, Math.ceil(spanSec / step));
        let consumedTo = 0;                       // seconds into the span
        for (let i = 0; i < windows; i++) {
            const from = i * step;
            if (from >= spanSec) break;
            const slice = pcm.subarray(
                Math.floor(from * SPEECH_SAMPLE_RATE),
                Math.min(pcm.length, Math.floor((from + WINDOW_SEC) * SPEECH_SAMPLE_RATE)));
            if (slice.length < SPEECH_SAMPLE_RATE * 0.2) break;

            onProgress?.(i / windows, `Whisper (${i + 1} of ${windows})`);
            const out = await this.pipe(slice, {
                // Segment timestamps, not word ones: word timings come from the
                // decoder's cross-attentions, and this export has no attention
                // outputs -- asking for them fails with "Model outputs must
                // contain cross attentions to extract timestamps". Segment
                // timestamps are decoded from Whisper's own timestamp TOKENS,
                // which every export has.
                return_timestamps: true,
                language: lang,
                task: "transcribe",
                // Greedy: beam search costs several decoder passes per token
                // for a transcript another model is going to translate anyway.
                num_beams: 1,
                do_sample: false,
            });

            const fresh: AsrWord[] = [];
            for (const word of whisperWords(out, startSec + from)) {
                // Everything before `consumedTo` was already heard by the
                // previous window, which had more context for it.
                if (word.start - startSec < consumedTo - 0.05) continue;
                fresh.push(word);
                consumedTo = Math.max(consumedTo, word.end - startSec);
            }
            words.push(...fresh);
            onWords?.(fresh, startSec + Math.min(spanSec, from + WINDOW_SEC));
        }

        const elapsed = (Date.now() - started) / 1000;
        console.log(`[whisper] ${spanSec.toFixed(0)} s of audio in ${elapsed.toFixed(1)} s = `
            + `${(spanSec / Math.max(elapsed, 0.001)).toFixed(1)}x realtime on ${this.backend}, `
            + `${windows} window(s), ${words.length} word(s), language=${lang ?? "en (default)"}`);
        return words;
    }
}

// Whisper's window, and how much of it the next one repeats. The overlap is
// what keeps a word spoken across a boundary from being cut in half.
const WINDOW_SEC = 30;
const WINDOW_OVERLAP_SEC = 2;

// The loudest 30 s in the span, for language detection. A film that opens on
// silence or music would otherwise have its language guessed from that.
function pickSpeechWindow(pcm: Float32Array): Float32Array {
    const win = WINDOW_SEC * SPEECH_SAMPLE_RATE;
    if (pcm.length <= win) return pcm;
    let bestAt = 0, bestEnergy = -1;
    const stride = Math.floor(win / 2);
    for (let at = 0; at + win <= pcm.length; at += stride) {
        let energy = 0;
        // Every 32nd sample is plenty to rank one window against another.
        for (let i = at; i < at + win; i += 32) energy += Math.abs(pcm[i]);
        if (energy > bestEnergy) { bestEnergy = energy; bestAt = at; }
    }
    return pcm.subarray(bestAt, bestAt + win);
}

// transformers.js returns { text, chunks: [{ text, timestamp: [start, end] }] }
// with timestamps in seconds from the start of what it was given. Each chunk is
// a segment -- a phrase or a sentence -- so its span is shared out across the
// words in it.
//
// Sharing it out by word length rather than evenly, because "a" and
// "incomprehensible" do not take the same time to say, and length is the only
// proxy available without the attentions this export does not have. The result
// is good enough for what it feeds: cues break on silences between segments,
// where the timestamps are real, not inside them.
function whisperWords(out: any, startSec: number): AsrWord[] {
    const chunks: any[] = Array.isArray(out?.chunks) ? out.chunks : [];
    const words: AsrWord[] = [];
    let last = 0;
    for (const c of chunks) {
        const text = String(c?.text ?? "").trim();
        if (!text) continue;
        const from = Number(c?.timestamp?.[0]);
        const to = Number(c?.timestamp?.[1]);
        // A missing end timestamp is common on the last segment of a window; a
        // missing start is not, but both are better repaired than dropped.
        const start = Number.isFinite(from) ? from : last;
        const end = Number.isFinite(to) && to > start ? to : start + Math.max(0.4, text.length * 0.06);
        last = end;

        const pieces = text.split(/\s+/).filter(Boolean);
        const totalChars = pieces.reduce((n, w) => n + w.length, 0) || 1;
        let at = start;
        for (const piece of pieces) {
            const span = (end - start) * (piece.length / totalChars);
            words.push({
                word: piece,
                start: startSec + at,
                end: startSec + Math.min(end, at + span),
            });
            at += span;
        }
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
