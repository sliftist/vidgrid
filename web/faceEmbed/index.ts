// Public façade for the face-embedding pipeline. Lazy-loads the two ONNX
// models (Buffalo_L's det_10g + w600k_r50) on first call, caches them in
// OPFS, and runs the SCRFD → align → ArcFace pipeline on a HTMLImageElement
// or canvas. Returns a list of {bbox, embedding, alignedCrop, score}.

import { createSession } from "./onnx";
import { fetchModelWithCache } from "./opfs";
import { ScrfdDetector, DetectedFace } from "./scrfd";
import { ArcfaceEmbedder, l2Distance, cosineDistance } from "./arcface";

// Backblaze B2 public immutable bucket — files are uploaded by
// `scripts/uploadFaceModels.ts` from /root/face-models/. Bucket name is
// `vidgrid-face-models-public-immutable` (the wrapper helper in
// sliftutils appends `-public-immutable`). Switched off the dev server
// at video.letterquick.com:6399 so the production app doesn't
// pull weights from a personal machine.
const MODEL_BASE_URL = "https://f002.backblazeb2.com/file/vidgrid-face-models-public-immutable";

const MODEL_DET = "det_10g.onnx";
const MODEL_REC = "w600k_r50.onnx";
// Float16 model variants (uploaded by scripts/uploadFaceModels.ts). Opt-in via
// settings; may be faster on some GPUs (neutral on others). We fetch these
// preferentially when fp16 is on and fall back to the base fp32 models if they
// 404 — so the app keeps working even before the variants are uploaded to B2.
const MODEL_DET_FP16 = "det_10g_fp16.onnx";
const MODEL_REC_FP16 = "w600k_r50_fp16.onnx";

export interface PipelineOptions {
    // Use float16 model variants. Off by default.
    fp16?: boolean;
}

export interface FaceEmbeddingResult {
    bbox: { x1: number; y1: number; x2: number; y2: number };
    score: number;
    embedding: Float32Array;
    alignedCrop: OffscreenCanvas;
    // Wall-clock for the per-face ArcFace inference (alignment + embed).
    embedMs: number;
    // Wall-clock for the whole-image SCRFD detection pass that yielded
    // this face. Same value for every face from one image.
    detectMs: number;
}

// Per-frame cap when bulk-extracting faces from a video — spec says
// any face counts regardless of score, but never more than 10 per
// frame. Sort by score desc and slice.
export const MAX_FACES_PER_FRAME = 10;

export interface PipelineProgress {
    stage: "model-det" | "model-rec" | "detect" | "embed" | "done";
    received?: number;
    total?: number;
    detail?: string;
}

// Fetch `name` from B2, falling back to `fallbackName` if it isn't there yet
// (e.g. a variant build that hasn't been uploaded). Returns the bytes and the
// name actually used so the caller can react (e.g. enable batching only when
// the batch model really loaded).
async function fetchModelOrFallback(
    name: string, fallbackName: string,
    onProgress?: (r: number, t: number | undefined) => void,
): Promise<{ bytes: ArrayBuffer; name: string }> {
    if (name === fallbackName) {
        return { bytes: await fetchModelWithCache(name, `${MODEL_BASE_URL}/${name}`, onProgress), name };
    }
    try {
        return { bytes: await fetchModelWithCache(name, `${MODEL_BASE_URL}/${name}`, onProgress), name };
    } catch (err) {
        console.warn(`[faceEmbed] ${name} unavailable (${(err as Error).message}); using ${fallbackName}`);
        return { bytes: await fetchModelWithCache(fallbackName, `${MODEL_BASE_URL}/${fallbackName}`, onProgress), name: fallbackName };
    }
}

let pipelinePromise: Promise<{ detector: ScrfdDetector; embedder: ArcfaceEmbedder }> | undefined;
let pipelineFp16 = false;

