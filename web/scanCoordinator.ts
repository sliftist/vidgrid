// The scan COORDINATOR + SCANNER — a SharedWorker (one instance across all tabs).
// It does ALL the scanning work: file-system traversal, all BulkDatabase2 access,
// orchestration, clustering, poster/avatar generation, progress. The one thing it
// can't do is decode video (a SharedWorker has no WebCodecs), so it appoints ONE
// "victim" tab and delegates just the decode of a specific file to it (see
// scanDelegate.ts + the victim-side decodeService.ts). Tabs never scan; they only
// decode-on-request, on their main thread.
//
// The victim is chosen to disturb the user least: a tab that has the folder
// handle, isn't playing video, and has been unfocused the longest.

import { setStorageRootOverride } from "sliftutils/storage/FileFolderAPI";
import { setScanRoot, startScanCore, wakeScanCore, requestWalkNow, notifyScanSettingsChanged } from "./scan/workerScanCore";
import { setVictimPort, handleVictimMessage } from "./scan/scanDelegate";
// The build timestamp compiled into THIS coordinator bundle. Because a
// stable-URL SharedWorker keeps running its original script until every tab
// closes, a running coordinator can be older than a freshly-loaded page. We tell
// each tab our version; if a tab is newer it asks us to shut down (below) so a
// fresh coordinator loads. Same value the page bundle embeds (one stamp per build).
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

    // A newer page asked us to make way for a fresh coordinator. Tell every tab to
    // reconnect (which respawns the SharedWorker from the new script), then close
    // ourselves. State lives in BulkDatabase2, so losing an in-flight scan is
    // harmless — the new coordinator picks up exactly where we left off.
    function shutdownForUpgrade(): void {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[scan-coordinator] outdated (running ${COORD_VERSION}); shutting down so a newer one can take over`);
        for (const t of tabs) { try { t.port.postMessage({ type: "coordinatorShuttingDown" }); } catch { /* gone */ } }
        // Let the broadcast flush before we terminate.
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
        // ineligible — it started playing, lost its handle, or went away. Switching
        // just because another tab got focused/blurred would needlessly abort an
        // in-flight decode; a focused-but-not-playing tab is a fine decoder.
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
                    startScanCore();
                }
                reevaluate();
            } else if (d.type === "command") {
                if (d.cmd === "walkNow") requestWalkNow();
                else if (d.cmd === "settingsChanged") void notifyScanSettingsChanged();
                else if (d.cmd === "shutdownForUpgrade") shutdownForUpgrade();
            } else {
                // decodeResult / faceFrame / decodeDone from the victim.
                handleVictimMessage(d);
            }
        };
        port.start?.();
        // Announce our version so a newer tab can decide whether to replace us.
        try { port.postMessage({ type: "coordinatorHello", version: COORD_VERSION }); } catch { /* gone */ }
        reevaluate();
    };
}
