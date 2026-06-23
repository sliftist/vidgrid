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
} from "../appState";
import { matchFilter } from "./matchFilter";
import { getSeries, SeriesGroup, SeriesVideo } from "./series";
import { lists as listsDb, listMemberships, getListsSync, getListMembersSync } from "../lists/lists";
import {
    showFaces,
    getClosestCharactersByFileSync,
    SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { l2Distance } from "../faceEmbed/arcface";
import { startOfDay } from "./gridShared";

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
// `added` is its addedAt (ingest) timestamp; `modified` is its file mtime.
// Only the filtered path produces these.
export type SortValue = { name: string; added: number; modified: number };

export type SearchResult = {
    keys: SearchKey[];
    // Only the filtered (non-face) path populates this; the caller uses it to
    // tell a series tile (key === parentPath) from a video tile and to drill
    // into a series. File keys are encodeURIComponent(path) so they never
    // collide with a raw parentPath.
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

export function search(config: { mode: DisplayMode; query: string; fsSpec: Float32Array | undefined; perFrame: boolean; sortOrder: SortOrder; sortReversed: boolean; durationMinMinutes?: number; durationMaxMinutes?: number; errorOnly?: boolean }): SearchResult {
    // Face search has its own intrinsic order (closest first); the user's sort
    // controls only apply to the filtered (library-browsing) path.
    if (config.fsSpec) return faceSearch(config.fsSpec, config.query, config.perFrame);
    return filteredSearch({ mode: config.mode, query: config.query, sortOrder: config.sortOrder, sortReversed: config.sortReversed, durationMinMinutes: config.durationMinMinutes, durationMaxMinutes: config.durationMaxMinutes, errorOnly: config.errorOnly });
}

// Duration of the last core search that actually ran (cache miss). Held so the
// UI can show "how expensive is the real work", not the near-zero cached time.
let lastUncachedSearchMs = 0;
export function getLastUncachedSearchMs(): number {
    return lastUncachedSearchMs;
}

let faceCache: {
    query: string;
    perFrame: boolean;
    centroidCol: unknown;
    nameCol: unknown;
    result: SearchResult;
} | undefined;

// Per-source top-frame cache for per-frame face search. Each character source
// keeps only its top-3 frames (already scored against the search embedding).
// Keyed by the face query string — a new search makes every distance stale.
let frameSourceCache: { query: string; perSource: Map<string, TopFrame[]> } | undefined;

function faceSearch(fsSpec: Float32Array, query: string, perFrame: boolean): SearchResult {
    const centroidCol = characters.getColumnSync("centroid");
    const nameCol = files.getColumnSync("name");

    const cached = faceCache;
    if (cached) {
        const reason =
            cached.query !== query ? "query" :
            cached.perFrame !== perFrame ? "perFrame" :
            cached.centroidCol !== centroidCol ? "character data changed" :
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
    if (!files.isColumnLoadedSync("name")) load.ok = false;

    const totalFiles = nameCol ? nameCol.length : 0;
    const faceDistances = getClosestCharactersByFileSync(fsSpec);

    let keys: SearchKey[];
    if (perFrame) {
        let cache = frameSourceCache;
        if (!cache || cache.query !== query) {
            cache = { query, perSource: new Map() };
            frameSourceCache = cache;
        }
        keys = [];
        for (const [fileKey, match] of faceDistances) {
            if (match.distance >= SAME_CHARACTER_THRESHOLD) continue;
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
        keys.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    } else {
        keys = [];
        for (const [fileKey, match] of faceDistances) {
            keys.push({ key: fileKey, distance: match.distance });
        }
        keys.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    }

    // Per-frame search repeats a file key once per matched frame; dedup so the
    // flat set is one entry per file.
    const flatKeys = [...new Set(keys.map(k => k.key))];
    const result: SearchResult = { keys, seriesMap: new Map(), totalFiles, flatKeys };
    // Only cache a fully-loaded result. Leaving faceCache unset forces the next
    // render to recompute, which re-reads (and re-observes) the still-loading
    // fields — so the moment they finish, the result refreshes and caches.
    faceCache = load.ok ? { query, perFrame, centroidCol, nameCol, result } : undefined;
    lastUncachedSearchMs = performance.now() - t0;
    console.log(`[search] face core: ${keys.length} keys in ${lastUncachedSearchMs.toFixed(2)}ms${load.ok ? "" : " (data still loading — not cached)"}`);
    return result;
}

let filteredCache: {
    mode: DisplayMode;
    query: string;
    showFaces: boolean;
    sortOrder: SortOrder;
    sortReversed: boolean;
    durationMin: number | undefined;
    durationMax: number | undefined;
    errorOnly: boolean;
    seriesMin: number;
    nameCol: unknown;
    pathCol: unknown;
    addedCol: unknown;
    modCol: unknown;
    durationCol: unknown;
    charCountCol: unknown;
    errorCol: unknown;
    listNameCol: unknown;
    membershipCol: unknown;
    result: SearchResult;
} | undefined;

function filteredSearch(config: { mode: DisplayMode; query: string; sortOrder: SortOrder; sortReversed: boolean; durationMinMinutes?: number; durationMaxMinutes?: number; errorOnly?: boolean }): SearchResult {
    const { mode, query, sortOrder, sortReversed } = config;
    const durationMin = config.durationMinMinutes;
    const durationMax = config.durationMaxMinutes;
    const durationActive = durationMin !== undefined || durationMax !== undefined;
    const errorOnly = config.errorOnly ?? false;
    const seriesMin = seriesMinVideos.get();
    const sf = showFaces.get();

    const nameCol = files.getColumnSync("name");
    const pathCol = files.getColumnSync("relativePath");
    const addedCol = files.getColumnSync("addedAt");
    const modCol = files.getColumnSync("fileModifiedAt");
    const durationCol = durationActive ? files.getColumnSync("durationSec") : undefined;
    const charCountCol = sf ? files.getColumnSync("characterCount") : undefined;
    const errorCol = errorOnly ? files.getColumnSync("extractionError") : undefined;
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
            cached.durationMin !== durationMin ? "durationMin" :
            cached.durationMax !== durationMax ? "durationMax" :
            cached.errorOnly !== errorOnly ? "errorOnly" :
            cached.seriesMin !== seriesMin ? "seriesMin" :
            cached.errorCol !== errorCol ? "errors changed" :
            cached.nameCol !== nameCol ? "files added/removed" :
            cached.pathCol !== pathCol ? "paths changed" :
            cached.addedCol !== addedCol ? "addedAt changed" :
            cached.modCol !== modCol ? "modified times changed" :
            cached.durationCol !== durationCol ? "durations changed" :
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
    if (durationActive && !files.isColumnLoadedSync("durationSec")) load.ok = false;
    if (sf && !files.isColumnLoadedSync("characterCount")) load.ok = false;
    if (errorOnly && !files.isColumnLoadedSync("extractionError")) load.ok = false;

    const nameByKey = new Map<string, string>();
    if (nameCol) for (const { key, value } of nameCol) nameByKey.set(key, value as string);
    const pathByKey = new Map<string, string>();
    if (pathCol) for (const { key, value } of pathCol) pathByKey.set(key, value as string);
    const addedByKey = new Map<string, number>();
    if (addedCol) for (const { key, value } of addedCol) addedByKey.set(key, (value as number) || 0);
    const modByKey = new Map<string, number>();
    if (modCol) for (const { key, value } of modCol) modByKey.set(key, (value as number) || 0);
    const durationByKey = new Map<string, number>();
    if (durationCol) for (const { key, value } of durationCol) durationByKey.set(key, (value as number) || 0);
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
    if (errorOnly) {
        // A file "has an error" when its last extraction left a non-empty
        // message ("" = cleared by a later success, undefined = never failed).
        const errSet = new Set<string>();
        if (errorCol) for (const { key, value } of errorCol) {
            if (typeof value === "string" && value !== "") errSet.add(key);
        }
        candidateKeys = candidateKeys.filter(key => errSet.has(key));
    }

    // Face mode without an active search floats files that have at least one
    // detected character to the front.
    let facesSet: Set<string> | undefined;
    if (sf && charCountCol) {
        facesSet = new Set<string>();
        for (const { key, value } of charCountCol) {
            if (typeof value === "number" && value > 0) facesSet.add(key);
        }
    }

    const sortFace = (key: string) => facesSet && facesSet.has(key) ? 1 : 0;
    const sortDay = (key: string) => startOfDay(addedByKey.get(key) || 0);
    const sortMod = (key: string) => modByKey.get(key) || 0;
    const sortAdded = (key: string) => addedByKey.get(key) || 0;

    // Collapse into series tiles only in the grouping modes. A series tile
    // takes the sort position of its newest matching member, so it lands
    // exactly where that member would have.
    const collapses = mode === "hybrid" || mode === "movies" || mode === "series";
    const seriesByKey = new Map<string, SeriesGroup>();
    if (collapses) for (const g of seriesMap.values()) for (const v of g.videos) seriesByKey.set(v.key, g);

    // Series tiles sort by their folder name; video tiles by their filename.
    const sortName = (key: string) => nameByKey.get(key) || "";

    type SortTile = { key: string; sortFace: number; sortDay: number; sortMod: number; sortAdded: number; sortName: string };
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
            const f = sortFace(key), d = sortDay(key), m = sortMod(key), ad = sortAdded(key);
            const tile = seriesTileByPath.get(group.parentPath);
            if (tile) {
                // The series tile floats to its newest member's position in
                // every dimension (face-first day for unified, max mtime for
                // date, max ingest as well), so each sort lands it correctly.
                if (f > tile.sortFace || f === tile.sortFace && d > tile.sortDay) {
                    tile.sortFace = f; tile.sortDay = d;
                }
                if (m > tile.sortMod) tile.sortMod = m;
                if (ad > tile.sortAdded) tile.sortAdded = ad;
                continue;
            }
            // A series tile carries its parentPath as the key — the caller
            // resolves it back through seriesMap.
            const newTile: SortTile = { key: group.parentPath, sortFace: f, sortDay: d, sortMod: m, sortAdded: ad, sortName: group.folderName };
            seriesTileByPath.set(group.parentPath, newTile);
            tiles.push(newTile);
        } else {
            if (mode === "series") continue;
            flatKeys.push(key);
            tiles.push({ key, sortFace: sortFace(key), sortDay: sortDay(key), sortMod: sortMod(key), sortAdded: sortAdded(key), sortName: sortName(key) });
        }
    }

    const compare =
        sortOrder === "name"
            ? (a: SortTile, b: SortTile) => a.sortName.localeCompare(b.sortName)
            : sortOrder === "date"
                ? (a: SortTile, b: SortTile) => b.sortMod - a.sortMod || a.sortName.localeCompare(b.sortName)
                : (a: SortTile, b: SortTile) => {
                    if (a.sortFace !== b.sortFace) return b.sortFace - a.sortFace;
                    if (a.sortDay !== b.sortDay) return b.sortDay - a.sortDay;
                    return b.sortMod - a.sortMod;
                };
    tiles.sort(compare);
    if (sortReversed) tiles.reverse();

    const keys: SearchKey[] = tiles.map(t => ({ key: t.key }));
    const sortValues: SortValue[] = tiles.map(t => ({ name: t.sortName, added: t.sortAdded, modified: t.sortMod }));
    const result: SearchResult = { keys, seriesMap, totalFiles, sortValues, flatKeys };
    filteredCache = load.ok
        ? { mode, query, showFaces: sf, sortOrder, sortReversed, durationMin, durationMax, errorOnly, seriesMin, nameCol, pathCol, addedCol, modCol, durationCol, charCountCol, errorCol, listNameCol, membershipCol, result }
        : undefined;
    lastUncachedSearchMs = performance.now() - t0;
    console.log(`[search] filtered core: ${keys.length} keys in ${lastUncachedSearchMs.toFixed(2)}ms${load.ok ? "" : " (data still loading — not cached)"}`);
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
    console.log(`[search] rehydrate: ${out.length} tiles in ${(performance.now() - t0).toFixed(2)}ms`);
    return out;
}
