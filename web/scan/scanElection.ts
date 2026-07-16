// Wire-format constants for the scan-coordinator election + build-version
// bookkeeping used by BOTH the tab and the coordinator SharedWorker.
//
// The election runs on a BroadcastChannel: on spawn AND every 60s the coordinator
// broadcasts `whoIsAlive`; every other coordinator replies with `alive` carrying
// its BUILD_TIMESTAMP. Any coordinator that hears a version STRICTLY newer than
// its own self-closes. Highest timestamp wins.
//
// Tabs pick which coordinator to talk to via a `?v=<formattedTimestamp>` query
// on the SharedWorker URL: that query is a *cache buster* (the server ignores
// it) AND part of the SharedWorker's identity — a newer timestamp means a
// different URL, which the browser treats as a new SharedWorker key. So every
// tab, on boot, bumps a localStorage cell to max(stored, BUILD_TIMESTAMP) and
// uses that timestamp in the URL. A stale tab that reboots after a newer tab has
// bumped the cell picks up the newer URL for free, no coordination required.

export const ELECTION_CHANNEL_NAME = "vidgrid-scan-coordinator-election";

export type ElectionMsg =
    | { type: "whoIsAlive" }
    | { type: "alive"; version: string };

// localStorage cell: the latest build timestamp any tab on this browser has ever
// booted with. We store it in raw ISO form (BUILD_TIMESTAMP) so string
// comparison sorts chronologically.
export const COORD_VERSION_LS_KEY = "vidgrid-scan-coord-version";

// Format an ISO build timestamp as a human-readable slug that goes into the
// SharedWorker URL's ?v= query — the format itself is the whole point: it's
// what a user sees in the URL when opening DevTools ("what time was this built,
// in my local time?"). Deterministic per browser (uses the browser's local TZ)
// so different tabs on the same browser produce the same slug and dedupe to the
// same SharedWorker. URL-safe (only alnum, '-', '_').
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

// Read the max-seen build timestamp from localStorage, bumping it up to
// `ourTimestamp` if we're newer. Returns whichever is greater. Safe if
// localStorage is unavailable (private mode) — we just return our own.
export function bumpCoordVersion(ourTimestamp: string): string {
    let stored: string | null = null;
    try { stored = localStorage.getItem(COORD_VERSION_LS_KEY); } catch { /* ignore */ }
    // ISO timestamps sort lexicographically == chronologically.
    const winner = (stored && stored > ourTimestamp) ? stored : ourTimestamp;
    if (winner !== stored) {
        try { localStorage.setItem(COORD_VERSION_LS_KEY, winner); } catch { /* ignore */ }
    }
    return winner;
}
