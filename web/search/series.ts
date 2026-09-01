// Series detection.
//
// Rules (per spec):
//   - A *folder* (not the root) directly containing between minVideos and
//     SERIES_MAX videos counts as a series. Direct children only — anything
//     in a deeper subfolder belongs to that subfolder's potential series,
//     *except* for lone videos, which collapse upwards (see collapseSingles).
//   - Order of series: pure alphabetical on the folder path.
//   - Order of videos inside a series: alphabetical by filename.
//
// Caching: detection is pure over the set of {relativePath} we feed it, and
// in practice that set changes infrequently (a scan adding/removing files).
// We stringify the sorted relativePath list as the cache key and remember
// the last result. One-entry cache is enough — series detection is fast
// and the new list invalidates the old one anyway.

// Upper bound on folder size — beyond this a folder is assumed to be a dumping
// ground (e.g. a flat "all videos" directory), not a series. The lower bound is
// the user-configurable `seriesMinVideos` setting, passed into getSeries().
export const SERIES_MAX = 100;

export interface SeriesVideo {
    key: string;
    name: string;
    relativePath: string;
}

export interface SeriesGroup {
    // Folder path *relative to the scan root*, e.g. "Movies/Friends/Season 1".
    parentPath: string;
    // Just the final segment of parentPath, used as the display name.
    folderName: string;
    // Videos directly inside the folder, sorted alphabetically by name.
    videos: SeriesVideo[];
}

function addTo(byParent: Map<string, SeriesVideo[]>, parentPath: string, video: SeriesVideo) {
    let list = byParent.get(parentPath);
    if (!list) {
        list = [];
        byParent.set(parentPath, list);
    }
    list.push(video);
}

const depthOf = (parentPath: string) => parentPath.split("/").length;

// A folder holding exactly one video can't be a series on its own, and nesting
// those is common ("Show/Season 3/only-episode.mkv"). So a lone video is handed
// up to its parent folder, where it can join the other videos that live there.
//
// This is done in rounds, deepest folders first, rather than by walking any one
// video all the way up: two sibling folders that each hold one video both hand
// their video to the shared parent in the same round, and that parent now holds
// two — so they stop there instead of drifting further up on their own. Going
// deepest-first likewise means a folder receives from its subfolders before it
// is ever considered for collapsing itself.
//
// Videos stop moving as soon as they land somewhere holding more than one, and
// nothing ever collapses into the root (root-level files are never a series),
// which bounds the loop: every round strictly reduces the depth of the deepest
// lone video.
function collapseSingles(byParent: Map<string, SeriesVideo[]>) {
    for (;;) {
        // Depth 1 folders are excluded — their parent is the root.
        let deepest = 1;
        for (const [parentPath, videos] of byParent) {
            if (videos.length !== 1) continue;
            deepest = Math.max(deepest, depthOf(parentPath));
        }
        if (deepest <= 1) return;
        const moving: string[] = [];
        for (const [parentPath, videos] of byParent) {
            if (videos.length === 1 && depthOf(parentPath) === deepest) moving.push(parentPath);
        }
        for (const parentPath of moving) {
            const video = byParent.get(parentPath)![0];
            byParent.delete(parentPath);
            addTo(byParent, parentPath.slice(0, parentPath.lastIndexOf("/")), video);
        }
    }
}

function detectSeries(records: SeriesVideo[], minVideos: number): Map<string, SeriesGroup> {
    const byParent = new Map<string, SeriesVideo[]>();
    for (const r of records) {
        const slash = r.relativePath.lastIndexOf("/");
        if (slash < 0) continue; // root-level file — never a series
        addTo(byParent, r.relativePath.slice(0, slash), r);
    }
    collapseSingles(byParent);
    const out = new Map<string, SeriesGroup>();
    for (const [parentPath, videos] of byParent) {
        if (videos.length < minVideos || videos.length > SERIES_MAX) continue;
        const folderName = parentPath.slice(parentPath.lastIndexOf("/") + 1) || parentPath;
        const sorted = videos.slice().sort((a, b) => a.name.localeCompare(b.name));
        out.set(parentPath, { parentPath, folderName, videos: sorted });
    }
    return out;
}

let lastKey: string | undefined;
let lastResult: Map<string, SeriesGroup> | undefined;

