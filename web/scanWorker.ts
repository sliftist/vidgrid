// The scanner — a DEDICATED Worker. It's spawned by whichever tab the coordinator
// (a SharedWorker — see scanCoordinator.ts) appoints as host. It must be a
// dedicated Worker, not the SharedWorker, because WebCodecs (VideoDecoder) is
// only exposed in Window + DedicatedWorker contexts — a SharedWorker can't decode
// video at all. Here decode/keyframes/faces all work (see inlineExtractor.ts).
//
// The host tab sends the granted directory handle once; commands (walk-now,
// settings-changed) arrive over a BroadcastChannel from any tab.

import { setStorageRootOverride } from "sliftutils/storage/FileFolderAPI";
import { setScanRoot, startScanCore, requestWalkNow, notifyScanSettingsChanged } from "./scan/workerScanCore";

// The bundler runs this entry under Node to enumerate modules; `importScripts`
// exists only in a real worker scope, so the wiring stays dormant there.
declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    let rootSet = false;

    self.addEventListener("message", (ev: MessageEvent) => {
        const data = ev.data;
        if (data && data.type === "handle" && data.handle && !rootSet) {
            rootSet = true;
            const handle = data.handle as FileSystemDirectoryHandle;
            // Injected before any DB read/write or file resolve happens.
            setStorageRootOverride(handle);
            setScanRoot(handle);
            startScanCore();
        }
    });

    // Commands from any tab (they can't reach this worker directly — only the
    // host tab spawned it — so they broadcast and this single worker listens).
    if (typeof BroadcastChannel !== "undefined") {
        const cmd = new BroadcastChannel("vidgrid-scan-cmd");
        cmd.onmessage = (ev: MessageEvent) => {
            const d = ev.data;
            if (!d) return;
            if (d.cmd === "walkNow") requestWalkNow();
            else if (d.cmd === "settingsChanged") void notifyScanSettingsChanged();
        };
    }
}
