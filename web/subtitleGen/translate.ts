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

// Formatting only. This deliberately does NOT judge whether the reply is a
// good translation -- we cannot tell, and every heuristic that tried (is it too
// long? does it look like the source? is the real answer hidden in the quotes?)
// threw away correct translations as often as it caught bad ones. Getting the
// prompt right is what fixes output; second-guessing the output afterwards is
// not something this code is in a position to do.
export function cleanTranslation(raw: string, source: string): string {
    let text = String(raw ?? "").trim();
    // First non-empty line: subtitle cues are one line, so anything past it is
    // the model continuing to talk.
    text = text.split("\n").map(l => l.trim()).find(l => !!l) ?? "";
    text = text.replace(/^["'«»„“”]+|["'«»„“”]+$/g, "").trim();
    text = text.replace(/^(translation|translated|output|answer|result)\s*[:\-]\s*/i, "").trim();
    return text || source;
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

    // The system turn says WHAT THIS MODEL IS. It carries no text to work on
    // and describes no situation.
    //
    // The version this replaced opened with "The user sends one subtitle line
    // in some language. Write that same line in X." That is a description of
    // the conversation, and a model this size does not reliably tell a
    // description of the task apart from the text to perform it on -- so it
    // paraphrased the description instead of translating. That is exactly where
    // subtitles reading "The user is asking to be translated into the media"
    // came from: the model was translating my prompt.
    private systemPrompt(): string {
        return `You are a translator. You translate text into ${this.targetLanguage}. `
            + `You reply with the translation only, never with an explanation.`;
    }

    // The user turn carries the INSTRUCTION plus the text it applies to. The
    // instruction belongs here, next to its argument, rather than in the system
    // turn where it sits detached from anything to act on.
    //
    // Ending on the target's own name and a colon leaves exactly one sensible
    // continuation, and the endonym pins the output language harder than its
    // English name does.
    private userPrompt(source: string): string {
        return `Translate into ${this.targetLanguage}:\n\n${source}\n\n${this.targetEndonym}:`;
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
                { role: "user", content: this.userPrompt(source) },
            ], {
                // Room to finish a sentence. The old budget was scaled down
                // from the source length, which truncated mid-clause and left
                // half-translations on screen.
                max_new_tokens: 128,
                do_sample: false,
                // NO repetition_penalty and NO no_repeat_ngram_size.
                //
                // Both penalise tokens ALREADY IN THE CONTEXT, and the context
                // is a prompt written in the target language. So they were
                // docking the model for emitting ordinary target-language words
                // -- and when the source legitimately repeats ("Si, tantissimo,
                // si, ti piace") they force it off the token it wants until the
                // output degrades into "tantissum, tantisum". That is the
                // mangling that looked like a broken model. Repetition is
                // handled after the fact in cleanTranslation instead, where it
                // cannot corrupt a correct line.
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