export function getPipeline(onProgress?: (p: PipelineProgress) => void, opts: PipelineOptions = {}): Promise<{ detector: ScrfdDetector; embedder: ArcfaceEmbedder }> {
    const fp16 = !!opts.fp16;
    // Rebuild if the precision toggle changed since last build.
    if (pipelinePromise && pipelineFp16 !== fp16) pipelinePromise = undefined;
    if (!pipelinePromise) {
        pipelineFp16 = fp16;
        pipelinePromise = (async () => {
            // fp16 swaps both models to their float16 builds (falling back to
            // the fp32 base models if those builds aren't uploaded yet).
            const detName = fp16 ? MODEL_DET_FP16 : MODEL_DET;
            const recName = fp16 ? MODEL_REC_FP16 : MODEL_REC;
            const det = await fetchModelOrFallback(detName, MODEL_DET, (r, t) => onProgress?.({ stage: "model-det", received: r, total: t }));
            const rec = await fetchModelOrFallback(recName, MODEL_REC, (r, t) => onProgress?.({ stage: "model-rec", received: r, total: t }));
            // Both models on WebGPU with NCHW layout. Works as of
            // onnxruntime-web 1.24.3+ (we pin 1.26.0). On older versions
            // SCRFD failed at inference with AveragePool/ceil and broke
            // the shared device for ArcFace — see web/faceEmbed/onnx.ts
            // for the version notes. ScrfdDetector still keeps the model
            // bytes for its runtime WASM fallback, in case a future op
            // regression bites again.
            const recSession = await createSession(rec.bytes, rec.name, [
                { name: "webgpu", preferredLayout: "NCHW" },
                "wasm",
            ]);
            const detSession = await createSession(det.bytes, det.name, [
                { name: "webgpu", preferredLayout: "NCHW" },
                "wasm",
            ]);
            return {
                detector: new ScrfdDetector(detSession, det.bytes, det.name),
                embedder: new ArcfaceEmbedder(recSession),
            };
        })().catch(err => {
            pipelinePromise = undefined; // allow retry
            throw err;
        });
    }
    return pipelinePromise;
}

// Convenience: detect faces and embed them in one go.
export async function extractFaces(
    source: HTMLCanvasElement | OffscreenCanvas | HTMLImageElement,
    onProgress?: (p: PipelineProgress) => void,
    opts?: PipelineOptions,
): Promise<FaceEmbeddingResult[]> {
    const { detector, embedder } = await getPipeline(onProgress, opts);
    const canvas = toCanvas(source);
    onProgress?.({ stage: "detect" });
    const tDet0 = performance.now();
    const faces: DetectedFace[] = await detector.detect(canvas);
    const detectMs = performance.now() - tDet0;
    if (faces.length === 0) { onProgress?.({ stage: "done" }); return []; }

    // Embed ALL faces from this frame in one ArcFace call — bit-identical to
    // per-face runs but amortizes ORT-web's fixed per-inference overhead.
    onProgress?.({ stage: "embed", detail: `${faces.length}` });
    const tEmb0 = performance.now();
    const embedded = await embedder.embedBatch(canvas, faces.map(f => f.landmarks));
    const embedMs = (performance.now() - tEmb0) / faces.length; // amortized, for display
    const results: FaceEmbeddingResult[] = faces.map((f, i) => ({
        bbox: f.bbox, score: f.score,
        embedding: embedded[i].embedding, alignedCrop: embedded[i].alignedCrop,
        embedMs, detectMs,
    }));
    onProgress?.({ stage: "done" });
    return results;
}

// Bulk path: embed faces from MANY frames in a SINGLE ArcFace call. Each input
// is a frame plus its already-detected faces (the caller does detection, then
// sorts/caps per frame). All faces across all frames are aligned and packed
// into one [N,3,112,112] inference. This is the big throughput win for video
// scans: ArcFace barely uses the GPU at batch=1 and most frames have only 1-2
// faces, so packing faces across frames keeps the GPU full. Detection (SCRFD)
// can't be batched this way — its export collapses batch>1 — so the caller
// still detects frame-by-frame. Returns one result list per frame, in order.
export async function embedFramesBatched(
    frames: { source: HTMLCanvasElement | OffscreenCanvas; faces: DetectedFace[] }[],
    opts?: PipelineOptions,
): Promise<FaceEmbeddingResult[][]> {
    const { embedder } = await getPipeline(undefined, opts);
    const tensors: Float32Array[] = [];
    const crops: OffscreenCanvas[] = [];
    for (const fr of frames) {
        for (const f of fr.faces) {
            const a = embedder.alignToTensor(fr.source, f.landmarks);
            tensors.push(a.tensor); crops.push(a.alignedCrop);
        }
    }
    const embeddings = await embedder.embedTensors(tensors);
    const out: FaceEmbeddingResult[][] = frames.map(() => []);
    let k = 0;
    for (let fi = 0; fi < frames.length; fi++) {
        for (const f of frames[fi].faces) {
            out[fi].push({ bbox: f.bbox, score: f.score, embedding: embeddings[k], alignedCrop: crops[k], embedMs: 0, detectMs: 0 });
            k++;
        }
    }
    return out;
}

export { l2Distance, cosineDistance };
export type { DetectedFace } from "./scrfd";

function toCanvas(source: HTMLCanvasElement | OffscreenCanvas | HTMLImageElement): HTMLCanvasElement | OffscreenCanvas {
    // HTMLCanvasElement / HTMLImageElement don't exist in worker scope —
    // guard the instanceof refs behind `typeof` so this same code path
    // works from both contexts. In the worker we only ever get
    // OffscreenCanvas anyway.
    if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) return source;
    if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return source;
    const img = source as HTMLImageElement;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
}
