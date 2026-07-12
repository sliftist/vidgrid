// Face-based scenes. Builds, at read time, a per-file view of "scenes" — spans
// of the video defined by face continuity — and lets the player highlight and
// play only the scenes containing a chosen set of faces.
//
// The stored per-file characters come out of a greedy online clusterer, so the
// same person is occasionally split across two character records. Newer
// extractions get a consolidation pass (see faceEmbed/clustering.mergeClusters),
// but data extracted earlier does not — so we ALSO merge here, at read time, so
// scenes see one group per person regardless of when the file was scanned.
//
// A "selection" is a set of source character keys. On the file they came from
// each key resolves to its own group; on a sibling video in the same series it
// resolves to whichever local group its face matches (within the same-character
// threshold), so a selection made on episode 1 keeps working on episode 2.

import { runInAction } from "mobx";
import { characters, faceFrames, files, seriesMinVideos } from "../appState";
import { getCharacterKeysForFileSync } from "./faceSearch";
import { l2Distance } from "../faceEmbed/arcface";
import { SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";
import { getSeries, SeriesVideo } from "../search/series";
import { selectedFaces, sceneGapSec } from "../router";

// Default max gap (seconds) between two IN-SCENE faces before the scene is
// considered over. Faces are only sampled at keyframes and only when a face is
// actually detected, so a person can vanish for a long stretch mid-scene
// (turned away, dark shot, cutaways). The user can tune this in the scenes
// modal; the live value comes from the URL (see sceneGapSec).
export const DEFAULT_SCENE_GAP_SEC = 180;

function sceneGapMs(): number {
    const s = sceneGapSec.value;
    return (typeof s === "number" && s > 0 ? s : DEFAULT_SCENE_GAP_SEC) * 1000;
}

// ─────────────────────────────────────────────────────────────────────
// Key helpers. A character key is `${fileKey}#${paddedIdx}`; fileKey may
// itself contain '#', so always split on the LAST one.

export function fileKeyOfCharacter(characterKey: string): string {
    const hash = characterKey.lastIndexOf("#");
    return hash >= 0 ? characterKey.slice(0, hash) : characterKey;
}

function parentOf(fileKey: string): string {
    const slash = fileKey.lastIndexOf("/");
    return slash >= 0 ? fileKey.slice(0, slash) : "";
}

// The set of folder paths that qualify as a series (same rules as the grid).
// Reads the file name column reactively, so callers inside a render/reaction
// recompute when the library changes. getSeries caches on the path set.
function seriesParentsSync(): Set<string> {
    const nameCol = files.getColumnSync("name");
    const input: SeriesVideo[] = [];
    if (nameCol) {
        for (const { key, value } of nameCol) {
            input.push({ key, name: (value as string) ?? key, relativePath: key });
        }
    }
    return new Set(getSeries(input, seriesMinVideos.get()).keys());
}

// Two files are "the same series" when they sit directly in the same folder and
// that folder is a detected series. A file is trivially in its own series.
export function sameSeries(a: string, b: string): boolean {
    if (a === b) return true;
    const pa = parentOf(a);
    if (!pa || pa !== parentOf(b)) return false;
    return seriesParentsSync().has(pa);
}

// ─────────────────────────────────────────────────────────────────────
// Merged per-file face view.

export interface MergedGroup {
    groupId: number;             // stable, 0-based (ordered by smallest characterIdx)
    charKeys: string[];          // every character record merged into this group
    repCharKey: string;          // representative (most members) — drives the avatar
    repEmbedding: Float32Array;  // the representative's real best-face embedding
    times: number[];             // sorted ms timestamps this group appears at
    memberCount: number;
}

export interface MergedFaces {
    fileKey: string;
    groups: MergedGroup[];
    byChar: Map<string, number>; // characterKey → groupId
}

// Cache MUST be keyed on every reactive input the body reads, not on one
// column's identity — otherwise a call made while some columns were still
// loading caches a partial result that never refreshes when the rest arrives.
// We also read every field on every call (below) so the enclosing observer
// re-subscribes to all of them; a cache hit that skipped those reads would go
// dead the moment the data changed.
function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

let mergedCache: { fileKey: string; token: unknown[]; value: MergedFaces } | undefined;

// Characters with fewer than this many member faces are ignored entirely — they
// are one-off / spurious detections. Mirrors the extraction-time filter so old
// records (extracted before that filter existed) are dropped here too.
const MIN_MERGE_MEMBERS = 3;

// Merge one file's characters into per-person groups. Rather than union-find
// (which CHAINS: A~B and B~C fold A and C together even when A and C are far
// apart), we grow groups around a fixed representative: process characters
// best-first (highest detection score, then most members), and each one either
// joins the nearest existing group whose representative is within the
// same-character threshold, or seeds a new group. Because the best face seeds
// each group first, the representative is always the group's best face — so a
// merge "re-picks" the best face automatically. Every comparison is against a
// representative (never transitive), so no chaining. Sync + reactive.
export function getMergedFacesSync(fileKey: string): MergedFaces {
    const chars = getCharacterKeysForFileSync(fileKey);
    const n = chars.length;

    // Read every dependency up front, capturing the raw references into `token`.
    // Reading them here (every call) is what registers the reactive deps; the
    // references double as the cache key — when a lazy field finishes loading
    // its reference changes (undefined → array), so the cache misses and we
    // rebuild with the now-complete data.
    const embs: (Float32Array | undefined)[] = [];
    const memberCounts: number[] = [];
    const scores: number[] = [];
    const timesArr: (Float32Array | undefined)[] = [];
    const token: unknown[] = [fileKey, n];
    for (const { key } of chars) {
        const emb = characters.getSingleFieldSync(key, "bestFaceEmbedding");
        const mc = characters.getSingleFieldSync(key, "memberCount");
        const sc = characters.getSingleFieldSync(key, "bestFaceScore");
        const t = faceFrames.getSingleFieldSync(key, "frameTimes");
        embs.push(emb);
        memberCounts.push(mc ?? 0);
        scores.push(sc ?? 0);
        timesArr.push(t);
        token.push(key, emb, mc, sc, t);
    }

    if (mergedCache && mergedCache.fileKey === fileKey && sameRefs(mergedCache.token, token)) {
        return mergedCache.value;
    }

    const empty: MergedFaces = { fileKey, groups: [], byChar: new Map() };
    if (n === 0) {
        mergedCache = { fileKey, token, value: empty };
        return empty;
    }

    // Eligible characters: real embedding + at least MIN_MERGE_MEMBERS faces.
    // Ordered best-first so each group is seeded by its best face.
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!embs[i]) continue;
        if (memberCounts[i] < MIN_MERGE_MEMBERS) continue;
        eligible.push(i);
    }
    eligible.sort((a, b) => (scores[b] - scores[a]) || (memberCounts[b] - memberCounts[a]));

    // Greedy grouping around fixed representatives (no chaining).
    interface RawGroup { rep: number; members: number[]; }
    const rawGroups: RawGroup[] = [];
    for (const i of eligible) {
        const ei = embs[i]!;
        let best: RawGroup | undefined;
        let bestD = Infinity;
        for (const grp of rawGroups) {
            const d = l2Distance(ei, embs[grp.rep]!);
            if (d < bestD) { bestD = d; best = grp; }
        }
        if (best && bestD < SAME_CHARACTER_THRESHOLD) best.members.push(i);
        else rawGroups.push({ rep: i, members: [i] });
    }

    // Order groups by smallest characterIdx so ids are stable across reloads.
    rawGroups.sort((a, b) =>
        Math.min(...a.members.map(i => chars[i].characterIdx)) -
        Math.min(...b.members.map(i => chars[i].characterIdx)));

    const groups: MergedGroup[] = [];
    const byChar = new Map<string, number>();
    for (let g = 0; g < rawGroups.length; g++) {
        const { rep, members } = rawGroups[g];
        const repEmbedding = embs[rep]!;
        const times: number[] = [];
        let total = 0;
        const charKeys: string[] = [];
        for (const i of members) {
            charKeys.push(chars[i].key);
            byChar.set(chars[i].key, g);
            total += memberCounts[i];
            const t = timesArr[i];
            if (t) for (let k = 0; k < t.length; k++) times.push(t[k]);
        }
        times.sort((a, b) => a - b);
        groups.push({ groupId: g, charKeys, repCharKey: chars[rep].key, repEmbedding, times, memberCount: total });
    }
    const value: MergedFaces = { fileKey, groups, byChar };
    mergedCache = { fileKey, token, value };
    return value;
}

