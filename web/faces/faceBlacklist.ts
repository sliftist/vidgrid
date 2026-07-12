// User face blacklist. Faces the user has flagged as bad (garbage / spurious
// detections) are stored globally with their real embedding + avatar. At read
// time the faces modal pulls any character within the same-character threshold
// of a blacklisted face out of the normal list and shows it in a separate
// "Blacklisted" section — so a bad face stays hidden, but we can still SEE when
// a real character erroneously matches one (to verify the detector).

import { blacklistedFaces, characters, BlacklistedFaceRecord } from "../appState";
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
// into the blacklist (keyed by the character key, so re-flagging is a no-op).
// The character record itself is left intact — the faces modal relocates it to
// the blacklist section via matchBlacklistSync, and unblacklisting restores it.
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
}

export async function unblacklistFace(key: string): Promise<void> {
    await blacklistedFaces.delete(key);
}
