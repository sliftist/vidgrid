// Translation stage: run an already-generated transcript through a small
// instruct model with transformers.js.
//
// This runs over STORED text, never over audio. Transcribing and translating
// are separate steps (see generator.ts) so that redoing a translation -- other
// language, other model, or just a bad pass -- costs one LLM sweep and not
// another trip through the 456 MB speech model.
//
// The model is not served as a directory of files -- it is one .tar.gz that the
// browser unpacks into OPFS. transformers.js is pointed at that via
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

// Strip the ways a small instruct model fails at "reply with the translation
// only". These are cheap and specific; none of them can turn a bad translation
// into a good one, they just stop obvious non-answers from reaching the screen.
export function cleanTranslation(raw: string, source: string): string {
    let text = String(raw ?? "").trim();
    // Only the first line: anything after it is commentary the model added.
    text = text.split("\n")[0].trim();
    text = text.replace(/^["'«»„“”]+|["'«»„“”]+$/g, "").trim();
    text = text.replace(/^(translation|translated|output|answer|result)\s*[:\-]\s*/i, "").trim();

    // The signature failure of a 0.5B model with a 64-token budget: it finds a
    // sentence it likes and repeats it until the budget runs out. Collapsing
    // ADJACENT duplicates is exactly the shape of that, and leaves a line that
    // genuinely repeats itself for effect alone.
    const parts = text.split(/(?<=[.!?。！？])\s+/);
    const kept: string[] = [];
    for (const p of parts) {
        if (kept.length && kept[kept.length - 1].trim() === p.trim()) continue;
        kept.push(p);
    }
    text = kept.join(" ").trim();

    if (!text) return source;
    // A subtitle line does not get four times longer in translation. When it
    // does, the model has started narrating rather than translating -- the
    // original is a better subtitle than that.
    if (text.length > source.length * 4 + 40) return source;
    return text;
}

export class Translator {
    private constructor(
        private generator: any,
        private targetLanguage: string,
        private targetEndonym: string,
    ) { }

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
                await ensureTarballExtracted(def.tarball, def.label,
                    (msg, fraction) => onProgress?.(msg, fraction));
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
        return new Translator(await pending, targetLanguage, targetEndonym);
    }

    // Naming the target in its OWN language, not just in English. "Answer in
    // Français" holds a small model to the target; "answer in French" is itself
    // an English sentence and invites an English answer. The English name is
    // kept alongside it because the endonym alone is ambiguous for scripts the
    // model may not have seen much of.
    private systemPrompt(): string {
        const target = this.targetEndonym === this.targetLanguage
            ? this.targetLanguage
            : `${this.targetEndonym} (${this.targetLanguage})`;
        return `You are a subtitle translator. The user sends one subtitle line in some language. `
            + `Write that same line in ${target}. `
            + `Output only the ${this.targetEndonym} text of that one line: no explanation, `
            + `no notes, no quotes, no repetition, and never the original line.`;
    }

    // Returns the translated line, or the original if the model gives us
    // nothing usable. Never throws for a single bad line -- one failed cue must
    // not abort a whole film.
    async translate(text: string): Promise<string> {
        const source = text.trim();
        if (!source) return "";
        try {
            const out = await this.generator([
                { role: "system", content: this.systemPrompt() },
                { role: "user", content: source },
            ], {
                // Budgeted from the line rather than fixed at 64: a translation
                // is roughly the length of its source, and a generous ceiling on
                // a short line is an invitation to keep talking.
                max_new_tokens: Math.min(96, Math.max(24, Math.ceil(source.length / 2) + 16)),
                do_sample: false,
                // The observed failure was a sentence repeated to fill the
                // budget. Both of these attack that directly.
                repetition_penalty: 1.15,
                no_repeat_ngram_size: 6,
                return_full_text: false,
            });

            const raw = out?.[0]?.generated_text;
            const generated = typeof raw === "string" ? raw : raw?.[raw.length - 1]?.content ?? "";
            return cleanTranslation(String(generated), source);
        } catch (e) {
            console.warn(`[subtitleGen] translation failed for ${JSON.stringify(source)}:`, e);
            return source;
        }
    }
}
