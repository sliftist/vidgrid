// Where the subtitle-generation models live, and which ones we offer.
//
// Two stages, two runtimes:
//   speech -> text   vosk-browser (Kaldi/WASM), model shipped as a .tar.gz
//   text   -> text   transformers.js (ONNX), model shipped as a HF-layout dir
//
// Both are fetched at runtime rather than bundled -- they are hundreds of
// megabytes, and only the users who turn the feature on should ever pay for
// them.
//
// Everything is ONE FLAT BUCKET of .tar.gz files. We do not host a directory
// tree: the browser downloads an archive and unpacks it into Cache Storage
// (see tarball.ts), which is also what vosk-browser already does internally.
// So adding a model means uploading one file and pinning one URL here.
export const MODEL_BASE_URL = "https://f002.backblazeb2.com/file/audiotree-cc-public/";

// Vosk models are ONE LANGUAGE EACH. The acoustic model, phone set and lexicon
// are all language-specific and the recogniser takes no language parameter (its
// only options are sampleRate and a grammar word-list, which narrows within a
// language rather than switching it). So transcribing French audio requires the
// French model -- pointing the English one at it produces English-shaped
// nonsense, which is exactly what it sounds like.
//
// Names match alphacephei's small-model list. They publish .zip; vosk-browser
// only unpacks .tar.gz, and alphacephei serves no CORS headers, so each one has
// to be repacked and uploaded to the bucket before it can be selected here.
export interface VoskModelDef {
    // Our code for it, and the localStorage value.
    code: string;
    label: string;
    // Basename in the bucket, minus ".tar.gz".
    file: string;
    sizeMb: number;
}

export const VOSK_MODELS: VoskModelDef[] = [
    { code: "en-us", label: "English (US)", file: "vosk-model-small-en-us-0.15", sizeMb: 39 },
    { code: "en-gb", label: "English (UK)", file: "vosk-model-small-en-gb-0.15", sizeMb: 41 },
    { code: "en-in", label: "English (Indian)", file: "vosk-model-small-en-in-0.4", sizeMb: 36 },
    { code: "fr", label: "French", file: "vosk-model-small-fr-0.22", sizeMb: 40 },
    { code: "de", label: "German", file: "vosk-model-small-de-0.15", sizeMb: 44 },
    { code: "es", label: "Spanish", file: "vosk-model-small-es-0.42", sizeMb: 38 },
    { code: "it", label: "Italian", file: "vosk-model-small-it-0.22", sizeMb: 47 },
    { code: "pt", label: "Portuguese", file: "vosk-model-small-pt-0.3", sizeMb: 31 },
    { code: "nl", label: "Dutch", file: "vosk-model-small-nl-0.22", sizeMb: 39 },
    { code: "ru", label: "Russian", file: "vosk-model-small-ru-0.22", sizeMb: 44 },
    { code: "pl", label: "Polish", file: "vosk-model-small-pl-0.22", sizeMb: 51 },
    { code: "cs", label: "Czech", file: "vosk-model-small-cs-0.4-rhasspy", sizeMb: 44 },
    { code: "tr", label: "Turkish", file: "vosk-model-small-tr-0.3", sizeMb: 35 },
    { code: "ja", label: "Japanese", file: "vosk-model-small-ja-0.22", sizeMb: 47 },
    { code: "ko", label: "Korean", file: "vosk-model-small-ko-0.22", sizeMb: 83 },
    { code: "cn", label: "Chinese", file: "vosk-model-small-cn-0.22", sizeMb: 42 },
    { code: "hi", label: "Hindi", file: "vosk-model-small-hi-0.22", sizeMb: 42 },
    { code: "vn", label: "Vietnamese", file: "vosk-model-small-vn-0.4", sizeMb: 32 },
    { code: "ar", label: "Arabic", file: "vosk-model-small-ar-0.3", sizeMb: 100 },
    { code: "fa", label: "Farsi", file: "vosk-model-small-fa-0.42", sizeMb: 51 },
    { code: "uk", label: "Ukrainian", file: "vosk-model-small-uk-v3-small", sizeMb: 137 },
    { code: "ca", label: "Catalan", file: "vosk-model-small-ca-0.4", sizeMb: 41 },
];

export function voskModelDef(code: string): VoskModelDef {
    return VOSK_MODELS.find(m => m.code === code) ?? VOSK_MODELS[0];
}

// vosk-browser downloads and unpacks this itself.
export function voskModelUrl(code: string): string {
    return MODEL_BASE_URL + voskModelDef(code).file + ".tar.gz";
}

// Pinned CDN builds. Per CLAUDE.md the Function-constructor import trick is
// only sanctioned for pinned external URLs like these.
export const VOSK_CDN_URL = "https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/+esm";
export const TRANSFORMERS_CDN_URL =
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js";

import { SubtitleGenModel } from "../appState";

export interface LanguageModelDef {
    key: SubtitleGenModel;
    label: string;
    // HuggingFace repo id. Also the directory the tarball unpacks into, which
    // is what lets the unpacked files answer transformers.js's lookups.
    repo: string;
    // Archive holding that repo's files, in the bucket.
    tarball: string;
    // transformers.js dtype string; picks which .onnx file gets fetched.
    dtype: string;
    // Rough download size, for the settings UI. Users on metered connections
    // care about this more than about anything else we could show them.
    downloadMb: number;
    detail: string;
}

export const LANGUAGE_MODELS: LanguageModelDef[] = [
    {
        key: "smollm2-360m",
        label: "SmolLM2 360M",
        repo: "HuggingFaceTB/SmolLM2-360M-Instruct",
        tarball: MODEL_BASE_URL + "SmolLM2-360M-Instruct-q8.tar.gz",
        dtype: "q8",
        downloadMb: 234,
        detail: "8-bit. Smaller download, runs on the CPU (WASM) if WebGPU is missing.",
    },
    {
        key: "qwen2.5-0.5b",
        label: "Qwen2.5 0.5B",
        repo: "onnx-community/Qwen2.5-0.5B-Instruct",
        tarball: MODEL_BASE_URL + "Qwen2.5-0.5B-Instruct-q4f16.tar.gz",
        dtype: "q4f16",
        downloadMb: 377,
        // q4f16 keeps activations in fp16, which the WASM backend cannot run --
        // it fails at session init, not at inference, so there is no partial
        // mode to fall back to. See ensureTranslator().
        detail: "4-bit with fp16 activations. Needs WebGPU.",
    },
];

export function languageModelDef(key: SubtitleGenModel): LanguageModelDef {
    return LANGUAGE_MODELS.find(m => m.key === key) ?? LANGUAGE_MODELS[1];
}
