// Decoded-picture buffer for the MPEG-4 decoder. Each plane is stored with a
// replicated EDGE border so half-pel motion compensation can read up to EDGE
// pixels outside the image without bounds checks (larger excursions go through
// the emulated-edge path in motion.ts). Luma motion vectors and per-MB types
// are kept alongside the pixels so future B-frames can read this picture's
// colocated data for direct-mode prediction.

export const EDGE = 16;

export class Frame {
    readonly w: number;
    readonly h: number;
    readonly cw: number;
    readonly ch: number;
    readonly yStride: number;
    readonly cStride: number;
    readonly yOrigin: number;
    readonly cOrigin: number;
    readonly y: Uint8Array;
    readonly u: Uint8Array;
    readonly v: Uint8Array;
    // Per-8x8-block luma motion (2 shorts per block) in the bordered b8 grid.
    readonly mv: Int16Array;
    readonly b8Stride: number;
    // Per-macroblock type flags (see MB_* in the decoder).
    readonly mbType: Int32Array;
    readonly mbStride: number;
    // MPEG-4 VOP display time of the picture currently held here (set by the
    // decoder when this buffer is filled; used to reorder output past B-frames).
    vopTime: number = 0;

    constructor(w: number, h: number, mbStride: number, mbHeight: number) {
        this.w = w;
        this.h = h;
        this.cw = (w + 1) >> 1;
        this.ch = (h + 1) >> 1;
        this.yStride = w + 2 * EDGE;
        this.cStride = this.cw + 2 * EDGE;
        this.yOrigin = EDGE * this.yStride + EDGE;
        this.cOrigin = EDGE * this.cStride + EDGE;
        this.y = new Uint8Array(this.yStride * (h + 2 * EDGE));
        this.u = new Uint8Array(this.cStride * (this.ch + 2 * EDGE));
        this.v = new Uint8Array(this.cStride * (this.ch + 2 * EDGE));
        this.b8Stride = mbStride * 2;
        this.mv = new Int16Array(this.b8Stride * (mbHeight * 2 + 2) * 2);
        this.mbStride = mbStride;
        this.mbType = new Int32Array(mbStride * (mbHeight + 2));
    }
}

function extendPlane(p: Uint8Array, stride: number, origin: number, w: number, h: number): void {
    // Left/right columns.
    for (let y = 0; y < h; y++) {
        const row = origin + y * stride;
        const left = p[row]!;
        const right = p[row + w - 1]!;
        for (let x = 1; x <= EDGE; x++) {
            p[row - x] = left;
            p[row + w - 1 + x] = right;
        }
    }
    // Top/bottom rows (including the now-filled corners).
    const top = origin - EDGE;
    const bot = origin + (h - 1) * stride - EDGE;
    const full = w + 2 * EDGE;
    for (let y = 1; y <= EDGE; y++) {
        p.copyWithin(top - y * stride, top, top + full);
        p.copyWithin(bot + y * stride, bot, bot + full);
    }
}

export function extendEdges(f: Frame): void {
    extendPlane(f.y, f.yStride, f.yOrigin, f.w, f.h);
    extendPlane(f.u, f.cStride, f.cOrigin, f.cw, f.ch);
    extendPlane(f.v, f.cStride, f.cOrigin, f.cw, f.ch);
}

// Repack into a tightly-packed I420 buffer for VideoSample.
export function packI420(f: Frame): Uint8Array {
    const out = new Uint8Array(f.w * f.h + 2 * f.cw * f.ch);
    let o = 0;
    for (let y = 0; y < f.h; y++) {
        const r = f.yOrigin + y * f.yStride;
        out.set(f.y.subarray(r, r + f.w), o);
        o += f.w;
    }
    for (let y = 0; y < f.ch; y++) {
        const r = f.cOrigin + y * f.cStride;
        out.set(f.u.subarray(r, r + f.cw), o);
        o += f.cw;
    }
    for (let y = 0; y < f.ch; y++) {
        const r = f.cOrigin + y * f.cStride;
        out.set(f.v.subarray(r, r + f.cw), o);
        o += f.cw;
    }
    return out;
}
