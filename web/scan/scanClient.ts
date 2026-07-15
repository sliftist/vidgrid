// Tab side of the single background scanner.
//
// Every tab connects to the ONE coordinator SharedWorker (scanCoordinator.ts) and
// reports its focus / playing / has-handle state. The coordinator appoints ONE
// tab as host; when THIS tab is the host it spawns the dedicated scan Worker
// (scanWorker.ts) — which can decode video, unlike the SharedWorker — and hands
// it the directory handle. All progress/results flow back through BulkDatabase2.
// Non-host tabs do nothing but report state and relay commands.

import { reaction } from "mobx";
import { ensureFolder, onScanSettingsChanged, thisTabPlayingVideo } from "../appState";
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { scanStatusDb, SCAN_STATUS_KEY } from "./scanStatusBus";

// Human-readable, URL-safe build slug for the ?v= cache-buster, e.g.
// "2026-07-15_16-09-19_EDT" — Eastern local time, no percent-escaped colons, no
// bare UTC "Z". (BUILD_TIMESTAMP itself stays an ISO string for other displays.)
function buildVersionSlug(): string {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hourCycle: "h23", timeZoneName: "short",
        }).formatToParts(new Date(BUILD_TIMESTAMP));
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
        const tz = get("timeZoneName") || "ET";
        return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}-${get("minute")}-${get("second")}_${tz}`;
    } catch {
        // Fallback: make the ISO string URL-safe (no unescaped colons/dots).
        return BUILD_TIMESTAMP.replace(/[:.]/g, "-").replace(/[^0-9A-Za-z_-]/g, "");
    }
}

const V = buildVersionSlug();
const COORD_URL = `./scanCoordinator.js?v=${V}`;
const WORKER_URL = `./scanWorker.js?v=${V}`;
const CMD_CHANNEL = "vidgrid-scan-cmd";
// If we're the host but the worker's status row goes stale this long, the worker
// crashed/hung — restart it.
const RESURRECT_STALE_MS = 3 * 60 * 1000;

let coordinator: SharedWorker | undefined;
let scanWorker: Worker | undefined; // the dedicated worker — only while we're host
let cmdChannel: BroadcastChannel | undefined;
let handle: FileSystemDirectoryHandle | undefined;
let isHost = false;
let started = false;

// Start the client (idempotent). Called once on app boot.
export function startScanClient(): void {
    if (started) return;
    started = true;
    if (typeof SharedWorker === "undefined" || typeof Worker === "undefined") {
        console.warn("[scanClient] workers unavailable — background scanning disabled in this browser");
        return;
    }
    try {
        coordinator = new SharedWorker(COORD_URL, { name: "vidgrid-scan-coordinator" });
        coordinator.port.start();
    } catch (err) {
        console.warn("[scanClient] could not start scan coordinator:", err);
        return;
    }
    coordinator.port.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d && d.type === "host") setHost(!!d.isHost);
    };

    if (typeof BroadcastChannel !== "undefined") cmdChannel = new BroadcastChannel(CMD_CHANNEL);
    // Enable/disable a phase → tell the (host) worker to react immediately.
    onScanSettingsChanged(() => cmdChannel?.postMessage({ cmd: "settingsChanged" }));

    // Grab the handle (reuses the tab's already-resolved one — no second picker),
    // then report state so the coordinator can consider us for hosting.
    void ensureFolder().then(h => { handle = h ?? undefined; reportState(); }).catch(() => { /* no folder yet */ });

    // Report focus / playing / handle on change + a heartbeat (also keeps us
    // alive in the coordinator's liveness tracking).
    window.addEventListener("focus", reportState);
    window.addEventListener("blur", reportState);
    document.addEventListener("visibilitychange", reportState);
    reaction(() => thisTabPlayingVideo.get(), reportState);
    setInterval(reportState, 5_000);
    setInterval(() => { void checkWorkerHealth(); }, 60_000);
    reportState();
}

function reportState(): void {
    coordinator?.port.postMessage({
        type: "state",
        focused: document.hasFocus() && document.visibilityState === "visible",
        playing: thisTabPlayingVideo.get(),
        hasHandle: !!handle,
    });
}

function setHost(host: boolean): void {
    if (host === isHost) return;
    isHost = host;
    if (host) startScanWorker();
    else stopScanWorker();
}

function startScanWorker(): void {
    if (scanWorker) return;
    if (!handle) {
        // Handle not ready yet — fetch it, then (if still host) spawn.
        void ensureFolder().then(h => { handle = h ?? undefined; if (isHost && handle) startScanWorker(); reportState(); });
        return;
    }
    try {
        scanWorker = new Worker(WORKER_URL);
        scanWorker.onerror = e => console.warn("[scanClient] scan worker error:", (e as ErrorEvent).message || e);
        scanWorker.postMessage({ type: "handle", handle });
    } catch (err) {
        console.warn("[scanClient] could not start scan worker:", err);
        scanWorker = undefined;
    }
}

function stopScanWorker(): void {
    if (scanWorker) {
        try { scanWorker.terminate(); } catch { /* ignore */ }
        scanWorker = undefined;
    }
}

// Restart our dedicated worker if it went silent (crashed/hung) while we're host.
async function checkWorkerHealth(): Promise<void> {
    if (!isHost || !scanWorker) return;
    let updatedAt: number | undefined;
    try { updatedAt = await scanStatusDb.getSingleField(SCAN_STATUS_KEY, "updatedAt"); } catch { return; }
    if (updatedAt && Date.now() - updatedAt > RESURRECT_STALE_MS) {
        console.warn("[scanClient] host scan worker looks dead; restarting");
        stopScanWorker();
        startScanWorker();
    }
}

// Force the background worker to walk the folder for new files right now.
export function requestFileWalkNow(): void {
    cmdChannel?.postMessage({ cmd: "walkNow" });
}
