// One-shot migration that rewrites every stored file key from the legacy
// encodeURIComponent(relativePath) form to the raw relativePath the app now
// uses everywhere (see pathKey in appState.ts).
//
// Affected stores, all keyed (directly or as a `${x}#${fileKey}` composite) by
// the file key:
//   files (vidgrid_index), thumbnails, keyframes  — key = fileKey
//   characters                                    — key = `${fileKey}#${NN}`, plus a fileKey column
//   faceFrames                                    — key = `${fileKey}#${NN}`
//   removedFiles                                  — key = fileKey (tombstones)
//   listMemberships                               — key = `${listKey}#${itemKey}`, plus an itemKey column (video items)
//   localStorage vidgrid.timedOutKeys             — array of fileKeys
//
// Ground truth for the remap is each file's raw `relativePath`: the old key was
// exactly encodeURIComponent(relativePath), so we derive the old key from the
// raw path. That keeps each migrated file key === its relativePath (the
// invariant the scan relies on) and makes the whole thing safe to re-run — a
// row already at its raw key is simply not in the map and is left alone.

import { files, thumbnails, keyframes, characters, faceFrames, removedFiles, remapTimedOutKeys, CharacterRecord } from "./appState";
import { listMemberships, ListMembership } from "./lists/lists";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";

export type KeyMigrationReport = {
    files: number;
    thumbnails: number;
    keyframes: number;
    characters: number;
    faceFrames: number;
    removed: number;
    memberships: number;
    timedOut: number;
};

type Remap = (oldKey: string) => string | undefined;

// A key is in the old (encoded) form iff decoding changes it and re-encoding
// the result reproduces it exactly. Raw keys — even ones containing "/" — fail
// that round-trip and are left untouched. Used for the stores with no
// relativePath column to anchor against (removedFiles, timed-out keys).
function decodeIfEncoded(key: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(key);
    } catch {
        return undefined;
    }
    if (decoded === key) return undefined;
    if (encodeURIComponent(decoded) !== key) return undefined;
    return decoded;
}

// Read full rows (every on-disk column) for a set of keys.
async function assembleRows<T extends { key: string }>(
    store: BulkDatabase2<T>, needed: Set<string>,
): Promise<Map<string, Partial<T>>> {
    const rows = new Map<string, Partial<T>>();
    const cols = await store.getColumnInfo();
    for (const { column } of cols) {
        const entries = await store.getColumn(column as keyof T);
        for (const { key, value } of entries) {
            if (!needed.has(key)) continue;
            let row = rows.get(key);
            if (!row) {
                row = {} as Partial<T>;
                rows.set(key, row);
            }
            if (value !== undefined) (row as Record<string, unknown>)[column] = value;
        }
    }
    return rows;
}

// Copy every remapped row to its new key (optionally fixing key-bearing columns
// via fixRow), then delete the old rows. Returns how many rows moved.
async function rekeyStore<T extends { key: string }>(
    store: BulkDatabase2<T>, remap: Remap, fixRow?: (row: Partial<T>, newKey: string) => void,
): Promise<number> {
    const moves: { oldKey: string; newKey: string }[] = [];
    for (const k of await store.getKeys()) {
        const nk = remap(k);
        if (nk && nk !== k) moves.push({ oldKey: k, newKey: nk });
    }
    if (moves.length === 0) return 0;
    const rows = await assembleRows(store, new Set(moves.map(m => m.oldKey)));
    const writes: T[] = [];
    const dels: string[] = [];
    for (const { oldKey, newKey } of moves) {
        const row = rows.get(oldKey);
        if (!row) continue;
        (row as { key: string }).key = newKey;
        if (fixRow) fixRow(row, newKey);
        writes.push(row as T);
        dels.push(oldKey);
    }
    await store.writeBatch(writes);
    await store.deleteBatch(dels);
    await store.flush();
    return writes.length;
}

export async function migrateEncodedKeys(): Promise<KeyMigrationReport> {
    const fileKeyMap = new Map<string, string>();
    for (const { value: rel } of await files.getColumn("relativePath")) {
        if (typeof rel !== "string") continue;
        const enc = encodeURIComponent(rel);
        if (enc !== rel) fileKeyMap.set(enc, rel);
    }

    const remapFile: Remap = k => fileKeyMap.get(k);
    // `${fileKey}#${NN}` — remap the part before the last "#".
    const remapComposite: Remap = k => {
        const h = k.lastIndexOf("#");
        if (h < 0) return undefined;
        const nf = fileKeyMap.get(k.slice(0, h));
        if (!nf) return undefined;
        return nf + k.slice(h);
    };
    // `${listKey}#${itemKey}` — the list slug has no "#" and the old encoded
    // itemKey has none either, so the first "#" is the separator. Only video
    // items (itemKey === a file key) are in the map; series items (raw folder
    // paths) aren't, and are left alone.
    const remapMembership: Remap = k => {
        const h = k.indexOf("#");
        if (h < 0) return undefined;
        const ni = fileKeyMap.get(k.slice(h + 1));
        if (!ni) return undefined;
        return k.slice(0, h + 1) + ni;
    };

    return {
        files: await rekeyStore(files, remapFile),
        thumbnails: await rekeyStore(thumbnails, remapFile),
        keyframes: await rekeyStore(keyframes, remapFile),
        characters: await rekeyStore(characters, remapComposite, (row, newKey) => {
            (row as Partial<CharacterRecord>).fileKey = newKey.slice(0, newKey.lastIndexOf("#"));
        }),
        faceFrames: await rekeyStore(faceFrames, remapComposite),
        removed: await rekeyStore(removedFiles, decodeIfEncoded),
        memberships: await rekeyStore(listMemberships, remapMembership, (row, newKey) => {
            (row as Partial<ListMembership>).itemKey = newKey.slice(newKey.indexOf("#") + 1);
        }),
        timedOut: remapTimedOutKeys(decodeIfEncoded),
    };
}
