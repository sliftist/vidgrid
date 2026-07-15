// Scan progress channel — backed by BulkDatabase2, NOT a bespoke BroadcastChannel.
//
// The single background scan worker (scanWorker.ts, a SharedWorker) writes the
// live snapshot into the `vidgrid_scan_status` store; every tab reads it
// reactively. BulkDatabase2 already synchronizes across threads/tabs (it syncs
// via its own BroadcastChannel + file lock), so we get cross-context progress
// for free and don't hand-roll any messaging. The remaining-work COUNTS are not
// carried here — they're derived reactively from the databases (scanCounts.ts),
// correct in every tab even before the worker writes its first snapshot.

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";

export type ScanPhase = "metadata" | "keyframes" | "faces";

// One row, key "current", holding the live snapshot. Optional fields so a
// partial write (e.g. just flipping running=false) is cheap.
export interface ScanStatusRecord {
    key: string;
    running?: boolean;
    phase?: ScanPhase;
    currentKey?: string;
    done?: number;
    total?: number;
    ratePerItemMs?: number;
    etaMs?: number;
    updatedAt?: number;
}

export const scanStatusDb = new BulkDatabase2<ScanStatusRecord>("vidgrid_scan_status");
const CURRENT_KEY = "current";

export interface ScanProgressSnapshot {
    // The phase currently doing work, or undefined when idle (nothing running).
    phase: ScanPhase | undefined;
    // Key of the file being processed right now (for a status tooltip).
    currentKey: string | undefined;
    // Live done/total within the active phase this run.
    done: number;
    total: number;
    // Rolling average wall-clock ms per completed item in the active phase, and
    // the derived ETA for the rest of that phase. Undefined until we have a
    // couple of samples.
    ratePerItemMs: number | undefined;
    etaMs: number | undefined;
    // When this snapshot was produced (Date.now); a stale snapshot (producer
    // died without a final idle) is ignored after SNAPSHOT_STALE_MS.
    updatedAt: number;
}

export const IDLE_SNAPSHOT: ScanProgressSnapshot = {
    phase: undefined,
    currentKey: undefined,
    done: 0,
    total: 0,
    ratePerItemMs: undefined,
    etaMs: undefined,
    updatedAt: 0,
};

// A producer that stops updating is treated as idle after this long, so a
// crashed/terminated worker doesn't leave every tab showing a frozen "scanning".
// The worker refreshes updatedAt well within this window while active.
export const SNAPSHOT_STALE_MS = 30_000;

// Reactive read of the current snapshot (call inside an observer render / mobx
// reaction). Collapses a stale or not-running snapshot to idle so the UI never
// shows a phantom "scanning" if the worker vanished.
export function currentScanSnapshot(): ScanProgressSnapshot {
    const running = scanStatusDb.getSingleFieldSync(CURRENT_KEY, "running");
    const updatedAt = scanStatusDb.getSingleFieldSync(CURRENT_KEY, "updatedAt") ?? 0;
    if (!running) return IDLE_SNAPSHOT;
    if (Date.now() - updatedAt > SNAPSHOT_STALE_MS) return IDLE_SNAPSHOT;
    return {
        phase: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "phase"),
        currentKey: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "currentKey"),
        done: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "done") ?? 0,
        total: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "total") ?? 0,
        ratePerItemMs: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "ratePerItemMs"),
        etaMs: scanStatusDb.getSingleFieldSync(CURRENT_KEY, "etaMs"),
        updatedAt,
    };
}

// Producer side (the scan worker): persist the snapshot. BulkDatabase2 fans it
// out to every tab. Throttle the call at the worker (see scanWorker) so we don't
// churn the store on every file.
export function publishScanProgress(snapshot: Partial<ScanProgressSnapshot> & { running: boolean }): Promise<void> {
    return scanStatusDb.write({
        key: CURRENT_KEY,
        running: snapshot.running,
        phase: snapshot.phase,
        currentKey: snapshot.currentKey,
        done: snapshot.done,
        total: snapshot.total,
        ratePerItemMs: snapshot.ratePerItemMs,
        etaMs: snapshot.etaMs,
        updatedAt: Date.now(),
    });
}

// Mark the worker idle (nothing running). Cheap terminal write.
export function publishScanIdle(): Promise<void> {
    return scanStatusDb.write({ key: CURRENT_KEY, running: false, phase: undefined, currentKey: undefined, updatedAt: Date.now() });
}