// True while any input getMergedFacesSync needs is still loading — the
// character list, or any character's embedding / member count / frame times.
// Lets callers tell "still loading" apart from a genuinely empty result.
// isFieldLoadedSync also kicks off the lazy load and is reactive, so a view
// reading this flips from loading → loaded on its own once the data arrives.
export function facesLoadingSync(fileKey: string): boolean {
    if (!characters.isColumnLoadedSync("characterIdx")) return true;
    for (const { key } of getCharacterKeysForFileSync(fileKey)) {
        if (!characters.isFieldLoadedSync(key, "bestFaceEmbedding")) return true;
        if (!characters.isFieldLoadedSync(key, "memberCount")) return true;
        if (!faceFrames.isFieldLoadedSync(key, "frameTimes")) return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────
// Scene detection.

export interface Scene {
    start: number;             // ms — playback start (the face before this scene, or 0)
    end: number;               // ms — playback end (the face after this scene, or duration)
    firstFaceT: number;        // ms — first face detection that seeded the scene
    lastInSceneFaceT: number;  // ms — last confirmed in-scene face
    groups: Set<number>;       // group ids present in the scene
}

interface Detection { t: number; g: number; }

// Two-pass detection.
//   Pass 1 walks the time-sorted detections, growing a scene while a face
//   already in it keeps reappearing within `gapMs`. A new face is held
//   "pending" (it doesn't reset the gap timer); when an in-scene face reappears
//   every pending face in between is absorbed ("encapsulated"). The gap is
//   measured only from the last IN-SCENE face. When the scene ends, the next
//   one seeds from the earliest still-pending detection (never-encapsulated
//   faces get their own shot), else from the detection that broke the gap.
//   Pass 2 pads each scene outward to the neighbouring faces: it starts at the
//   last face detected BEFORE the scene's first face (or the video start if
//   there is none) and ends at the first face AFTER the scene's last face (or
//   the video end), so nothing between two faces is dropped.
export function detectScenes(merged: MergedFaces, durationMs: number, gapMs: number): Scene[] {
    const D: Detection[] = [];
    for (const grp of merged.groups) for (const t of grp.times) D.push({ t, g: grp.groupId });
    D.sort((a, b) => a.t - b.t || a.g - b.g);
    if (D.length === 0) return [];

    interface Raw { firstFaceT: number; lastInSceneFaceT: number; groups: Set<number>; }
    const raw: Raw[] = [];
    let i = 0;
    while (i < D.length) {
        const firstFaceT = D[i].t;
        const groups = new Set<number>([D[i].g]);
        let lastConfirmedT = D[i].t;
        let pending: Detection[] = [];
        let pendingFirstIdx = -1;
        let j = i + 1;
        for (; j < D.length; j++) {
            const d = D[j];
            if (d.t - lastConfirmedT > gapMs) break;
            if (groups.has(d.g)) {
                for (const p of pending) groups.add(p.g);
                pending = [];
                pendingFirstIdx = -1;
                lastConfirmedT = d.t;
            } else {
                if (pendingFirstIdx < 0) pendingFirstIdx = j;
                pending.push(d);
            }
        }
        raw.push({ firstFaceT, lastInSceneFaceT: lastConfirmedT, groups });
        i = pendingFirstIdx >= 0 ? pendingFirstIdx : j;
    }

    // Pass 2: pad to the neighbouring faces. D is sorted by time, so the face
    // before a scene is the last detection with t < firstFaceT, and the face
    // after is the first detection with t > lastInSceneFaceT.
    const times = D.map(d => d.t);
    const lastBefore = (x: number): number | undefined => {
        let lo = 0, hi = times.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < x) lo = mid + 1; else hi = mid; }
        return lo > 0 ? times[lo - 1] : undefined;
    };
    const firstAfter = (x: number): number | undefined => {
        let lo = 0, hi = times.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= x) lo = mid + 1; else hi = mid; }
        return lo < times.length ? times[lo] : undefined;
    };

    const scenes: Scene[] = [];
    for (const cur of raw) {
        const start = lastBefore(cur.firstFaceT) ?? 0;
        const end = firstAfter(cur.lastInSceneFaceT) ?? Math.max(durationMs, cur.lastInSceneFaceT);
        scenes.push({ start, end, firstFaceT: cur.firstFaceT, lastInSceneFaceT: cur.lastInSceneFaceT, groups: cur.groups });
    }
    return scenes;
}

