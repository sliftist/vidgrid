// The single background scan worker — a SharedWorker, so there is exactly ONE
// instance across every open tab (the browser guarantees it; no locks, no leader
// election). It runs all library scanning. WebCodecs/WebGPU work fine here (via
// the nested metadataWorker it spawns), and BulkDatabase2 works in a worker
// (its DOM access is guarded and it syncs across threads via BroadcastChannel),
// so this worker reads/writes the same stores the tabs do with no bespoke
// messaging.
//
// A tab connects a port and sends its granted directory handle exactly once
// (workers can't show the picker, but a handle whose permission is already
// granted works via getFile). We inject it as the storage-root override so both
// BulkDatabase2 and our file reads resolve against the real library folder.

import { setStorageRootOverride } from "sliftutils/storage/FileFolderAPI";
import { setScanRoot, startScanCore, requestWalkNow, notifyScanSettingsChanged } from "./scan/workerScanCore";

// The bundler runs this entry under Node to enumerate modules; `importScripts`
// exists only in a real worker scope, so the connect wiring stays dormant there.
declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    let rootSet = false;

    (self as any).onconnect = (e: MessageEvent) => {
        const port: MessagePort = e.ports[0];
        port.onmessage = (ev: MessageEvent) => {
            const data = ev.data;
            if (data && data.type === "handle" && data.handle && !rootSet) {
                rootSet = true;
                const handle = data.handle as FileSystemDirectoryHandle;
                // Injected before any DB read/write or file resolve happens.
                setStorageRootOverride(handle);
                setScanRoot(handle);
                startScanCore();
            } else if (data && data.type === "command") {
                // Tab-driven commands so enable/disable and "check for new files"
                // take effect immediately rather than on the next idle poll.
                if (data.cmd === "walkNow") requestWalkNow();
                else if (data.cmd === "settingsChanged") void notifyScanSettingsChanged();
            }
        };
        port.start?.();
    };
}
