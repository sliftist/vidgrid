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
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { handleDecodeRequest, setDecodeRefusing } from "./decodeService";

// Human-readable, URL-safe build slug for the ?v= cache-buster, e.g.
// "2026-07-15_16-09-19_EDT" — Eastern local time, no percent-escaped colons.
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
        return BUILD_TIMESTAMP.replace(/[:.]/g, "-").replace(/[^0-9A-Za-z_-]/g, "");
    }
}

const COORD_URL = `./scanCoordinator.js?v=${buildVersionSlug()}`;

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
