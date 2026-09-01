import { observable, runInAction } from "mobx";

const timeMs = observable.box(0);
const durationMs = observable.box(0);

export function playbackTimeMs(): number {
    return timeMs.get();
}

export function playbackDurationMs(): number {
    return durationMs.get();
}

export function setPlaybackTimeMs(ms: number): void {
    if (timeMs.get() === ms) return;
    runInAction(() => timeMs.set(ms));
}

export function setPlaybackDurationMs(ms: number): void {
    if (durationMs.get() === ms) return;
    runInAction(() => durationMs.set(ms));
}
