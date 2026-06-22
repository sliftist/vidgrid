// 8x8 inverse DCT, ported from ffmpeg's ff_simple_idct (BIT_DEPTH 8 path in
// simple_idct_template.c). Operates on an Int16Array block in natural raster
// order (no idct permutation — callers place coefficients via the plain
// zig-zag scan). Constants and shift amounts match ffmpeg so pixel output
// agrees with the C decoder.

const W1 = 22725;
const W2 = 21407;
const W3 = 19266;
const W4 = 16383;
const W5 = 12873;
const W6 = 8867;
const W7 = 4520;

const ROW_SHIFT = 11;
const COL_SHIFT = 20;

// Rounding bias for the column pass: W4 * (col0 + COL_BIAS) == W4*col0 + 2^19.
const COL_BIAS = (1 << (COL_SHIFT - 1)) / W4 | 0;

function idctRow(block: Int16Array, off: number): void {
    const r0 = block[off]!;
    const r1 = block[off + 1]!;
    const r2 = block[off + 2]!;
    const r3 = block[off + 3]!;
    const r4 = block[off + 4]!;
    const r5 = block[off + 5]!;
    const r6 = block[off + 6]!;
    const r7 = block[off + 7]!;

    // DC-only fast path: every AC coefficient is zero.
    if ((r1 | r2 | r3 | r4 | r5 | r6 | r7) === 0) {
        const dc = r0 * 8;
        block[off] = dc;
        block[off + 1] = dc;
        block[off + 2] = dc;
        block[off + 3] = dc;
        block[off + 4] = dc;
        block[off + 5] = dc;
        block[off + 6] = dc;
        block[off + 7] = dc;
        return;
    }

    let a0 = W4 * r0 + (1 << (ROW_SHIFT - 1));
    let a1 = a0;
    let a2 = a0;
    let a3 = a0;

    a0 += W2 * r2;
    a1 += W6 * r2;
    a2 -= W6 * r2;
    a3 -= W2 * r2;

    let b0 = W1 * r1 + W3 * r3;
    let b1 = W3 * r1 - W7 * r3;
    let b2 = W5 * r1 - W1 * r3;
    let b3 = W7 * r1 - W5 * r3;

    if (r4 | r5 | r6 | r7) {
        a0 += W4 * r4 + W6 * r6;
        a1 += -W4 * r4 - W2 * r6;
        a2 += -W4 * r4 + W2 * r6;
        a3 += W4 * r4 - W6 * r6;

        b0 += W5 * r5 + W7 * r7;
        b1 += -W1 * r5 - W5 * r7;
        b2 += W7 * r5 + W3 * r7;
        b3 += W3 * r5 - W1 * r7;
    }

    block[off] = (a0 + b0) >> ROW_SHIFT;
    block[off + 7] = (a0 - b0) >> ROW_SHIFT;
    block[off + 1] = (a1 + b1) >> ROW_SHIFT;
    block[off + 6] = (a1 - b1) >> ROW_SHIFT;
    block[off + 2] = (a2 + b2) >> ROW_SHIFT;
    block[off + 5] = (a2 - b2) >> ROW_SHIFT;
    block[off + 3] = (a3 + b3) >> ROW_SHIFT;
    block[off + 4] = (a3 - b3) >> ROW_SHIFT;
}

// Column pass shared core. Returns the eight results in the provided out array
// (length 8), as (acc >> COL_SHIFT) without clipping.
function idctColCore(block: Int16Array, col: number, out: Int32Array): void {
    const c0 = block[col]!;
    const c1 = block[col + 8]!;
    const c2 = block[col + 16]!;
    const c3 = block[col + 24]!;
    const c4 = block[col + 32]!;
    const c5 = block[col + 40]!;
    const c6 = block[col + 48]!;
    const c7 = block[col + 56]!;

    let a0 = W4 * (c0 + COL_BIAS);
    let a1 = a0;
    let a2 = a0;
    let a3 = a0;

    a0 += W2 * c2;
    a1 += W6 * c2;
    a2 += -W6 * c2;
    a3 += -W2 * c2;

    let b0 = W1 * c1;
    let b1 = W3 * c1;
    let b2 = W5 * c1;
    let b3 = W7 * c1;

    b0 += W3 * c3;
    b1 += -W7 * c3;
    b2 += -W1 * c3;
    b3 += -W5 * c3;

    if (c4) {
        a0 += W4 * c4;
        a1 += -W4 * c4;
        a2 += -W4 * c4;
        a3 += W4 * c4;
    }
    if (c5) {
        b0 += W5 * c5;
        b1 += -W1 * c5;
        b2 += W7 * c5;
        b3 += W3 * c5;
    }
    if (c6) {
        a0 += W6 * c6;
        a1 += -W2 * c6;
        a2 += W2 * c6;
        a3 += -W6 * c6;
    }
    if (c7) {
        b0 += W7 * c7;
        b1 += -W5 * c7;
        b2 += W3 * c7;
        b3 += -W1 * c7;
    }

    out[0] = (a0 + b0) >> COL_SHIFT;
    out[1] = (a1 + b1) >> COL_SHIFT;
    out[2] = (a2 + b2) >> COL_SHIFT;
    out[3] = (a3 + b3) >> COL_SHIFT;
    out[4] = (a3 - b3) >> COL_SHIFT;
    out[5] = (a2 - b2) >> COL_SHIFT;
    out[6] = (a1 - b1) >> COL_SHIFT;
    out[7] = (a0 - b0) >> COL_SHIFT;
}

const colTmp = new Int32Array(8);

function clip8(v: number): number {
    if (v < 0) {
        return 0;
    }
    if (v > 255) {
        return 255;
    }
    return v;
}

// IDCT then write clipped pixels to dest (intra blocks).
export function idctPut(dest: Uint8Array, destOff: number, stride: number, block: Int16Array): void {
    for (let i = 0; i < 8; i++) {
        idctRow(block, i * 8);
    }
    for (let i = 0; i < 8; i++) {
        idctColCore(block, i, colTmp);
        let p = destOff + i;
        for (let r = 0; r < 8; r++) {
            dest[p] = clip8(colTmp[r]!);
            p += stride;
        }
    }
}

// IDCT then add residual to existing pixels, clip (inter blocks).
export function idctAdd(dest: Uint8Array, destOff: number, stride: number, block: Int16Array): void {
    for (let i = 0; i < 8; i++) {
        idctRow(block, i * 8);
    }
    for (let i = 0; i < 8; i++) {
        idctColCore(block, i, colTmp);
        let p = destOff + i;
        for (let r = 0; r < 8; r++) {
            dest[p] = clip8(dest[p]! + colTmp[r]!);
            p += stride;
        }
    }
}
