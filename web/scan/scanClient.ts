// Tab side of the single background scanner.
//
// This tab connects to the ONE coordinator SharedWorker (scanCoordinator.ts),
// hands it the folder handle so it can traverse + own the DB, and reports its
// focus/playing state. The coordinator does ALL the scanning; when this tab is
// appointed "victim" it services per-file decode requests on its MAIN THREAD
// (decodeService.ts) — it never scans or touches the DB itself. If this tab
// starts playing video it refuses decoding immediately.
//
// Version + lifecycle:
//   - localStorage stores the max build-timestamp any tab on this browser has
//     ever booted with. On boot, we bump that cell to max(stored, our build),
//     format it (YYYY-MM-DD_HH-MM-tz), and use it as `?v=` on the SharedWorker
//     URL. Same slug across tabs on the same browser → same SharedWorker key.
//   - We PING the coordinator every 60s. If we don't hear a pong within 60s,
//     we assume it's dead, tear down our port, and try to reconnect. A general
//     30s "want-to-be-connected but aren't" retry covers spawn failures too.
//   - If master scanning is OFF and no allowance is granted, we don't spawn at
//     all. Enabling it (in this tab OR another) spawns; disabling kills.
//   - "Scan Now" while master is OFF spawns with a one-shot allowance.

import { reaction } from "mobx";
import { ensureFolder, onScanSettingsChanged, scanEnabled, thisTabPlayingVideo } from "../appState";
import { handleDecodeRequest, setDecodeRefusing } from "./decodeService";
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { bumpCoordVersion, formatBuildVersion, ELECTION_CHANNEL_NAME, ElectionMsg } from "./scanElection";

// STABLE base path — only the ?v= slug changes when the browser sees a newer
// build. Same slug in every tab of this browser dedupes to one SharedWorker.
const COORD_BASE = "./scanCoordinator.js";
const COORD_NAME = "vidgrid-scan-coordinator";

// Heartbeat cadence: we ping every 60s and reconnect if we haven't heard back
// in 60s. Detection window is thus up to ~120s (last ping at t=60 goes silent
// → next ping at t=120 sees `now - lastHeartbeatOkAt > 60`). Reconnect delay is
// 30s per the user's spec — safe because same-URL `new SharedWorker(...)` is
// idempotent (browser gives us the existing one if it's still alive).
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_DEAD_MS = 60_000;
const RECONNECT_DELAY_MS = 30_000;

let coordinator: SharedWorker | undefined;
let coordUrl = "";                       // last URL used (for logging)
let handle: FileSystemDirectoryHandle | undefined;
let started = false;
let lastHeartbeatOkAt = 0;
let nextReconnectAt = 0;
// Once granted for the tab's session, the coordinator's own oneShot state is
// authoritative; we keep this flag so we'll keep it connected even if master is
// off, until we see it shut down.
let oneShotSessionActive = false;

function post(msg: any, transfer?: Transferable[]): void {
    if (!coordinator) return;
    if (transfer && transfer.length) coordinator.port.postMessage(msg, transfer);
    else coordinator.port.postMessage(msg);
}

function shouldBeConnected(): boolean {
    return scanEnabled.get() || oneShotSessionActive;
}

// Start the client (idempotent). Called once on app boot.
export function startScanClient(): void {
    if (started) return;
    started = true;
    if (typeof SharedWorker === "undefined") {
        console.warn("[scanClient] SharedWorker unavailable — background scanning disabled in this browser");
        return;
    }

    // Bump the localStorage max at boot so any SharedWorker URL we compute uses
    // the newest slug this browser has ever seen (potentially newer than THIS
    // page's build).
    bumpCoordVersion(BUILD_TIMESTAMP);

    // Listen on the election channel so we can log when we're behind a peer
    // coordinator (informational — a hard reload picks up the new build).
    try {
        const electionBc = new BroadcastChannel(ELECTION_CHANNEL_NAME);
        electionBc.addEventListener("message", ev => {
            const m = ev.data as ElectionMsg | undefined;
            if (m && m.type === "alive" && typeof m.version === "string" && m.version > BUILD_TIMESTAMP) {
                console.warn(`[scanClient] this page (${BUILD_TIMESTAMP}) is behind a peer coordinator (${m.version}); reload to pick up the new build`);
            }
        });
    } catch { /* no BroadcastChannel — skip */ }

    if (shouldBeConnected()) connect();

    onScanSettingsChanged(() => post({ type: "command", cmd: "settingsChanged" }));

    // React to the master toggle flipping — either from THIS tab's UI or from a
    // BroadcastChannel echo (appState's scanEnabledBox handles both).
    reaction(() => scanEnabled.get(), enabled => {
        if (enabled) {
            if (!coordinator) connect();
        } else if (!oneShotSessionActive) {
            // Disable: the coordinator hears the same broadcast and closes
            // itself; we just tear down our port so we don't heartbeat a dead
            // SharedWorker.
            teardown("scanning disabled");
        }
    });

    // Hand the coordinator our directory handle (any tab's works) so it can
    // traverse + own the BulkDatabase2 storage root, then start reporting state.
    void ensureFolder().then(h => {
        handle = h ?? undefined;
        if (handle && coordinator) post({ type: "handle", handle });
        reportState();
    }).catch(() => { /* no folder yet */ });

    window.addEventListener("focus", reportState);
    window.addEventListener("blur", reportState);
    document.addEventListener("visibilitychange", reportState);
    reaction(() => thisTabPlayingVideo.get(), playing => {
        setDecodeRefusing(playing);
        reportState();
    });

    // Heartbeat + reconnect ticker. One interval covers both: send a ping, and
    // if we've gone too long without a pong tear it down; then, if we should be
    // connected but aren't, try to reconnect (subject to the 30s backoff).
    setInterval(supervisorTick, HEARTBEAT_INTERVAL_MS / 2);
    // State reporting on its own faster cadence for focus/handle changes.
    setInterval(reportState, 5_000);
    reportState();
}

