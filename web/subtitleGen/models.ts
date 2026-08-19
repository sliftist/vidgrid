// Where the subtitle-generation models live, and which ones we offer.
//
// Two stages, two runtimes:
//   speech -> text   vosk-browser (Kaldi/WASM), model shipped as a .tar.gz
//   text   -> text   transformers.js (ONNX), model shipped as a HF-layout dir
//
// Both are fetched at runtime from MODEL_BASE_URL rather than bundled -- they
// are hundreds of megabytes, and only the users who turn the feature on should
// ever pay for them.
//
// NOTE ON MODEL_BASE_URL: this currently points at the box that serves the app.
// That works, but it is plain http on a non-standard port, so a page served
// over https will refuse the fetch as mixed content. Swap this for the real
// cloud-hosted https base as soon as one exists; nothing else has to change,
// because the tree under it mirrors HuggingFace's layout exactly.
export const MODEL_BASE_URL = "http://video.letterquick.com:8059/subtitle-models/";

// vosk-browser wants the tarball URL itself, not a directory.
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
    // HuggingFace repo id -- also the path under MODEL_BASE_URL.
    repo: string;
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
        dtype: "q8",
        downloadMb: 350,
        detail: "8-bit. Smaller download, runs on the CPU (WASM) if WebGPU is missing.",
    },
    {
        key: "qwen2.5-0.5b",
        label: "Qwen2.5 0.5B",
        repo: "onnx-community/Qwen2.5-0.5B-Instruct",
        dtype: "q4f16",
        downloadMb: 460,
        // q4f16 keeps activations in fp16, which the WASM backend cannot run --
        // it fails at session init, not at inference, so there is no partial
        // mode to fall back to. See ensureTranslator().
        detail: "4-bit with fp16 activations. Needs WebGPU.",
    },
];

export function languageModelDef(key: SubtitleGenModel): LanguageModelDef {
    return LANGUAGE_MODELS.find(m => m.key === key) ?? LANGUAGE_MODELS[1];
}
