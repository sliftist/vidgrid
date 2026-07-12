// User face blacklist. Faces the user has flagged as bad (garbage / spurious
// detections) are stored globally with their real embedding + avatar. At read
// time the faces modal pulls any character within the same-character threshold
// of a blacklisted face out of the normal list and shows it in a separate
// "Blacklisted" section — so a bad face stays hidden, but we can still SEE when
// a real character erroneously matches one (to verify the detector).

import { blacklistedFaces, characters, faceFrames, BlacklistedFaceRecord } from "../appState";
import { l2Distance } from "../faceEmbed/arcface";
import { SAME_CHARACTER_THRESHOLD } from "../faceEmbed/clustering";

export interface BlacklistedFace {
    key: string;
    embedding: Float32Array;
    avatarJpeg?: Uint8Array;
    fileKey?: string;
    blacklistedAt?: number;
}

// Every blacklisted face, reactively. Reads the whole (small) collection: one
// row per flagged face, each carrying a 512-float embedding + a tiny avatar.
// Safe inside render / mobx reactions.
export function getBlacklistedFacesSync(): BlacklistedFace[] {
    const embCol = blacklistedFaces.getColumnSync("embedding");
    if (!embCol) return [];
    const out: BlacklistedFace[] = [];
    for (const { key, value } of embCol) {
        if (!(value instanceof Float32Array)) continue;
        out.push({
            key,
            embedding: value,
            avatarJpeg: blacklistedFaces.getSingleFieldSync(key, "avatarJpeg"),
            fileKey: blacklistedFaces.getSingleFieldSync(key, "fileKey"),
            blacklistedAt: blacklistedFaces.getSingleFieldSync(key, "blacklistedAt"),
        });
    }
    out.sort((a, b) => (b.blacklistedAt ?? 0) - (a.blacklistedAt ?? 0));
    return out;
}

// True once the blacklist collection has loaded (so callers can tell "empty"
// apart from "still loading" — an unloaded column returns [] just like empty).
export function blacklistLoadedSync(): boolean {
    return blacklistedFaces.isColumnLoadedSync("embedding");
}

// The blacklisted face closest to `embedding` within the same-character
// threshold, or undefined. `list` is passed in so a render pass that already
// pulled the blacklist doesn't re-read it per character.
export function matchBlacklistSync(
    embedding: Float32Array,
    list: BlacklistedFace[],
): { entry: BlacklistedFace; distance: number } | undefined {
    let best: BlacklistedFace | undefined;
    let bestD = Infinity;
    for (const b of list) {
        const d = l2Distance(embedding, b.embedding);
        if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD < SAME_CHARACTER_THRESHOLD) return { entry: best, distance: bestD };
    return undefined;
}

// Flag a character's face as bad. Copies its real best-face embedding + avatar
// into the blacklist (keyed by the character key, so re-flagging is a no-op),
// then HARD-DELETES the character (summary + per-frame embeddings) so it's gone
// from the collection entirely — scenes, search, everything. Extraction skips
// any face matching the blacklist, so it never comes back.
export async function blacklistFace(characterKey: string): Promise<void> {
    const embedding = await characters.getSingleField(characterKey, "bestFaceEmbedding");
    if (!embedding) return;
    const avatarJpeg = await characters.getSingleField(characterKey, "avatarJpeg");
    const fileKey = await characters.getSingleField(characterKey, "fileKey");
    const record: BlacklistedFaceRecord = {
        key: characterKey,
        embedding,
        avatarJpeg,
        fileKey,
        blacklistedAt: Date.now(),
    };
    await blacklistedFaces.write(record);
    // Remove it from the character collection for good.
    await characters.delete(characterKey);
    await faceFrames.delete(characterKey);
}

// Un-blacklisting only drops the blacklist row. It does NOT restore the deleted
// character — re-extract the file to bring the face back (now that it's no
// longer blacklisted).
export async function unblacklistFace(key: string): Promise<void> {
    await blacklistedFaces.delete(key);
}

// Every blacklisted face's embedding, async — for the extraction path, which
// filters out clusters matching one before writing characters.
export async function getBlacklistedEmbeddingsAsync(): Promise<Float32Array[]> {
    const col = await blacklistedFaces.getColumn("embedding");
    const out: Float32Array[] = [];
    for (const { value } of col) if (value instanceof Float32Array) out.push(value);
    return out;
}

// True if `embedding` is within the same-person threshold of any blacklisted
// face. Used at extraction time to drop blacklisted clusters.
export function isBlacklistedEmbedding(embedding: Float32Array, blacklistEmbeddings: Float32Array[]): boolean {
    for (const b of blacklistEmbeddings) {
        if (l2Distance(embedding, b) < SAME_CHARACTER_THRESHOLD) return true;
    }
    return false;
}
