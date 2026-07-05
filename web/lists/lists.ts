// User-managed lists of videos and series.
//
// Two BulkDatabase2 collections:
//   - lists: one row per list (name, order)
//   - listMemberships: one row per (list, item) pair, key composed as
//     `${listKey}#${itemKey}` so writes are idempotent and a delete by
//     composed key is enough to "remove from list".
//
// Items can be videos (itemKey = FileRecord.key) or series (itemKey =
// SeriesGroup.parentPath). Membership rows carry itemType so the
// renderer knows which kind of cell to draw.

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";

export interface ListRecord {
    key: string;
    name: string;
    createdAt: number;
    // Manual sort order — only meaningful while `pinned`. Unpinned lists
    // ignore it and sort by most-recently-added-to instead.
    order: number;
    // Pinned lists sit (in manual `order`) above the unpinned ones, which
    // float by recency. Optional: legacy rows don't have it.
    pinned?: boolean;
}

export type ListItemType = "video" | "series";

export interface ListMembership {
    key: string;        // `${listKey}#${itemKey}`
    listKey: string;
    itemKey: string;
    itemType: ListItemType;
    addedAt: number;
    // Sort key within the list, higher = closer to the front. Defaults
    // to addedAt at insertion time (so newest-added shows up first),
    // overridden by reorderListMembers when the user drags items
    // around in rearrange mode. Optional because legacy rows written
    // before this field existed don't have it; readers fall back to
    // addedAt.
    order?: number;
}

export const lists = new BulkDatabase2<ListRecord>("vidgrid_lists");
export const listMemberships = new BulkDatabase2<ListMembership>("vidgrid_list_memberships");

// A built-in, always-present list whose contents are computed on the fly (the
// most-recently-active videos) rather than stored as memberships. It has a real
// ListRecord but always sorts first on the list page, and it's excluded from
// the "add to list" picker and can't be renamed/deleted/rearranged/pinned —
// the double-underscore key can never collide with a user slug. ListMode
// renders its dynamic contents; see getRecentVideosMembers there.
export const RECENT_VIDEOS_LIST_KEY = "__recent_videos__";
export const RECENT_VIDEOS_LIST_NAME = "Most recent videos";

// Create the built-in "most recent videos" list if it's missing. Idempotent —
// leaves an existing record (and whatever order the user gave it) untouched.
export async function ensureRecentVideosList(): Promise<void> {
    const existing = await lists.getSingleField(RECENT_VIDEOS_LIST_KEY, "name");
    if (typeof existing === "string") return;
    await lists.write({
        key: RECENT_VIDEOS_LIST_KEY,
        name: RECENT_VIDEOS_LIST_NAME,
        createdAt: Date.now(),
        // Default to the front of the list page; the user can reorder it.
        order: 0,
    });
}

// Lowercase-kebab-case slug, falling back to a timestamped slug if the
// name normalises to nothing (e.g. all symbols).
function slug(name: string): string {
    const base = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return base || `list-${Date.now()}`;
}

async function uniqueListKey(baseSlug: string): Promise<string> {
    const existing = new Set(await lists.getKeys());
    if (!existing.has(baseSlug)) return baseSlug;
    // Collision (different name with same slug) — append a counter.
    for (let i = 2; i < 1000; i++) {
        const cand = `${baseSlug}-${i}`;
        if (!existing.has(cand)) return cand;
    }
    return `${baseSlug}-${Date.now()}`;
}

async function nextOrder(): Promise<number> {
    const col = await lists.getColumn("order");
    let max = 0;
    for (const { value } of col) {
        if (typeof value === "number" && value > max) max = value;
    }
    return max + 1;
}

// Create a list with the given display name. If a list with the same
// case-insensitive name already exists, returns the existing record.
export async function createList(name: string): Promise<ListRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("List name required");
    const nameCol = await lists.getColumn("name");
    for (const { key, value } of nameCol) {
        if (typeof value === "string" && value.toLowerCase() === trimmed.toLowerCase()) {
            const createdAt = await lists.getSingleField(key, "createdAt") ?? 0;
            const order = await lists.getSingleField(key, "order") ?? 0;
            return { key, name: value, createdAt, order };
        }
    }
    const baseKey = slug(trimmed);
    const key = await uniqueListKey(baseKey);
    const rec: ListRecord = { key, name: trimmed, createdAt: Date.now(), order: await nextOrder() };
    await lists.write(rec);
    return rec;
}

// Rename an existing list. The list key (slug) stays the same so all
// membership rows keep pointing at it — only ListRecord.name changes.
// Throws if the new name collides (case-insensitive) with a *different*
// existing list.
export async function renameList(listKey: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("List name required");
    const nameCol = await lists.getColumn("name");
    for (const { key, value } of nameCol) {
        if (key === listKey) continue;
        if (typeof value === "string" && value.toLowerCase() === trimmed.toLowerCase()) {
            throw new Error(`A list called "${value}" already exists`);
        }
    }
    await lists.update({ key: listKey, name: trimmed });
}

