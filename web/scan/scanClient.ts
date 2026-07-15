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

// STABLE url, deliberately with NO version query. A SharedWorker is a singleton
// keyed by its script URL — a constant URL is the browser's own, absolute
// guarantee that exactly ONE coordinator exists across every tab. (A ?v= cache
// buster would give tabs on different builds different URLs → multiple
// coordinators, which must never happen.) The tradeoff — a running coordinator
// keeps its old code until every tab closes — is the correct singleton behaviour.
const COORD_URL = "./scanCoordinator.js";

let coordinator: SharedWorker | undefined;
let handle: FileSystemDirectoryHandle | undefined;
let started = false;

// Start the client (idempotent). Called once on app boot.
export function startScanClient(): void {
    if (started) return;
    started = true;
    if (typeof SharedWorker === "undefined") {
        console.warn("[scanClient] SharedWorker unavailable — background scanning disabled in this browser");
        return;
    }
    try {
        coordinator = new SharedWorker(COORD_URL, { name: "vidgrid-scan-coordinator" });
        coordinator.port.start();
    } catch (err) {
        console.warn("[scanClient] could not start scan coordinator:", err);
        return;
    }

    const post = (msg: any, transfer?: Transferable[]) => {
        if (transfer && transfer.length) coordinator!.port.postMessage(msg, transfer);
        else coordinator!.port.postMessage(msg);
    };

    coordinator.port.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (!d) return;
        if (d.type === "victim") {
            if (d.isVictim) console.log("[scanClient] this tab is now the scan decode victim");
            return;
        }
        // decode / decodeAbort requests (only the victim tab receives these).
        void handleDecodeRequest(d, handle, post);
    };

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

function reportState(): void {
    coordinator?.port.postMessage({
        type: "state",
        focused: document.hasFocus() && document.visibilityState === "visible",
        playing: thisTabPlayingVideo.get(),
        hasHandle: !!handle,
    });
}

// Force the coordinator to walk the folder for new files right now.
export function requestFileWalkNow(): void {
    coordinator?.port.postMessage({ type: "command", cmd: "walkNow" });
}
