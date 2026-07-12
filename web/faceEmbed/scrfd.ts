// SCRFD face detection — Buffalo_L's det_10g.onnx. Single-stream detector
// trained at 640×640. Outputs 9 tensors: per-stride (8/16/32) score, bbox
// deltas, and 5-point landmark deltas. We decode + NMS in JS.

import { loadOrt, createSession } from "./onnx";
import { GpuPreprocessor, LetterboxMeta } from "./gpuPreprocess";

export interface DetectedFace {
    // Coords in the ORIGINAL (un-letterboxed) input image.
    bbox: { x1: number; y1: number; x2: number; y2: number };
    score: number;
    // 5 landmarks in (x, y) order: left_eye, right_eye, nose, mouth_left, mouth_right.
    landmarks: [number, number][];
}

export type DetSource = HTMLCanvasElement | OffscreenCanvas;

const DET_INPUT = 640;
const STRIDES = [8, 16, 32];
const ANCHORS_PER_CELL = 2;
const SCORE_THRESHOLD = 0.65;
const NMS_IOU = 0.4;

// Letterbox + normalize one image into a 640×640 NCHW RGB tensor on the CPU.
// Mirrors InsightFace: aspect-preserving resize padded TOP-LEFT (zeros right +
// bottom), RGB, (img − 127.5) / 128. This is the fallback when GPU
// preprocessing isn't available; the fast path lives in gpuPreprocess.ts.
function cpuPreprocess(source: DetSource): { tensor: Float32Array; meta: LetterboxMeta } {
    const srcW = source.width;
    const srcH = source.height;
    const scale = Math.min(DET_INPUT / srcW, DET_INPUT / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);

    const canvas = new OffscreenCanvas(DET_INPUT, DET_INPUT);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, DET_INPUT, DET_INPUT);
    ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, newW, newH);
    const pixels = ctx.getImageData(0, 0, DET_INPUT, DET_INPUT).data;

    const tensor = new Float32Array(3 * DET_INPUT * DET_INPUT);
    const planeSize = DET_INPUT * DET_INPUT;
    for (let i = 0, p = 0; i < planeSize; i++, p += 4) {
        const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
        // RGB channel order — matches InsightFace's swapRB=True input.
        tensor[i] = (r - 127.5) / 128.0;
        tensor[i + planeSize] = (g - 127.5) / 128.0;
        tensor[i + 2 * planeSize] = (b - 127.5) / 128.0;
    }
    return { tensor, meta: { scale, padX: 0, padY: 0, srcW, srcH, newW, newH } };
}

interface RawDet {
    bbox: [number, number, number, number];
    score: number;
    landmarks: [number, number][];
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
    const ix1 = Math.max(a[0], b[0]);
    const iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]);
    const iy2 = Math.min(a[3], b[3]);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    return inter / (areaA + areaB - inter + 1e-9);
}

function nms(items: RawDet[], iouThresh: number): RawDet[] {
    items.sort((x, y) => y.score - x.score);
    const keep: RawDet[] = [];
    const dropped = new Set<number>();
    for (let i = 0; i < items.length; i++) {
        if (dropped.has(i)) continue;
        keep.push(items[i]);
        for (let j = i + 1; j < items.length; j++) {
            if (dropped.has(j)) continue;
            if (iou(items[i].bbox, items[j].bbox) > iouThresh) dropped.add(j);
        }
    }
    return keep;
}

// Decode raw SCRFD outputs for one stride. `score`, `bbox`, `kps` shapes:
//   score: [N, 1]  bbox: [N, 4]  kps: [N, 10]
// where N = (DET_INPUT/stride)^2 * ANCHORS_PER_CELL.
function decodeStride(score: Float32Array, bbox: Float32Array, kps: Float32Array, stride: number, thresh: number): RawDet[] {
    const cells = DET_INPUT / stride;
    const out: RawDet[] = [];
    for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
            for (let a = 0; a < ANCHORS_PER_CELL; a++) {
                const idx = (cy * cells + cx) * ANCHORS_PER_CELL + a;
                const s = score[idx];
                if (s < thresh) continue;
                const ax = (cx + 0.5) * stride;
                const ay = (cy + 0.5) * stride;
                const dl = bbox[idx * 4 + 0] * stride;
                const dt = bbox[idx * 4 + 1] * stride;
                const dr = bbox[idx * 4 + 2] * stride;
                const db = bbox[idx * 4 + 3] * stride;
                const landmarks: [number, number][] = [];
                for (let k = 0; k < 5; k++) {
                    const kx = ax + kps[idx * 10 + k * 2] * stride;
                    const ky = ay + kps[idx * 10 + k * 2 + 1] * stride;
                    landmarks.push([kx, ky]);
                }
                out.push({
                    bbox: [ax - dl, ay - dt, ax + dr, ay + db],
                    score: s,
                    landmarks,
                });
            }
        }
    }
    return out;
}

