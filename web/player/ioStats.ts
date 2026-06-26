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
// readBytesLast60s() recomputes from it; the overlay establishes reactivity
// off ioStats.totalBytes (which moves on every settled read).
const samples: ReadSample[] = [];

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
    if (ok) samples.push({ t: Date.now(), bytes });
}

export function readBytesLast60s(): number {
    const cutoff = Date.now() - WINDOW_MS;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
    let sum = 0;
    for (const s of samples) sum += s.bytes;
    return sum;
}
