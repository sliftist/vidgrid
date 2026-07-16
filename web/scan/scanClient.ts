// Tab side of the single background scanner.
//
// Every tab connects to the ONE coordinator SharedWorker (scanCoordinator.ts),
// hands it the directory handle (so the coordinator can traverse + own the DB),
// and reports its focus/playing state. The coordinator does ALL the scanning and
// delegates only per-file DECODE to whichever tab it appoints as "victim". When
// this tab is the victim it services those decode requests on its MAIN THREAD
// (decodeService.ts) — it never scans or touches the DB itself. If this tab
// starts playing video it refuses decoding immediately.

import { reaction } from "mobx";
import { ensureFolder, onScanSettingsChanged, thisTabPlayingVideo } from "../appState";
import { handleDecodeRequest, setDecodeRefusing } from "./decodeService";
import { BUILD_TIMESTAMP } from "../../buildVersion";

// STABLE url, deliberately with NO version query. A SharedWorker is a singleton
// keyed by its script URL — a constant URL is the browser's own, absolute
// guarantee that exactly ONE coordinator exists across every tab. (A ?v= cache
// buster would give tabs on different builds different URLs → multiple
// coordinators, which must never happen.) The tradeoff — a running coordinator
// keeps its old code until every tab closes — is handled by the version-upgrade
// dance below: a newer tab tells the old coordinator to shut down, and everyone
// reconnects to a fresh one, WITHOUT ever having two coordinators at once.
const COORD_URL = "./scanCoordinator.js";

// Cross-tab guard so N tabs don't each fire a restart, and so a cache-stuck
// coordinator (one that respawns still-old because the browser served the old
// script from HTTP cache) doesn't loop forever: we only attempt to upgrade TO a
// given version once per cooldown.
const UPGRADE_LS_KEY = "vidgrid-scan-coord-upgrade";
const UPGRADE_COOLDOWN_MS = 60_000;
// After we reconnect post-shutdown we expect the fresh coordinator to greet us.
// If it doesn't (we raced the dying instance), retry a few times.
const HELLO_TIMEOUT_MS = 3_000;
const MAX_RECONNECT_RETRIES = 3;

let coordinator: SharedWorker | undefined;
let handle: FileSystemDirectoryHandle | undefined;
let started = false;
let reconnecting = false;
let helloTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectRetries = 0;

function post(msg: any, transfer?: Transferable[]): void {
    if (!coordinator) return;
    if (transfer && transfer.length) coordinator.port.postMessage(msg, transfer);
    else coordinator.port.postMessage(msg);
}

// Start the client (idempotent). Called once on app boot.
export function startScanClient(): void {
    if (started) return;
    started = true;
    if (typeof SharedWorker === "undefined") {
        console.warn("[scanClient] SharedWorker unavailable — background scanning disabled in this browser");
        return;
    }

    // Connect first so the coordinator exists before the async handle resolves.
    connect(false);

    // Enable/disable a phase → tell the coordinator (the scanner) to react now.
    onScanSettingsChanged(() => post({ type: "command", cmd: "settingsChanged" }));

    // Hand the coordinator our directory handle (any tab's works) so it can
    // traverse + own the BulkDatabase2 storage root, then start reporting state.
    void ensureFolder().then(h => {
        handle = h ?? undefined;
        if (handle) post({ type: "handle", handle });
        reportState();
    }).catch(() => { /* no folder yet */ });

    // Report focus/playing/handle on change + heartbeat.
    window.addEventListener("focus", reportState);
    window.addEventListener("blur", reportState);
    document.addEventListener("visibilitychange", reportState);
    reaction(() => thisTabPlayingVideo.get(), playing => {
        // Refuse decoding the instant playback starts (don't lag the video), and
        // tell the coordinator so it moves scanning to another tab.
        setDecodeRefusing(playing);
        reportState();
    });
    setInterval(reportState, 5_000);
    reportState();
}

