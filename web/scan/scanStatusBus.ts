// Scan status channel — backed by BulkDatabase2, NOT a bespoke BroadcastChannel.
//
// The single background scan worker (scanWorker.ts, a SharedWorker) writes one
// status row here; every tab reads it reactively. BulkDatabase2 already syncs
// across threads/tabs, so we get cross-context status for free.
//
// The row carries BOTH live work-progress (what's scanning right now) AND the
// remaining-work counts + the file-walk timing, since the worker computes those
// each loop anyway (it reads the columns to pick work). The tab therefore never
// has to load the heavy keyframes stream just to show a keyframes count.

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
    // Remaining-work counts (files still needing each phase) + library size.
    filesTotal?: number;
    metadataRemaining?: number;
    keyframesRemaining?: number;
    facesRemaining?: number;
    // File-walk timing: when the worker last walked the folder for new files and
    // when it will next do so automatically.
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
}

export const IDLE_SNAPSHOT: ScanProgressSnapshot = {
    phase: undefined, currentKey: undefined, done: 0, total: 0, ratePerItemMs: undefined, etaMs: undefined,
};

// The live "running" flags go stale if the worker dies without a clean idle
// write; after this long a "running" snapshot collapses to idle. (Counts and
// walk timing do NOT expire — they stay valid until overwritten.)
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
    };
}

// Reactive read of the worker-published keyframes-remaining count (metadata /
// faces / total are cheap to derive tab-side from the files DB — see
// scanCounts.ts — but keyframesVersion lives on the heavy keyframes stream, so
// only the worker counts it). undefined until the worker's first publish.
export function keyframesRemainingFromStatus(): number | undefined {
    return scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "keyframesRemaining");
}

// Reactive read of the file-walk timing for the "check for new files" button.
export function walkTiming(): { lastWalkAt: number | undefined; nextWalkAt: number | undefined } {
    return {
        lastWalkAt: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "lastWalkAt"),
        nextWalkAt: scanStatusDb.getSingleFieldSync(SCAN_STATUS_KEY, "nextWalkAt"),
    };
}
