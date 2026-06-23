// Face-search state + helpers.
//
// A face search is encoded directly in the normal search query as
// `face:<base64url-embedding>` — there is no separate observable or URL
// param. parseFaceSearchQuery decodes it back to the 512-float vector;
// any query that isn't a valid payload is treated as ordinary text. The
// `face` viewMode (the avatar strip) is a separate, persisted setting
// from the query, so clearing the query keeps the strip visible.

import { observable, runInAction } from "mobx";
import {
    characters,
    facesFp16,
} from "../appState";
import { l2Distance } from "../faceEmbed/arcface";
import { extractFaces } from "../faceEmbed";
import { SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";
import { searchQuery, viewMode } from "../router";

export { SAME_CHARACTER_THRESHOLD };

const PER_FRAME_KEY = "vidgrid.perFrameSearch";
const FACE_QUERY_PREFIX = "face:";

function readBool(key: string): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(key) === "1";
}

// showFaces is derived from the viewMode URL param — "face" mode implies
// the avatar strip is visible. Reads stay reactive because
// `viewMode.value` touches the URLParam's observable seqNum.
export const showFaces = {
    get: () => viewMode.value === "face",
};
export const perFrameSearch = observable.box<boolean>(readBool(PER_FRAME_KEY));

export function setPerFrameSearch(v: boolean): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(PER_FRAME_KEY, v ? "1" : "0");
    runInAction(() => perFrameSearch.set(v));
}
// Encode a 512-float embedding as base64url for stuffing into the URL.
// Float32Array → underlying 2048-byte Uint8Array → base64 → URL-safe.
function encodeEmbeddingForUrl(e: Float32Array): string {
    const bytes = new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeEmbeddingFromUrl(encoded: string): Float32Array | undefined {
    try {
        const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64.length % 4;
        const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
        const bin = atob(padded);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.byteLength !== 512 * 4) return undefined;
        return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch {
        return undefined;
    }
}

// A query is a face search when it's `face:` followed by a base64url
// payload long enough to be a 2048-byte embedding that actually decodes
// to a 512-float vector. Anything shorter or malformed is ordinary text.
export function parseFaceSearchQuery(q: string): Float32Array | undefined {
    if (!q.startsWith(FACE_QUERY_PREFIX)) return undefined;
    const encoded = q.slice(FACE_QUERY_PREFIX.length);
    if (encoded.length < 2000) return undefined;
    return decodeEmbeddingFromUrl(encoded);
}

// Reactive read of the active face-search embedding off the search query.
export function getFaceSearchEmbedding(): Float32Array | undefined {
    return parseFaceSearchQuery(searchQuery.value);
}

// Starting a face search is just writing the encoded query and switching
// into face mode so the avatar strip is visible.
export function setFaceSearch(embedding: Float32Array): void {
    runInAction(() => {
        searchQuery.value = FACE_QUERY_PREFIX + encodeEmbeddingForUrl(embedding);
        viewMode.value = "face";
    });
}

// ─────────────────────────────────────────────────────────────────────
// Sync (reactive) lookups. Only safe inside renders / mobx.reaction.

// Character keys for a file, sorted by characterIdx. Cheap: only the
// (small, numeric) characterIdx column is read — callers pull the heavier
// fields (centroid / avatarJpeg / embedding) per key, and only the ones
// they actually need. BulkDatabase2 has no prefix scan, so we filter the
// column by the `${fileKey}#` key prefix. mobx caches the column read.
export function getCharacterKeysForFileSync(fileKey: string): { key: string; characterIdx: number }[] {
    const col = characters.getColumnSync("characterIdx");
    if (!col) return [];
    const prefix = `${fileKey}#`;
    const out: { key: string; characterIdx: number }[] = [];
    for (const { key, value } of col) {
        if (!key.startsWith(prefix)) continue;
        out.push({ key, characterIdx: typeof value === "number" ? value : 0 });
    }
    out.sort((a, b) => a.characterIdx - b.characterIdx);
    return out;
}

// Whole-library closest-character lookup. Dumps the centroid column ONCE and,
// in a single pass, scores every character against the search embedding,
// keeping the nearest character per file. Returns fileKey → { distance,
// characterIdx } for every file that has at least one character.
//
// This is the bulk path for face search. The old approach walked the file
// list and called getClosestCharacterSync per file — but that scans the full
// character column once per file (a prefix filter), i.e. O(files × characters):
// a classic double join over data we're reading in full anyway. Every
// character's key already encodes its file (`${fileKey}#${paddedIdx}`), so we
// map characters → files directly in one O(characters) pass instead.
export function getClosestCharactersByFileSync(
    search: Float32Array,
): Map<string, { distance: number; characterIdx: number }> {
    const out = new Map<string, { distance: number; characterIdx: number }>();
    const col = characters.getColumnSync("centroid");
    if (!col) return out;
    for (const { key, value: centroid } of col) {
        if (!centroid) continue;
        // fileKey may itself contain '#', so split on the last one — the
        // suffix is always `#${paddedCharacterIdx}`.
        const hash = key.lastIndexOf("#");
        if (hash < 0) continue;
        const fileKey = key.slice(0, hash);
        const characterIdx = parseInt(key.slice(hash + 1), 10) || 0;
        const distance = l2Distance(centroid, search);
        const prev = out.get(fileKey);
        if (!prev || distance < prev.distance) out.set(fileKey, { distance, characterIdx });
    }
    return out;
}

// Min-distance lookup over a single file's characters: returns the closest
// character's idx + its distance to the search embedding, or undefined if
// the file has no characters. Reads only the centroid per character. For the
// whole library use getClosestCharactersByFileSync — calling this in a loop
// reintroduces the per-file double join.
export function getClosestCharacterSync(fileKey: string, search: Float32Array): { characterIdx: number; distance: number } | undefined {
    const keys = getCharacterKeysForFileSync(fileKey);
    if (keys.length === 0) return undefined;
    let bestIdx = keys[0].characterIdx;
    let bestD = Infinity;
    for (const { key, characterIdx } of keys) {
        const centroid = characters.getSingleFieldSync(key, "centroid");
        if (!centroid) continue;
        const d = l2Distance(centroid, search);
        if (d < bestD) { bestD = d; bestIdx = characterIdx; }
    }
    if (!Number.isFinite(bestD)) return undefined;
    return { characterIdx: bestIdx, distance: bestD };
}

// ─────────────────────────────────────────────────────────────────────
// Async helper: run an image through the face pipeline, return the
// highest-scoring face's embedding. Used by paste/drop image search.

export async function searchByImage(source: HTMLImageElement | HTMLCanvasElement | OffscreenCanvas): Promise<boolean> {
    const faces = await extractFaces(source, undefined, { fp16: facesFp16.get() });
    if (faces.length === 0) {
        console.warn(`[face-search] no faces in pasted/dropped image`);
        return false;
    }
    // Best face = highest detection score.
    const best = faces.reduce((a, b) => b.score > a.score ? b : a);
    setFaceSearch(best.embedding);
    return true;
}
