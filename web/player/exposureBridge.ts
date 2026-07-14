// Neutral bridge so the info modal can push a live HDR exposure to the active
// player without importing PlayerPage (which would create an import cycle).
// PlayerPage registers a sink when it builds a player and clears it on
// teardown; the modal calls applyLiveExposure on every keystroke.

let sink: ((ls: number) => void) | undefined;

export function setExposureSink(fn: ((ls: number) => void) | undefined): void {
    sink = fn;
}

export function applyLiveExposure(ls: number): void {
    sink?.(ls);
}
