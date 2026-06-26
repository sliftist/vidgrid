// App-wide, reactive view of which bulk databases are mid-compaction. Every
// BulkDatabase2 exposes isCompactingSync() (reactive — true while a merge is
// rewriting its files); this gathers them all under friendly labels so the UI
// can show a single "N compacting" indicator and name the collections on hover.

import { files, thumbnails, keyframes, characters, faceFrames, removedFiles } from "./appState";
import { lists, listMemberships } from "./lists/lists";

const COMPACTABLE: { db: { isCompactingSync(): boolean }; label: string }[] = [
    { db: files, label: "Files" },
    { db: thumbnails, label: "Thumbnails" },
    { db: keyframes, label: "Keyframes" },
    { db: characters, label: "Characters" },
    { db: faceFrames, label: "Face frames" },
    { db: removedFiles, label: "Removed" },
    { db: lists, label: "Lists" },
    { db: listMemberships, label: "List memberships" },
];

// Reactive: the labels of every bulk database currently compacting. Call from
// inside an observer/render so it re-runs as compaction starts/stops.
export function getCompactingDatabases(): string[] {
    return COMPACTABLE.filter(c => c.db.isCompactingSync()).map(c => c.label);
}
