// Half-pel motion compensation matching ffmpeg's hpeldsp put/avg pixel ops.
// dxy bit0 = half-pel in x, bit1 = half-pel in y. Rounding follows the MPEG-4
// no_rounding flag: rounding-up adds 1 (x/y) or 2 (xy), no-rounding adds 0 or 1.
// `avg` blends the result into the destination ((dst+v+1)>>1), used to combine
// the forward and backward predictions of a bidirectional B-frame block.

import { EDGE, Frame } from "./frame";

// Core block interpolator. Reads from src starting at sOff (stride sStride),
// writes a bw x bh block to dst at dOff (stride dStride).
function mcBlock(
    src: Uint8Array, sOff: number, sStride: number, dxy: number,
    bw: number, bh: number,
    dst: Uint8Array, dOff: number, dStride: number,
    avg: boolean, noRnd: boolean,
): void {
    const r1 = noRnd ? 0 : 1;
    const r2 = noRnd ? 1 : 2;
    for (let y = 0; y < bh; y++) {
        let s = sOff + y * sStride;
        let d = dOff + y * dStride;
        if (dxy === 0) {
            for (let x = 0; x < bw; x++) {
                const v = src[s]!;
                dst[d] = avg ? (dst[d]! + v + 1) >> 1 : v;
                s++; d++;
            }
        } else if (dxy === 1) {
            for (let x = 0; x < bw; x++) {
                const v = (src[s]! + src[s + 1]! + r1) >> 1;
                dst[d] = avg ? (dst[d]! + v + 1) >> 1 : v;
                s++; d++;
            }
        } else if (dxy === 2) {
            for (let x = 0; x < bw; x++) {
                const v = (src[s]! + src[s + sStride]! + r1) >> 1;
                dst[d] = avg ? (dst[d]! + v + 1) >> 1 : v;
                s++; d++;
            }
        } else {
            for (let x = 0; x < bw; x++) {
                const v = (src[s]! + src[s + 1]! + src[s + sStride]! + src[s + sStride + 1]! + r2) >> 2;
                dst[d] = avg ? (dst[d]! + v + 1) >> 1 : v;
                s++; d++;
            }
        }
    }
}

// Gather a (bw+1)x(bh+1) region into temp with clamped coordinates, for motion
// vectors that point too far outside the padded plane for the fast path.
const emuTemp = new Uint8Array((17 + 1) * (17 + 1));
function emulatedMc(
    plane: Uint8Array, stride: number, origin: number, pw: number, ph: number,
    srcX: number, srcY: number, dxy: number, bw: number, bh: number,
    dst: Uint8Array, dOff: number, dStride: number, avg: boolean, noRnd: boolean,
): void {
    const tw = bw + 1;
    const th = bh + 1;
    for (let y = 0; y < th; y++) {
        let yy = srcY + y;
        if (yy < 0) yy = 0; else if (yy >= ph) yy = ph - 1;
        const rr = origin + yy * stride;
        for (let x = 0; x < tw; x++) {
            let xx = srcX + x;
            if (xx < 0) xx = 0; else if (xx >= pw) xx = pw - 1;
            emuTemp[y * tw + x] = plane[rr + xx]!;
        }
    }
    mcBlock(emuTemp, 0, tw, dxy, bw, bh, dst, dOff, dStride, avg, noRnd);
}

// One plane's motion compensation. (srcX,srcY) is the integer top-left in image
// coordinates (relative to pixel 0,0); dxy is the half-pel phase.
function planeMc(
    plane: Uint8Array, stride: number, origin: number, pw: number, ph: number,
    srcX: number, srcY: number, dxy: number, bw: number, bh: number,
    dst: Uint8Array, dOff: number, dStride: number, avg: boolean, noRnd: boolean,
): void {
    if (srcX >= -EDGE && srcY >= -EDGE &&
        srcX + bw + 1 <= pw + EDGE && srcY + bh + 1 <= ph + EDGE) {
        const sOff = origin + srcY * stride + srcX;
        mcBlock(plane, sOff, stride, dxy, bw, bh, dst, dOff, dStride, avg, noRnd);
    } else {
        emulatedMc(plane, stride, origin, pw, ph, srcX, srcY, dxy, bw, bh,
            dst, dOff, dStride, avg, noRnd);
    }
}

// Luma block (bw x bh, at pixel position px,py) using motion (mx,my) in half-pel.
export function lumaMc(
    ref: Frame, mx: number, my: number, px: number, py: number, bw: number, bh: number,
    dst: Uint8Array, dOff: number, dStride: number, avg: boolean, noRnd: boolean,
): void {
    const dxy = ((my & 1) << 1) | (mx & 1);
    planeMc(ref.y, ref.yStride, ref.yOrigin, ref.w, ref.h,
        px + (mx >> 1), py + (my >> 1), dxy, bw, bh, dst, dOff, dStride, avg, noRnd);
}

// Chroma U+V 8x8 blocks at chroma position (cx,cy) with already-rounded chroma
// motion (cmx,cmy) in half-pel chroma units.
export function chromaMc(
    ref: Frame, cmx: number, cmy: number, cx: number, cy: number,
    dstU: Uint8Array, dstV: Uint8Array, dOff: number, dStride: number,
    avg: boolean, noRnd: boolean,
): void {
    const dxy = ((cmy & 1) << 1) | (cmx & 1);
    const sx = cx + (cmx >> 1);
    const sy = cy + (cmy >> 1);
    planeMc(ref.u, ref.cStride, ref.cOrigin, ref.cw, ref.ch, sx, sy, dxy, 8, 8,
        dstU, dOff, dStride, avg, noRnd);
    planeMc(ref.v, ref.cStride, ref.cOrigin, ref.cw, ref.ch, sx, sy, dxy, 8, 8,
        dstV, dOff, dStride, avg, noRnd);
}