// (Re)create the SharedWorker connection and wire up its port. `expectHello`
// arms a watchdog that retries if the fresh coordinator never greets us — only
// used after an upgrade shutdown, never on the initial connect (an old
// coordinator that predates this handshake simply won't greet us, and that must
// NOT trigger a reconnect storm against a perfectly healthy scanner).
function connect(expectHello: boolean): void {
    try {
        coordinator = new SharedWorker(COORD_URL, { name: "vidgrid-scan-coordinator" });
        coordinator.port.start();
    } catch (err) {
        console.warn("[scanClient] could not start scan coordinator:", err);
        coordinator = undefined;
        return;
    }
    coordinator.port.onmessage = onCoordMessage;
    // On a reconnect we already have the handle — re-hand it to the new coordinator.
    if (handle) post({ type: "handle", handle });
    reportState();
    if (expectHello) armHelloTimeout();
}

function onCoordMessage(ev: MessageEvent): void {
    const d = ev.data;
    if (!d) return;
    if (d.type === "coordinatorHello") {
        // The fresh coordinator greeted us — reconnect (if any) succeeded.
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = undefined; }
        reconnectRetries = 0;
        maybeUpgradeCoordinator(d.version);
        return;
    }
    if (d.type === "coordinatorShuttingDown") {
        reconnectRetries = 0;
        reconnect();
        return;
    }
    if (d.type === "victim") {
        if (d.isVictim) console.log("[scanClient] this tab is now the scan decode victim");
        return;
    }
    // decode / decodeAbort requests (only the victim tab receives these).
    void handleDecodeRequest(d, handle, post);
}

// If the running coordinator is older than this page's build, ask it to step
// aside so a fresh one loads. Guarded by localStorage so only one tab fires it
// and a stale-cache respawn can't loop.
function maybeUpgradeCoordinator(coordVersion: unknown): void {
    if (typeof coordVersion !== "string") return;
    // ISO timestamps sort lexicographically == chronologically. Up to date (or
    // the coordinator is somehow newer) → nothing to do.
    if (BUILD_TIMESTAMP <= coordVersion) return;

    try {
        const raw = localStorage.getItem(UPGRADE_LS_KEY);
        const rec = raw ? JSON.parse(raw) as { version?: string; at?: number } : undefined;
        if (rec && typeof rec.version === "string" && typeof rec.at === "number"
            && rec.version >= BUILD_TIMESTAMP && Date.now() - rec.at < UPGRADE_COOLDOWN_MS) {
            // Another tab already asked for (at least) our version very recently —
            // don't pile on, and don't loop if the respawn came back still-old.
            return;
        }
        localStorage.setItem(UPGRADE_LS_KEY, JSON.stringify({ version: BUILD_TIMESTAMP, at: Date.now() }));
    } catch { /* localStorage blocked — proceed without the cross-tab guard */ }

    console.log(`[scanClient] coordinator is ${coordVersion}, this page is ${BUILD_TIMESTAMP} — requesting upgrade restart`);
    post({ type: "command", cmd: "shutdownForUpgrade" });
}

// Tear down the current (shutting-down) coordinator connection and attach to the
// fresh one. A brief delay lets the old worker fully terminate so the browser
// re-fetches the new script instead of handing us the dying instance.
function reconnect(): void {
    if (reconnecting) return;
    reconnecting = true;
    console.log("[scanClient] reconnecting to the upgraded scan coordinator");
    try { coordinator?.port.close(); } catch { /* ignore */ }
    coordinator = undefined;
    setTimeout(() => {
        reconnecting = false;
        connect(true);
    }, 400);
}

// Watchdog for a reconnect: if the fresh coordinator doesn't greet us, we likely
// raced its dying predecessor — retry a bounded number of times, then give up
// (the upgrade will settle on the next page load).
function armHelloTimeout(): void {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
        helloTimer = undefined;
        if (reconnectRetries < MAX_RECONNECT_RETRIES) {
            reconnectRetries++;
            console.warn(`[scanClient] no coordinator greeting after reconnect — retry ${reconnectRetries}`);
            reconnect();
        } else {
            console.warn("[scanClient] gave up reconnecting after upgrade; will settle on next load");
        }
    }, HELLO_TIMEOUT_MS);
}

function reportState(): void {
    post({
        type: "state",
        focused: document.hasFocus() && document.visibilityState === "visible",
        playing: thisTabPlayingVideo.get(),
        hasHandle: !!handle,
    });
}

// Force the coordinator to walk the folder for new files right now.
export function requestFileWalkNow(): void {
    post({ type: "command", cmd: "walkNow" });
}
