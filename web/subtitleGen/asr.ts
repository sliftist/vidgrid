// Speech-to-text with vosk-browser (Kaldi, WASM), following the same shape as
// letterfast's VoiceMode: load the module from a pinned CDN build, createModel
// on a .tar.gz URL, then feed audio to a KaldiRecognizer and listen for
// "result" events carrying word-level timestamps.
//
// The one substantive difference from letterfast: it feeds a live microphone
// through a ScriptProcessorNode, so it is pinned to realtime and its timestamps
// start at zero. We feed decoded PCM straight from the file as fast as the
// decoder produces it, which is the whole point -- so timestamps have to be
// rebased onto media time (see `baseMediaSec`).

import { VOSK_CDN_URL, voskModelDef, voskModelUrl } from "./models";

export interface AsrWord {
    word: string;
    // Media seconds, already rebased -- directly usable as cue times.
    start: number;
    end: number;
}

// Sanctioned runtime import: pinned external CDN URL, hidden from the bundler.
const dynImport: (u: string) => Promise<any> = new Function("u", "return import(u)") as any;

let voskModulePromise: Promise<any> | undefined;
function loadVosk(): Promise<any> {
    if (!voskModulePromise) {
        voskModulePromise = dynImport(VOSK_CDN_URL).catch(e => {
            voskModulePromise = undefined;
            throw e;
        });
    }
    return voskModulePromise;
}

// Models are heavy to download and instantiate, so they outlive any single
// transcription -- generating subtitles for a second video reuses them. Keyed
// by language, since each is a separate download.
const modelPromises = new Map<string, Promise<any>>();
export function loadVoskModel(language: string, onProgress?: (msg: string) => void): Promise<any> {
    let modelPromise = modelPromises.get(language);
    if (!modelPromise) {
        const def = voskModelDef(language);
        modelPromise = (async () => {
            onProgress?.("Loading speech runtime...");
            const vosk = await loadVosk();
            onProgress?.(`Downloading ${def.label} speech model (${def.sizeMb} MB)...`);
            // vosk-browser downloads, untars and caches in IndexedDB; repeat
            // calls after the first are fast.
            try {
                return await vosk.createModel(voskModelUrl(language));
            } catch (e) {
                // createModel rejects with no reason at all, so the actionable
                // part -- which model is missing -- has to come from us.
                throw new Error(
                    `Could not load the ${def.label} speech model. `
                    + `Check that ${def.file}.tar.gz has been uploaded.`);
            }
        })().catch(e => {
            modelPromises.delete(language);
            throw e;
        });
        modelPromises.set(language, modelPromise);
    }
    return modelPromise;
}

export class Transcriber {
    private recognizer: any;
    private baseMediaSec: number;
    private disposed = false;

    private constructor(recognizer: any, baseMediaSec: number) {
        this.recognizer = recognizer;
        this.baseMediaSec = baseMediaSec;
    }

    // `sampleRate` must match the PCM that will be fed. Vosk resamples to the
    // model's 16 kHz internally, so we hand it the decoder's native rate rather
    // than writing a resampler.
    // ONE recognizer per run, and never more. Each one loads a decoding graph
    // into the shared wasm heap; a few hundred of them exhaust it and abort the
    // whole module, after which acceptWaveform silently does nothing forever.
    // Callers must therefore memoise the PROMISE, not the resolved value.
    static async create(opts: {
        language: string;
        sampleRate: number;
        baseMediaSec: number;
        onWords: (words: AsrWord[]) => void;
        onPartial?: (text: string) => void;
        onError?: (message: string) => void;
    }): Promise<Transcriber> {
        const model = await loadVoskModel(opts.language);
        const recognizer = new model.KaldiRecognizer(opts.sampleRate);
        recognizer.setWords(true);
        const self = new Transcriber(recognizer, opts.baseMediaSec);

        recognizer.on("result", (message: any) => {
            const result = message?.result ?? {};
            const raw: any[] = Array.isArray(result.result) ? result.result : [];
            const words: AsrWord[] = [];
            for (const w of raw) {
                const text = String(w?.word ?? "").trim();
                if (!text) continue;
                const start = typeof w?.start === "number" ? w.start : 0;
                const end = typeof w?.end === "number" ? w.end : start;
                words.push({
                    word: text,
                    start: start + self.baseMediaSec,
                    end: end + self.baseMediaSec,
                });
            }
            if (words.length) opts.onWords(words);
        });
        recognizer.on("partialresult", (message: any) => {
            const partial = message?.result?.partial;
            if (partial) opts.onPartial?.(String(partial));
        });
        recognizer.on("error", (err: any) => {
            console.error("[subtitleGen] vosk recognizer error:", err);
            const msg = err?.error ?? err?.message ?? String(err);
            opts.onError?.(`Speech recogniser error: ${msg}`);
        });

        return self;
    }

    // `mono` is one channel of f32 PCM at the sample rate given to create().
    accept(mono: Float32Array, sampleRate: number): void {
        if (this.disposed || !mono.length) return;
        // acceptWaveform takes an AudioBuffer. Constructing one directly avoids
        // needing an AudioContext (which would also drag in its own rate).
        const buf = new AudioBuffer({ length: mono.length, numberOfChannels: 1, sampleRate });
        buf.copyToChannel(mono, 0);
        try {
            this.recognizer.acceptWaveform(buf);
        } catch (e) {
            console.error("[subtitleGen] acceptWaveform failed:", e);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try { this.recognizer.remove(); } catch { /* already gone */ }
    }
}

// Decoded audio arrives as f32-planar, often 5.1. Vosk wants one channel; a
// plain average across channels is the right call here (unlike playback, where
// AudioPlayback.ts does a weighted downmix to preserve stereo image) because
// speech sits in the centre channel and we only care about intelligibility.
export function downmixToMono(planar: Float32Array, channels: number, frames: number): Float32Array {
    if (channels === 1) return planar.subarray(0, frames);
    const out = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
        const base = c * frames;
        for (let i = 0; i < frames; i++) out[i] += planar[base + i];
    }
    const scale = 1 / channels;
    for (let i = 0; i < frames; i++) out[i] *= scale;
    return out;
}
