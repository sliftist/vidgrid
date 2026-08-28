// Where the subtitle-generation models live, and which ones we offer.
//
// Two stages, two runtimes:
//   speech -> text   Parakeet TDT (ONNX) on raw onnxruntime-web
//   text   -> text   transformers.js (ONNX), model shipped as a HF-layout dir
//
// Both are fetched at runtime rather than bundled -- they are hundreds of
// megabytes, and only the users who turn the feature on should ever pay for
// them.
//
// Everything is ONE FLAT BUCKET of .tar.gz files. We do not host a directory
// tree: the browser downloads an archive and unpacks it into Cache Storage
// (see tarball.ts). So adding a model means uploading one file and pinning one
// URL here.
export const MODEL_BASE_URL = "https://f002.backblazeb2.com/file/audiotree-cc-public/";

// NVIDIA Parakeet TDT 0.6B v3: a FastConformer encoder with a Token-and-
// Duration Transducer decoder, quantized to int8 from the fp32 export.
//
// It replaced vosk, and the reason is not accuracy -- it is that vosk models
// are ONE LANGUAGE EACH, so the feature needed a "what language is this?"
// setting that the viewer had to get right before hearing a word, and 22
// separate tarballs behind it. This single model covers 25 European languages
// and auto-detects, so there is no language setting at all. It also emits
// punctuation and capitalization, which vosk does not.
//
// The archive unpacks into a directory of the same name, which is why the
// paths below are prefixed with it.
export const SPEECH_MODEL = {
    label: "Parakeet TDT 0.6B v3",
    dir: "parakeet-tdt-0.6b-v3-int8",
    tarball: MODEL_BASE_URL + "parakeet-tdt-0.6b-v3-int8.tar.gz",
    // Compressed transfer size...
    downloadMb: 456,
    // ...and what it occupies unpacked in Cache Storage, which is the number
    // that has to fit inside the origin's storage quota (encoder 652 MB +
    // decoder_joint 18 MB + frontend and vocab). Checked before downloading.
    unpackedBytes: 670_400_000,
    languageCount: 25,
    files: {
        // Mel-spectrogram frontend, exported as ONNX -- so there is no
        // hand-written spectrogram in JS to get subtly wrong.
        preprocessor: "parakeet-tdt-0.6b-v3-int8/nemo128.onnx",
        encoder: "parakeet-tdt-0.6b-v3-int8/encoder-model.int8.onnx",
        decoderJoint: "parakeet-tdt-0.6b-v3-int8/decoder_joint-model.int8.onnx",
        vocab: "parakeet-tdt-0.6b-v3-int8/vocab.txt",
    },
};

// The model expects exactly this rate; the preprocessor's window/hop are baked
// into the graph.
export const SPEECH_SAMPLE_RATE = 16000;

// Pinned CDN builds. Per CLAUDE.md, loading a pinned external URL at runtime is
// the sanctioned escape hatch; a path into this repo never is.
//
// The UMD (.js, not .mjs) build is deliberate: the ASR worker is a classic
// worker, so it pulls this in with importScripts(), which needs UMD.
//
// TWO bundles, and picking the wrong one is a silent tax. ort.webgpu.min.js
// loads ort-wasm-simd-threaded.ASYNCIFY.wasm, a build instrumented so GPU calls
// can suspend and resume the WASM stack. That instrumentation costs CPU
// throughput on every kernel, whether or not a GPU is ever involved -- so a
// CPU-only run on the webgpu bundle is slower than the same run on the plain
// one for no benefit at all. ort.wasm.min.js loads the uninstrumented binary.
const ORT_VERSION = "1.23.0";
export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_CDN_WEBGPU_URL = ORT_CDN_BASE + "ort.webgpu.min.js";
export const ORT_CDN_WASM_URL = ORT_CDN_BASE + "ort.wasm.min.js";
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