// Pin / unpin a list. Pinning assigns a fresh order so the list lands at
// the bottom of the pinned block; unpinning returns it to the natural
// (most-recently-added-to) ordering.
export async function setListPinned(listKey: string, pinned: boolean): Promise<void> {
    if (pinned) await lists.update({ key: listKey, pinned: true, order: await nextOrder() });
    else await lists.update({ key: listKey, pinned: false });
}

// Swap a pinned list's `order` value with the pinned neighbor immediately
// above or below it. Only pinned lists have a manual position (the UI only
// shows ↑/↓ on them), so the swap is confined to the pinned block.
export async function moveListUp(listKey: string): Promise<void> {
    const all = getListsSync().filter(l => l.pinned && l.key !== RECENT_VIDEOS_LIST_KEY);
    const i = all.findIndex(l => l.key === listKey);
    if (i <= 0) return;
    const a = all[i - 1];
    const b = all[i];
    await lists.updateBatch([
        { key: a.key, order: b.order },
        { key: b.key, order: a.order },
    ]);
}
export async function moveListDown(listKey: string): Promise<void> {
    const all = getListsSync().filter(l => l.pinned && l.key !== RECENT_VIDEOS_LIST_KEY);
    const i = all.findIndex(l => l.key === listKey);
    if (i < 0 || i >= all.length - 1) return;
    const a = all[i];
    const b = all[i + 1];
    await lists.updateBatch([
        { key: a.key, order: b.order },
        { key: b.key, order: a.order },
    ]);
}

// Move a list to a specific 1-indexed slot, shifting the others to make
// room. Renumbers every list's order to position*10 so subsequent
// swaps have ample gaps. Used by the bulk-reorder modal.
export async function setListPosition(listKey: string, newPosition: number): Promise<void> {
    const all = getListsSync();
    const without = all.filter(l => l.key !== listKey);
    const target = all.find(l => l.key === listKey);
    if (!target) return;
    const clamped = Math.max(1, Math.min(newPosition, all.length));
    const reordered = without.slice();
    reordered.splice(clamped - 1, 0, target);
    await lists.updateBatch(reordered.map((l, idx) => ({ key: l.key, order: (idx + 1) * 10 })));
}

export async function deleteList(listKey: string): Promise<void> {
    // Remove the list itself.
    await lists.delete(listKey);
    // Cascade: drop every membership row for this list.
    const col = await listMemberships.getColumn("listKey");
    const toDelete: string[] = [];
    for (const { key, value } of col) {
        if (value === listKey) toDelete.push(key);
    }
    if (toDelete.length > 0) await listMemberships.deleteBatch(toDelete);
}

export async function addToList(listKey: string, itemKey: string, itemType: ListItemType): Promise<void> {
    const memKey = `${listKey}#${itemKey}`;
    const now = Date.now();
    await listMemberships.write({ key: memKey, listKey, itemKey, itemType, addedAt: now, order: now });
}

// Rewrite the `order` field on every membership row for a list so the
// rows render in the given itemKey order (front-of-list first). Used
// by the per-list rearrange-mode drag-and-drop. Spaced (length - idx)
// so the front item gets the highest value — same direction the sort
// in getListMembersSync uses.
export async function reorderListMembers(listKey: string, orderedItemKeys: string[]): Promise<void> {
    const n = orderedItemKeys.length;
    if (n === 0) return;
    await listMemberships.updateBatch(orderedItemKeys.map((itemKey, idx) => ({
        key: `${listKey}#${itemKey}`,
        order: (n - idx) * 1000,
    })));
}

export async function removeFromList(listKey: string, itemKey: string): Promise<void> {
    await listMemberships.delete(`${listKey}#${itemKey}`);
    // A tag with nothing left assigned to it is dead weight — drop the list
    // record too so empty tags don't linger in the picker. Re-reads the
    // authoritative column (not a sync snapshot) so the check can't race the
    // delete above.
    const col = await listMemberships.getColumn("listKey");
    const stillHasMembers = col.some(({ value }) => value === listKey);
    if (!stillHasMembers) await lists.delete(listKey);
}

// ───────────────────────────────────────────────────────────────
// Sync (reactive) lookups. Safe inside renders / mobx.reaction only.

