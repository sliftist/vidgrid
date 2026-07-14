// Neutral bridge so the info modal can push a live HDR exposure to the active
// player without importing PlayerPage (which would create an import cycle).
// PlayerPage registers a sink when it builds a player and clears it on
// teardown; the modal calls applyLiveExposure on every keystroke.

import { observable, runInAction } from "mobx";

let sink: ((ls: number) => void) | undefined;

export function setExposureSink(fn: ((ls: number) => void) | undefined): void {
    sink = fn;
}

export function applyLiveExposure(ls: number): void {
    sink?.(ls);
}

// The key of the currently-playing video IF the decoder has confirmed it's HDR
// (a PQ/HLG frame was decoded). Container metadata often fails to tag HDR, so
// this frame-derived signal is what the info modal trusts to show its exposure
// control. Cleared when playback tears down or the video isn't HDR.
const activeHdrKeyBox = observable.box<string | undefined>(undefined);

export function setActiveHdrKey(key: string | undefined): void {
    runInAction(() => activeHdrKeyBox.set(key));
}

export function getActiveHdrKey(): string | undefined {
    return activeHdrKeyBox.get();
}
