// End-to-end check of VobSub extraction from real containers.
//
//   npx tsx scripts/testVobsubExtract.ts <file.mkv|file.mp4> <outDir>
//
// Pulls the subtitle track out of the container, decodes every cue's SPU, and
// writes the RGBA + geometry so the fixture comparison can diff it against
// ffmpeg's own dvdsub rendering.

import * as fs from "fs";
import * as path from "path";
import { extractMkvSubtitles, listMkvSubtitleTracks } from "../web/player/mkv";
import { extractMp4Subtitles, listMp4SubtitleTracks } from "../web/player/mp4";
import { decodeSpuBitmap } from "../web/player/vobsub";

async function main() {
    const src = process.argv[2];
    const outDir = process.argv[3];
    if (!src || !outDir) {
        console.error("usage: testVobsubExtract.ts <file> <outDir>");
        process.exit(1);
    }

    const buf = fs.readFileSync(src);
    const file = new File([buf], path.basename(src));

    // Extraction is per-track now, so list first and take the first entry.
    const isMp4 = /\.(mp4|m4v|mov)$/i.test(src);
    const track = isMp4
        ? await extractMp4Subtitles(file, (await listMp4SubtitleTracks(file))[0]?.index ?? 0)
        : await extractMkvSubtitles(file, (await listMkvSubtitleTracks(file))[0]?.number ?? 1);

    if (!track) {
        console.log("NO TRACK FOUND");
        process.exit(1);
    }

    console.log(`label: ${track.label}`);
    console.log(`cues: ${track.cues.length}`);
    if (track.bitmap) {
        console.log(`bitmap space: ${track.bitmap.width}x${track.bitmap.height}`);
        console.log(`palette[0..3]: ${[...track.bitmap.palette.slice(0, 4)]
            .map(v => v.toString(16).padStart(6, "0")).join(" ")}`);
    } else {
        console.log("(text track)");
    }

    fs.mkdirSync(outDir, { recursive: true });
    let failures = 0;
    track.cues.forEach((c, i) => {
        const kind = c.spu ? "spu" : "text";
        let extra = "";
        if (c.spu && track.bitmap) {
            const bmp = decodeSpuBitmap(c.spu, track.bitmap.palette);
            if (!bmp) {
                extra = " DECODE-FAILED";
                failures++;
            } else {
                let opaque = 0;
                for (let k = 3; k < bmp.rgba.length; k += 4) if (bmp.rgba[k] > 0) opaque++;
                const pct = (opaque / (bmp.width * bmp.height)) * 100;
                extra = ` ${bmp.width}x${bmp.height}@${bmp.x},${bmp.y} ink=${pct.toFixed(2)}%`;
                if (pct <= 0.05) { extra += " BLANK"; failures++; }
                fs.writeFileSync(path.join(outDir, `x_${i}.rgba`), Buffer.from(bmp.rgba.buffer));
                fs.writeFileSync(path.join(outDir, `x_${i}.json`), JSON.stringify({
                    x: bmp.x, y: bmp.y, width: bmp.width, height: bmp.height,
                    startMs: c.startMs, endMs: c.endMs,
                }));
            }
        } else {
            extra = ` ${JSON.stringify(c.text.slice(0, 40))}`;
        }
        console.log(`  [${i}] ${kind} ${c.startMs}..${c.endMs}ms${extra}`);
    });

    console.log(failures === 0 ? "\nEXTRACT OK" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error("FAILED:", e); process.exit(1); });
