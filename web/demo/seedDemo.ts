// Demo / screenshot fixture. Writes a believable library straight into the
// `files` + `thumbnails` collections and flips `state.folderReady`, so the grid
// renders a populated UI with zero real files on disk. Triggered only by the
// `?demo=1` URL param (see browser.tsx) — never at import time.
//
// Thumbnails are generated on a canvas (a per-title gradient + a play glyph +
// the name), so every cell looks distinct and the screenshots read clearly.

import { runInAction } from "mobx";
import { files, thumbnails, state, pathKey, FileRecord, ThumbnailRecord } from "../appState";

interface DemoSpec {
    relativePath: string;
    durationSec: number;
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string;
    // 0..1 watched fraction → drives the progress bar; omit for unwatched.
    watched?: number;
}

const MOVIES: [string, number, number][] = [
    // [title (with ext), durationSec, watchedPct*100 (0 = unwatched)]
    ["Inception (2010).mkv", 8880, 100],
    ["Blade Runner 2049 (2017).mp4", 9840, 62],
    ["Interstellar (2014).mkv", 10140, 0],
    ["The Matrix (1999).mp4", 8160, 100],
    ["Dune - Part Two (2024).mkv", 9960, 28],
    ["Spirited Away (2001).mkv", 7500, 0],
    ["Parasite (2019).mp4", 7920, 88],
    ["Mad Max - Fury Road (2015).mkv", 7200, 0],
    ["Arrival (2016).mp4", 7080, 45],
    ["Whiplash (2014).mkv", 6660, 0],
    ["Everything Everywhere All At Once (2022).mkv", 8340, 12],
    ["The Grand Budapest Hotel (2014).mp4", 5990, 0],
];

const SERIES: { folder: string; episodes: string[]; durationSec: number }[] = [
    {
        folder: "Breaking Bad",
        durationSec: 2820,
        episodes: [
            "Breaking Bad - S01E01 - Pilot.mkv",
            "Breaking Bad - S01E02 - Cat's in the Bag.mkv",
            "Breaking Bad - S01E03 - And the Bag's in the River.mkv",
            "Breaking Bad - S01E04 - Cancer Man.mkv",
            "Breaking Bad - S01E05 - Gray Matter.mkv",
            "Breaking Bad - S01E06 - Crazy Handful of Nothin'.mkv",
            "Breaking Bad - S01E07 - A No-Rough-Stuff-Type Deal.mkv",
        ],
    },
    {
        folder: "Planet Earth II",
        durationSec: 3000,
        episodes: [
            "Planet Earth II - 01 - Islands.mkv",
            "Planet Earth II - 02 - Mountains.mkv",
            "Planet Earth II - 03 - Jungles.mkv",
            "Planet Earth II - 04 - Deserts.mkv",
            "Planet Earth II - 05 - Grasslands.mkv",
            "Planet Earth II - 06 - Cities.mkv",
        ],
    },
    {
        folder: "The Office",
        durationSec: 1320,
        episodes: [
            "The Office - S02E01 - The Dundies.mp4",
            "The Office - S02E02 - Sexual Harassment.mp4",
            "The Office - S02E03 - Office Olympics.mp4",
            "The Office - S02E04 - The Fire.mp4",
            "The Office - S02E05 - Halloween.mp4",
            "The Office - S02E06 - The Fight.mp4",
        ],
    },
];

function baseName(relativePath: string): string {
    const slash = relativePath.lastIndexOf("/");
    return slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
}

// Stable hue from a string so each title keeps the same color across reloads.
function hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function drawPoster(ctx: CanvasRenderingContext2D, w: number, h: number, title: string): void {
    const hue = hashHue(title);
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue}, 55%, 32%)`);
    grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 60%, 16%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Soft vignette so text stays legible at the bottom.
    const vg = ctx.createLinearGradient(0, h * 0.4, 0, h);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // Play glyph.
    const cx = w / 2, cy = h * 0.42, r = h * 0.16;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.85);
    ctx.lineTo(cx - r * 0.5, cy + r * 0.85);
    ctx.lineTo(cx + r, cy);
    ctx.closePath();
    ctx.fill();

    // Title (dropping the extension), wrapped to two lines max.
    const clean = title.replace(/\.[a-z0-9]+$/i, "");
    ctx.fillStyle = "white";
    ctx.font = `${Math.round(h * 0.075)}px sans-serif`;
    ctx.textBaseline = "alphabetic";
    const maxW = w * 0.9;
    const words = clean.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxW && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 2);
    const lh = h * 0.09;
    let y = h - 16 - (shown.length - 1) * lh;
    for (const l of shown) {
        ctx.fillText(l, w * 0.05, y);
        y += lh;
    }
}

function makeThumb(title: string, width: number): Uint8Array {
    const height = Math.round(width * 9 / 16);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    drawPoster(ctx, width, height, title);
    return dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.85));
}

let seeded = false;

export async function seedDemoData(): Promise<void> {
    if (seeded) return;
    seeded = true;

    const now = Date.now();
    const fileRecords: FileRecord[] = [];
    const thumbRecords: ThumbnailRecord[] = [];

    const add = (relativePath: string, durationSec: number, watchedPct: number, idx: number) => {
        const key = pathKey(relativePath);
        const name = baseName(relativePath);
        const addedAt = now - idx * 3_600_000;
        fileRecords.push({
            key,
            name,
            relativePath,
            size: Math.round(durationSec * 1_200_000),
            seenAt: now,
            addedAt,
            fileModifiedAt: addedAt,
            durationSec,
            width: 1920,
            height: 1080,
            videoCodec: relativePath.endsWith(".mp4") ? "avc" : "hevc",
            audioCodec: relativePath.endsWith(".mp4") ? "aac" : "eac3",
            metadataExtractedAt: now,
            positionSec: watchedPct > 0 ? Math.round(durationSec * watchedPct / 100) : undefined,
            positionUpdatedAt: watchedPct > 0 ? addedAt : undefined,
        });
        thumbRecords.push({
            key,
            thumb160: makeThumb(name, 160),
            thumb320: makeThumb(name, 320),
            thumb640: makeThumb(name, 640),
            thumbW: 640,
            thumbH: 360,
            thumbSource: "auto",
        });
    };

    let idx = 0;
    for (const [title, durationSec, watchedPct] of MOVIES) add(title, durationSec, watchedPct, idx++);
    for (const s of SERIES) {
        for (let e = 0; e < s.episodes.length; e++) {
            add(`${s.folder}/${s.episodes[e]}`, s.durationSec, e === 0 ? 100 : (e === 1 ? 40 : 0), idx++);
        }
    }

    await files.writeBatch(fileRecords);
    await thumbnails.writeBatch(thumbRecords);

    runInAction(() => {
        state.rootName = "Demo Library";
        state.folderReady = true;
    });
}
