// Translation stage: run an already-generated transcript through a small
// instruct model with transformers.js.
//
// This runs over STORED text, never over audio. Transcribing and translating
// are separate steps (see generator.ts) so that redoing a translation -- other
// language, other model, or just a bad pass -- costs one LLM sweep and not
// another trip through the 456 MB speech model.
//
// The model is not served as a directory of files -- it is one .tar.gz that the
// browser unpacks into the shared folder. transformers.js is pointed at that via
// `env.customCache`, which it consults before the network, so every file it
// asks for is answered locally and `remoteHost` only ever sees requests for
// optional files the archive does not contain.

import { SubtitleGenModel } from "../appState";
import { MODEL_BASE_URL, TRANSFORMERS_CDN_URL, languageModelDef } from "./models";
import { ensureRawFileFetched, ensureTarballExtracted, modelTarCache } from "./tarball";
import { DetectedLanguage, detectLanguageOfCues, ensureOpusModel } from "./opusMt";

const dynImport: (u: string) => Promise<any> = new Function("u", "return import(u)") as any;

let transformersPromise: Promise<any> | undefined;
async function loadTransformers(): Promise<any> {
    if (!transformersPromise) {
        transformersPromise = (async () => {
            const mod = await dynImport(TRANSFORMERS_CDN_URL);
            // Everything is remote: there is no local model directory to serve
            // from, and leaving this on makes transformers.js probe /models/
            // first and log a 404 for every file.
            mod.env.allowLocalModels = false;
            mod.env.remoteHost = MODEL_BASE_URL;
            // Default template embeds "/resolve/{revision}/", a HuggingFace API
            // detail. Ours is a flat bucket, so the repo id is the whole path.
            mod.env.remotePathTemplate = "{model}";
            // Everything real comes out of the unpacked tarball.
            mod.env.useCustomCache = true;
            mod.env.customCache = modelTarCache;
            return mod;
        })().catch(e => {
            transformersPromise = undefined;
            throw e;
        });
    }
    return transformersPromise;
}

async function hasWebGpu(): Promise<boolean> {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    try {
        return !!(await gpu.requestAdapter());
    } catch {
        return false;
    }
}

// Both translators answer the same question, so the generator does not care
// which one it got.
export interface TextTranslator {
    translate(text: string): Promise<string>;
    // Shown in the progress line. Which model is running is the single most
    // useful thing to know while watching a long translation crawl.
    readonly label: string;
}

// A dedicated {source}->English Marian model. Nothing to prompt and nothing to
// parse: text in, text out.
export class OpusMtTranslator implements TextTranslator {
    private constructor(private pipe: any, public readonly label: string) { }

    private static cache = new Map<string, Promise<any>>();

    static async create(
        source: DetectedLanguage,
        onProgress?: (msg: string, fraction?: number) => void,
    ): Promise<OpusMtTranslator> {
        const packLang = source.pack;
        if (!packLang) throw new Error("That transcript is already in English.");
        const label = source.viaMul
            ? `${source.name} to English (multilingual)`
            : `${source.name} to English`;
        let pending = OpusMtTranslator.cache.get(packLang);
        if (!pending) {
            pending = (async () => {
                const { pipeline } = await loadTransformers();
                const repo = await ensureOpusModel(packLang, source.name,
                    (msg, fraction) => onProgress?.(msg, fraction));
                onProgress?.(`Starting ${label}...`);
                return await pipeline("translation", repo, {
                    dtype: "q8",
                    // CPU, not WebGPU. These are int8 Marian graphs and WebGPU
                    // int8 coverage is patchy; a cue that fails mid-run comes
                    // back untranslated rather than erroring, so an unverified
                    // fast path would degrade silently. ~0.6s per cue here.
                    device: "wasm",
                    session_options: {
                        // Full optimization rewrites the shared embedding's
                        // DequantizeLinear into MatMulNBits and then rejects
                        // its own output: "Missing required scale:
                        // model.shared.weight_merged_0_scale". "basic" skips
                        // that pass -- and measured FASTER than "disabled".
                        graphOptimizationLevel: "basic",
                    },
                });
            })().catch(e => {
                OpusMtTranslator.cache.delete(packLang);
                throw e;
            });
            OpusMtTranslator.cache.set(packLang, pending);
        }
        return new OpusMtTranslator(await pending, label);
    }

    async translate(text: string): Promise<string> {
        if (!text.trim()) return "";
        try {
            // Marian has no context window to speak of and a subtitle cue is a
            // sentence or two; the cap is only there so a pathological cue
            // cannot spin forever.
            const out = await this.pipe(text, { max_new_tokens: 256 });
            const got = out?.[0]?.translation_text;
            return typeof got === "string" && got.trim() ? got : text;
        } catch (e) {
            console.warn(`[subtitleGen] translation failed for ${JSON.stringify(text)}:`, e);
            return text;
        }
    }
}