// ─────────────────────────────────────────────────────────────────────
// Memoized per-file scenes. getMergedFacesSync returns a stable object while
// its inputs are unchanged (and a fresh one when any load/change), so we can
// memo the expensive detectScenes on that identity plus the duration (the last
// scene's end depends on it). getMergedFacesSync is always called, so all the
// reactive field reads still happen on every call.

let sceneCache: { merged: MergedFaces; durationMs: number; gapMs: number; scenes: Scene[] } | undefined;

export function getScenesForFileSync(fileKey: string, durationMs: number): { merged: MergedFaces; scenes: Scene[] } {
    const merged = getMergedFacesSync(fileKey);
    const gapMs = sceneGapMs();
    if (sceneCache && sceneCache.merged === merged && sceneCache.durationMs === durationMs && sceneCache.gapMs === gapMs) {
        return { merged, scenes: sceneCache.scenes };
    }
    const scenes = detectScenes(merged, durationMs, gapMs);
    sceneCache = { merged, durationMs, gapMs, scenes };
    return { merged, scenes };
}

export function currentScene(scenes: Scene[], timeMs: number): Scene | undefined {
    // Scenes are contiguous and sorted; the current one is the last that starts
    // at or before the time.
    let found: Scene | undefined;
    for (const s of scenes) {
        if (s.start > timeMs) break;
        found = s;
    }
    return found;
}

