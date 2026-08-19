// The subtitle model, plus the format-agnostic parsing every source shares.
// One parser handles both sidecar formats (`.srt` / `.vtt`) — they share the
// "timestamp --> timestamp / text-lines" block shape, differing only in the
// millisecond separator (SRT `,` vs VTT `.`) and VTT's optional header / cue
// settings, both of which the parser tolerates.
//
// Deliberately free of app dependencies: the container demuxers (./mkv, ./mp4)
// import the helpers below, and byte-level parsers should not transitively
// depend on the app's directory-handle state. Loading sidecars off disk — the
// one piece that does need it — lives in ./sidecarSubtitles.

import type { VobsubPalette } from "./vobsub";

// A cue is either text (every format below) or a bitmap (VobSub). Bitmap cues
// keep the raw SPU packet rather than decoded pixels: a single full-frame cue
// is ~1.4 MB of RGBA, so holding every cue in a feature-length film decoded
// would cost gigabytes. The player decodes the one cue that is on screen.
export type SubtitleCue = { startMs: number; endMs: number; text: string; spu?: Uint8Array };

// What a subtitle source resolves to. `bitmap` is present only for bitmap
// tracks, and carries what's needed to turn a cue's SPU into pixels: the
// palette (stored in the container, not the packet) and the coordinate space
// the cue rectangles are expressed in.
export type SubtitleTrack = {
    cues: SubtitleCue[];
    label: string;
    bitmap?: { palette: VobsubPalette; width: number; height: number };
};

// Hours are optional (VTT allows MM:SS.mmm); separator is `.` or `,`.
const TIME_LINE =
    /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
    return (parseInt(h ?? "0", 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000
        + parseInt(ms.padEnd(3, "0").slice(0, 3), 10);
}

// Strip HTML-ish inline tags (<i>, <b>, <font ...>) and ASS/SSA override
// blocks ({\an8}, {\pos...}) so the rendered cue is plain text.
export function stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "");
}

// Subtitle text sometimes carries characters we don't know how to render —
// stray control bytes, zero-width / bidi format marks, the U+FFFD replacement
// glyph — which show up as a "tofu" box. Rather than silently drop them (and
// lose the chance to learn what they are), surface each as a visible `[U+XXXX]`
// escape. Newlines and tabs are real formatting we keep; the control (Cc),
// format (Cf), private-use (Co), surrogate (Cs), line/paragraph separators and
// the replacement character get escaped.
export function escapeUnrenderable(s: string): string {
    return s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029\uFFFD]/gu, ch => {
        if (ch === "\n" || ch === "\t") return ch;
        const cp = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
        return `[U+${cp}]`;
    });
}

// Final cleanup shared by every cue source: drop markup, normalise CR/LF, then
// escape anything unrenderable so it's visible rather than a mystery box.
export function cleanCueText(s: string): string {
    return escapeUnrenderable(stripTags(s).replace(/\r\n?/g, "\n").trim());
}

// One ASS/SSA "Dialogue" payload, as muxed into a Matroska block, is the
// comma-separated event fields with the timing stripped:
//   ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
// Only the trailing Text matters for display; it may itself contain commas, so
// we walk past exactly eight delimiters rather than splitting. ASS line breaks
// are the literal escapes `\N` (hard) / `\n` (soft) and `\h` (hard space).
export function assEventToText(payload: string): string {
    let idx = 0;
    for (let i = 0; i < 8; i++) {
        const c = payload.indexOf(",", idx);
        if (c < 0) { idx = -1; break; }
        idx = c + 1;
    }
    const text = idx >= 0 ? payload.slice(idx) : payload;
    return cleanCueText(text.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
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
        const t = cleanCueText(body.join("\n"));
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

// The most recent cue to have STARTED at or before `timeMs`, ignoring whether
// it has already ended. Unlike activeCue this keeps returning a line through
// the silence gap that follows it. Used only to seed an immediate caption when
// CC is first switched on inside a gap — normal display uses activeCue and so
// stays blank during gaps.
export function previousCue(cues: SubtitleCue[], timeMs: number): SubtitleCue | undefined {
    let prev: SubtitleCue | undefined;
    for (const c of cues) {
        if (c.startMs > timeMs) break;
        prev = c;
    }
    return prev;
}
