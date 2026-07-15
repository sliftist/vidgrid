// Reactive remaining-work counts for the scan status UI: how many files still
// need each phase.
//
// metadata / faces / total are derived straight from the `files` DB (the grid
// already has it loaded, and metadataVersion / facesVersion / name are cheap
// number/string columns) so they're correct and immediate — a file "needs"
// metadata (or faces) when its version column doesn't match the current one.
//
// keyframesVersion, however, lives on the heavy keyframes stream (reading it
// tab-side would pull tens of MB just to count), so the background worker counts
// it and publishes the number in the scan-status record; we read that here.
// Nothing is gated behind "has the user hovered a keyframe cell" — that old
// behaviour was wrong and produced a "?".

import { METADATA_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { files } from "../appState";
import { keyframesRemainingFromStatus } from "./scanStatusBus";

export interface ScanCounts {
    total: number;
    metadataRemaining: number;
    // undefined only until the worker's first status publish (render as "—",
    // never "?"). It resolves within a second of a tab connecting.
    keyframesRemaining: number | undefined;
    facesRemaining: number;
}

export function scanCounts(): ScanCounts {
    const nameCol = files.getColumnSync("name");
    const total = nameCol ? nameCol.length : 0;

    // remaining = total − done, so files with no version entry yet (never
    // scanned) count as "needing" the phase without depending on whether the
    // column materialises an entry for them.
    const metaCol = files.getColumnSync("metadataVersion");
    const metaDone = metaCol ? metaCol.filter(r => r.value === METADATA_VERSION).length : 0;
    const metadataRemaining = Math.max(0, total - metaDone);

    const facesCol = files.getColumnSync("facesVersion");
    const facesDone = facesCol ? facesCol.filter(r => r.value === FACES_VERSION).length : 0;
    const facesRemaining = Math.max(0, total - facesDone);

    return {
        total,
        metadataRemaining,
        keyframesRemaining: keyframesRemainingFromStatus(),
        facesRemaining,
    };
}