// Picks the translator for this job.
//
// Currently: always the instruct LLM (Qwen/SmolLM2). The opus-mt path
// (OpusMtTranslator + franc source-language detection) is still in the repo
// and imported so it stays live, but not routed to -- Marian degenerates
// into "I'm sorry, I'm sorry..." on colloquial or fragmented inputs, and
// Qwen 0.5B on the same inputs gives usable output. Kept around because
// opus-mt IS faster and cleaner when it works, so a per-cue fallback (try
// opus-mt, detect the degeneracy, redo with Qwen) is a plausible next step.
export async function createTranslator(opts: {
    modelKey: SubtitleGenModel;
    // ISO code of the target, its English name, and its endonym.
    targetLanguage: string;
    targetLanguageName: string;
    targetEndonym: string;
    // The transcript being translated. Currently unused, retained because the
    // opus-mt path needs it and is still imported (see block comment above).
    sourceCues: { text: string }[];
    onProgress?: (msg: string, fraction?: number) => void;
}): Promise<TextTranslator> {
    void detectLanguageOfCues;
    void OpusMtTranslator;
    void opts.sourceCues;
    return await Translator.create(
        opts.modelKey, opts.targetLanguageName, opts.targetEndonym, opts.onProgress);
}

export class Translator implements TextTranslator {
    public readonly label: string;

    private constructor(
        private generator: any,
        private targetLanguage: string,
        private targetEndonym: string,
        modelLabel: string,
    ) {
        this.label = `${modelLabel} to ${targetLanguage}`;
    }

    // Cached across videos -- loading is the expensive part, and switching
    // target language does not require reloading the model.
    private static cache = new Map<SubtitleGenModel, Promise<any>>();

    static async create(
        modelKey: SubtitleGenModel,
        // English name and endonym of the target. BOTH are required and neither
        // may be empty: without a target there is no instruction to give, and
        // the model answers a question nobody asked.
        targetLanguage: string,
        targetEndonym: string,
        // The fraction is not decoration: this model is a 234-377 MB download,
        // so a bare message with no bar reads as a hang for minutes.
        onProgress?: (msg: string, fraction?: number) => void,
    ): Promise<Translator> {
        if (!targetLanguage.trim() || !targetEndonym.trim()) {
            throw new Error("Pick a language to translate into first.");
        }
        const def = languageModelDef(modelKey);
        let pending = Translator.cache.get(modelKey);
        if (!pending) {
            pending = (async () => {
                const { pipeline } = await loadTransformers();
                const webgpu = await hasWebGpu();
                // q4f16 keeps activations in fp16 with a mixed-precision graph
                // the WASM backend rejects at session-init time -- there is no
                // CPU degradation path, so say so plainly rather than surfacing
                // an onnxruntime graph-fusion error. Pure fp16 (Gemma 4B fp16)
                // is fine on WASM: measured ~9s / cue on Node WASM in testing.
                if (!webgpu && def.dtype === "q4f16") {
                    throw new Error(
                        `${def.label} needs WebGPU, which this browser does not expose. `
                        + `Pick a different model in Settings -- SmolLM2 360M, Qwen 0.5B, `
                        + `Gemma 3 1B, and Gemma 3 4B (int8 or fp16) all run on the CPU.`);
                }
                modelTarCache.registerRepo(def.repo);
                await ensureTarballExtracted(def.tarball, def.label,
                    (msg, fraction) => onProgress?.(msg, fraction));
                if (def.weightsUrl && def.weightsStorePath) {
                    await ensureRawFileFetched(
                        def.weightsUrl, def.weightsStorePath, `${def.label} weights`,
                        (msg, fraction) => onProgress?.(msg, fraction));
                }
                onProgress?.(`Starting ${def.label}...`);
                return await pipeline("text-generation", def.repo, {
                    dtype: def.dtype,
                    device: webgpu ? "webgpu" : "wasm",
                    ...(def.kvCacheDtype ? { kv_cache_dtype: def.kvCacheDtype } : {}),
                });
            })().catch(e => {
                Translator.cache.delete(modelKey);
                throw e;
            });
            Translator.cache.set(modelKey, pending);
        }
        return new Translator(await pending, targetLanguage, targetEndonym, def.label);
    }

    private systemPrompt(): string {
        // The inputs are subtitle cues from an automatic speech recognizer, not
        // clean text: expect fragments cut across sentence boundaries, and
        // occasional phonetic mistranscriptions (e.g. "golo" for "gola"). Ask
        // the model to prefer the intended word when it can infer one, and to
        // read each cue as continuing the previous ones.
        return `You are translating a running transcript of speech into ${this.targetLanguage}. `
            + `Each message is one subtitle cue, and follows on from the cues before it. `
            + `The text comes from automatic speech recognition, so it may contain `
            + `phonetic mistranscriptions -- when a word does not fit, translate what was `
            + `most likely said. Reply with the ${this.targetLanguage} translation only, `
            + `never with an explanation.`;
    }

    async translate(text: string): Promise<string> {
        if (!text.trim()) return "";
        try {
            const out = await this.generator([
                { role: "system", content: this.systemPrompt() },
                { role: "user", content: text },
            ], {
                max_new_tokens: 128,
                do_sample: false,
                return_full_text: false,
            });

            const raw = out?.[0]?.generated_text;
            const generated = typeof raw === "string" ? raw : raw?.[raw.length - 1]?.content ?? "";
            return String(generated);
        } catch (e) {
            console.warn(`[subtitleGen] translation failed for ${JSON.stringify(text)}:`, e);
            return text;
        }
    }
}
