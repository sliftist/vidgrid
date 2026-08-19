// Translation stage: run the transcript through a small instruct model with
// transformers.js. The model is fetched from MODEL_BASE_URL, which mirrors
// HuggingFace's directory layout, so pointing `env.remoteHost` at it is the
// only configuration needed.

import { SubtitleGenModel } from "../appState";
import { MODEL_BASE_URL, TRANSFORMERS_CDN_URL, languageModelDef } from "./models";

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
            // Default template embeds "/resolve/{revision}/", which is a
            // HuggingFace API detail our static tree does not reproduce.
            mod.env.remotePathTemplate = "{model}";
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
                onProgress?.(`Downloading ${def.label} (${def.downloadMb} MB)...`);
                return await pipeline("text-generation", def.repo, {
                    dtype: def.dtype,
                    device: webgpu ? "webgpu" : "wasm",
                    progress_callback: (p: any) => {
                        if (p?.status === "progress" && p.total) {
                            const pct = Math.round((p.loaded / p.total) * 100);
                            onProgress?.(`Downloading ${def.label}: ${pct}%`);
                        }
                    },
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
