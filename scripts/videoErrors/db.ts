// Loads the erroring videos out of the bulk index, for the offline error
// triage tools (analyze.ts / ffprobeCli.ts).
//
// The browser scan records a per-file `extractionError` on the FileRecord
// whenever Mediabunny/WebCodecs fails to pull metadata + a thumbnail. Many of
// those failures are pure browser limitations (a codec WebCodecs can't decode
// but ffmpeg/our own decoders can), so we want to look at them outside the
// browser. This module is the one place that knows how to read them.
//
// IMPORTANT: BulkDatabase2 binds its storage path to the cwd on first access,
// so bindDataRoot() must run before any read. The bulk DBs live at
// <VIDEO_ROOT>/data/bulkDatabases2/, matching the convention the face pipeline
// uses (see scripts/faces/faceIngest.ts).

import * as path from "path";
import * as fs from "fs";
import { files } from "../../web/appState";
import type { MediaInfo } from "../../web/MetadataExtractor";

// The folder the library was scanned from. The bulk databases sit under
// <VIDEO_ROOT>/data/ and every FileRecord.relativePath is relative to here, so
// a video's absolute path is VIDEO_ROOT joined with its relativePath.
export const VIDEO_ROOT = "E:/downloads";

let didChdir = false;
export function bindDataRoot(): void {
    if (didChdir) return;
    process.chdir(VIDEO_ROOT);
    didChdir = true;
}

export interface ErrorRecord {
    key: string;
    relativePath: string;
    absPath: string;
    // Whether absPath actually exists on disk right now (a stale index can
    // point at a since-moved/deleted file).
    exists: boolean;
    extractionError: string;
    ext: string;
    videoCodec?: string;
    audioCodec?: string;
    durationSec?: number;
    size?: number;
}

function lc<T>(col: { key: string; value: T }[]): Map<string, T> {
    const m = new Map<string, T>();
    for (const { key, value } of col) m.set(key, value);
    return m;
}

// Every FileRecord whose last extraction failed (non-empty extractionError).
// Empty string = cleared by a later success; undefined = never failed — both
// excluded.
export async function loadErrorRecords(): Promise<ErrorRecord[]> {
    bindDataRoot();
    const [errCol, relCol, vCol, aCol, durCol, sizeCol] = await Promise.all([
        files.getColumn("extractionError"),
        files.getColumn("relativePath"),
        files.getColumn("videoCodec"),
        files.getColumn("audioCodec"),
        files.getColumn("durationSec"),
        files.getColumn("size"),
    ]);
    const rel = lc(relCol);
    const v = lc(vCol);
    const a = lc(aCol);
    const dur = lc(durCol);
    const size = lc(sizeCol);

    const out: ErrorRecord[] = [];
    for (const { key, value } of errCol) {
        if (typeof value !== "string" || value === "") continue;
        const relativePath = rel.get(key);
        if (typeof relativePath !== "string") continue;
        const absPath = path.resolve(VIDEO_ROOT, relativePath);
        const dot = relativePath.lastIndexOf(".");
        out.push({
            key,
            relativePath,
            absPath,
            exists: fs.existsSync(absPath),
            extractionError: value,
            ext: dot >= 0 ? relativePath.slice(dot + 1).toLowerCase() : "",
            videoCodec: v.get(key),
            audioCodec: a.get(key),
            durationSec: dur.get(key),
            size: size.get(key),
        });
    }
    return out;
}

// Full per-track detail for one file, read lazily — the mediaInfo column is the
// heavy one, so we never bulk-load it; the analyzer fetches it per-key only when
// drilling into a single file.
export async function loadMediaInfo(key: string): Promise<MediaInfo | undefined> {
    bindDataRoot();
    return await files.getSingleField(key, "mediaInfo");
}
