// Scan-coordinator version bookkeeping, shared by the tab and the SharedWorker.
//
// IndexedDB is the source of truth. Every context — tab or coord — on startup
// bumps a single IDB cell to max(stored, own BUILD_TIMESTAMP) and reads back
// the winner. The tab uses that winner as the SharedWorker URL slug (?v=<...>).
// The coord uses it to decide whether it's already outdated at spawn AND
// periodically (every 60s, straight from IDB — no messages needed for the
// steady-state check).
//
// The BroadcastChannel is ONLY for propagating "there's a newer version"
// immediately, so a running coord dies within milliseconds of a newer tab
// booting instead of waiting up to 60s for the next IDB poll. There is exactly
// ONE wire message: `{type: "hello", version}` — every broadcast carries the
// sender's version. On receipt: bump IDB, and (if we're a coord and the
// sender's version is strictly newer) self-close.
//
// Why IDB rather than localStorage: SharedWorkers can't access localStorage
// at all (Storage is a Window-only API). IDB works in every worker type, so
// this file is importable from both sides without conditionals.

// ── Wire format ──────────────────────────────────────────────────────────────
export const COORD_VERSION_CHANNEL_NAME = "vidgrid-scan-coord-version";

// Every message carries the sender's version. Recipients decide what to do
// (bump IDB unconditionally; self-close if we're an outdated coord).
export type CoordVersionMsg = { type: "hello"; version: string };

// ── IndexedDB store (single kv row) ──────────────────────────────────────────
const DB_NAME = "vidgrid_scan_coord_version";
const STORE = "kv";
const KEY = "latestBuildVersion";

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function readLatestKnownVersion(): Promise<string | undefined> {
    try {
        const db = await openDb();
        return await new Promise<string | undefined>((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).get(KEY);
            req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : undefined);
            req.onerror = () => reject(req.error);
        });
    } catch { return undefined; }
}

async function writeLatestKnownVersion(v: string): Promise<void> {
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(v, KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* ignore */ }
}

// Bump the stored cell to max(stored, ourTimestamp) and return the winner. ISO
// timestamps sort lexicographically = chronologically. Safe if IDB is
// unavailable — falls back to returning our own so we can still boot.
export async function bumpLatestKnownVersion(ourTimestamp: string): Promise<string> {
    const stored = await readLatestKnownVersion();
    const winner = stored && stored > ourTimestamp ? stored : ourTimestamp;
    if (winner !== stored) await writeLatestKnownVersion(winner);
    return winner;
}

// ── URL slug formatter ───────────────────────────────────────────────────────
// Format an ISO build timestamp as a human-readable slug that goes into the
// SharedWorker URL's ?v= query — the format itself is the whole point: it's
// what a user sees in the URL when opening DevTools ("what time was this built,
// in my local time?"). Deterministic per browser (uses the browser's local TZ)
// so different tabs on the same browser produce the same slug and dedupe to
// the same SharedWorker. URL-safe (only alnum, '-', '_').
export function formatBuildVersion(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "unknown";
    const pad = (n: number): string => String(n).padStart(2, "0");
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    let tz = "UTC";
    try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d);
        const t = parts.find(p => p.type === "timeZoneName");
        if (t && t.value) tz = t.value.replace(/[^A-Za-z0-9+-]/g, "");
    } catch { /* keep UTC fallback */ }
    return `${Y}-${M}-${D}_${hh}-${mm}-${tz}`;
}
