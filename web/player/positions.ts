// Playback positions and loop regions, in localStorage.
//
// These used to live in the files database, written every five seconds of
// playback. That is the wrong home for them twice over.
//
// It is expensive: BulkDatabase2's sync reads observe ONE overlay signal per
// table, so a positionSec write invalidates EVERY getColumnSync subscriber of
// the files table, whatever column it asked for. During playback that meant
// the favicon's series reactions and the player's series pill regrouping the
// whole library on a five-second timer, plus a disk write per position.
//
// And it is unnecessary: a position is read on demand -- when a cell draws its
// progress bar, when the player resumes, when the info modal is opened -- and
// never needs the synchronisation, history or multi-file storage the database
// exists to provide. Losing one is worth a few seconds of rewatching.
//
// MILLISECONDS, everywhere. The old fields were seconds, which meant every
// caller converted at the boundary and the player's own clock (ms) was divided
// on the way in and multiplied on the way out. The old positionSec /
// positionUpdatedAt / loop*Sec fields are left on the record: they are not
// written any more, and not read.

import { observable, runInAction } from "mobx";

const KEY = "vidgrid.positions.v1";

interface Entry {
    // Where playback got to, in milliseconds.
    ms: number;
    // When that was, epoch milliseconds. Drives "recently watched" sorting.
    at: number;
    // Loop region, milliseconds, only when a loop is enabled for this video.
    loopStartMs?: number;
    loopEndMs?: number;
}

// Bumped on every change. Views that draw a progress bar observe this, so they
// still update live without the position itself being an observable -- one atom
// for the whole store rather than a database subscription per file.
export const positionsVersion = observable.box(0);

let store: Map<string, Entry> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Map<string, Entry> {
    if (store) return store;
    store = new Map();
    if (typeof localStorage === "undefined") return store;
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Record<string, Entry>;
            for (const [k, v] of Object.entries(parsed)) {
                if (v && typeof v.ms === "number") store.set(k, v);
            }
        }
    } catch (e) {
        console.warn("[positions] could not read stored positions:", e);
    }
    return store;
}

// Written on a debounce rather than per change: playback updates every few
// seconds and serialising the whole map each time would be the same mistake in
// a cheaper place. Also flushed when the page goes away, which is the case that
// actually matters for not losing a position.
function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(flushNow, 2000);
}

export function flushNow(): void {
    if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
    if (!store || typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(store)));
    } catch (e) {
        console.warn("[positions] could not save positions:", e);
    }
}

if (typeof addEventListener === "function") {
    addEventListener("pagehide", flushNow);
    addEventListener("visibilitychange", () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") flushNow();
    });
}

export function getPositionMs(key: string): number | undefined {
    return load().get(key)?.ms;
}

export function getPositionUpdatedAt(key: string): number | undefined {
    return load().get(key)?.at;
}

export function setPositionMs(key: string, ms: number): void {
    const map = load();
    const prev = map.get(key);
    map.set(key, { ...prev, ms, at: Date.now() });
    runInAction(() => positionsVersion.set(positionsVersion.get() + 1));
    scheduleFlush();
}

export function getLoop(key: string): { startMs: number; endMs: number } | undefined {
    const e = load().get(key);
    if (!e || e.loopStartMs === undefined || e.loopEndMs === undefined) return undefined;
    if (!(e.loopEndMs > e.loopStartMs)) return undefined;
    return { startMs: e.loopStartMs, endMs: e.loopEndMs };
}

export function setLoop(key: string, loop: { startMs: number; endMs: number } | undefined): void {
    const map = load();
    const prev = map.get(key) ?? { ms: 0, at: Date.now() };
    map.set(key, {
        ...prev,
        loopStartMs: loop?.startMs,
        loopEndMs: loop?.endMs,
    });
    runInAction(() => positionsVersion.set(positionsVersion.get() + 1));
    scheduleFlush();
}

// Every stored position, for sorting a grid by how recently it was watched.
// Reading this in a reactive context also observes positionsVersion, so the
// grid re-sorts when a position changes.
export function allPositionsSync(): Map<string, Entry> {
    void positionsVersion.get();
    return load();
}
