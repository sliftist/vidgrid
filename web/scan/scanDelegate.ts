// SharedWorker side of decode delegation.
//
// The SharedWorker does ALL the scanning work (traversal, DB, orchestration,
// clustering) EXCEPT the one thing it physically can't: decode video (a
// SharedWorker has no WebCodecs). For each file that needs decoding it delegates
// to the current "victim" tab — sends "decode this file for phase X", the victim
// decodes on its main thread and ships the raw result back. This module is that
// transport + a drop-in replacement for the extractor interface workerScanCore
// used, so the scan loop calls `remoteExtractor.extract(...)` exactly as before.

import type { ExtractedInfo, KeyframeBundle } from "../MetadataExtractor";
import type { ExtractedFrame, ProgressInfo } from "./MetadataExtractorClient";

type Pending = {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    onFrame?: (f: ExtractedFrame) => Promise<void> | void;
    onProgress?: (info: ProgressInfo) => void;
};

let victimPort: MessagePort | undefined;
let reqCounter = 0;
const pending = new Map<number, Pending>();

// Called by the coordinator whenever the appointed victim changes. Any in-flight
// decode targeting the old victim is rejected so the scan loop retries it on the
// new one.
export function setVictimPort(port: MessagePort | undefined): void {
    if (victimPort === port) return;
    for (const p of pending.values()) p.reject(new Error("victim changed"));
    pending.clear();
    victimPort = port;
}

export function hasVictim(): boolean {
    return !!victimPort;
}

// Called by the coordinator for every message the victim sends back.
export function handleVictimMessage(data: any): void {
    if (!data) return;
    if (data.type === "decodeResult") {
        const p = pending.get(data.reqId);
        if (!p) return;
        pending.delete(data.reqId);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
    } else if (data.type === "decodeProgress") {
        // Per-file sub-progress heartbeat from the victim's decode worker
        // (~1/s). Doesn't resolve/reject — just drives the live progress bar.
        const p = pending.get(data.reqId);
        if (!p || !p.onProgress) return;
        p.onProgress({ message: data.message, currentMs: data.currentMs, durationMs: data.durationMs });
    } else if (data.type === "faceFrame") {
        const p = pending.get(data.reqId);
        if (!p || !p.onFrame) return;
        const frame: ExtractedFrame = {
            timeMs: data.timeMs,
            jpeg: new Uint8Array(data.jpeg),
            width: data.width,
            height: data.height,
            faces: (data.faces as { x1: number; y1: number; x2: number; y2: number; score: number; embedding: ArrayBuffer }[])
                .map(f => ({ bbox: { x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2 }, score: f.score, embedding: new Float32Array(f.embedding) })),
        };
        void p.onFrame(frame);
    } else if (data.type === "decodeDone") {
        const p = pending.get(data.reqId);
        if (!p) return;
        pending.delete(data.reqId);
        p.resolve(data.count);
    }
}

function send<T>(op: string, relativePath: string, extra: Record<string, unknown>, onFrame?: (f: ExtractedFrame) => Promise<void> | void, onProgress?: (info: ProgressInfo) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (!victimPort) { reject(new Error("no decode victim available")); return; }
        const reqId = ++reqCounter;
        pending.set(reqId, { resolve, reject, onFrame, onProgress });
        try {
            victimPort.postMessage({ type: "decode", reqId, op, relativePath, ...extra });
        } catch (err) {
            pending.delete(reqId);
            reject(err as Error);
        }
    });
}

// Same shape workerScanCore expects, but each call is delegated to the victim.
export const remoteExtractor = {
    hasVictim,
    extract(relativePath: string, _label: string, softwareDecode: boolean): Promise<ExtractedInfo> {
        return send<ExtractedInfo>("extract", relativePath, { softwareDecode });
    },
    extractKeyframes(relativePath: string, _label: string, softwareDecode: boolean, onProgress?: (info: ProgressInfo) => void): Promise<KeyframeBundle> {
        return send<KeyframeBundle>("extractKeyframes", relativePath, { softwareDecode }, undefined, onProgress);
    },
    extractFaceFrames(relativePath: string, _label: string, onFrame: (f: ExtractedFrame) => Promise<void> | void, fp16: boolean, softwareDecode: boolean, onProgress?: (info: ProgressInfo) => void): Promise<number> {
        return send<number>("extractFaceFrames", relativePath, { fp16, softwareDecode }, onFrame, onProgress);
    },
    abort(): void {
        for (const p of pending.values()) p.reject(new Error("Scan aborted"));
        pending.clear();
        try { victimPort?.postMessage({ type: "decodeAbort" }); } catch { /* ignore */ }
    },
};
