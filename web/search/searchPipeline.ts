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
import { observable, runInAction } from "mobx";
import {
    showFaces,
    getClosestCharactersByFileAsync,
    yieldIfBlocked,
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
    embCol: unknown;
    memberCol: unknown;
    nameCol: unknown;
    result: SearchResult;
} | undefined;

// Per-source top-frame cache for per-frame face search. Each character source
// keeps only its top-3 frames (already scored against the search embedding).
// Keyed by the face query string — a new search makes every distance stale.
let frameSourceCache: { query: string; perSource: Map<string, TopFrame[]> } | undefined;

// ── Background face-search job ──────────────────────────────────────────────
// Scoring every character (and, per-frame, every stored frame) against the
// search embedding can take whole seconds on a big library, so the heavy work
// runs in a time-sliced async job instead of inside render. faceSearch()
// derives a (partial) result from whatever the job has produced so far; the
// job bumps `faceSearchTick` at every yield so renders pick up new results as
// they stream in, and `faceSearchProgress` drives the UI's progress display.
// A job is cancelled by bumping faceJobSession — it polls at every yield.

let faceJobSession = 0;
let faceJob: {
    session: number;
    query: string;
    perFrame: boolean;
    showAll: boolean;
    refreshGen: number;
    // Whether the character collection had any data when this job started.
    // Gates the stale-instead-of-rerun behavior below: a job over an empty
    // collection (initial column streaming) still auto-reruns as data lands.
    hadData: boolean;
    embCol: unknown;
    memberCol: unknown;
    nameCol: unknown;
    // Filled in place while the job runs (partial until `done`).
    distances: Map<string, { distance: number; characterIdx: number; memberCount: number }>;
    frameEntries: SearchKey[];
    done: boolean;
} | undefined;

const faceSearchTick = observable.box(0);
export const faceSearchProgress = observable.box<
    { phase: "characters" | "frames"; done: number; total: number } | undefined
>(undefined);

// The face DB changed under a completed search that had real data. We do NOT
// silently re-score — another tab ingesting faces would keep a search
// re-running forever. The UI shows an out-of-date notice with a refresh
// button (refreshFaceSearch) instead.
export const faceSearchStale = observable.box(false);
let faceRefreshGen = 0;
export function refreshFaceSearch(): void {
    faceRefreshGen++;
    runInAction(() => {
        faceSearchStale.set(false);
        faceSearchTick.set(faceSearchTick.get() + 1);
    });
}

// The last fully-computed result per query. When a job restarts because the
// underlying columns changed (files/characters landed mid-search), the fresh
// job starts from zero — showing its near-empty partials would clobber a
// perfectly good result the user is looking at. Instead we keep returning
// the previous complete result (marked loading) until the new job's results
// grow past it or the job finishes. Never flash empty over stale-but-useful.
let lastFaceResult: { query: string; perFrame: boolean; result: SearchResult } | undefined;

async function runFaceJob(job: NonNullable<typeof faceJob>, fsSpec: Float32Array): Promise<void> {
    const cancelled = () => job.session !== faceJobSession;
    const bump = () => runInAction(() => faceSearchTick.set(faceSearchTick.get() + 1));
    const t0 = performance.now();
    try {
        const map = await getClosestCharactersByFileAsync(fsSpec, {
            shouldCancel: cancelled,
            sink: job.distances,
            onProgress: (done, total) => {
                runInAction(() => faceSearchProgress.set({ phase: "characters", done, total }));
                bump();
            },
        });
        if (!map || cancelled()) return;

        if (job.perFrame) {
            let cache = frameSourceCache;
            if (!cache || cache.query !== job.query) {
                cache = { query: job.query, perSource: new Map() };
                frameSourceCache = cache;
            }
            const sources: { fileKey: string; charKey: string }[] = [];
            for (const [fileKey, match] of job.distances) {
                if (!job.showAll && match.distance >= SAME_CHARACTER_THRESHOLD) continue;
                sources.push({ fileKey, charKey: characterKey(fileKey, match.characterIdx) });
            }
            const slice = { start: performance.now() };
            for (let i = 0; i < sources.length; i++) {
                const { fileKey, charKey: ck } = sources[i];
                let top = cache.perSource.get(ck);
                if (!top) {
                    top = await computeTopFrames(ck, fsSpec, slice, cancelled);
                    if (!top) return; // cancelled
                    cache.perSource.set(ck, top);
                }
                for (const f of top) {
                    job.frameEntries.push({ key: fileKey, distance: f.distance, frame: { keyframeIndex: f.keyframeIndex, characterKey: ck } });
                }
                if (await yieldIfBlocked(slice)) {
                    if (cancelled()) return;
                    runInAction(() => faceSearchProgress.set({ phase: "frames", done: i + 1, total: sources.length }));
                    bump();
                }
            }
        }
        if (cancelled()) return;
        job.done = true;
        const ms = performance.now() - t0;
        if (ms > SEARCH_LOG_MIN_MS) console.log(`[search] face job: ${job.perFrame ? job.frameEntries.length : job.distances.size} entries in ${ms.toFixed(0)}ms`);
    } catch (err) {
        // Mark done so the UI shows whatever we have instead of "loading" forever.
        console.warn(`[search] face job failed:`, err);
        job.done = true;
    } finally {
        if (!cancelled()) {
            runInAction(() => faceSearchProgress.set(undefined));
            bump();
        }
    }
}

