// Tab side of the single background scanner.
//
// Every tab connects to the ONE SharedWorker (the browser guarantees a single
// shared instance — that's the whole point; no locks, no leader election). The
// tab's only job is to hand the worker the granted directory handle once, so the
// worker can read the library and open the same BulkDatabase2 stores. After
// that the worker scans on its own and all progress/results flow back through
// BulkDatabase2. Tabs never scan themselves.

import { ensureFolder, onScanSettingsChanged } from "../appState";
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { scanStatusDb, SCAN_STATUS_KEY } from "./scanStatusBus";

let worker: SharedWorker | undefined;
let sentHandle = false;
let listenerRegistered = false;
let healthTimer: ReturnType<typeof setInterval> | undefined;

// The worker refreshes the status row at least every 30s (idle poll) and
// heartbeats during long extractions. If it's been silent this long it has
// crashed — recreate it.
const RESURRECT_STALE_MS = 3 * 60 * 1000;

// Start the client (idempotent). Called once on app boot instead of the old
// foreground scan scheduler.
export function startScanClient(): void {
    if (typeof SharedWorker === "undefined") {
        console.warn("[scanClient] SharedWorker unavailable — background scanning disabled in this browser");
        return;
    }
    if (worker) return;
    try {
        // Cache-bust by build version: SharedWorkers are keyed (and cached) by
        // URL, so without this a browser that cached an old/broken scanWorker.js
        // would keep reusing it after a deploy. All tabs on the same build share
        // one worker (same URL); a deploy rolls everyone onto the new one.
        const url = `./scanWorker.js?v=${encodeURIComponent(BUILD_TIMESTAMP)}`;
        worker = new SharedWorker(url, { name: "vidgrid-scan" });
        worker.port.start();
        // A hard load/script error in the worker surfaces here — resurrect it.
        worker.onerror = (e: Event) => {
            console.warn("[scanClient] scan worker error; will resurrect:", (e as ErrorEvent).message || e);
            resurrect();
        };
    } catch (err) {
        console.warn("[scanClient] could not start scan SharedWorker:", err);
        worker = undefined;
        return;
    }
    // Register the settings listener ONCE (resurrect calls startScanClient again).
    if (!listenerRegistered) {
        listenerRegistered = true;
        // Whenever a scan phase is enabled/disabled in this tab, tell the worker so
        // it starts/stops immediately instead of waiting for its next poll.
        onScanSettingsChanged(() => sendCommand("settingsChanged"));
    }
    startHealthCheck();
    void sendHandleWhenReady();
}

function sendCommand(cmd: "walkNow" | "settingsChanged"): void {
    worker?.port.postMessage({ type: "command", cmd });
}

// Force the background worker to walk the folder for new files right now.
export function requestFileWalkNow(): void {
    sendCommand("walkNow");
}

// Send the directory handle to the worker as soon as one is available. Safe to
// call repeatedly; only the first successful send does anything. ensureFolder()
// reuses the tab's already-resolved handle (no second folder picker).
export async function sendHandleWhenReady(): Promise<void> {
    if (sentHandle || !worker) return;
    let handle: FileSystemDirectoryHandle | undefined;
    try {
        handle = await ensureFolder();
    } catch (err) {
        console.warn("[scanClient] ensureFolder failed:", err);
        return;
    }
    if (!handle || !worker) return;
    sentHandle = true;
    // The native FileSystemDirectoryHandle is structured-cloneable and keeps its
    // permission grant across the postMessage into the worker.
    worker.port.postMessage({ type: "handle", handle });
}

// Watchdog: if the worker stops updating its status row for RESURRECT_STALE_MS,
// treat it as crashed and recreate it. Creating a SharedWorker with the same URL
// revives a dead one (and just reconnects to a live one, which is harmless).
function startHealthCheck(): void {
    if (healthTimer) return;
    healthTimer = setInterval(() => { void checkHealth(); }, 60_000);
    (healthTimer as { unref?: () => void }).unref?.();
}
async function checkHealth(): Promise<void> {
    if (!sentHandle) return; // nothing to monitor until the worker has the handle
    let updatedAt: number | undefined;
    try {
        updatedAt = await scanStatusDb.getSingleField(SCAN_STATUS_KEY, "updatedAt");
    } catch {
        return;
    }
    if (updatedAt && Date.now() - updatedAt > RESURRECT_STALE_MS) {
        console.warn("[scanClient] scan worker looks dead (stale status); resurrecting");
        resurrect();
    }
}

function resurrect(): void {
    try { worker?.port.close(); } catch { /* ignore */ }
    worker = undefined;
    sentHandle = false;
    startScanClient();
}
