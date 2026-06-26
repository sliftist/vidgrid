// Auto-scan disk throttle.
//
// When a scan was *auto-started* (just from loading the page) — rather than the
// user explicitly clicking Scan/Force or one of the per-phase buttons — we
// deliberately slow it so a spinning disk that's also serving video playback
// isn't saturated. User- and force-initiated scans skip all of this entirely
// (autoThrottle stays false), so an explicit request runs full speed.
//
// Three independent brakes, all no-ops unless an auto scan is active:
//   - every READ_REST_BYTES of disk reads, pause READ_REST_MS (the primary
//     "let the disk breathe" brake; applies across metadata/keyframes/faces
//     since all their byte reads funnel through the extractor worker).
//   - heavy per-item phases (keyframes, faces) pause HEAVY_ITEM_MS between
//     each file.
//   - light high-count phases (file walk, metadata+thumbnails) run in
//     DUTY_ON_MS bursts then rest DUTY_REST_MS — a flat per-file pause there
//     would crawl across thousands of files.

const READ_REST_BYTES = 100 * 1024 * 1024;
const READ_REST_MS = 5_000;
const HEAVY_ITEM_MS = 5_000;
const DUTY_ON_MS = 20_000;
const DUTY_REST_MS = 5_000;

let autoThrottle = false;
let cancelled = false;
let bytesSinceRest = 0;
let dutyOnStart = 0;

export function beginThrottledScan(): void {
    autoThrottle = true;
    cancelled = false;
    bytesSinceRest = 0;
    dutyOnStart = Date.now();
}

export function endThrottledScan(): void {
    autoThrottle = false;
}

// Let an in-progress throttle pause wake immediately when the user stops the
// scan, instead of stranding the loop in a multi-second sleep.
export function cancelThrottle(): void {
    cancelled = true;
}

async function sleep(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!cancelled) {
        const left = until - Date.now();
        if (left <= 0) return;
        await new Promise(r => setTimeout(r, Math.min(200, left)));
    }
}

// Call after each scan read returns, with its byte count. Rests once a full
// READ_REST_BYTES has accumulated. `onBeforeRest` (when a rest is due) lets the
// caller refresh its watchdog timeout so the deliberate pause isn't mistaken
// for a stuck worker. Returns true if it actually slept.
export async function throttleScanRead(bytes: number, onBeforeRest?: () => void): Promise<boolean> {
    if (!autoThrottle || cancelled) return false;
    bytesSinceRest += bytes;
    if (bytesSinceRest < READ_REST_BYTES) return false;
    bytesSinceRest = 0;
    onBeforeRest?.();
    await sleep(READ_REST_MS);
    dutyOnStart = Date.now();
    return true;
}

// Between heavy per-item iterations (keyframes / faces): a flat rest per file.
export async function throttleHeavyItem(): Promise<void> {
    if (!autoThrottle || cancelled) return;
    await sleep(HEAVY_ITEM_MS);
    dutyOnStart = Date.now();
}

// For light, high-count phases (file walk, metadata): rest only once the
// current on-window has run DUTY_ON_MS, then open a fresh window.
export async function throttleDutyCycle(): Promise<void> {
    if (!autoThrottle || cancelled) return;
    if (Date.now() - dutyOnStart < DUTY_ON_MS) return;
    await sleep(DUTY_REST_MS);
    dutyOnStart = Date.now();
}
