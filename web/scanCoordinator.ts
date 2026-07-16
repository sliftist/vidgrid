// The scan COORDINATOR + SCANNER — a SharedWorker. It does ALL the scanning work:
// file-system traversal, all BulkDatabase2 access, orchestration, clustering,
// poster/avatar generation, progress. The one thing it can't do is decode video
// (a SharedWorker has no WebCodecs), so it appoints ONE "victim" tab and
// delegates just the decode of a specific file to it (scanDelegate.ts +
// decodeService.ts). Tabs never scan; they only decode-on-request, on their
// main thread.
//
// Lifecycle & singleton:
//   - The tab loads this worker at URL "./scanCoordinator.js?v=<slug>" where the
//     slug is the max build-timestamp any tab on the browser has ever seen
//     (localStorage-persisted). SharedWorkers are keyed by URL, so a bumped
//     version is a fresh key → a fresh scope with fresh bytes.
//   - On spawn AND every 60s we broadcast `whoIsAlive`; every other coordinator
//     replies with its BUILD_TIMESTAMP. Any coordinator that hears a strictly
//     newer version self-closes. Highest timestamp wins.
//   - Master scanning is stored in localStorage (Window-only) and broadcast on
//     the scan-settings BroadcastChannel. We hear that broadcast (and the
//     initial value from each connecting tab); if it flips to OFF and no
//     one-shot allowance is granted, we self-close.
//   - "Scan Now" from a tab that has scanning OFF spawns us with a one-shot
//     allowance; when the scan loop reaches idle we self-close.
//
// The victim is chosen to disturb the user least: a tab that has the folder
// handle, isn't playing video, and has been unfocused the longest.

import { setStorageRootOverride } from "sliftutils/storage/FileFolderAPI";
import { setScanRoot, startScanCore, wakeScanCore, requestWalkNow, notifyScanSettingsChanged, setCoordinatorMode, cancelInFlightScan } from "./scan/workerScanCore";
import { setVictimPort, handleVictimMessage } from "./scan/scanDelegate";
import { COORD_VERSION_CHANNEL_NAME, CoordVersionMsg, bumpLatestKnownVersion, readLatestKnownVersion } from "./scan/scanCoordVersion";
import { BUILD_TIMESTAMP as COORD_VERSION } from "../buildVersion";

declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    interface Tab {
        id: number;
        port: MessagePort;
        focused: boolean;
        playing: boolean;
        hasHandle: boolean;
        lastFocusedAt: number; // "now" while focused; frozen when it blurs
        lastSeenAt: number;    // heartbeat liveness
    }
    const tabs: Tab[] = [];
    let victim: Tab | undefined;
    let scannerStarted = false;
    let tabIdCounter = 0;
    let shuttingDown = false;

    const STALE_MS = 15_000;
    // How often we RE-CHECK the shared "latest known build version" IDB cell.
    // This is the steady-state kill mechanism — the broadcast is just a fast
    // path on top of it. If IDB says a newer version exists we self-close.
    const VERSION_POLL_INTERVAL_MS = 60_000;
    const SCAN_SETTINGS_CHANNEL = "vidgrid-scan-settings";

    // We WERE spawned; the tab may or may not have said "and here's your
    // one-shot allowance" yet. Until we know, defer any self-close decision.
    let scanEnabledFromTab: boolean | undefined;
    let oneShotAllowance = false;

    console.log(`[scan-coordinator] spawned (build ${COORD_VERSION})`);

    // ── Version handshake ─────────────────────────────────────────────────────
    // IDB is the source of truth. We bump it to max(stored, ours) at spawn and
    // self-close immediately if IDB already holds something newer than us.
    // Every 60s we re-check IDB (steady-state kill: any newer coord that ever
    // wrote to IDB will kill us on the next poll). The BroadcastChannel is
    // ONLY a fast-path so an outdated coord dies within milliseconds of a new
    // one booting instead of waiting up to 60s for the poll.
    //
    // ONE wire message: `{type: "hello", version}` — every broadcast carries
    // the sender's version. On receipt we bump IDB unconditionally and, if
    // the sender is strictly newer, self-close.
    const versionBc = new BroadcastChannel(COORD_VERSION_CHANNEL_NAME);
    versionBc.addEventListener("message", (e: MessageEvent) => {
        const msg = e.data as CoordVersionMsg | undefined;
        if (!msg || msg.type !== "hello" || typeof msg.version !== "string") return;
        // Update IDB so any future coord (or tab) sees the newest seen version.
        void bumpLatestKnownVersion(msg.version);
        if (msg.version > COORD_VERSION) {
            console.log(`[scan-coordinator] heard newer version ${msg.version} (we're ${COORD_VERSION}) — closing`);
            selfClose("outdated by peer broadcast");
        }
    });
    // Spawn: bump IDB, close if already outdated, else announce our hello.
    void (async () => {
        const winner = await bumpLatestKnownVersion(COORD_VERSION);
        if (winner > COORD_VERSION) {
            console.log(`[scan-coordinator] outdated at spawn (IDB has ${winner} > ${COORD_VERSION}) — closing`);
            selfClose("outdated at spawn");
            return;
        }
        try { versionBc.postMessage({ type: "hello", version: COORD_VERSION }); } catch { /* ignore */ }
    })();
    // Steady-state poll: check IDB every 60s. If ANYTHING newer than us has
    // written itself in, we're stale — close.
    setInterval(async () => {
        if (shuttingDown) return;
        const stored = await readLatestKnownVersion();
        if (stored && stored > COORD_VERSION) {
            console.log(`[scan-coordinator] IDB poll found newer version ${stored} (we're ${COORD_VERSION}) — closing`);
            selfClose("outdated per IDB poll");
        }
    }, VERSION_POLL_INTERVAL_MS);

    // ── Settings channel: the master toggle across tabs + coord ───────────────
    const settingsBc = new BroadcastChannel(SCAN_SETTINGS_CHANNEL);
    settingsBc.addEventListener("message", (e: MessageEvent) => {
        const m = e.data as { type?: string; enabled?: boolean } | undefined;
        if (!m || m.type !== "scanEnabled" || typeof m.enabled !== "boolean") return;
        applyMasterEnabled(m.enabled);
    });

    function applyMasterEnabled(enabled: boolean): void {
        scanEnabledFromTab = enabled;
        setCoordinatorMode({ enabled });
        if (!enabled && !oneShotAllowance) {
            selfClose("scanning disabled");
        }
    }

    function selfClose(reason: string): void {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[scan-coordinator] closing (${reason})`);
        // Tell connected tabs so their heartbeat doesn't wait 60s to notice.
        for (const t of tabs) {
            try { t.port.postMessage({ type: "coordinatorShuttingDown", reason }); } catch { /* gone */ }
        }
        try { versionBc.close(); } catch { /* ignore */ }
        try { settingsBc.close(); } catch { /* ignore */ }
        // Small delay so the port messages flush before termination.
        setTimeout(() => { try { (self as any).close(); } catch { /* already gone */ } }, 50);
    }

    const eligible = (t: Tab): boolean => t.hasHandle && !t.playing;

    function pickBest(): Tab | undefined {
        const cands = tabs.filter(eligible);
        if (cands.length === 0) return undefined;
        cands.sort((a, b) =>
            (Number(a.focused) - Number(b.focused)) ||   // unfocused before focused
            (a.lastFocusedAt - b.lastFocusedAt));         // unfocused longest first
        return cands[0];
    }

    function setVictim(next: Tab | undefined): void {
        if (next === victim) return;
        const prev = victim;
        victim = next;
        setVictimPort(next ? next.port : undefined);
        if (prev && tabs.includes(prev)) { try { prev.port.postMessage({ type: "victim", isVictim: false }); } catch { /* gone */ } }
        if (victim) {
            console.log(`[scan-coordinator] delegating decode to tab #${victim.id} (focused=${victim.focused}, playing=${victim.playing})`);
            try { victim.port.postMessage({ type: "victim", isVictim: true }); } catch { /* gone */ }
            wakeScanCore(); // decode phases can resume now
        } else {
            console.log("[scan-coordinator] no eligible tab to decode — pausing decode phases");
        }
    }

    function reevaluate(): void {
        // Once a victim is chosen, KEEP it as long as it's still eligible (has the
        // handle and isn't playing video). We only switch when it becomes
        // ineligible — it started playing, lost its handle, or went away.
        if (victim && tabs.includes(victim) && eligible(victim)) return;
        setVictim(pickBest());
    }

    function prune(): void {
        const now = Date.now();
        let changed = false;
        for (let i = tabs.length - 1; i >= 0; i--) {
            if (now - tabs[i].lastSeenAt > STALE_MS) {
                if (tabs[i] === victim) victim = undefined;
                console.log(`[scan-coordinator] tab #${tabs[i].id} gone`);
                tabs.splice(i, 1);
                changed = true;
            }
        }
        if (changed) reevaluate();
    }
    setInterval(prune, 5_000);

    (self as any).onconnect = (e: MessageEvent) => {
        const port: MessagePort = e.ports[0];
        const tab: Tab = { id: ++tabIdCounter, port, focused: false, playing: false, hasHandle: false, lastFocusedAt: Date.now(), lastSeenAt: Date.now() };
        tabs.push(tab);
        console.log(`[scan-coordinator] tab #${tab.id} connected (${tabs.length} total)`);
        port.onmessage = (ev: MessageEvent) => {
            const d = ev.data;
            if (!d) return;
            // Heartbeat — the tab's liveness check. Reply immediately.
            if (d.type === "ping") { try { port.postMessage({ type: "pong" }); } catch { /* gone */ } tab.lastSeenAt = Date.now(); return; }
            if (d.type === "state") {
                tab.lastSeenAt = Date.now();
                tab.focused = !!d.focused;
                tab.playing = !!d.playing;
                tab.hasHandle = !!d.hasHandle;
                if (tab.focused) tab.lastFocusedAt = Date.now();
                reevaluate();
            } else if (d.type === "handle" && d.handle) {
                // Any tab's handle works (same picked directory). Use the first to
                // arrive to drive our own traversal + BulkDatabase2 storage root.
                tab.hasHandle = true;
                if (!scannerStarted) {
                    scannerStarted = true;
                    console.log(`[scan-coordinator] starting scanner with handle from tab #${tab.id}`);
                    setStorageRootOverride(d.handle as FileSystemDirectoryHandle);
                    setScanRoot(d.handle as FileSystemDirectoryHandle);
                    startScanCore({ onOneShotFinished: () => selfClose("one-shot pass complete") });
                }
                reevaluate();
            } else if (d.type === "settings" && typeof d.enabled === "boolean") {
                // Tab is telling us the current master-toggle value (from its
                // localStorage). First one wins for the initial state; a later
                // scanSettings broadcast will still update us as usual.
                applyMasterEnabled(d.enabled);
            } else if (d.type === "allowance" && d.oneShot === true) {
                // Tab spawned us for "Scan Now" while scanning is disabled — burn
                // through pending work then self-close.
                console.log(`[scan-coordinator] one-shot allowance granted by tab #${tab.id}`);
                oneShotAllowance = true;
                setCoordinatorMode({ oneShot: true });
            } else if (d.type === "command") {
                if (d.cmd === "walkNow") requestWalkNow();
                else if (d.cmd === "settingsChanged") void notifyScanSettingsChanged();
                else if (d.cmd === "cancelScanNow") {
                    // Abort the in-flight decode so the victim tab stops
                    // decoding right now, then self-close so we don't pick
                    // another file (matches the user's "just stop" intent).
                    cancelInFlightScan();
                    selfClose("user cancelled");
                }
            } else {
                // decodeResult / faceFrame / decodeDone from the victim.
                handleVictimMessage(d);
            }
        };
        port.start?.();
        reevaluate();
    };
}
