// Translation stage: run the transcript through a small instruct model with
// transformers.js.
//
// The model is not served as a directory of files -- it is one .tar.gz that the
// browser unpacks into Cache Storage. transformers.js is pointed at that via
// `env.customCache`, which it consults before the network, so every file it
// asks for is answered locally and `remoteHost` only ever sees requests for
// optional files the archive does not contain.

import { SubtitleGenModel } from "../appState";
import { MODEL_BASE_URL, TRANSFORMERS_CDN_URL, languageModelDef } from "./models";
import { ensureTarballExtracted, modelTarCache } from "./tarball";

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

export class Translator {
    private constructor(
        private generator: any,
        private targetLanguage: string,
    ) { }

    // Cached across videos -- loading is the expensive part, and switching
    // target language does not require reloading the model.
    private static cache = new Map<SubtitleGenModel, Promise<any>>();

    static async create(
        modelKey: SubtitleGenModel,
        targetLanguage: string,
        onProgress?: (msg: string) => void,
    ): Promise<Translator> {
        const def = languageModelDef(modelKey);
        let pending = Translator.cache.get(modelKey);
        if (!pending) {
            pending = (async () => {
                const { pipeline } = await loadTransformers();
                const webgpu = await hasWebGpu();
                // q4f16 keeps activations in fp16. The WASM backend rejects
                // that at session-init time, so without WebGPU there is nothing
                // to degrade to -- say so plainly rather than surfacing an
                // onnxruntime graph-fusion error.
                if (!webgpu && def.dtype.includes("f16")) {
                    throw new Error(
                        `${def.label} needs WebGPU, which this browser does not expose. `
                        + `Pick SmolLM2 360M in Settings instead -- it runs on the CPU.`);
                }
                modelTarCache.registerRepo(def.repo);
                await ensureTarballExtracted(def.tarball, def.label, msg => onProgress?.(msg));
                onProgress?.(`Starting ${def.label}...`);
                return await pipeline("text-generation", def.repo, {
                    dtype: def.dtype,
                    device: webgpu ? "webgpu" : "wasm",
                });
            })().catch(e => {
                Translator.cache.delete(modelKey);
                throw e;
            });
            Translator.cache.set(modelKey, pending);
        }
        return new Translator(await pending, targetLanguage);
    }

    setTargetLanguage(lang: string): void {
        this.targetLanguage = lang;
    }

    // Returns the translated line, or the original if the model gives us
    // nothing usable. Never throws for a single bad line -- one failed cue must
    // not abort a whole film.
    async translate(text: string): Promise<string> {
        const source = text.trim();
        if (!source) return "";
        try {
            const out = await this.generator([
                {
                    role: "system",
                    content: `You are a subtitle translator. Translate the user's line into `
                        + `${this.targetLanguage}. Reply with the translation only -- no quotes, `
                        + `no explanation, no original text.`,
                },
                { role: "user", content: source },
            ], { max_new_tokens: 64, do_sample: false, return_full_text: false });

            const raw = out?.[0]?.generated_text;
            const text2 = typeof raw === "string" ? raw : raw?.[raw.length - 1]?.content ?? "";
            const cleaned = String(text2).trim().replace(/^["']|["']$/g, "").split("\n")[0].trim();
            return cleaned || source;
        } catch (e) {
            console.warn(`[subtitleGen] translation failed for ${JSON.stringify(source)}:`, e);
            return source;
        }
    }
}