// When each list last had something added to it, keyed by listKey. One pass
// over the membership addedAt column; the listKey is parsed off the composed
// row key (slugs can't contain "#") so this stays a single-column read.
export function getListLastAddedSync(): Map<string, number> {
    const col = listMemberships.getColumnSync("addedAt");
    const out = new Map<string, number>();
    if (!col) return out;
    for (const { key, value } of col) {
        if (typeof value !== "number") continue;
        const hash = key.indexOf("#");
        if (hash <= 0) continue;
        const listKey = key.slice(0, hash);
        if (value > (out.get(listKey) ?? 0)) out.set(listKey, value);
    }
    return out;
}

export function getListsSync(): ListRecord[] {
    const orderCol = lists.getColumnSync("order");
    if (!orderCol) return [];
    const out: ListRecord[] = [];
    for (const { key } of orderCol) {
        const name = lists.getSingleFieldSync(key, "name");
        if (typeof name !== "string") continue;
        out.push({
            key,
            name,
            createdAt: lists.getSingleFieldSync(key, "createdAt") ?? 0,
            order: lists.getSingleFieldSync(key, "order") ?? 0,
            pinned: lists.getSingleFieldSync(key, "pinned") ?? false,
        });
    }
    // Display order: the built-in recent-videos list is always first, then
    // pinned lists in manual `order`, then everything else floating by
    // most-recently-added-to (falling back to createdAt for empty lists).
    const lastAdded = getListLastAddedSync();
    const activityAt = (l: ListRecord) => lastAdded.get(l.key) ?? l.createdAt;
    out.sort((a, b) => {
        const aRecent = a.key === RECENT_VIDEOS_LIST_KEY ? 1 : 0;
        const bRecent = b.key === RECENT_VIDEOS_LIST_KEY ? 1 : 0;
        if (aRecent !== bRecent) return bRecent - aRecent;
        const aPin = a.pinned ? 1 : 0;
        const bPin = b.pinned ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        if (aPin) return a.order - b.order || a.name.localeCompare(b.name);
        return activityAt(b) - activityAt(a) || a.name.localeCompare(b.name);
    });
    return out;
}

export interface MembershipEntry {
    itemKey: string;
    itemType: ListItemType;
    addedAt: number;
}

// All items in a list, sorted by explicit `order` (desc) when set,
// addedAt otherwise. So newly added rows appear at the front by
// default, and the rearrange UI takes precedence once it's run.
export function getListMembersSync(listKey: string): MembershipEntry[] {
    const col = listMemberships.getColumnSync("itemKey");
    if (!col) return [];
    const prefix = `${listKey}#`;
    const out: (MembershipEntry & { sortKey: number })[] = [];
    for (const { key, value: itemKey } of col) {
        if (!key.startsWith(prefix)) continue;
        if (typeof itemKey !== "string") continue;
        const addedAt = listMemberships.getSingleFieldSync(key, "addedAt") ?? 0;
        const order = listMemberships.getSingleFieldSync(key, "order");
        out.push({
            itemKey,
            itemType: listMemberships.getSingleFieldSync(key, "itemType") ?? "video",
            addedAt,
            sortKey: typeof order === "number" ? order : addedAt,
        });
    }
    out.sort((a, b) => b.sortKey - a.sortKey);
    return out.map(({ sortKey, ...m }) => m);
}

// Number of items assigned to each list, keyed by listKey. One pass over the
// membership column. Safe inside renders / reactions only.
export function getListCountsSync(): Map<string, number> {
    const col = listMemberships.getColumnSync("listKey");
    const out = new Map<string, number>();
    if (!col) return out;
    for (const { value } of col) {
        if (typeof value === "string") out.set(value, (out.get(value) ?? 0) + 1);
    }
    return out;
}

// All list keys an item is currently in. Walks the listKey column.
export function getItemListsSync(itemKey: string): Set<string> {
    const col = listMemberships.getColumnSync("listKey");
    if (!col) return new Set();
    const out = new Set<string>();
    for (const { key, value: listKey } of col) {
        const memItemKey = listMemberships.getSingleFieldSync(key, "itemKey");
        if (memItemKey === itemKey && typeof listKey === "string") out.add(listKey);
    }
    return out;
}

// Match-finder used by the AddToList UI. Returns the lists ordered for
// matching (prefix first, then substring), with the first being the
// current "best" match if any. Non-matches stay visible in the original
// order; only "matches" gets the keyboard-navigation ring around it.
export function matchLists(text: string, allLists: ListRecord[]): { matches: ListRecord[] } {
    const t = text.trim().toLowerCase();
    if (!t) return { matches: [] };
    const prefix: ListRecord[] = [];
    const substring: ListRecord[] = [];
    for (const l of allLists) {
        const n = l.name.toLowerCase();
        if (n.startsWith(t)) prefix.push(l);
        else if (n.includes(t)) substring.push(l);
    }
    return { matches: [...prefix, ...substring] };
}
