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
    const allKeys = nameCol ? nameCol.map(r => r.key) : [];

    const metaCol = files.getColumnSync("metadataVersion");
    const metaDone = metaCol ? metaCol.filter(r => r.value === METADATA_VERSION).length : 0;

    // Files whose metadata terminally FAILED (version stamped, but with an error).
    // These will never be keyframe/face-scanned automatically — if we couldn't
    // even read the metadata the file is almost certainly corrupt/unsupported —
    // so they must drop out of the keyframe + face "remaining" counts the instant
    // metadata fails. (They're still metadata-*done*, so they're not counted as
    // remaining for metadata either.)
    const errCol = files.getColumnSync("extractionError");
    const metaFailed = new Set<string>();
    if (errCol) for (const r of errCol) if (typeof r.value === "string" && r.value !== "") metaFailed.add(r.key);

    // "Remaining" = files that still CAN be scanned automatically (metadata didn't
    // fail) and aren't yet done. Iterate every file key so never-touched files —
    // which have no keyframes/faces column entry at all — are counted.
    const kfDone = new Set<string>();
    const kfCol = files.getColumnSync("keyframesDoneVersion");
    if (kfCol) for (const r of kfCol) if (r.value === KEYFRAMES_VERSION) kfDone.add(r.key);
    const keyframesRemaining = allKeys.filter(k => !kfDone.has(k) && !metaFailed.has(k)).length;

    const facesDone = new Set<string>();
    const facesCol = files.getColumnSync("facesVersion");
    if (facesCol) for (const r of facesCol) if (r.value === FACES_VERSION) facesDone.add(r.key);
    const facesRemaining = allKeys.filter(k => !facesDone.has(k) && !metaFailed.has(k)).length;

    return {
        total,
        metadataRemaining: Math.max(0, total - metaDone),
        keyframesRemaining,
        facesRemaining,
    };
}
