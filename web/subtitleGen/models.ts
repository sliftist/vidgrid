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
    downloadMb: 456,
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
    // Optional: raw weights .onnx hosted on its own URL, streamed straight to
    // the model folder at `weightsStorePath`. When present, the tarball only
    // carries tokenizer/config; keeps a small metadata bundle even for models
    // whose weights are much larger.
    weightsUrl?: string;
    weightsStorePath?: string;
    // Optional: a replacement ONNX *graph* file, written over one of the files
    // the tarball just unpacked. Distinct from `weightsUrl`, which brings the
    // weights and means the tarball has none: this brings a few hundred KB of
    // graph and leaves the multi-gigabyte external data files beside it
    // untouched, because an .onnx and its .onnx_data are separate files and
    // only the first one has to change to change the computation.
    patchUrl?: string;
    patchStorePath?: string;
    // transformers.js dtype string; picks which .onnx file gets fetched.
    dtype: string;
    // Gemma-3 publishes a matching fp16 KV cache alongside its fp16/q4f16
    // weights. Setting this to "float16" was measured 3-4x faster on the 1B
    // (same outputs), so it is a speed knob, not a correctness knob.
    kvCacheDtype?: string;
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
        // Tokenizer + config only (2 MB). The 480 MB weights come from
        // `weightsUrl` below.
        tarball: MODEL_BASE_URL + "Qwen2.5-0.5B-Instruct-tokenizer.tar.gz",
        // Block-wise 8-bit weight-only quantization (MatMulNBits, block_size=128,
        // RTN, symmetric) plus fp16 embedding. Made in-house because every
        // 8-bit ONNX file HuggingFace ships for this model is broken -- naive
        // dynamic PTQ that a 0.5B / 896-hidden model does not survive. See
        // /tmp/trtest/quantize3.py + shrink.py for the recipe.
        weightsUrl: MODEL_BASE_URL + "Qwen2.5-0.5B-Instruct-int8bw.onnx",
        weightsStorePath:"onnx-community/Qwen2.5-0.5B-Instruct/onnx/model_int8.onnx",
        dtype: "int8",
        downloadMb: 480,
        detail: "8-bit weights, 480 MB. Runs on WebGPU or WASM.",
    },
    {
        key: "gemma-3-1b-int8",
        label: "Gemma 3 1B",
        repo: "onnx-community/gemma-3-1b-it-ONNX",
        tarball: MODEL_BASE_URL + "gemma-3-1b-it-tokenizer.tar.gz",
        // Same in-house block-wise 8-bit recipe as Qwen 0.5B above -- the HF
        // 8-bit export is the broken naive-PTQ variant. Fp16 embedding cast
        // brings the tied [262144, 1152] table from 1.2 GB down to 600 MB, so
        // the whole file lands at 1042 MB.
        weightsUrl: MODEL_BASE_URL + "gemma-3-1b-it-int8bw.onnx",
        weightsStorePath:"onnx-community/gemma-3-1b-it-ONNX/onnx/model_int8.onnx",
        dtype: "int8",
        downloadMb: 1042,
        detail: "1 GB, 8-bit. Bigger step up from Qwen 0.5B for the same runtime.",
    },
    // Gemma 3 4B, three precisions.
    //
    // These are the multi-file HF exports (decoder + external-data shards +
    // embed_tokens), bundled into one .tar per variant so a switch is one
    // download rather than a fan-out. tarball.ts handles bare .tar without
    // trying to gunzip -- gzip on already-dense ONNX weights is pure overhead.
    //
    // Quality was measured close between q4f16 and fp16 on the 5-cue test set
    // (see subtitleGen tests in the branch history); int8 matched the other
    // two on quality but had no fast WASM matmul kernel, so it ran ~15x
    // slower on CPU. WebGPU is expected to close that gap.
    //
    // THE FP16 RESIDUAL OVERFLOW, and the fix for it.
    //
    // Gemma 3 carries a residual stream that grows monotonically down the
    // layer stack. On WebGPU that residual is held in f16, and in this 4B it
    // passes f16's 65504 ceiling at layer 5 -- measured on the real prompt,
    // CPU EP, reading the residual adds straight out of the graph:
    //
    //     layers.3/Add_2   25200
    //     layers.4/Add_2   51392
    //     layers.5/Add_1   51936
    //     layers.5/Add_2      inf   <-- and every layer after it
    //
    // Once it saturates, the following RMSNorm/Softmax turn inf into NaN, and
    // greedy decoding picks argmax of an all-NaN row, which never beats its
    // starting index: token 0, <pad>, forever. The model loads, runs at a
    // believable speed, and translates to nothing.
    //
    //   https://github.com/microsoft/onnxruntime/issues/26732
    //
    // CPU and WASM are unaffected because they keep intermediates in f32, and
    // fp32-activation dtypes on WebGPU are unaffected for the same reason.
    //
    // onnx-community hit this on gemma-3-270m and fixed it in the export
    // ("update fp16 models with clips"): a Clip on both residual adds of every
    // layer, bounded at +/-64992, so a saturated add is pulled back to a finite
    // number before the next norm sees it. They never applied it to the 4B --
    // its current revision still has zero Clip nodes -- so `patchUrl` below
    // carries the same transformation, 68 Clips for 34 layers at the same
    // bound, built by the same rule.
    //
    // Verified in Chrome on WebGPU, one cue, everything identical but the
    // decoder graph:
    //
    //     stock export   63/63 tokens, all id 0, output ""
    //     with clips     22 tokens then EOS, "Futility well done, do you like
    //                    it? Yes, very much, yes, you like it."
    //
    // int8 remains the fastest GPU build (28-35 tok/s on an RTX 4090); fp16 is
    // now correct rather than empty. q4f16 computes in fp16 too and has the
    // same overflow -- it needs the same patch against its own decoder graph,
    // which has not been built yet.
    {
        key: "gemma-3-4b-q4f16",
        label: "Gemma 3 4B (q4f16)",
        repo: "onnx-community/gemma-3-4b-it-ONNX",
        tarball: MODEL_BASE_URL + "gemma-3-4b-it-q4f16.tar",
        dtype: "q4f16",
        kvCacheDtype: "float16",
        downloadMb: 2660,
        detail: "2.6 GB, 4-bit weights with fp16 activations. Needs WebGPU, and its "
            + "fp16 activations overflow there (onnxruntime #26732), so it has no working "
            + "path today.",
    },
    {
        key: "gemma-3-4b-int8",
        label: "Gemma 3 4B (int8)",
        repo: "onnx-community/gemma-3-4b-it-ONNX",
        tarball: MODEL_BASE_URL + "gemma-3-4b-it-int8.tar",
        dtype: "q8",
        downloadMb: 5290,
        detail: "5.3 GB, 8-bit weights with fp32 activations. The one to use on a GPU: "
            + "measured 28-35 tok/s on an RTX 4090, about a second per cue. Slow on WASM.",
    },
    {
        key: "gemma-3-4b-fp16",
        label: "Gemma 3 4B (fp16)",
        repo: "onnx-community/gemma-3-4b-it-ONNX",
        tarball: MODEL_BASE_URL + "gemma-3-4b-it-fp16.tar",
        dtype: "fp16",
        kvCacheDtype: "float16",
        // The residual-clip fix, as a 511 KB replacement for the decoder graph
        // the tarball ships. See the block comment above.
        patchUrl: MODEL_BASE_URL + "gemma-3-4b-it-fp16-clipped-decoder.onnx",
        patchStorePath:
            "onnx-community/gemma-3-4b-it-ONNX/onnx/decoder_model_merged_fp16.onnx",
        downloadMb: 8820,
        detail: "8.8 GB, 16-bit weights. Highest precision. Ships with a patched decoder "
            + "graph that clips the residual stream, without which fp16 returns nothing at "
            + "all on WebGPU.",
    },
];

export function languageModelDef(key: SubtitleGenModel): LanguageModelDef {
    return LANGUAGE_MODELS.find(m => m.key === key) ?? LANGUAGE_MODELS[1];
}
