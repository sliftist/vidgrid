// Sidecar subtitle discovery: `.srt` / `.vtt` files sitting next to the video
// in the same folder. Split out from ./subtitles because this is the only part
// of subtitle loading that reaches into the app's folder handle, and keeping
// it here lets the container demuxers stay dependency-free.

import { ensureFolder } from "../appState";
import { parseSubtitles, SubtitleTrack } from "./subtitles";

export type SidecarFile = {
    name: string;
    // The chunk between the video's stem and the extension, without its dot:
    // "" for "Foo.srt", "eng" for "Foo.eng.srt". This is the only language
    // signal a sidecar carries, and it's a free-form tag, not an ISO code.
    tag: string;
    ext: "srt" | "vtt";
};

// Every sidecar sitting beside the video, unsorted and unopened. Listing is
// separate from loading so the player can show all of them in the menu and
// only read the bytes of the one that gets picked.
export async function listSidecarSubtitles(relativePath: string): Promise<SidecarFile[]> {
    const dir = await sidecarFolder(relativePath);
    if (!dir) return [];
    const stem = videoStem(relativePath);
    const out: SidecarFile[] = [];
    try {
        for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (handle.kind !== "file") continue;
            const nl = name.toLowerCase();
            const ext = nl.endsWith(".srt") ? "srt" : nl.endsWith(".vtt") ? "vtt" : undefined;
            if (!ext) continue;
            if (!nl.startsWith(stem)) continue;
            // Reject "Foo2.srt" for video "Foo.mkv": anything between the stem
            // and the extension must be a dotted suffix.
            const middle = nl.slice(stem.length, nl.length - ext.length - 1);
            if (middle !== "" && !middle.startsWith(".")) continue;
            out.push({ name, tag: middle.replace(/^\./, ""), ext });
        }
    } catch {
        return [];
    }
    return out;
}

export async function loadSidecarSubtitles(
    relativePath: string,
    name: string,
): Promise<SubtitleTrack | undefined> {
    const dir = await sidecarFolder(relativePath);
    if (!dir) return undefined;
    try {
        const fh = await (dir as any).getFileHandle(name);
        const file: File = await fh.getFile();
        const cues = parseSubtitles(await file.text());
        if (!cues.length) return undefined;
        console.log(`[subtitles] ${cues.length} cues from ${name}`);
        return { cues, label: name };
    } catch {
        return undefined;
    }
}

function videoStem(relativePath: string): string {
    const fileName = relativePath.split("/").filter(Boolean).pop() ?? "";
    const dot = fileName.lastIndexOf(".");
    return (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
}

async function sidecarFolder(relativePath: string): Promise<FileSystemDirectoryHandle | undefined> {
    const root = await ensureFolder();
    if (!root) return undefined;
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) return undefined;
    let dir = root;
    try {
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await (dir as any).getDirectoryHandle(parts[i]);
        }
    } catch {
        return undefined;
    }
    return dir;
}
