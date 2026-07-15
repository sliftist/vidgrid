// Reactive, DB-derived remaining-work counts for the scan status UI.
//
// These are computed straight from the databases (files / keyframes columns)
// rather than carried in the progress broadcast, so every tab renders correct
// remaining counts even before the first snapshot arrives — and they stay
// correct as the single scan worker writes results, because getColumnSync is
// reactive (mobx re-runs the caller when a column changes).
//
// The keyframes count is gated: reading the keyframesVersion column pulls the
// whole multi-MB stream file into memory, so we only read it once the user has
// actually engaged with keyframes (matching SearchPage's gate). Until then the
// keyframes remaining count is `undefined` and the UI shows "?".

import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import {
    files,
    keyframes as keyframesDb,
    keyframesCollectionAllowed,
    keyframesHasBeenAccessed,
} from "../appState";

export interface ScanCounts {
    // Total files discovered in the library.
    total: number;
    // Files still needing each phase (remaining = total − done). `keyframes` is
    // undefined while the keyframes column is gated off (render as "?").
    metadataRemaining: number;
    keyframesRemaining: number | undefined;
    facesRemaining: number;
    // Done counts, for callers that want done/total instead of remaining.
    metadataDone: number;
    keyframesDone: number | undefined;
    facesDone: number;
}

// Reactive: call inside a mobx reaction/observer render to get live counts.
export function scanCounts(): ScanCounts {
    const nameCol = files.getColumnSync("name");
    const total = nameCol ? nameCol.length : 0;

    const metaCol = files.getColumnSync("metadataVersion");
    const metadataDone = metaCol ? metaCol.filter(r => r.value === METADATA_VERSION).length : 0;

    const facesCol = files.getColumnSync("facesVersion");
    const facesDone = facesCol ? facesCol.filter(r => r.value === FACES_VERSION).length : 0;

    // Only touch the keyframes stream once it's been accessed — otherwise the
    // status component would force a tens-of-MB load on every page's first paint.
    const kfCol = (keyframesCollectionAllowed() && keyframesHasBeenAccessed.get())
        ? keyframesDb.getColumnSync("keyframesVersion")
        : undefined;
    const keyframesDone = kfCol ? kfCol.filter(r => r.value === KEYFRAMES_VERSION).length : undefined;

    return {
        total,
        metadataDone,
        keyframesDone,
        facesDone,
        metadataRemaining: Math.max(0, total - metadataDone),
        keyframesRemaining: keyframesDone === undefined ? undefined : Math.max(0, total - keyframesDone),
        facesRemaining: Math.max(0, total - facesDone),
    };
}
