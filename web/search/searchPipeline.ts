import {
    files,
    characters,
    faceFrames,
    characterKey,
    EMBEDDING_FLOATS,
    FileRecord,
    DisplayMode,
    SortOrder,
    seriesMinVideos,
    keyframes as keyframesDb,
    keyframesCollectionAllowed,
} from "../appState";
import { KEYFRAMES_VERSION } from "../MetadataExtractor";
import { matchFilter } from "./matchFilter";
import { getSeries, SeriesGroup, SeriesVideo } from "./series";
import { lists as listsDb, listMemberships, getListsSync, getListMembersSync } from "../lists/lists";
import {
    showFaces,
    getClosestCharactersByFileSync,
    SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { l2Distance } from "../faceEmbed/arcface";
import { faceShowAll, faceSort, FaceSort } from "../router";

// One ordered key in the result. `distance` is set by the face paths (smaller
// = closer match). `frame` is set only by per-frame face search: a specific
// matched keyframe within one character source.
export type SearchKey = {
    key: string;
    distance?: number;
    frame?: { keyframeIndex: number; characterKey: string };
};

// Per-key values the custom scrollbar buckets into position labels. `name` is
// the tile's display name (filename, or folder name for a series tile);
// `modified` is its file mtime. Only the filtered path produces these.
export type SortValue = { name: string; modified: number; duration: number; watched: number };

export type SearchResult = {
    keys: SearchKey[];
    // Only the filtered (non-face) path populates this; the caller uses it to
    // tell a series tile (key === parentPath) from a video tile and to drill
    // into a series. A video key is a file's relativePath and a parentPath is a
    // folder path, so the two can't collide (a file and its folder can't share
    // a full path).
    seriesMap: Map<string, SeriesGroup>;
    totalFiles: number;
    // Aligned 1:1 with `keys` on the filtered path; undefined on the face path
    // (which has its own closest-first order, so the scrollbar shows no labels).
    sortValues?: SortValue[];
    // Every underlying file key the result actually represents, with the same
    // filter applied that produced `keys` — a series tile contributes only its
    // matching members, not the whole folder. This is the honest set "delete
    // all" operates on (and what thumbnail prioritization should target), as
    // opposed to expanding `keys` through `seriesMap`, which would pull in
    // non-matching siblings.
    flatKeys: string[];
    // True when a column this result depends on was still streaming in (the
    // same condition that refuses to cache the result). `keys` may be partial
    // or empty, so the UI shows "Loading…" rather than "no results".
    loading: boolean;
};

// A rehydrated, render-ready tile. Produced from a SearchKey by reading the
// (now small) visible window's file fields.
export type Tile =
    | { type: "video"; record: Pick<FileRecord, "key" | "name" | "relativePath" | "size">; highlighted?: boolean }
    | { type: "series"; series: SeriesGroup }
    | { type: "frame"; fileKey: string; fileName: string; relativePath: string; timeMs: number; characterKey: string; distance: number };

// ────────────────────────────────────────────────────────────────────────────
// search() — produces the ordered key list. Two independent branches, each
// with its own cache keyed by the inputs that actually affect it. We hold the
// observable column references in the cache key: getColumnSync returns a frozen
// array that stays referentially stable until the data changes, so a changed
// reference is exactly "the underlying data changed".

export function search(config: { mode: DisplayMode; query: string; fsSpec: Float32Array | undefined; perFrame: boolean; sortOrder: SortOrder; sortReversed: boolean; shuffleSeed?: string; durationMinMinutes?: number; durationMaxMinutes?: number; filterErrors?: boolean; filterKeyframes?: boolean; filterFaces?: boolean; filterInvert?: boolean }): SearchResult {
    // Face search has its own intrinsic order (closest first); the user's sort
    // controls only apply to the filtered (library-browsing) path.
    if (config.fsSpec) return faceSearch(config.fsSpec, config.query, config.perFrame);
    return filteredSearch({ mode: config.mode, query: config.query, sortOrder: config.sortOrder, sortReversed: config.sortReversed, shuffleSeed: config.shuffleSeed, durationMinMinutes: config.durationMinMinutes, durationMaxMinutes: config.durationMaxMinutes, filterErrors: config.filterErrors, filterKeyframes: config.filterKeyframes, filterFaces: config.filterFaces, filterInvert: config.filterInvert });
}

// Deterministic 32-bit string hash (FNV-1a). Used by "shuffle" sort: a tile's
// position is hash(key + seed), so the same seed yields a stable arbitrary
// order and changing the seed reshuffles everything.
function hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Only log a timing line when the work crossed this many ms — fast searches are
// the common case and their logs are just noise.
const SEARCH_LOG_MIN_MS = 50;

// Duration of the last core search that actually ran (cache miss). Held so the
// UI can show "how expensive is the real work", not the near-zero cached time.
let lastUncachedSearchMs = 0;
export function getLastUncachedSearchMs(): number {
    return lastUncachedSearchMs;
}

let faceCache: {
    query: string;
    perFrame: boolean;
    showAll: boolean;
    sort: FaceSort;
    centroidCol: unknown;
    memberCol: unknown;
    nameCol: unknown;
    result: SearchResult;
} | undefined;

// Per-source top-frame cache for per-frame face search. Each character source
// keeps only its top-3 frames (already scored against the search embedding).
// Keyed by the face query string — a new search makes every distance stale.
let frameSourceCache: { query: string; perSource: Map<string, TopFrame[]> } | undefined;

function faceSearch(fsSpec: Float32Array, query: string, perFrame: boolean): SearchResult {
    const centroidCol = characters.getColumnSync("centroid");
    const memberCol = characters.getColumnSync("memberCount");
    const nameCol = files.getColumnSync("name");
    // Default: only files whose closest character is within the closeness
    // threshold. The "Only close matches" checkbox (faceShowAll URL param)
    // flips this to include every file ranked by its closest character.
    const showAll = faceShowAll.get();
    const sort = faceSort.get();

    const cached = faceCache;
    if (cached) {
        const reason =
            cached.query !== query ? "query" :
            cached.perFrame !== perFrame ? "perFrame" :
            cached.showAll !== showAll ? "showAll" :
            cached.sort !== sort ? "sort" :
            cached.centroidCol !== centroidCol ? "character data changed" :
            cached.memberCol !== memberCol ? "member counts changed" :
            cached.nameCol !== nameCol ? "files added/removed" :
            undefined;
        if (!reason) return cached.result;
        console.log(`[search] face cache miss: ${reason}`);
    }

    const t0 = performance.now();

    // Single load flag for the whole run. Every field/column access below
    // flips it false if its data is still streaming in. We always compute (so
    // partial results still show), but if anything we touched wasn't loaded we
    // refuse to cache — the next render recomputes (re-observing those fields)
    // until everything is loaded and the result is genuinely final.
    const load = { ok: true };
    if (!characters.isColumnLoadedSync("centroid")) load.ok = false;
    if (!characters.isColumnLoadedSync("memberCount")) load.ok = false;
    if (!files.isColumnLoadedSync("name")) load.ok = false;

    const totalFiles = nameCol ? nameCol.length : 0;
    const faceDistances = getClosestCharactersByFileSync(fsSpec);
    // "count" (default): ordered by the matched character's memberCount (most
    // first), distance breaking ties so equally-prominent characters fall
    // closest-match first. "distance": closest match first, memberCount
    // breaking ties.
    const memberCountOf = (fileKey: string) => faceDistances.get(fileKey)?.memberCount ?? 0;
    const byMembers = (a: SearchKey, b: SearchKey) =>
        (memberCountOf(b.key) - memberCountOf(a.key)) || ((a.distance ?? 0) - (b.distance ?? 0));
    const byDistance = (a: SearchKey, b: SearchKey) =>
        ((a.distance ?? 0) - (b.distance ?? 0)) || (memberCountOf(b.key) - memberCountOf(a.key));
    const byActiveSort = sort === "distance" ? byDistance : byMembers;

    let keys: SearchKey[];
    if (perFrame) {
        let cache = frameSourceCache;
        if (!cache || cache.query !== query) {
            cache = { query, perSource: new Map() };
            frameSourceCache = cache;
        }
        keys = [];
        for (const [fileKey, match] of faceDistances) {
            if (!showAll && match.distance >= SAME_CHARACTER_THRESHOLD) continue;
            const charKey = characterKey(fileKey, match.characterIdx);
            let top = cache.perSource.get(charKey);
            if (!top) {
                // Per-source memo: only keep it if computeTopFrames saw every
                // field loaded. A loaded-but-empty source (genuinely no frames)
                // still gets cached; one whose embeddings are mid-stream does
                // not, so it recomputes once they arrive.
                const srcLoad = { ok: true };
                top = computeTopFrames(charKey, fsSpec, srcLoad);
                if (srcLoad.ok) cache.perSource.set(charKey, top);
                else load.ok = false;
            }
            for (const f of top) {
                keys.push({ key: fileKey, distance: f.distance, frame: { keyframeIndex: f.keyframeIndex, characterKey: charKey } });
            }
        }
        keys.sort(byActiveSort);
    } else {
        keys = [];
        for (const [fileKey, match] of faceDistances) {
            if (!showAll && match.distance >= SAME_CHARACTER_THRESHOLD) continue;
            keys.push({ key: fileKey, distance: match.distance });
        }
        keys.sort(byActiveSort);
    }

    // Per-frame search repeats a file key once per matched frame; dedup so the
    // flat set is one entry per file.
    const flatKeys = [...new Set(keys.map(k => k.key))];
    const result: SearchResult = { keys, seriesMap: new Map(), totalFiles, flatKeys, loading: !load.ok };
    // Only cache a fully-loaded result. Leaving faceCache unset forces the next
    // render to recompute, which re-reads (and re-observes) the still-loading
    // fields — so the moment they finish, the result refreshes and caches.
    faceCache = load.ok ? { query, perFrame, showAll, sort, centroidCol, memberCol, nameCol, result } : undefined;
    lastUncachedSearchMs = performance.now() - t0;
    if (lastUncachedSearchMs > SEARCH_LOG_MIN_MS) console.log(`[search] face core: ${keys.length} keys in ${lastUncachedSearchMs.toFixed(2)}ms${load.ok ? "" : " (data still loading — not cached)"}`);
    return result;
}

let filteredCache: {
    mode: DisplayMode;
    query: string;
    showFaces: boolean;
    sortOrder: SortOrder;
    sortReversed: boolean;
    shuffleSeed: string;
    durationMin: number | undefined;
    durationMax: number | undefined;
    filterErrors: boolean;
    filterKeyframes: boolean;
    filterFaces: boolean;
    filterInvert: boolean;
    seriesMin: number;
    nameCol: unknown;
    pathCol: unknown;
    modCol: unknown;
    durationCol: unknown;
    watchedCol: unknown;
    charCountCol: unknown;
    errorCol: unknown;
    keyframeVersionCol: unknown;
    listNameCol: unknown;
    membershipCol: unknown;
    result: SearchResult;
} | undefined;

function filteredSearch(config: { mode: DisplayMode; query: string; sortOrder: SortOrder; sortReversed: boolean; shuffleSeed?: string; durationMinMinutes?: number; durationMaxMinutes?: number; filterErrors?: boolean; filterKeyframes?: boolean; filterFaces?: boolean; filterInvert?: boolean }): SearchResult {
    const { mode, query, sortOrder, sortReversed } = config;
    // Only meaningful for "shuffle"; for any other order the value is ignored
    // (and doesn't affect the cache key, so toggling sorts stays cache-friendly).
    const shuffleSeed = sortOrder === "shuffle" ? (config.shuffleSeed ?? "") : "";
    const durationMin = config.durationMinMinutes;
    const durationMax = config.durationMaxMinutes;
    const durationActive = durationMin !== undefined || durationMax !== undefined;
    const filterErrors = config.filterErrors ?? false;
    const filterFaces = config.filterFaces ?? false;
    // The keyframes column read forces the multi-MB stream-file load, so only
    // honor the filter once the access gate is open (see keyframes gating in
    // appState — the setter marks it accessed when the user turns this on).
    const filterKeyframes = (config.filterKeyframes ?? false) && keyframesCollectionAllowed();
    // Flips each active attribute filter's sense (has X → lacks X).
    const filterInvert = config.filterInvert ?? false;
    const seriesMin = seriesMinVideos.get();
    const sf = showFaces.get();

    const nameCol = files.getColumnSync("name");
    const pathCol = files.getColumnSync("relativePath");
    const modCol = files.getColumnSync("fileModifiedAt");
    const durationCol = (durationActive || sortOrder === "duration") ? files.getColumnSync("durationSec") : undefined;
    const watchedCol = sortOrder === "watched" ? files.getColumnSync("positionUpdatedAt") : undefined;
    const charCountCol = (sf || filterFaces) ? files.getColumnSync("characterCount") : undefined;
    const errorCol = filterErrors ? files.getColumnSync("extractionError") : undefined;
    const keyframeVersionCol = filterKeyframes ? keyframesDb.getColumnSync("keyframesVersion") : undefined;
    // Observed so the cache invalidates when tags/memberships change — a query
    // that matches a tag name pulls in that tag's members below.
    const listNameCol = listsDb.getColumnSync("name");
    const membershipCol = listMemberships.getColumnSync("listKey");

    const cached = filteredCache;
    if (cached) {
        const reason =
            cached.mode !== mode ? "mode" :
            cached.query !== query ? "query" :
            cached.showFaces !== sf ? "showFaces" :
            cached.sortOrder !== sortOrder ? "sortOrder" :
            cached.sortReversed !== sortReversed ? "sortReversed" :
            cached.shuffleSeed !== shuffleSeed ? "shuffleSeed" :
            cached.durationMin !== durationMin ? "durationMin" :
            cached.durationMax !== durationMax ? "durationMax" :
            cached.filterErrors !== filterErrors ? "filterErrors" :
            cached.filterKeyframes !== filterKeyframes ? "filterKeyframes" :
            cached.filterFaces !== filterFaces ? "filterFaces" :
            cached.filterInvert !== filterInvert ? "filterInvert" :
            cached.seriesMin !== seriesMin ? "seriesMin" :
            cached.errorCol !== errorCol ? "errors changed" :
            cached.keyframeVersionCol !== keyframeVersionCol ? "keyframes changed" :
            cached.nameCol !== nameCol ? "files added/removed" :
            cached.pathCol !== pathCol ? "paths changed" :
            cached.modCol !== modCol ? "modified times changed" :
            cached.durationCol !== durationCol ? "durations changed" :
            cached.watchedCol !== watchedCol ? "watched times changed" :
            cached.charCountCol !== charCountCol ? "face counts changed" :
            cached.listNameCol !== listNameCol ? "tags changed" :
            cached.membershipCol !== membershipCol ? "tag memberships changed" :
            undefined;
        if (!reason) return cached.result;
        console.log(`[search] filtered cache miss: ${reason}`);
    }

    const t0 = performance.now();

    // See faceSearch: any column still streaming flips this false and the
    // result is computed-but-not-cached so it recomputes once data lands.
    const load = { ok: true };
    if (!files.isColumnLoadedSync("name")) load.ok = false;
    if (!files.isColumnLoadedSync("relativePath")) load.ok = false;
    if (!files.isColumnLoadedSync("addedAt")) load.ok = false;
    if (!files.isColumnLoadedSync("fileModifiedAt")) load.ok = false;
    if ((durationActive || sortOrder === "duration") && !files.isColumnLoadedSync("durationSec")) load.ok = false;
    if (sortOrder === "watched" && !files.isColumnLoadedSync("positionUpdatedAt")) load.ok = false;
    if ((sf || filterFaces) && !files.isColumnLoadedSync("characterCount")) load.ok = false;
    if (filterErrors && !files.isColumnLoadedSync("extractionError")) load.ok = false;
    if (filterKeyframes && !keyframesDb.isColumnLoadedSync("keyframesVersion")) load.ok = false;

    const nameByKey = new Map<string, string>();
    if (nameCol) for (const { key, value } of nameCol) nameByKey.set(key, value as string);
    const pathByKey = new Map<string, string>();
    if (pathCol) for (const { key, value } of pathCol) pathByKey.set(key, value as string);
    const modByKey = new Map<string, number>();
    if (modCol) for (const { key, value } of modCol) modByKey.set(key, (value as number) || 0);
    const durationByKey = new Map<string, number>();
    if (durationCol) for (const { key, value } of durationCol) durationByKey.set(key, (value as number) || 0);
    const watchedByKey = new Map<string, number>();
    if (watchedCol) for (const { key, value } of watchedCol) watchedByKey.set(key, (value as number) || 0);
    const totalFiles = nameByKey.size;

    // Series detection over the whole library (cached in series.ts).
    const seriesInput: SeriesVideo[] = [];
    for (const [key, name] of nameByKey) {
        const relativePath = pathByKey.get(key);
        if (!relativePath) continue;
        seriesInput.push({ key, name, relativePath });
    }
    const seriesMap = getSeries(seriesInput, seriesMin);

    let candidateKeys: string[] = [];
    for (const key of nameByKey.keys()) {
        if (pathByKey.has(key)) candidateKeys.push(key);
    }
    if (query.trim()) {
        // If the query matches a tag's name, every video in that tag is a hit —
        // even when its path doesn't contain the query text.
        const taggedKeys = new Set<string>();
        for (const list of getListsSync()) {
            if (!matchFilter({ value: query }, list.name)) continue;
            for (const m of getListMembersSync(list.key)) {
                if (m.itemType === "video") taggedKeys.add(m.itemKey);
            }
        }
        candidateKeys = candidateKeys.filter(key =>
            taggedKeys.has(key) || matchFilter({ value: query }, pathByKey.get(key) || ""));
    }
    if (durationActive) {
        // Bounds are in minutes; durations are in seconds. A file with no known
        // duration (0 / missing) is excluded whenever any bound is set.
        const minSec = durationMin !== undefined ? durationMin * 60 : undefined;
        const maxSec = durationMax !== undefined ? durationMax * 60 : undefined;
        candidateKeys = candidateKeys.filter(key => {
            const d = durationByKey.get(key) || 0;
            if (d <= 0) return false;
            if (minSec !== undefined && d < minSec) return false;
            if (maxSec !== undefined && d > maxSec) return false;
            return true;
        });
    }
    // Each attribute filter keeps keys whose "has X" membership matches; with
    // filterInvert on, it keeps the complement instead ("no X").
    const keepBy = (has: (key: string) => boolean) =>
        candidateKeys.filter(key => has(key) !== filterInvert);
    if (filterErrors) {
        // A file "has an error" when its last extraction left a non-empty
        // message ("" = cleared by a later success, undefined = never failed).
        const errSet = new Set<string>();
        if (errorCol) for (const { key, value } of errorCol) {
            if (typeof value === "string" && value !== "") errSet.add(key);
        }
        candidateKeys = keepBy(key => errSet.has(key));
    }
    if (filterFaces) {
        // A file "has faces" when its detected-character count is > 0. This
        // reads the cheap, already-loaded characterCount column.
        const countByKey = new Map<string, number>();
        if (charCountCol) for (const { key, value } of charCountCol) countByKey.set(key, (value as number) || 0);
        candidateKeys = keepBy(key => (countByKey.get(key) || 0) > 0);
    }
    if (filterKeyframes) {
        // A file "has keyframes" when its last extraction reached the current
        // version (older/failed/never-run files are excluded).
        const kfSet = new Set<string>();
        if (keyframeVersionCol) for (const { key, value } of keyframeVersionCol) {
            if (value === KEYFRAMES_VERSION) kfSet.add(key);
        }
        candidateKeys = keepBy(key => kfSet.has(key));
    }

    const sortMod = (key: string) => modByKey.get(key) || 0;
    const sortDur = (key: string) => durationByKey.get(key) || 0;
    const sortWatched = (key: string) => watchedByKey.get(key) || 0;

    // Collapse into series tiles only in the grouping modes. A series tile
    // takes the sort position of its newest matching member, so it lands
    // exactly where that member would have.
    const collapses = mode === "hybrid" || mode === "movies" || mode === "series";
    const seriesByKey = new Map<string, SeriesGroup>();
    if (collapses) for (const g of seriesMap.values()) for (const v of g.videos) seriesByKey.set(v.key, g);

    // Series tiles sort by their folder name; video tiles by their filename.
    const sortName = (key: string) => nameByKey.get(key) || "";

    // sortHash is the shuffle position: hash(tile key + seed). For a series tile
    // the key is its parentPath, so the whole series moves as one unit.
    const sortHash = (key: string) => hashString(key + shuffleSeed);
    type SortTile = { key: string; sortMod: number; sortDur: number; sortWatched: number; sortName: string; sortHash: number };
    const tiles: SortTile[] = [];
    const seriesTileByPath = new Map<string, SortTile>();
    // The matching file keys represented by the shown tiles (a series tile
    // contributes only its members that survived the filter). This is what
    // "delete all" deletes — never the whole series folder.
    const flatKeys: string[] = [];
    for (const key of candidateKeys) {
        const group = collapses ? seriesByKey.get(key) : undefined;
        if (group) {
            if (mode === "movies") continue;
            flatKeys.push(key);
            const m = sortMod(key), du = sortDur(key), w = sortWatched(key);
            const tile = seriesTileByPath.get(group.parentPath);
            if (tile) {
                // The series tile floats to its newest member's position in
                // every dimension (max mtime for date, longest member for
                // duration, most recently watched member for watched), so each
                // sort lands it correctly.
                if (m > tile.sortMod) tile.sortMod = m;
                if (du > tile.sortDur) tile.sortDur = du;
                if (w > tile.sortWatched) tile.sortWatched = w;
                continue;
            }
            // A series tile carries its parentPath as the key — the caller
            // resolves it back through seriesMap.
            const newTile: SortTile = { key: group.parentPath, sortMod: m, sortDur: du, sortWatched: w, sortName: group.folderName, sortHash: sortHash(group.parentPath) };
            seriesTileByPath.set(group.parentPath, newTile);
            tiles.push(newTile);
        } else {
            if (mode === "series") continue;
            flatKeys.push(key);
            tiles.push({ key, sortMod: sortMod(key), sortDur: sortDur(key), sortWatched: sortWatched(key), sortName: sortName(key), sortHash: sortHash(key) });
        }
    }

    const compare =
        sortOrder === "shuffle"
            ? (a: SortTile, b: SortTile) => a.sortHash - b.sortHash || a.sortName.localeCompare(b.sortName)
            : sortOrder === "name"
            ? (a: SortTile, b: SortTile) => a.sortName.localeCompare(b.sortName)
            : sortOrder === "duration"
            ? (a: SortTile, b: SortTile) => b.sortDur - a.sortDur || a.sortName.localeCompare(b.sortName)
            : sortOrder === "watched"
            // Most recently watched first; never-played (0) sinks to the end.
            ? (a: SortTile, b: SortTile) => b.sortWatched - a.sortWatched || a.sortName.localeCompare(b.sortName)
            // date (default): newest file mtime first.
            : (a: SortTile, b: SortTile) => b.sortMod - a.sortMod || a.sortName.localeCompare(b.sortName);
    tiles.sort(compare);
    if (sortReversed) tiles.reverse();

    const keys: SearchKey[] = tiles.map(t => ({ key: t.key }));
    const sortValues: SortValue[] = tiles.map(t => ({ name: t.sortName, modified: t.sortMod, duration: t.sortDur, watched: t.sortWatched }));
    const result: SearchResult = { keys, seriesMap, totalFiles, sortValues, flatKeys, loading: !load.ok };
    filteredCache = load.ok
        ? { mode, query, showFaces: sf, sortOrder, sortReversed, shuffleSeed, durationMin, durationMax, filterErrors, filterKeyframes, filterFaces, filterInvert, seriesMin, nameCol, pathCol, modCol, durationCol, watchedCol, charCountCol, errorCol, keyframeVersionCol, listNameCol, membershipCol, result }
        : undefined;
    lastUncachedSearchMs = performance.now() - t0;
    if (lastUncachedSearchMs > SEARCH_LOG_MIN_MS) console.log(`[search] filtered core: ${keys.length} keys in ${lastUncachedSearchMs.toFixed(2)}ms${load.ok ? "" : " (data still loading — not cached)"}`);
    return result;
}

type TopFrame = { keyframeIndex: number; timeMs: number; distance: number };

// A character source's top-3 frames closest to the search embedding. Reads the
// (heavy) per-character frame fields once. `loaded` is false if ANY field it
// touches is still streaming — the caller must not cache the result in that
// case (an absent field reads as loaded=true, so a source that genuinely has
// no frames still caches its empty result). Marks the load flag through `load`.
function computeTopFrames(charKey: string, search: Float32Array, load: { ok: boolean }): TopFrame[] {
    if (!faceFrames.isFieldLoadedSync(charKey, "embeddings")) load.ok = false;
    if (!faceFrames.isFieldLoadedSync(charKey, "embeddingCount")) load.ok = false;
    if (!faceFrames.isFieldLoadedSync(charKey, "frameTimes")) load.ok = false;
    const embeddings = faceFrames.getSingleFieldSync(charKey, "embeddings");
    if (!embeddings) return [];
    const count = faceFrames.getSingleFieldSync(charKey, "embeddingCount") ?? 0;
    const frameTimes = faceFrames.getSingleFieldSync(charKey, "frameTimes");
    const scored: TopFrame[] = [];
    for (let i = 0; i < count; i++) {
        const slice = embeddings.subarray(i * EMBEDDING_FLOATS, (i + 1) * EMBEDDING_FLOATS);
        scored.push({ keyframeIndex: i, timeMs: frameTimes ? frameTimes[i] : 0, distance: l2Distance(slice, search) });
    }
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, 3);
}