function supervisorTick(): void {
    const now = Date.now();
    if (coordinator) {
        try { coordinator.port.postMessage({ type: "ping" }); } catch { /* respawn */ }
        if (lastHeartbeatOkAt > 0 && now - lastHeartbeatOkAt > HEARTBEAT_DEAD_MS) {
            console.warn(`[scanClient] no coordinator pong for ${((now - lastHeartbeatOkAt) / 1000).toFixed(0)}s — reconnecting`);
            teardown("no heartbeat");
        }
    }
    if (!coordinator && shouldBeConnected() && now >= nextReconnectAt) {
        connect();
    }
}

// Open the SharedWorker at the current versioned URL, wire it up, and hand it
// our current state. Called on initial boot, after teardown, and after 30s
// reconnect backoff.
function connect(): void {
    const slug = formatBuildVersion(bumpCoordVersion(BUILD_TIMESTAMP));
    coordUrl = `${COORD_BASE}?v=${encodeURIComponent(slug)}`;
    try {
        coordinator = new SharedWorker(coordUrl, { name: COORD_NAME });
        coordinator.port.start();
    } catch (err) {
        console.warn("[scanClient] could not start scan coordinator:", err);
        coordinator = undefined;
        nextReconnectAt = Date.now() + RECONNECT_DELAY_MS;
        return;
    }
    coordinator.port.onmessage = onCoordMessage;
    // Reset heartbeat baseline — treat "just connected" as fresh so the dead
    // detector doesn't fire before we've had a chance to see our first pong.
    lastHeartbeatOkAt = Date.now();
    console.log(`[scanClient] connected to coordinator at ${coordUrl}`);

    // Tell the freshly-connected coordinator our current state. ORDER MATTERS:
    // `allowance` MUST come before `settings` when we're spawning for a
    // one-shot pass with autoscan off — otherwise the coord processes
    // settings(enabled:false), doesn't see the allowance yet, and self-closes
    // before the walk/scan ever starts.
    if (oneShotSessionActive) post({ type: "allowance", oneShot: true });
    post({ type: "settings", enabled: scanEnabled.get() });
    if (handle) post({ type: "handle", handle });
    reportState();
}

function teardown(reason: string): void {
    if (!coordinator) return;
    console.log(`[scanClient] tearing down coordinator connection: ${reason}`);
    try { coordinator.port.close(); } catch { /* ignore */ }
    coordinator = undefined;
    lastHeartbeatOkAt = 0;
    nextReconnectAt = Date.now() + RECONNECT_DELAY_MS;
    // Assume any one-shot session ended with the coordinator; the user can
    // re-request it if they still want a pass.
    oneShotSessionActive = false;
}

function onCoordMessage(ev: MessageEvent): void {
    const d = ev.data;
    if (!d) return;
    if (d.type === "pong") { lastHeartbeatOkAt = Date.now(); return; }
    if (d.type === "coordinatorShuttingDown") {
        teardown(`coord announced shutdown${d.reason ? ` (${d.reason})` : ""}`);
        return;
    }
    if (d.type === "victim") {
        if (d.isVictim) console.log("[scanClient] this tab is now the scan decode victim");
        return;
    }
    // decode / decodeAbort requests (only the victim tab receives these).
    void handleDecodeRequest(d, handle, post);
}

function reportState(): void {
    if (!coordinator) return;
    post({
        type: "state",
        focused: document.hasFocus() && document.visibilityState === "visible",
        playing: thisTabPlayingVideo.get(),
        hasHandle: !!handle,
    });
}

// User hit "Cancel Scan" on the Scanning page. Tell the coordinator to abort
// the in-flight decode and self-close. Also clear the one-shot session flag so
// the supervisor tick won't respawn a new coordinator afterwards while
// autoscan is off. If autoscan is ON the supervisor's normal reconnect logic
// still applies (a fresh coordinator spawns on the next 30s retry).
export function requestScanCancel(): void {
    post({ type: "command", cmd: "cancelScanNow" });
    oneShotSessionActive = false;
}

// Force the coordinator to walk the folder for new files right now — used by
// the Scanning page's "Scan Now" button. If scanning is OFF, this spawns a
// coordinator with a one-shot allowance so a pass runs even without the
// background loop.
export function requestFileWalkNow(): void {
    if (scanEnabled.get()) {
        if (coordinator) post({ type: "command", cmd: "walkNow" });
        return;
    }
    // Master toggle is OFF: spawn the coordinator ourselves with a one-shot
    // allowance. It will run through pending work and self-close.
    oneShotSessionActive = true;
    if (!coordinator) connect();
    else post({ type: "allowance", oneShot: true });
    post({ type: "command", cmd: "walkNow" });
}
