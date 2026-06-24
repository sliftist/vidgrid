// Subtitle loading + parsing. We support sidecar files (`.srt` / `.vtt`)
// sitting next to the video in the same folder; embedded in-container
// subtitle tracks are not read (the mediabunny build we use exposes no
// subtitle decode path). One parser handles both formats — they share the
// "timestamp --> timestamp / text-lines" block shape, differing only in the
// millisecond separator (SRT `,` vs VTT `.`) and VTT's optional header / cue
// settings, both of which the parser tolerates.

import { state } from "../appState";

export type SubtitleCue = { startMs: number; endMs: number; text: string };

// Hours are optional (VTT allows MM:SS.mmm); separator is `.` or `,`.
const TIME_LINE =
    /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
    return (parseInt(h ?? "0", 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000
        + parseInt(ms.padEnd(3, "0").slice(0, 3), 10);
}

// Strip HTML-ish inline tags (<i>, <b>, <font …>) and ASS/SSA override
// blocks ({\an8}, {\pos…}) so the rendered cue is plain text.
function stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "");
}

export function parseSubtitles(text: string): SubtitleCue[] {
    const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
    const cues: SubtitleCue[] = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(TIME_LINE);
        if (!m) { i++; continue; }
        const startMs = toMs(m[1], m[2], m[3], m[4]);
        const endMs = toMs(m[5], m[6], m[7], m[8]);
        i++;
        const body: string[] = [];
        while (i < lines.length && lines[i].trim() !== "" && !TIME_LINE.test(lines[i])) {
            body.push(lines[i]);
            i++;
        }
        const t = stripTags(body.join("\n")).trim();
        if (t && endMs > startMs) cues.push({ startMs, endMs, text: t });
    }
    cues.sort((a, b) => a.startMs - b.startMs);
    return cues;
}

// Cues are sorted by start. Return the first whose [start, end] spans the
// time; stop once a cue starts after the time (none later can match earlier).
export function activeCue(cues: SubtitleCue[], timeMs: number): SubtitleCue | undefined {
    for (const c of cues) {
        if (c.startMs > timeMs) break;
        if (timeMs <= c.endMs) return c;
    }
    return undefined;
}

// Find and load the best sidecar subtitle for a video. Enumerates the video's
// own folder for `<stem>.srt` / `<stem>.vtt` (optionally with a language tag,
// e.g. `<stem>.eng.srt`) and picks the configured language when several exist.
export async function loadSidecarSubtitles(
    relativePath: string,
    lang: string,
): Promise<{ cues: SubtitleCue[]; label: string } | undefined> {
    const root = state.rootHandle;
    if (!root) return undefined;
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) return undefined;
    const fileName = parts[parts.length - 1];
    const dot = fileName.lastIndexOf(".");
    const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
    const langLower = lang.trim().toLowerCase();

    let dir = root;
    try {
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await (dir as any).getDirectoryHandle(parts[i]);
        }
    } catch {
        return undefined;
    }

    // Collect candidate sidecars in this folder, scored by language fit.
    const cands: { name: string; score: number }[] = [];
    try {
        for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (handle.kind !== "file") continue;
            const nl = name.toLowerCase();
            const ext = nl.endsWith(".srt") ? ".srt" : nl.endsWith(".vtt") ? ".vtt" : undefined;
            if (!ext) continue;
            if (!nl.startsWith(stem)) continue;
            // The chunk between the stem and the extension: "" for "Foo.srt",
            // ".eng" for "Foo.eng.srt". Reject "Foo2.srt" (chunk "2").
            const middle = nl.slice(stem.length, nl.length - ext.length);
            if (middle !== "" && !middle.startsWith(".")) continue;
            let score: number;
            if (langLower && middle === `.${langLower}`) score = 300;
            else if (langLower && middle.includes(langLower)) score = 200;
            else if (middle === "") score = 100;
            else score = 50;
            if (ext === ".srt") score += 1;
            cands.push({ name, score });
        }
    } catch {
        return undefined;
    }
    cands.sort((a, b) => b.score - a.score);

    for (const c of cands) {
        try {
            const fh = await (dir as any).getFileHandle(c.name);
            const file: File = await fh.getFile();
            const cues = parseSubtitles(await file.text());
            if (cues.length) {
                console.log(`[subtitles] ${cues.length} cues from ${c.name}`);
                return { cues, label: c.name };
            }
        } catch {
            // Unreadable/garbled candidate — fall through to the next.
        }
    }
    return undefined;
}