export class ScrfdDetector {
    private wasmFallbackTried = false;
    // GPU preprocessor: undefined = not yet tried, null = unavailable/disabled.
    private gpuPre?: GpuPreprocessor | null;

    constructor(private session: any, private modelBytes: ArrayBuffer | undefined, private label: string) { }

    async detect(source: DetSource): Promise<DetectedFace[]> {
        try {
            return await this.detectInner(source);
        } catch (err) {
            // Runtime fallback: SCRFD on WebGPU has known inference-time
            // blockers on some ORT versions (AveragePool/ceil, recursive
            // kernels). If we still have the model bytes and haven't rebuilt,
            // recreate the session on WASM and retry once.
            if (this.wasmFallbackTried || !this.modelBytes) throw err;
            this.wasmFallbackTried = true;
            this.gpuPre = null; // a WASM session can't take gpu-buffer tensors
            const detail = err instanceof Error ? err.message : String(err);
            console.warn(`[scrfd] detect failed (${detail}); rebuilding session on WASM and retrying`);
            this.session = await createSession(this.modelBytes, this.label, ["wasm"]);
            return await this.detectInner(source);
        }
    }

    private async detectInner(source: DetSource): Promise<DetectedFace[]> {
        const ort = await loadOrt();
        const inputName = this.session.inputNames[0];

        // Build the input tensor. Preferred path keeps the frame on the GPU
        // (texture → compute shader → gpu-buffer tensor); on any failure we
        // permanently fall back to CPU preprocessing for this detector
        // WITHOUT triggering the WASM session rebuild above.
        let input: any;
        // Assigned in either the GPU or CPU branch below before use.
        let meta!: LetterboxMeta;
        const tryGpu = this.gpuPre !== null && !!ort.env?.webgpu?.device;
        if (tryGpu) {
            try {
                const pre = this.gpuPre ?? new GpuPreprocessor(ort.env.webgpu.device, DET_INPUT);
                this.gpuPre = pre;
                pre.begin(1);
                meta = pre.write(source, 0);
                input = pre.tensor(ort, 1);
            } catch (err) {
                console.warn(`[scrfd] GPU preprocessing failed, using CPU:`, err);
                this.gpuPre = null;
                input = undefined;
            }
        }
        if (!input!) {
            const r = cpuPreprocess(source);
            meta = r.meta;
            input = new ort.Tensor("float32", r.tensor, [1, 3, DET_INPUT, DET_INPUT]);
        }

        const outputs = await this.session.run({ [inputName]: input });

        // SCRFD's output names from the InsightFace ONNX export. If the
        // model was exported differently we fall back to ordered names.
        const names = this.session.outputNames as string[];
        const get = (key: string, fallbackIdx: number): Float32Array => {
            const t = outputs[key] ?? outputs[names[fallbackIdx]];
            return t.data as Float32Array;
        };

        const all: RawDet[] = [];
        all.push(...decodeStride(get("score_8", 0), get("bbox_8", 3), get("kps_8", 6), 8, SCORE_THRESHOLD));
        all.push(...decodeStride(get("score_16", 1), get("bbox_16", 4), get("kps_16", 7), 16, SCORE_THRESHOLD));
        all.push(...decodeStride(get("score_32", 2), get("bbox_32", 5), get("kps_32", 8), 32, SCORE_THRESHOLD));

        const kept = nms(all, NMS_IOU);

        // Map back to the ORIGINAL image's coordinate system.
        return kept.map(r => {
            const x1 = (r.bbox[0] - meta.padX) / meta.scale;
            const y1 = (r.bbox[1] - meta.padY) / meta.scale;
            const x2 = (r.bbox[2] - meta.padX) / meta.scale;
            const y2 = (r.bbox[3] - meta.padY) / meta.scale;
            const landmarks: [number, number][] = r.landmarks.map(([lx, ly]) => [
                (lx - meta.padX) / meta.scale,
                (ly - meta.padY) / meta.scale,
            ]);
            return {
                bbox: { x1, y1, x2, y2 },
                score: r.score,
                landmarks,
            };
        });
    }
}
