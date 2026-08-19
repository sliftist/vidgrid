// Regression tests for the SPU display-control chain (web/player/vobsub.ts).
//
//   npx tsx scripts/testVobsubControl.ts
//
// Self-contained: every SPU is built in memory, so this needs no fixtures and
// runs anywhere. It covers the DCSQ shapes real discs emit, in particular the
// fade-out sequence (a trailing DCSQ that zeroes alpha before stopping) that
// makes a naive "fold every command" parser decode the cue to nothing.

import { decodeSpuBitmap, spuTiming, VobsubPalette } from "../web/player/vobsub";

const PLANE_W = 720, PLANE_H = 480;
const X1 = 10, Y1 = 400, W = 96, H = 24;   // cue rect inside the plane
const INK_FROM = 20, INK_TO = 60;          // columns painted with colour 1

// --- RLE encoding -----------------------------------------------------------
// A run is `(len << 2) | colour`. The decoder keeps reading nibbles while the
// value so far is below the threshold for its length, so each form has a
// minimum: 1 nibble needs >= 0x4, 2 need >= 0x10, 3 need >= 0x40. A value under
// 0x4 — notably the `run 0` = "rest of the line" marker — therefore has to be
// written in the full 4-nibble form, or the decoder consumes the next run's
// nibble and every following scanline desyncs.
function pushRun(nibbles: number[], len: number, colour: number) {
    const v = (len << 2) | colour;
    if (v >= 0x4 && v < 0x10) nibbles.push(v);
    else if (v >= 0x10 && v < 0x40) nibbles.push(v >> 4, v & 0xf);
    else if (v >= 0x40 && v < 0x100) nibbles.push(v >> 8, (v >> 4) & 0xf, v & 0xf);
    else nibbles.push((v >> 12) & 0xf, (v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
}

// One field = every other scanline, each padded to a byte boundary.
function encodeField(rows: number[]): Uint8Array {
    const nibbles: number[] = [];
    for (const _ of rows) {
        pushRun(nibbles, INK_FROM, 0);
        pushRun(nibbles, INK_TO - INK_FROM, 1);
        pushRun(nibbles, 0, 0); // run 0 = "rest of the line"
        if (nibbles.length % 2) nibbles.push(0); // byte-align the scanline
    }
    const out = new Uint8Array(nibbles.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
    return out;
}

type Variant = "plain" | "fadeOut" | "fadeIn";

function buildSpu(variant: Variant, hideDelay: number): Uint8Array {
    const topRows = Array.from({ length: Math.ceil(H / 2) }, (_, i) => i);
    const botRows = Array.from({ length: Math.floor(H / 2) }, (_, i) => i);
    const top = encodeField(topRows);
    const bot = encodeField(botRows);

    const topOffset = 4;
    const botOffset = topOffset + top.length;
    const rleEnd = botOffset + bot.length;

    // Colours: pixel value 0->palette 0, 1->1, 2->2, 3->3.
    const colByte0 = (3 << 4) | 2, colByte1 = (1 << 4) | 0;
    // Alpha: value 0 transparent, 1..3 opaque. Nibble order mirrors colour.
    const opaque0 = (15 << 4) | 15, opaque1 = (15 << 4) | 0;

    const x2 = X1 + W - 1, y2 = Y1 + H - 1;
    const area = [
        X1 >> 4, ((X1 & 0xf) << 4) | (x2 >> 8), x2 & 0xff,
        Y1 >> 4, ((Y1 & 0xf) << 4) | (y2 >> 8), y2 & 0xff,
    ];

    const firstAlpha = variant === "fadeIn" ? [0x00, 0x00] : [opaque0, opaque1];
    const seq0: number[] = [
        0x03, colByte0, colByte1,
        0x04, firstAlpha[0], firstAlpha[1],
        0x05, ...area,
        0x06, topOffset >> 8, topOffset & 0xff, botOffset >> 8, botOffset & 0xff,
        0x01,       // start display
        0xff,
    ];
    const seq1: number[] = [];
    if (variant === "fadeOut") seq1.push(0x04, 0x00, 0x00);       // fade to nothing
    if (variant === "fadeIn") seq1.push(0x04, opaque0, opaque1);  // ramp up to visible
    seq1.push(0x02, 0xff);                                        // stop display

    const seq0Off = rleEnd;
    const seq1Off = seq0Off + 4 + seq0.length;
    const total = seq1Off + 4 + seq1.length;

    const buf = new Uint8Array(total);
    const w16 = (p: number, v: number) => { buf[p] = v >> 8; buf[p + 1] = v & 0xff; };
    w16(0, total);
    w16(2, seq0Off);
    buf.set(top, topOffset);
    buf.set(bot, botOffset);
    w16(seq0Off, 0); w16(seq0Off + 2, seq1Off);
    buf.set(seq0, seq0Off + 4);
    // A DCSQ whose "next" points at itself terminates the chain.
    w16(seq1Off, Math.round((hideDelay * 90000) / 1024 / 1000));
    w16(seq1Off + 2, seq1Off);
    buf.set(seq1, seq1Off + 4);
    return buf;
}

// --- checks -----------------------------------------------------------------
const palette = new Uint32Array(16) as VobsubPalette;
palette[0] = 0x000000; palette[1] = 0xffffff; palette[2] = 0xff0000; palette[3] = 0x00ff00;

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

for (const variant of ["plain", "fadeOut", "fadeIn"] as Variant[]) {
    console.log(`\n${variant}:`);
    const spu = buildSpu(variant, 2000);

    const t = spuTiming(spu);
    check("timing parsed", !!t, t ? `show=${t.showDelayMs}ms hide=${t.hideDelayMs}ms` : "undefined");
    check("hide ~2000ms", !!t && t.hideDelayMs !== undefined && Math.abs(t.hideDelayMs - 2000) <= 15,
        String(t?.hideDelayMs));

    const bmp = decodeSpuBitmap(spu, palette);
    if (!bmp) {
        check("bitmap decoded", false, "decodeSpuBitmap returned undefined");
        continue;
    }
    check("bitmap decoded", true, `${bmp.width}x${bmp.height}@${bmp.x},${bmp.y}`);
    check("geometry", bmp.width === W && bmp.height === H && bmp.x === X1 && bmp.y === Y1,
        `expected ${W}x${H}@${X1},${Y1}`);

    let opaque = 0;
    for (let i = 3; i < bmp.rgba.length; i += 4) if (bmp.rgba[i] > 0) opaque++;
    const expected = (INK_TO - INK_FROM) * H;
    // This is the assertion the fold-everything parser failed: a fade-out cue
    // decoded to zero visible pixels.
    check("has visible pixels", opaque > 0, `${opaque} opaque px`);
    check("ink count", opaque === expected, `${opaque} vs expected ${expected}`);

    // Spot-check that the ink is where we painted it and the rest is clear.
    const at = (x: number, y: number) => bmp.rgba[(y * bmp.width + x) * 4 + 3];
    check("ink opaque mid-rect", at(INK_FROM + 5, 5) > 0 && at(INK_FROM + 5, 6) > 0, "both fields");
    check("background transparent", at(2, 5) === 0 && at(W - 2, 6) === 0, "");
}

console.log(failures === 0 ? "\nCONTROL CHAIN OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