export function getSeries(records: SeriesVideo[], minVideos: number): Map<string, SeriesGroup> {
    // Sort relativePaths and join — same record set → same key regardless of
    // input order. The join is intentionally a single string so it's a fast
    // === compare against the cached key. The threshold is part of the key so
    // changing the setting recomputes instead of returning a stale grouping.
    const paths = records.map(r => r.relativePath).sort();
    const key = `${minVideos}\n${paths.join("\n")}`;
    if (key === lastKey && lastResult) return lastResult;
    lastKey = key;
    lastResult = detectSeries(records, minVideos);
    return lastResult;
}

// Sorted list of SeriesGroups for display. Pure alphabetical on parentPath.
export function listSeriesAlphabetical(map: Map<string, SeriesGroup>): SeriesGroup[] {
    return Array.from(map.values()).sort((a, b) => a.parentPath.localeCompare(b.parentPath));
}

// Series that the given video key belongs to, if any.
export function findSeriesForKey(map: Map<string, SeriesGroup>, key: string): SeriesGroup | undefined {
    for (const group of map.values()) {
        for (const v of group.videos) if (v.key === key) return group;
    }
    return undefined;
}

// Same as findSeriesForKey but also returns the 0-based index within the
// (alphabetically-sorted) series videos.
export function locateInSeries(map: Map<string, SeriesGroup>, key: string): { group: SeriesGroup; index: number } | undefined {
    for (const group of map.values()) {
        const idx = group.videos.findIndex(v => v.key === key);
        if (idx >= 0) return { group, index: idx };
    }
    return undefined;
}


// --------------------------------------------------------------------------
// The library's series grouping, derived once and reused.
//
// Every caller of this used to walk the whole library itself: two full columns,
// a Map and an array over every file, then the grouping pass. That is
// expensive, and worse, it re-ran constantly for a reason that has nothing to
// do with series: BulkDatabase2's sync reads observe ONE overlay signal per
// table, so ANY write to ANY file field invalidates every getColumnSync
// subscriber. Playback saves positionSec every few seconds, so the favicon's
// two reactions and the player's series pill regrouped the entire library on a
// timer, in the middle of playback.
//
// The read is still observed -- that is how callers stay live -- but the
// derivation behind it is now skipped when nothing it depends on changed. The
// column arrays are returned by identity while they are fresh, so comparing
// references is enough to know the answer cannot have changed.
let cachedNameCol: unknown;
let cachedPathCol: unknown;
let cachedMinVideos = -1;
let cachedMap: Map<string, SeriesGroup> | undefined;
let cachedAtMs = 0;

// How stale the grouping is allowed to get while writes keep arriving.
//
// The identity check below is the fast path, but it only holds while the write
// overlay is empty: with a write pending, patchColumn rebuilds every column's
// array, so every column read comes back as a new array even though its
// contents are unchanged. Playback writes positionSec every five seconds, so
// without this bound the grouping would still be rebuilt on that cadence
// forever. A series list up to a couple of seconds behind a rename is not
// something anyone can perceive; regrouping the library during playback is.
const MAX_STALE_MS = 2000;

export function seriesMapSync(
    nameCol: { key: string; value: string }[] | undefined,
    pathCol: { key: string; value: string }[] | undefined,
    minVideos: number,
): Map<string, SeriesGroup> | undefined {
    if (!nameCol || !pathCol) return undefined;
    const sameInputs = nameCol === cachedNameCol && pathCol === cachedPathCol
        && minVideos === cachedMinVideos;
    if (cachedMap && sameInputs) return cachedMap;
    if (cachedMap && minVideos === cachedMinVideos
        && nameCol.length === (cachedNameCol as unknown[] | undefined)?.length
        && Date.now() - cachedAtMs < MAX_STALE_MS) {
        // Same number of files, rebuilt array, and we just did this. Whatever
        // changed was a write to some other column.
        return cachedMap;
    }
    const pathByKey = new Map<string, string>();
    for (const { key, value } of pathCol) pathByKey.set(key, value);
    const recs: SeriesVideo[] = [];
    for (const { key, value: name } of nameCol) {
        const relativePath = pathByKey.get(key);
        if (relativePath) recs.push({ key, name, relativePath });
    }
    cachedMap = getSeries(recs, minVideos);
    cachedNameCol = nameCol;
    cachedPathCol = pathCol;
    cachedMinVideos = minVideos;
    cachedAtMs = Date.now();
    return cachedMap;
}
