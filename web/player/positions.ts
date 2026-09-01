// Playback positions and loop regions: one localStorage key per video.
//
// These used to live in the files database, written every five seconds of
// playback. BulkDatabase2 observes one overlay signal per table, so each write
// invalidated every sync column read of `files` whatever column it asked for --
// which is what made the favicon reactions and the series pill regroup the
// whole library on a timer during playback.
//
// A position is read when a video loads and when a page loads. Nothing watches
// it, so there is nothing here to watch it with: no in-memory copy to keep in
// step, no debounce, no flush. A read is a localStorage.getItem, a write is a
// localStorage.setItem.
//
// MILLISECONDS. Only the position lives here: positionUpdatedAt is in the
// `playback` collection because sorting the library by it needs every file's
// value at once, and the loop region stays in `files` where it always was.

const PREFIX = "vidgrid.pos.";

export interface StoredPosition {
    // Where playback got to.
    ms: number;
}

export function getPositionMs(key: string): number | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function setPositionMs(key: string, ms: number): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(PREFIX + key, String(Math.round(ms)));
    } catch (e) {
        // A full quota is not worth failing playback over.
        console.warn("[positions] could not store position:", e);
    }
}
