// Single source of truth for "is this tab in the background?".
//
// A backgrounded tab must do no disk I/O: both the disk scanner and the video
// player gate on this. The motivating bug was a forgotten background tab
// pinning the disk at 100% with scan/playback reads the user couldn't see.
//
// Lazy-initialized (no import-time side effects) — the visibilitychange
// listener is attached on first use.

let initialized = false;
let hidden = false;
const listeners = new Set<(hidden: boolean) => void>();

function ensureInit(): void {
    if (initialized) return;
    initialized = true;
    if (typeof document === "undefined") return;
    hidden = document.hidden;
    document.addEventListener("visibilitychange", () => {
        const next = document.hidden;
        if (next === hidden) return;
        hidden = next;
        for (const l of listeners) l(hidden);
    });
}

export function isTabHidden(): boolean {
    ensureInit();
    return hidden;
}

// Subscribe to hidden↔visible transitions. Returns an unsubscribe function.
export function onVisibilityChange(cb: (hidden: boolean) => void): () => void {
    ensureInit();
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
