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

    const STALE_MS = 15_000;

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
            } else {
                // decodeResult / faceFrame / decodeDone from the victim.
                handleVictimMessage(d);
            }
        };
        port.start?.();
        reevaluate();
    };
}
