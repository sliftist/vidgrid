// Victim-tab decode service — runs on the tab's MAIN THREAD (WebCodecs/WebGPU
// are available there; no web worker). The coordinator SharedWorker sends
// "decode this file for phase X"; we open the file via the File System API,
// decode/detect/embed on the main thread, and ship the raw result straight back
// over the coordinator port. We NEVER touch BulkDatabase2 — the SharedWorker owns
// all state. If this tab starts playing video we abort immediately and refuse
// further decoding until it's paused / off the player, so decoding never lags
// playback.

import { observable, runInAction } from "mobx";
import { resolveFileHandle } from "./folderTraversal";
import { MetadataExtractorClient } from "./MetadataExtractorClient";
import type { ReadableFile } from "./MetadataExtractorClient";

// Indicator state (shown bottom-right in the tab that's actively decoding).
export const victimDecoding = observable.box<boolean>(false);
export const victimCurrentFile = observable.box<string | undefined>(undefined);
export const victimStartMs = observable.box<number>(0);

// Decode in a DEDICATED worker (metadataWorker via this client) — NOT on the
// victim tab's main thread, which would freeze the tab (and, on a pathological
// file, hang it hard). The client owns the worker, applies a 30s per-file
// timeout, and terminates + respawns the worker if a file wedges it.
const extractor = new MetadataExtractorClient();
let refusing = false;

// Called when this tab starts/stops playing video. On start we abort any in-flight
// decode at once so it can't lag playback, and refuse new requests until stopped.
export function setDecodeRefusing(refuse: boolean): void {
    refusing = refuse;
    if (refuse) {
        extractor.abort();
        setIndicator(false, undefined);
    }
}

function setIndicator(on: boolean, file: string | undefined): void {
    runInAction(() => {
        victimDecoding.set(on);
        victimCurrentFile.set(file);
        if (on) victimStartMs.set(Date.now());
    });
}

async function openByPath(handle: FileSystemDirectoryHandle, relativePath: string): Promise<ReadableFile | undefined> {
    try {
        const fh = await resolveFileHandle(handle, relativePath);
        const f = await fh.getFile();
        return {
            name: f.name || relativePath.split("/").pop() || relativePath,
            size: f.size,
            lastModified: f.lastModified,
            read: async (start, end) => new Uint8Array(await f.slice(start, end).arrayBuffer()),
        };
    } catch (err) {
        if ((err as { name?: string })?.name === "NotFoundError") return undefined;
        throw err;
    }
}

// Handle one decode request from the coordinator. `post` sends a message back on
// the coordinator port.
export async function handleDecodeRequest(
    data: any,
    handle: FileSystemDirectoryHandle | undefined,
    post: (msg: any, transfer?: Transferable[]) => void,
): Promise<void> {
    const reqId = data.reqId;
    if (data.type === "decodeAbort") { extractor.abort(); return; }
    if (data.type !== "decode") return;

    if (refusing) { post({ type: "decodeResult", reqId, error: "victim is playing video" }); return; }
    if (!handle) { post({ type: "decodeResult", reqId, error: "no folder handle" }); return; }

    const { op, relativePath, softwareDecode, fp16 } = data;
    const file = await openByPath(handle, relativePath).catch(() => undefined);
    if (!file) { post({ type: "decodeResult", reqId, error: "file not found" }); return; }

    console.log(`[victim] decoding ${op} for ${relativePath}`);
    setIndicator(true, relativePath);
    try {
        if (op === "extract") {
            const info = await extractor.extract(file, `[decode ${file.name}]`, softwareDecode);
            post({ type: "decodeResult", reqId, result: info });
        } else if (op === "extractKeyframes") {
            const bundle = await extractor.extractKeyframes(file, `[decode ${file.name}]`, undefined, softwareDecode);
            post({ type: "decodeResult", reqId, result: bundle }, [bundle.data.buffer as ArrayBuffer]);
        } else if (op === "extractFaceFrames") {
            const count = await extractor.extractFaceFrames(file, `[decode ${file.name}]`, (frame) => {
                const transfer: ArrayBuffer[] = [frame.jpeg.buffer as ArrayBuffer];
                const faces = frame.faces.map(f => {
                    const emb = f.embedding.buffer.slice(f.embedding.byteOffset, f.embedding.byteOffset + f.embedding.byteLength);
                    transfer.push(emb);
                    return { x1: f.bbox.x1, y1: f.bbox.y1, x2: f.bbox.x2, y2: f.bbox.y2, score: f.score, embedding: emb };
                });
                post({ type: "faceFrame", reqId, timeMs: frame.timeMs, width: frame.width, height: frame.height, jpeg: frame.jpeg.buffer, faces }, transfer);
            }, undefined, fp16, softwareDecode);
            post({ type: "decodeDone", reqId, count });
        } else {
            post({ type: "decodeResult", reqId, error: `unknown op ${op}` });
        }
    } catch (err) {
        post({ type: "decodeResult", reqId, error: (err as Error).message ?? String(err) });
    } finally {
        setIndicator(false, undefined);
    }
}
