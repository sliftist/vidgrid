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
// The remap is just decodeURIComponent: the old key was
// encodeURIComponent(relativePath), so decoding recovers the raw path exactly
// (and for a file key that means key === relativePath again, the invariant the
// scan relies on). Composite keys decode whole — the "#" separators and the
// list-slug prefix have no percent-escapes, so only the encoded file part
// changes. A key that's already raw decodes to itself (or throws on a stray
// "%"), so it's skipped — the pass is safe to re-run.

import { files, thumbnails, keyframes, characters, faceFrames, removedFiles, remapTimedOutKeys } from "./appState";
import { listMemberships } from "./lists/lists";
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

// Decoded key if decoding changes it, else undefined (already raw, or a stray
// "%" that isn't a valid escape — leave those untouched).
function decodeKey(key: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(key);
    } catch {
        return undefined;
    }
    if (decoded === key) return undefined;
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

// Copy every decodable row to its decoded key, decoding any key-bearing columns
// too, then delete the old rows. Returns how many rows moved.
async function rekeyStore<T extends { key: string }>(
    store: BulkDatabase2<T>, keyColumns: (keyof T)[] = [],
): Promise<number> {
    const moves: { oldKey: string; newKey: string }[] = [];
    for (const k of await store.getKeys()) {
        const nk = decodeKey(k);
        if (nk) moves.push({ oldKey: k, newKey: nk });
    }
    if (moves.length === 0) return 0;
    const rows = await assembleRows(store, new Set(moves.map(m => m.oldKey)));
    const writes: T[] = [];
    const dels: string[] = [];
    for (const { oldKey, newKey } of moves) {
        const row = rows.get(oldKey);
        if (!row) continue;
        (row as { key: string }).key = newKey;
        for (const col of keyColumns) {
            const v = row[col];
            if (typeof v === "string") {
                const dv = decodeKey(v);
                if (dv) (row as Record<string, unknown>)[col as string] = dv;
            }
        }
        writes.push(row as T);
        dels.push(oldKey);
    }
    await store.writeBatch(writes);
    await store.deleteBatch(dels);
    await store.flush();
    return writes.length;
}

export async function migrateEncodedKeys(): Promise<KeyMigrationReport> {
    return {
        files: await rekeyStore(files),
        thumbnails: await rekeyStore(thumbnails),
        keyframes: await rekeyStore(keyframes),
        characters: await rekeyStore(characters, ["fileKey"]),
        faceFrames: await rekeyStore(faceFrames),
        removed: await rekeyStore(removedFiles),
        memberships: await rekeyStore(listMemberships, ["itemKey"]),
        timedOut: remapTimedOutKeys(decodeKey),
    };
}
