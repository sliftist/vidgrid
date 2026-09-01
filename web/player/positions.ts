// Playback position per video, in milliseconds. One localStorage key each.

const PREFIX = "vidgrid.pos.";

export function getPositionMs(key: string): number | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function setPositionMs(key: string, ms: number): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(PREFIX + key, String(Math.round(ms)));
    } catch (e) {
        console.warn("[positions] could not store position:", e);
    }
}