// ────────────────────────────────────────────────────────────────────────────
// rehydrate() — turn the (already limited) key window into render-ready tiles
// by reading the few file fields each tile needs.

// The few file fields a video tile needs. Undefined while the record is still
// loading (e.g. a key that hasn't streamed its columns in yet).
export function hydrateKey(key: string): Pick<FileRecord, "key" | "name" | "relativePath" | "size"> | undefined {
    const name = files.getSingleFieldSync(key, "name");
    const relativePath = files.getSingleFieldSync(key, "relativePath");
    if (name === undefined || relativePath === undefined) return undefined;
    return { key, name, relativePath, size: files.getSingleFieldSync(key, "size") };
}

export function rehydrate(keys: SearchKey[], seriesMap: Map<string, SeriesGroup>, config?: { highlightedKey?: string }): Tile[] {
    const t0 = performance.now();
    const highlightedKey = config?.highlightedKey;
    const out: Tile[] = keys.map(k => {
        const series = seriesMap.get(k.key);
        if (series) return { type: "series", series };
        if (k.frame) {
            const frameTimes = faceFrames.getSingleFieldSync(k.frame.characterKey, "frameTimes");
            const timeMs = frameTimes ? frameTimes[k.frame.keyframeIndex] || 0 : 0;
            return {
                type: "frame",
                fileKey: k.key,
                fileName: files.getSingleFieldSync(k.key, "name") || "",
                relativePath: files.getSingleFieldSync(k.key, "relativePath") || "",
                timeMs,
                characterKey: k.frame.characterKey,
                distance: k.distance ?? 0,
            };
        }
        const record = hydrateKey(k.key) ?? { key: k.key, name: "", relativePath: "", size: undefined };
        return { type: "video", record, highlighted: highlightedKey === k.key };
    });
    const rehydrateMs = performance.now() - t0;
    if (rehydrateMs > SEARCH_LOG_MIN_MS) console.log(`[search] rehydrate: ${out.length} tiles in ${rehydrateMs.toFixed(2)}ms`);
    return out;
}