// ─────────────────────────────────────────────────────────────────────
// Selection ↔ local groups.

// The local group a source character resolves to on `fileKey`, or -1. Only
// considers sources from this file or a sibling in the same series; matches by
// nearest representative within the same-character threshold.
export function resolveCharToGroup(sourceCharKey: string, merged: MergedFaces): number {
    const srcFile = fileKeyOfCharacter(sourceCharKey);
    if (srcFile !== merged.fileKey && !sameSeries(srcFile, merged.fileKey)) return -1;
    const emb = characters.getSingleFieldSync(sourceCharKey, "bestFaceEmbedding");
    if (!emb) return -1;
    let best = -1;
    let bestD = Infinity;
    for (const g of merged.groups) {
        const d = l2Distance(emb, g.repEmbedding);
        if (d < bestD) { bestD = d; best = g.groupId; }
    }
    return best >= 0 && bestD <= SAME_CHARACTER_THRESHOLD ? best : -1;
}

// The local group ids the current selection maps to on `fileKey`.
export function selectedGroupsForFile(merged: MergedFaces, selection: string[]): Set<number> {
    const out = new Set<number>();
    for (const ck of selection) {
        const g = resolveCharToGroup(ck, merged);
        if (g >= 0) out.add(g);
    }
    return out;
}

// Scenes whose faces intersect the target groups.
export function scenesForGroups(scenes: Scene[], groups: Set<number>): Scene[] {
    if (groups.size === 0) return [];
    return scenes.filter(s => {
        for (const g of s.groups) if (groups.has(g)) return true;
        return false;
    });
}

// ─────────────────────────────────────────────────────────────────────
// Selection state (URL-backed). Reads are reactive via selectedFaces.value.

export function getSelectedFaceKeys(): string[] {
    const raw = selectedFaces.value;
    if (!raw) return [];
    return raw.split(",").map(s => { try { return decodeURIComponent(s); } catch { return s; } }).filter(Boolean);
}

export function setSelectedFaceKeys(keys: string[]): void {
    const uniq = Array.from(new Set(keys));
    runInAction(() => { selectedFaces.value = uniq.map(encodeURIComponent).join(","); });
}

export function isFaceKeySelected(ck: string): boolean {
    return getSelectedFaceKeys().includes(ck);
}

export function clearSelectedFaces(): void {
    runInAction(() => { selectedFaces.value = ""; });
}

// Add/remove one source character.
export function toggleSelectedFaceKey(ck: string): void {
    const cur = getSelectedFaceKeys();
    if (cur.includes(ck)) setSelectedFaceKeys(cur.filter(k => k !== ck));
    else setSelectedFaceKeys([...cur, ck]);
}

// Toggle a local group: if it's currently selected (any source resolves to it),
// drop every source that maps to it; otherwise add the group's representative.
export function toggleGroupSelection(merged: MergedFaces, group: MergedGroup): void {
    const cur = getSelectedFaceKeys();
    const mapsToGroup = cur.filter(ck => resolveCharToGroup(ck, merged) === group.groupId);
    if (mapsToGroup.length > 0) {
        const drop = new Set(mapsToGroup);
        setSelectedFaceKeys(cur.filter(ck => !drop.has(ck)));
    } else {
        setSelectedFaceKeys([...cur, group.repCharKey]);
    }
}
