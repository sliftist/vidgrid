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

// vosk-browser downloads and unpacks this itself.
export const VOSK_MODEL_URL = MODEL_BASE_URL + "vosk-model-small-en-us-0.15.tar.gz";

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
