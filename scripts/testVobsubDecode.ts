// Decoder harness for web/player/vobsub.ts. Reads the raw SPU packets dumped
// by the scratchpad fixture generator, decodes each with our decoder, and
// writes the RGBA out for pixel comparison against ffmpeg's own dvdsub output.
//
//   npx tsx scripts/testVobsubDecode.ts <fixtureDir>

import * as fs from "fs";
import * as path from "path";
import { decodeSpuBitmap, spuTiming, parseIdxHeader } from "../web/player/vobsub";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: testVobsubDecode.ts <fixtureDir>");
    process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(path.join(dir, "spu_meta.json"), "utf8"));
const idxText = `size: ${meta.w}x${meta.h}\npalette: ${meta.palette.join(", ")}\n`;
const { palette, width, height } = parseIdxHeader(idxText);

console.log(`idx header -> ${width}x${height}, palette[0..3] =`,
    [...palette.slice(0, 4)].map(v => v.toString(16).padStart(6, "0")).join(" "));

let failures = 0;
for (const cue of meta.cues) {
    const data = new Uint8Array(fs.readFileSync(path.join(dir, `spu_${cue.i}.bin`)));

    const timing = spuTiming(data);
    const expectedHide = Math.round((cue.end - cue.start) * 1000);
    const hideOk = timing && timing.hideDelayMs !== undefined
        && Math.abs(timing.hideDelayMs - expectedHide) <= 15;
    const showOk = timing && Math.abs(timing.showDelayMs) <= 15;

    const bmp = decodeSpuBitmap(data, palette);
    if (!bmp) {
        console.log(`cue ${cue.i}: DECODE FAILED`);
        failures++;
        continue;
    }

    fs.writeFileSync(path.join(dir, `out_${cue.i}.rgba`), Buffer.from(bmp.rgba.buffer));
    fs.writeFileSync(path.join(dir, `out_${cue.i}.json`), JSON.stringify({
        x: bmp.x, y: bmp.y, width: bmp.width, height: bmp.height,
        showDelayMs: timing?.showDelayMs, hideDelayMs: timing?.hideDelayMs,
    }));

    // Sanity: some pixels must be opaque, and the fully-transparent background
    // must dominate (subtitles are mostly empty space).
    let opaque = 0;
    for (let i = 3; i < bmp.rgba.length; i += 4) if (bmp.rgba[i] > 0) opaque++;
    const total = bmp.width * bmp.height;
    const pct = (opaque / total) * 100;

    const okShape = bmp.width === meta.w && bmp.height === meta.h;
    const okInk = pct > 0.5 && pct < 40;
    if (!okShape || !okInk || !hideOk || !showOk) failures++;

    console.log(
        `cue ${cue.i}: ${bmp.width}x${bmp.height} @${bmp.x},${bmp.y} ` +
        `ink=${pct.toFixed(2)}% show=${timing?.showDelayMs}ms hide=${timing?.hideDelayMs}ms ` +
        `(expect hide ~${expectedHide}ms) ` +
        `${okShape ? "" : "BAD-SHAPE "}${okInk ? "" : "BAD-INK "}${hideOk ? "" : "BAD-HIDE "}${showOk ? "" : "BAD-SHOW "}`,
    );
}

console.log(failures === 0 ? "\nDECODE OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
