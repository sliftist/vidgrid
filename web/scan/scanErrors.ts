// Scan error log — surfaced in the Scanning page and (as a count) in ScanStatus.
//
// The single background worker records any extraction/loop failure here; tabs
// read it reactively (BulkDatabase2 syncs across threads). Kept appState-free so
// the worker can write it.

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";

export interface ScanErrorRecord {
    key: string;       // `${at}:${phase}:${file}` — unique-ish, avoids dupes
    at: number;
    file?: string;
    phase?: string;
    message: string;
}

export const scanErrorsDb = new BulkDatabase2<ScanErrorRecord>("vidgrid_scan_errors");
// Keep the log bounded; the worker trims to this many most-recent rows.
const MAX_ERRORS = 200;

// Worker side: append an error (and trim old ones).
export async function recordScanError(e: { file?: string; phase?: string; message: string; at: number }): Promise<void> {
    const key = `${e.at}:${e.phase ?? ""}:${e.file ?? ""}`;
    try {
        await scanErrorsDb.write({ key, at: e.at, file: e.file, phase: e.phase, message: e.message });
        const keys = await scanErrorsDb.getKeys();
        if (keys.length > MAX_ERRORS) {
            // keys are `${at}:...`; oldest sort first lexically only within the same
            // digit count, so sort numerically by the leading timestamp.
            const sorted = keys.slice().sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
            await scanErrorsDb.deleteBatch(sorted.slice(0, keys.length - MAX_ERRORS));
        }
    } catch { /* logging an error must never throw */ }
}

// Tab side (reactive): recent errors, newest first.
export function recentScanErrors(limit = 100): ScanErrorRecord[] {
    const atCol = scanErrorsDb.getColumnSync("at");
    if (!atCol) return [];
    const fileCol = scanErrorsDb.getColumnSync("file");
    const phaseCol = scanErrorsDb.getColumnSync("phase");
    const msgCol = scanErrorsDb.getColumnSync("message");
    const file = new Map(fileCol?.map(r => [r.key, r.value]));
    const phase = new Map(phaseCol?.map(r => [r.key, r.value]));
    const msg = new Map(msgCol?.map(r => [r.key, r.value]));
    return atCol
        .map(r => ({ key: r.key, at: r.value ?? 0, file: file.get(r.key), phase: phase.get(r.key), message: msg.get(r.key) ?? "" }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
}

// Reactive count of errors (for the ScanStatus indicator).
export function scanErrorCount(): number {
    const atCol = scanErrorsDb.getColumnSync("at");
    return atCol ? atCol.length : 0;
}

export async function clearScanErrors(): Promise<void> {
    try { await scanErrorsDb.deleteBatch(await scanErrorsDb.getKeys()); } catch { /* ignore */ }
}
