// Imperative bridge from the heygoogle device protocol to the live player.
// PlayerPage registers its control callbacks here on mount and clears them on
// unmount; the device-call dispatcher reaches the player through this registry
// without importing the component or its module-private player instance.

export type PlayerStatusSummary = {
    playing: boolean;
    paused: boolean;
    ended: boolean;
    currentTimeMs: number;
    durationMs: number;
};

export type PlayerControls = {
    togglePause: () => void;
    pause: () => void;
    resume: () => void;
    playNext: () => boolean;
    playPrev: () => boolean;
    // Jump to an episode by its 1-based position in the current series.
    playEpisode: (episode: number) => boolean;
    getStatus: () => PlayerStatusSummary | undefined;
};

let controls: PlayerControls | undefined;

export function registerPlayerControls(c: PlayerControls): void {
    controls = c;
}

export function clearPlayerControls(c: PlayerControls): void {
    // Only clear if the registered controls are still ours — guards against a
    // remounting page's unmount racing past a newer mount.
    if (controls === c) controls = undefined;
}

export function getPlayerControls(): PlayerControls | undefined {
    return controls;
}
