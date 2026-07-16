// Force-rescan commands (tab side).
//
// The background worker picks any file whose phase version != the current
// version, so "force a re-scan" is simply clearing the version stamp: the worker
// notices on its next poll and re-extracts. No command channel needed — this
// rides BulkDatabase2 like everything else. Used by the Scanning page buttons.

import { files, keyframes, setFacesScanEnabled } from "../appState";

export type ScanPhaseName = "metadata" | "keyframes" | "faces";

// "Full scan": make sure every phase is enabled (enabling faces cascades to
// enable keyframes + the master toggle) and clear every phase's version stamp so
// the worker re-does the whole library across all phases. This is the usual
// "just scan everything" button.
export async function forceFullRescan(): Promise<void> {
    setFacesScanEnabled(true);
    await Promise.all([forceRescanAll("metadata"), forceRescanAll("keyframes"), forceRescanAll("faces")]);
}

// Clear one file's version stamp for a phase so the worker re-extracts it.
export async function forceRescanFile(key: string, phase: ScanPhaseName): Promise<void> {
    if (phase === "metadata") {
        // Clearing metadata also lifts any blacklist — the user explicitly wants
        // to retry this file.
        await files.update({ key, metadataVersion: undefined, extractionError: "", scanBlacklisted: undefined });
    } else if (phase === "keyframes") {
        await keyframes.update({ key, keyframesVersion: undefined, keyframesError: "" });
        // Clear the light files-record mirror the count reads, so re-queuing a
        // file immediately shows it as needing keyframes again.
        await files.update({ key, keyframesDoneVersion: undefined });
    } else {
        // Also clear the terminal empty/error flags so a previously faceless or
        // failed file actually gets retried.
        await files.update({ key, facesVersion: undefined, facesEmpty: false, facesError: "" });
    }
}

// "Q" — queue this file to the FRONT of the scan queue: force re-scan of all its
// phases AND stamp scanPriority so the background scanner picks it next (it won't
// interrupt the file currently scanning). The scanner still does the work.
export async function queueFileToFront(key: string): Promise<void> {
    await Promise.all([
        forceRescanFile(key, "metadata"),
        forceRescanFile(key, "keyframes"),
        forceRescanFile(key, "faces"),
    ]);
    await files.update({ key, scanPriority: Date.now() });
}

// Clear the phase version for EVERY file — a full forced re-run of that phase.
export async function forceRescanAll(phase: ScanPhaseName): Promise<void> {
    if (phase === "metadata") {
        const keys = await files.getKeys();
        await files.updateBatch(keys.map(key => ({ key, metadataVersion: undefined, extractionError: "", scanBlacklisted: undefined })));
    } else if (phase === "keyframes") {
        const keys = await keyframes.getKeys();
        await keyframes.updateBatch(keys.map(key => ({ key, keyframesVersion: undefined, keyframesError: "" })));
        // Clear the count mirror for every file too.
        const fileKeys = await files.getKeys();
        await files.updateBatch(fileKeys.map(key => ({ key, keyframesDoneVersion: undefined })));
    } else {
        const keys = await files.getKeys();
        await files.updateBatch(keys.map(key => ({ key, facesVersion: undefined, facesEmpty: false, facesError: "" })));
    }
}
