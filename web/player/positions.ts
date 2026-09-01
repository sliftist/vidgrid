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
// MILLISECONDS. The old positionSec / positionUpdatedAt / loop*Sec fields are
// still on the record so old data parses, but nothing reads or writes them.

const PREFIX = "vidgrid.pos.";

export interface StoredPosition {
    // Where playback got to.
    ms: number;
    // When that was, epoch milliseconds. Drives "recently watched" ordering.
    at: number;
    // Loop region, only when one is set for this video.
    loopStartMs?: number;
    loopEndMs?: number;
}

function read(key: string): StoredPosition | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    try {
        const v = JSON.parse(raw) as StoredPosition;
        return typeof v?.ms === "number" ? v : undefined;
    } catch {
        return undefined;
    }
}

function write(key: string, value: StoredPosition): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
        // A full quota is not worth failing playback over.
        console.warn("[positions] could not store position:", e);
    }
}

export function getPositionMs(key: string): number | undefined {
    return read(key)?.ms;
}

export function getPositionUpdatedAt(key: string): number | undefined {
    return read(key)?.at;
}

export function setPositionMs(key: string, ms: number): void {
    write(key, { ...read(key), ms, at: Date.now() });
}

export function getLoop(key: string): { startMs: number; endMs: number } | undefined {
    const v = read(key);
    if (!v || v.loopStartMs === undefined || v.loopEndMs === undefined) return undefined;
    if (!(v.loopEndMs > v.loopStartMs)) return undefined;
    return { startMs: v.loopStartMs, endMs: v.loopEndMs };
}

export function setLoop(key: string, loop: { startMs: number; endMs: number } | undefined): void {
    const v = read(key) ?? { ms: 0, at: Date.now() };
    write(key, { ...v, loopStartMs: loop?.startMs, loopEndMs: loop?.endMs });
}

// Every stored position, for ordering a grid or a list by how recently
// something was watched. Walks the localStorage keys, which is only worth doing
// when something is actually sorting by it.
export function allPositions(): Map<string, StoredPosition> {
    const out = new Map<string, StoredPosition>();
    if (typeof localStorage === "undefined") return out;
    for (let i = 0; i < localStorage.length; i++) {
        const storageKey = localStorage.key(i);
        if (!storageKey || !storageKey.startsWith(PREFIX)) continue;
        const key = storageKey.slice(PREFIX.length);
        const value = read(key);
        if (value) out.set(key, value);
    }
    return out;
}
