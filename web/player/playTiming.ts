let requestAt: number | undefined;
let requestPending = false;

export function markPlayRequest(label: string): void {
    requestAt = performance.now();
    requestPending = true;
    console.log(`[play-timing] +0ms play requested: ${label}`);
}

export function markPlaybackStart(key: string): void {
    if (requestPending && requestAt !== undefined) {
        requestPending = false;
        console.log(`[play-timing] ${playElapsed()} startPlayback ${key}`);
        return;
    }
    requestAt = performance.now();
    requestPending = false;
    console.log(`[play-timing] +0ms startPlayback ${key} (no click request pending; timing from here)`);
}

export function playElapsed(): string {
    if (requestAt === undefined) return "+?ms";
    return `+${(performance.now() - requestAt).toFixed(0)}ms`;
}
