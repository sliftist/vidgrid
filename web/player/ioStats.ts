// STYLE: no rounded corners anywhere in this project — never call .borderRadius
// on any element. Keep edges sharp.

import { observable, runInAction } from "mobx";

// Rolling disk-read telemetry for the player overlay. Every MediaFile.read
// goes through recordReadStart(bytes) before the await and recordReadDone on
// settle, so the overlay can surface: total bytes pulled off disk this
// session, the volume read in the last 60s (a coarse "is the drive keeping
// up" gauge), and how much was requested but hasn't come back yet
// (outstanding) — a backed-up disk shows a growing outstanding number.

const WINDOW_MS = 60_000;

interface ReadSample { t: number; bytes: number; }

// Completed-read ring, pruned to the last WINDOW_MS lazily. Not observable —
// readRatePerSec() recomputes from it; the overlay establishes reactivity
// off ioStats.totalBytes (which moves on every settled read).
const samples: ReadSample[] = [];
// When the first read landed, so the rate divides by the real elapsed window
// (e.g. 10s in if we've only read for 10s) rather than a flat 60 — which would
// understate the rate during the first minute. 0 = nothing read yet.
let firstSampleMs = 0;

export const ioStats = observable(
    { totalBytes: 0, outstandingBytes: 0 },
    undefined,
    { deep: false },
);

export function recordReadStart(bytes: number): void {
    if (!(bytes > 0)) return;
    runInAction(() => { ioStats.outstandingBytes += bytes; });
}

// Settle whether the read resolved or threw — an errored read still freed its
// outstanding claim. Only a successful read counts toward total/last-60s.
export function recordReadDone(bytes: number, ok: boolean): void {
    if (!(bytes > 0)) return;
    runInAction(() => {
        ioStats.outstandingBytes = Math.max(0, ioStats.outstandingBytes - bytes);
        if (ok) ioStats.totalBytes += bytes;
    });
    if (ok) {
        const now = Date.now();
        if (firstSampleMs === 0) firstSampleMs = now;
        samples.push({ t: now, bytes });
    }
}

// Average read throughput (bytes/sec) over the last WINDOW_MS. Divides by the
// actual elapsed window — capped at WINDOW_MS, but shorter while we've been
// reading for less than that — so the figure is honest from the first read.
export function readRatePerSec(): number {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
    if (firstSampleMs === 0) return 0;
    let sum = 0;
    for (const s of samples) sum += s.bytes;
    const windowMs = Math.min(WINDOW_MS, now - firstSampleMs);
    if (windowMs <= 0) return 0;
    return sum / (windowMs / 1000);
}