function faceSearch(fsSpec: Float32Array, query: string, perFrame: boolean): SearchResult {
    const embCol = characters.getColumnSync("bestFaceEmbedding");
    const memberCol = characters.getColumnSync("memberCount");
    const nameCol = files.getColumnSync("name");
    // Default: only files whose closest character is within the closeness
    // threshold. The "Only close matches" checkbox (faceShowAll URL param)
    // flips this to include every file ranked by its closest character.
    const showAll = faceShowAll.get();
    // Face-count sort only makes sense within the closeness threshold — with
    // every distant match included, "most faces" surfaces big characters that
    // don't look like the query at all. So when not filtering to close
    // matches, force distance sort (the UI hides the selector to match).
    const sort = showAll ? "distance" : faceSort.get();
    // Subscribe to job progress so partial results re-render as they stream in.
    faceSearchTick.get();

    const cached = faceCache;
    if (cached
        && cached.query === query
        && cached.perFrame === perFrame
        && cached.showAll === showAll
        && cached.sort === sort
        && cached.embCol === embCol
        && cached.memberCol === memberCol
        && cached.nameCol === nameCol) {
        return cached.result;
    }

    // (Re)start the background job whenever an input it depends on changed.
    // Sort is NOT a job input — it only affects the ordering derived below.
    let needNewJob = !faceJob
        || faceJob.query !== query
        || faceJob.perFrame !== perFrame
        || faceJob.showAll !== showAll
        || faceJob.refreshGen !== faceRefreshGen;
    if (!needNewJob && faceJob
        && (faceJob.embCol !== embCol || faceJob.memberCol !== memberCol || faceJob.nameCol !== nameCol)) {
        // Face data changed under an unchanged search. If the search already
        // ran over real data, don't silently re-score (another tab ingesting
        // faces would make this loop forever) — flag stale and let the user
        // refresh. Adopt the new column refs as the job's identity so the
        // derive cache below keeps hitting.
        if (faceJob.hadData) {
            if (!faceSearchStale.get()) runInAction(() => faceSearchStale.set(true));
            faceJob.embCol = embCol;
            faceJob.memberCol = memberCol;
            faceJob.nameCol = nameCol;
        } else {
            needNewJob = true;
        }
    }
    if (needNewJob) {
        faceJobSession++;
        if (faceSearchStale.get()) runInAction(() => faceSearchStale.set(false));
        console.log(`[search] face job start (perFrame=${perFrame}, showAll=${showAll})`);
        const job = faceJob = {
            session: faceJobSession, query, perFrame, showAll,
            refreshGen: faceRefreshGen,
            hadData: !!embCol && (embCol as { length: number }).length > 0,
            embCol, memberCol, nameCol,
            distances: new Map(), frameEntries: [], done: false,
        };
        void runFaceJob(job, fsSpec);
    }
    // needNewJob just assigned faceJob when it was unset, so it's never
    // undefined here — TS just can't see through the boolean.
    const job = faceJob!;

    // Derive the ordered result from whatever the job has so far. Cheap
    // relative to the scoring itself (O(matches log matches)), so doing it
    // per streamed tick keeps the grid live without re-blocking the UI.
    const t0 = performance.now();
    const totalFiles = nameCol ? nameCol.length : 0;
    // "count" (default): ordered by the matched character's memberCount (most
    // first), distance breaking ties so equally-prominent characters fall
    // closest-match first. "distance": closest match first, memberCount
    // breaking ties.
    const memberCountOf = (fileKey: string) => job.distances.get(fileKey)?.memberCount ?? 0;
    const byMembers = (a: SearchKey, b: SearchKey) =>
        (memberCountOf(b.key) - memberCountOf(a.key)) || ((a.distance ?? 0) - (b.distance ?? 0));
    const byDistance = (a: SearchKey, b: SearchKey) =>
        ((a.distance ?? 0) - (b.distance ?? 0)) || (memberCountOf(b.key) - memberCountOf(a.key));
    const byActiveSort = sort === "distance" ? byDistance : byMembers;

    let keys: SearchKey[];
    if (perFrame) {
        keys = [...job.frameEntries];
    } else {
        keys = [];
        for (const [fileKey, match] of job.distances) {
            if (!showAll && match.distance >= SAME_CHARACTER_THRESHOLD) continue;
            keys.push({ key: fileKey, distance: match.distance });
        }
    }
    keys.sort(byActiveSort);

    // Columns still streaming in also count as "loading" — when they finish,
    // their reference changes and the job restarts over the complete data.
    const load = { ok: true };
    if (!characters.isColumnLoadedSync("bestFaceEmbedding")) load.ok = false;
    if (!characters.isColumnLoadedSync("memberCount")) load.ok = false;
    if (!files.isColumnLoadedSync("name")) load.ok = false;

    // Per-frame search repeats a file key once per matched frame; dedup so the
    // flat set is one entry per file.
    const flatKeys = [...new Set(keys.map(k => k.key))];
    const result: SearchResult = { keys, seriesMap: new Map(), totalFiles, flatKeys, loading: !job.done || !load.ok };
    // Only cache the final, fully-loaded result — partial derives are rebuilt
    // on every tick until the job completes.
    if (job.done && load.ok) {
        faceCache = { query, perFrame, showAll, sort, embCol, memberCol, nameCol, result };
    }
    lastUncachedSearchMs = performance.now() - t0;
    if (lastUncachedSearchMs > SEARCH_LOG_MIN_MS) console.log(`[search] face derive: ${keys.length} keys in ${lastUncachedSearchMs.toFixed(2)}ms`);
    if (!result.loading) {
        lastFaceResult = { query, perFrame, result };
    } else if (lastFaceResult
        && lastFaceResult.query === query
        && lastFaceResult.perFrame === perFrame
        && lastFaceResult.result.keys.length > keys.length) {
        // Same search, restarted job (data refresh): the previous complete
        // result is richer than what the new job has produced so far — keep
        // showing it, flagged loading, until the fresh results overtake it.
        return { ...lastFaceResult.result, loading: true };
    }
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

// A character source's top-3 frames closest to the search embedding. Awaited
// field reads (so mid-stream data resolves instead of being skipped) and
// time-sliced via the caller's shared slice. Returns undefined on cancel.
async function computeTopFrames(
    charKey: string,
    search: Float32Array,
    slice: { start: number },
    cancelled: () => boolean,
): Promise<TopFrame[] | undefined> {
    const embeddings = await faceFrames.getSingleField(charKey, "embeddings");
    if (cancelled()) return undefined;
    if (!embeddings) return [];
    const count = (await faceFrames.getSingleField(charKey, "embeddingCount")) ?? 0;
    const frameTimes = await faceFrames.getSingleField(charKey, "frameTimes");
    if (cancelled()) return undefined;
    const scored: TopFrame[] = [];
    for (let i = 0; i < count; i++) {
        const emb = embeddings.subarray(i * EMBEDDING_FLOATS, (i + 1) * EMBEDDING_FLOATS);
        scored.push({ keyframeIndex: i, timeMs: frameTimes ? frameTimes[i] : 0, distance: l2Distance(emb, search) });
        if (await yieldIfBlocked(slice)) {
            if (cancelled()) return undefined;
        }
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
