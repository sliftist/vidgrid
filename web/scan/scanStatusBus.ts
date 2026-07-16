// Scan status channel — backed by BulkDatabase2.
//
// The coordinator SharedWorker writes one status row here; every tab reads it
// reactively. BulkDatabase2 already syncs across threads/tabs, so we get
// cross-context status for free — no bespoke messaging. (Progress not updating
// was a symptom of the victim tab FREEZING during main-thread decode, not the
// status mechanism; decoding now runs in a dedicated worker.)

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";

export type ScanPhase = "metadata" | "keyframes" | "faces";

export interface ScanStatusRecord {
    key: string;
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
    // fileDetail is the worker's human-readable line ("keyframe 3/10 at 5s/60s ...",
    // "face frame 42 at 30s/60s ... (7 faces so far)") shown in the cell's tooltip.
    fileFraction?: number;
    fileDetail?: string;
    // True while the coordinator is doing the initial (or periodic) file-system
    // walk to discover which files exist. Visually rendered as a distinct state
    // on the metadata cell — files are appearing; nothing is being scanned yet.
    walking?: boolean;
    // Remaining-work counts + library size (kept for compatibility; the tab now
    // derives counts from the files DB — see scanCounts.ts).
    filesTotal?: number;
    metadataRemaining?: number;
    keyframesRemaining?: number;
    facesRemaining?: number;
    // File-walk timing.
    lastWalkAt?: number;
    nextWalkAt?: number;
    updatedAt?: number;
}

export const scanStatusDb = new BulkDatabase2<ScanStatusRecord>("vidgrid_scan_status");
export const SCAN_STATUS_KEY = "current";

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

// A "running" snapshot collapses to idle after this long without an update, so a
// crashed coordinator doesn't leave every tab showing a frozen "scanning".
export const SNAPSHOT_STALE_MS = 30_000;

// Reactive read of the live work snapshot (call inside an observer render).
export function currentScanSnapshot(): ScanProgressSnapshot {
    const running = scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "running");
    const updatedAt = scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "updatedAt") ?? 0;
    if (!running || Date.now() - updatedAt > SNAPSHOT_STALE_MS) return IDLE_SNAPSHOT;
    return {
        phase: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "phase"),
        currentKey: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "currentKey"),
        done: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "done") ?? 0,
        total: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "total") ?? 0,
        ratePerItemMs: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "ratePerItemMs"),
        etaMs: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "etaMs"),
        fileFraction: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "fileFraction"),
        fileDetail: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "fileDetail"),
        walking: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "walking") === true,
    };
}

// True when SOME tab is actively scanning right now, fresh. Covers both the
// heavy phases AND the file-walk state — during a walk the phase is undefined
// but the coordinator IS working (and its cancel button should still show).
export function isScanRunning(): boolean {
    const snap = currentScanSnapshot();
    return snap.phase !== undefined || snap.walking;
}

// Reactive read of the file-walk timing for the "Scan now" hint.
export function walkTiming(): { lastWalkAt: number | undefined; nextWalkAt: number | undefined } {
    return {
        lastWalkAt: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "lastWalkAt"),
        nextWalkAt: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "nextWalkAt"),
    };
}
