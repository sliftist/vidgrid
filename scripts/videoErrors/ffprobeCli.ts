// Manual ffprobe / ffmpeg-decode entry point — the "call ffmpeg for probing"
// half of the triage toolkit. Separate package.json script so granting it once
// covers every file you point it at.
//
//   yarn vid-ffprobe <fileRef> [--decode] [--limit N]
//
// <fileRef> can be:
//   - an absolute or VIDEO_ROOT-relative path to a file that exists, or
//   - a DB key / path substring matching one or more erroring files (resolved
//     against the index, so you can paste a movie name straight from a report).
//
// Prints the full ffprobe stream/format breakdown; with --decode it also runs a
// few-second null-decode and reports the first decoder error.

import * as fs from "fs";
import * as path from "path";
import { loadErrorRecords, VIDEO_ROOT, bindDataRoot } from "./db";
import { runFfprobe, ffmpegDecodeTest, describeProbe } from "./ffmpeg";

async function resolveTargets(ref: string, limit: number): Promise<{ label: string; absPath: string }[]> {
    // Direct path first — absolute, or relative to the scan root.
    const direct = path.isAbsolute(ref) ? ref : path.resolve(VIDEO_ROOT, ref);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return [{ label: ref, absPath: direct }];
    }
    // Otherwise treat it as a key / substring over the erroring set.
    const all = await loadErrorRecords();
    const needle = ref.toLowerCase();
    const matches = all.filter(r =>
        r.key === ref ||
        r.relativePath.toLowerCase().includes(needle));
    return matches.slice(0, limit).map(r => ({ label: r.relativePath, absPath: r.absPath }));
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const decode = argv.includes("--decode");
    let limit = 5;
    const li = argv.indexOf("--limit");
    if (li >= 0) limit = Number(argv[li + 1]);
    const ref = argv.find(a => !a.startsWith("--") && a !== String(limit));
    if (!ref) {
        console.error("Usage: yarn vid-ffprobe <fileRef> [--decode] [--limit N]");
        process.exit(2);
        return;
    }

    bindDataRoot();
    const targets = await resolveTargets(ref, limit);
    if (targets.length === 0) {
        console.error(`No file or indexed match for "${ref}"`);
        process.exit(1);
        return;
    }

    for (const t of targets) {
        console.log(`\n======== ${t.label}`);
        console.log(t.absPath);
        if (!fs.existsSync(t.absPath)) { console.log("(missing on disk)"); continue; }
        const p = await runFfprobe(t.absPath);
        console.log(describeProbe(p));
        if (p.format) {
            console.log(`format: ${p.format.format_long_name ?? p.format.format_name} dur=${p.format.duration ?? "?"}s size=${p.format.size ?? "?"} bitrate=${p.format.bit_rate ?? "?"}`);
        }
        for (const s of p.streams) {
            const dims = s.width ? ` ${s.width}x${s.height}` : "";
            const extra = [s.profile && `profile=${s.profile}`, s.pix_fmt, s.codec_tag_string && `tag=${s.codec_tag_string}`, s.channels && `${s.channels}ch`, s.sample_rate && `${s.sample_rate}Hz`].filter(Boolean).join(" ");
            console.log(`   #${s.index} ${s.codec_type}: ${s.codec_name ?? "?"} (${s.codec_long_name ?? "?"})${dims} ${extra}`.trimEnd());
        }
        if (p.error) console.log(`error: ${p.error}`);
        if (p.stderr) console.log(`stderr: ${p.stderr}`);
        if (decode) {
            const d = await ffmpegDecodeTest(t.absPath);
            console.log(`decode: ${d.ok ? "OK" : `FAIL${d.timedOut ? " (timeout)" : ""}`}`);
            if (!d.ok && d.stderr) console.log(d.stderr.split("\n").slice(-5).join("\n"));
        }
    }
    console.log("");
}

main().then(() => process.exit(0)).catch(err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
