// Scan status channel — a BroadcastChannel, nothing else.
//
// The coordinator SharedWorker keeps ONE in-memory state object with every
// field (phase, current file, per-phase remaining counts, rate, ETA, sub-file
// progress, walk timing) and broadcasts the WHOLE object whenever anything
// changes, throttled to at most once per second. No database writes, no
// per-field updates — every message is the complete state, so the UI can never
// show fields from two different moments. Tabs hold the last received object
// in a mobx box and render from it.

import { observable, runInAction } from "mobx";

export type ScanPhase = "metadata" | "keyframes" | "faces";

const SCAN_STATUS_CHANNEL = "vidgrid-scan-status";

// The complete coordinator state. Broadcast in full on every change.
export interface ScanStatusState {
    // Live work progress.
    running?: boolean;
    phase?: ScanPhase;
    currentKey?: string;
    done?: number;
    total?: number;
    ratePerItemMs?: number;
    etaMs?: number;
    // Sub-progress WITHIN the file currently being scanned (the filling bar).
    // fileFraction is 0..1 (media-time based: keyframes/faces know duration);
    // undefined means indeterminate (metadata has no measurable sub-progress).
    // fileDetail is the worker's human-readable line shown in the cell tooltip.
    fileFraction?: number;
    fileDetail?: string;
    // True while the coordinator is walking the file system to discover files.
    walking?: boolean;
    // Remaining-work counts, computed by the coordinator with the SAME
    // eligibility rules its phase pickers use — the only count source the UI has.
    filesTotal?: number;
    metadataRemaining?: number;
    keyframesRemaining?: number;
    facesRemaining?: number;
    // File-walk timing.
    lastWalkAt?: number;
    nextWalkAt?: number;
    updatedAt?: number;
}

let channel: BroadcastChannel | undefined;
function getChannel(): BroadcastChannel {
    return channel ??= new BroadcastChannel(SCAN_STATUS_CHANNEL);
}

// Coordinator side: broadcast the full state (postMessage structured-clones it,
// so later mutations of the live object don't affect the sent snapshot).
export function broadcastScanStatus(state: ScanStatusState): void {
    try { getChannel().postMessage(state); } catch { /* ignore */ }
}

// ── Tab side ─────────────────────────────────────────────────────────────────

// A "running" state collapses to idle after this long without an update, so a
// crashed coordinator doesn't leave every tab showing a frozen "scanning".
export const SNAPSHOT_STALE_MS = 30_000;

const latestState = observable.box<ScanStatusState | undefined>(undefined, { deep: false });
// Bumped every few seconds so the staleness check re-evaluates reactively even
// when no new broadcasts arrive (i.e. the coordinator died).
const staleTick = observable.box(0);

// Listen from module load — the coordinator rebroadcasts its full state the
// moment a tab connects, and the listener must already exist to catch it.
// (Harmless in the coordinator context: it never receives its own posts.)
getChannel().addEventListener("message", (e: MessageEvent) => {
    const s = e.data as ScanStatusState | undefined;
    if (!s || typeof s !== "object") return;
    runInAction(() => latestState.set(s));
});
setInterval(() => runInAction(() => staleTick.set(staleTick.get() + 1)), 5_000);

// Reactive read of the full latest state (call inside an observer render).
// undefined until the first broadcast arrives.
export function latestScanState(): ScanStatusState | undefined {
    staleTick.get(); // subscribe so staleness re-evaluates
    return latestState.get();
}

export interface ScanProgressSnapshot {
    phase: ScanPhase | undefined;
    currentKey: string | undefined;
    done: number;
    total: number;
    ratePerItemMs: number | undefined;
    etaMs: number | undefined;
    fileFraction: number | undefined;
    fileDetail: string | undefined;
    walking: boolean;
}

export const IDLE_SNAPSHOT: ScanProgressSnapshot = {
    phase: undefined, currentKey: undefined, done: 0, total: 0, ratePerItemMs: undefined, etaMs: undefined,
    fileFraction: undefined, fileDetail: undefined, walking: false,
};

// Reactive read of the live work snapshot (collapses to idle when stale).
export function currentScanSnapshot(): ScanProgressSnapshot {
    const s = latestScanState();
    if (!s || !s.running || Date.now() - (s.updatedAt ?? 0) > SNAPSHOT_STALE_MS) return IDLE_SNAPSHOT;
    return {
        phase: s.phase,
        currentKey: s.currentKey,
        done: s.done ?? 0,
        total: s.total ?? 0,
        ratePerItemMs: s.ratePerItemMs,
        etaMs: s.etaMs,
        fileFraction: s.fileFraction,
        fileDetail: s.fileDetail,
        walking: s.walking === true,
    };
}

// True when the coordinator is actively scanning right now (heavy phases OR
// the file walk — during a walk the phase is undefined but it IS working).
export function isScanRunning(): boolean {
    const snap = currentScanSnapshot();
    return snap.phase !== undefined || snap.walking;
}

export interface CoordinatorCounts {
    total: number | undefined;
    metadataRemaining: number | undefined;
    keyframesRemaining: number | undefined;
    facesRemaining: number | undefined;
}

// Reactive read of the coordinator-published counts. Last-known values are
// kept even when the live snapshot goes stale — the numbers are still the best
// information we have; they refresh the moment a coordinator runs again.
export function coordinatorCounts(): CoordinatorCounts {
    const s = latestScanState();
    return {
        total: s?.filesTotal,
        metadataRemaining: s?.metadataRemaining,
        keyframesRemaining: s?.keyframesRemaining,
        facesRemaining: s?.facesRemaining,
    };
}

// Reactive read of the file-walk timing for the "Scan now" hint.
export function walkTiming(): { lastWalkAt: number | undefined; nextWalkAt: number | undefined } {
    const s = latestScanState();
    return { lastWalkAt: s?.lastWalkAt, nextWalkAt: s?.nextWalkAt };
}
