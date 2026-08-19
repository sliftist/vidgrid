// Sidecar subtitle discovery: `.srt` / `.vtt` files sitting next to the video
// in the same folder. Split out from ./subtitles because this is the only part
// of subtitle loading that reaches into the app's folder handle, and keeping
// it here lets the container demuxers stay dependency-free.

import { ensureFolder } from "../appState";
import { parseSubtitles, SubtitleTrack } from "./subtitles";

// Find and load the best sidecar subtitle for a video. Enumerates the video's
// own folder for `<stem>.srt` / `<stem>.vtt` (optionally with a language tag,
// e.g. `<stem>.eng.srt`) and picks the configured language when several exist.
export async function loadSidecarSubtitles(
    relativePath: string,
    lang: string,
): Promise<SubtitleTrack | undefined> {
    const root = await ensureFolder();
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
