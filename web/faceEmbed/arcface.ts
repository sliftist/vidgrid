// ArcFace recognition — Buffalo_L's w600k_r50.onnx. Takes a 112×112 face
// crop (aligned via the 5-point landmarks), returns a 512-dim unit-norm
// embedding. Cosine distance between two embeddings is `1 - dot(a, b)`.

import { loadOrt } from "./onnx";
import { umeyamaSimilarity, applyAffine } from "./similarity";

export const EMBEDDING_DIM = 512;
const FACE_INPUT = 112;

// Canonical destination landmarks for ArcFace alignment, from InsightFace.
// Order: left_eye, right_eye, nose, mouth_left, mouth_right.
const ARCFACE_DST: [number, number][] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

// Warp a face from the source canvas into a 112×112 aligned crop using the
// detected landmarks. Returns the crop canvas (kept around so the test page
// can show the user what was fed to the embedder).
export function alignFace(source: HTMLCanvasElement | OffscreenCanvas, landmarks: [number, number][]): OffscreenCanvas {
    if (landmarks.length !== 5) throw new Error(`alignFace: need 5 landmarks, got ${landmarks.length}`);
    const t = umeyamaSimilarity(landmarks, ARCFACE_DST);
    const out = new OffscreenCanvas(FACE_INPUT, FACE_INPUT);
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    // Match cv2.warpAffine's default interpolation (bilinear, no extra
    // smoothing pass). The browser's "low" quality is the closest analogue;
    // "high" tends to over-smooth and drifts away from the reference.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    // Canvas setTransform matrix order: a, b, c, d, e, f → (a c e; b d f).
    // Our Affine2D applies (a, b, c) row to x and (d, e, f) row to y, so
    // setTransform args are (a, d, b, e, c, f).
    ctx.setTransform(t.a, t.d, t.b, t.e, t.c, t.f);
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
}

function toArcfaceTensor(crop: OffscreenCanvas): Float32Array {
    const ctx = crop.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    const pixels = ctx.getImageData(0, 0, FACE_INPUT, FACE_INPUT).data;
    // ArcFace expects RGB CHW, normalised to (pixel - 127.5) / 127.5.
    const tensor = new Float32Array(3 * FACE_INPUT * FACE_INPUT);
    const plane = FACE_INPUT * FACE_INPUT;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
        tensor[i] = (pixels[p] - 127.5) / 127.5;            // R
        tensor[i + plane] = (pixels[p + 1] - 127.5) / 127.5; // G
        tensor[i + 2 * plane] = (pixels[p + 2] - 127.5) / 127.5; // B
    }
    return tensor;
}

// L2-normalise a vector into a fresh Float32Array. The result has unit
// magnitude (within float32 epsilon).
function toUnitVector(v: Float32Array): Float32Array {
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    const norm = Math.sqrt(sumSq) + 1e-12;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
    return out;
}

function magnitude(v: Float32Array): number {
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    return Math.sqrt(sumSq);
}

export class ArcfaceEmbedder {
    constructor(private session: any) { }

    async embed(source: HTMLCanvasElement | OffscreenCanvas, landmarks: [number, number][]): Promise<{ embedding: Float32Array; alignedCrop: OffscreenCanvas }> {
        return (await this.embedBatch(source, [landmarks]))[0];
    }

    // Align one face to the 112×112 ArcFace input (CPU warp). The crop canvas
    // is returned alongside the tensor so callers that want to show what was
    // fed to the model don't have to redo the warp.
    alignToTensor(source: HTMLCanvasElement | OffscreenCanvas, landmarks: [number, number][]): { tensor: Float32Array; alignedCrop: OffscreenCanvas } {
        const alignedCrop = alignFace(source, landmarks);
        return { tensor: toArcfaceTensor(alignedCrop), alignedCrop };
    }

    // Embed a list of pre-aligned 112×112 tensors in ONE inference call.
    // ArcFace is a plain ResNet50 (no FPN), so batching is exact — the
    // [N,3,112,112] run yields embeddings bit-identical to N separate runs,
    // while amortizing ORT-web's fixed per-call overhead (~3× faster per face
    // at N=8 on WebGPU). The tensors may come from different source frames —
    // this is what lets the bulk path pack faces across frames into one call.
    async embedTensors(tensors: Float32Array[]): Promise<Float32Array[]> {
        const N = tensors.length;
        if (N === 0) return [];
        const ort = await loadOrt();
        const plane = 3 * FACE_INPUT * FACE_INPUT;
        const data = new Float32Array(N * plane);
        for (let i = 0; i < N; i++) data.set(tensors[i], i * plane);
        const input = new ort.Tensor("float32", data, [N, 3, FACE_INPUT, FACE_INPUT]);
        const outputs = await this.session.run({ [this.session.inputNames[0]]: input });
        // Output is [N, 512], face i at rows [i*512, (i+1)*512).
        const raw = outputs[this.session.outputNames[0]].data as Float32Array;
        const out: Float32Array[] = [];
        for (let i = 0; i < N; i++) {
            // Strict invariant: NOTHING in this codebase ever sees the raw
            // (unnormalised) model output. The cast result is consumed
            // immediately and the only thing that escapes is the unit-length
            // vector — cosineDistance / l2Distance below assume that.
            const embedding = toUnitVector(raw.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
            const mag = magnitude(embedding);
            if (!Number.isFinite(mag) || Math.abs(mag - 1) > 1e-3) {
                throw new Error(`ArcFace embedding not unit length: |x|=${mag} (dim=${embedding.length})`);
            }
            out.push(embedding);
        }
        return out;
    }

    // Embed several faces from the SAME source image in one call.
    async embedBatch(source: HTMLCanvasElement | OffscreenCanvas, landmarksList: [number, number][][]): Promise<{ embedding: Float32Array; alignedCrop: OffscreenCanvas }[]> {
        const crops = landmarksList.map(lm => this.alignToTensor(source, lm));
        const embeddings = await this.embedTensors(crops.map(c => c.tensor));
        return embeddings.map((embedding, i) => ({ embedding, alignedCrop: crops[i].alignedCrop }));
    }
}

// L2 Euclidean distance between two unit-length embeddings — range
// [0, 2], closer to 0 is more similar. This is what the Python facegrabs
// pipeline uses (np.linalg.norm(a - b)) with same-person threshold 1.1,
// so distances here are directly comparable to that reference.
//
// For unit vectors |a|=|b|=1:
//   ||a - b||² = (a - b)·(a - b) = a·a − 2a·b + b·b = 2 − 2(a·b)
// — so we can save the per-component subtraction and just √(2 − 2·dot).
//
// Inputs MUST come from ArcfaceEmbedder.embed (guaranteed unit-length).
export function l2Distance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.sqrt(Math.max(0, 2 - 2 * dot));
}

// Cosine distance, kept for completeness. Range [0, 2]; closer to 0 is
// more similar. Same input requirement as l2Distance.
export function cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
}
