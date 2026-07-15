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

import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { files } from "../appState";

export interface ScanCounts {
    total: number;
    metadataRemaining: number;
    keyframesRemaining: number;
    facesRemaining: number;
}

// All counts derive from the light `files` DB (already loaded for the grid):
// remaining = total − done, where "done" means the phase's version column
// matches the current version. Keyframes uses a mirror field on the files record
// (keyframesDoneVersion) that the worker stamps, so we never load the heavy
// keyframes stream just to count.
export function scanCounts(): ScanCounts {
    const nameCol = files.getColumnSync("name");
    const total = nameCol ? nameCol.length : 0;

    const metaCol = files.getColumnSync("metadataVersion");
    const metaDone = metaCol ? metaCol.filter(r => r.value === METADATA_VERSION).length : 0;

    const kfCol = files.getColumnSync("keyframesDoneVersion");
    const kfDone = kfCol ? kfCol.filter(r => r.value === KEYFRAMES_VERSION).length : 0;

    const facesCol = files.getColumnSync("facesVersion");
    const facesDone = facesCol ? facesCol.filter(r => r.value === FACES_VERSION).length : 0;

    return {
        total,
        metadataRemaining: Math.max(0, total - metaDone),
        keyframesRemaining: Math.max(0, total - kfDone),
        facesRemaining: Math.max(0, total - facesDone),
    };
}
