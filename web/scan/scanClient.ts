// Tab side of the single background scanner.
//
// Every tab connects to the ONE SharedWorker (the browser guarantees a single
// shared instance — that's the whole point; no locks, no leader election). The
// tab's only job is to hand the worker the granted directory handle once, so the
// worker can read the library and open the same BulkDatabase2 stores. After
// that the worker scans on its own and all progress/results flow back through
// BulkDatabase2. Tabs never scan themselves.

import { ensureFolder, onScanSettingsChanged } from "../appState";

let worker: SharedWorker | undefined;
let sentHandle = false;

// Start the client (idempotent). Called once on app boot instead of the old
// foreground scan scheduler.
export function startScanClient(): void {
    if (typeof SharedWorker === "undefined") {
        console.warn("[scanClient] SharedWorker unavailable — background scanning disabled in this browser");
        return;
    }
    if (worker) return;
    try {
        worker = new SharedWorker("./scanWorker.js", { name: "vidgrid-scan" });
        worker.port.start();
    } catch (err) {
        console.warn("[scanClient] could not start scan SharedWorker:", err);
        worker = undefined;
        return;
    }
    // Whenever a scan phase is enabled/disabled in this tab, tell the worker so
    // it starts/stops immediately instead of waiting for its next poll.
    onScanSettingsChanged(() => sendCommand("settingsChanged"));
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
