// Wraps a promise so a stuck await becomes visible in the console: if it
// hasn't settled after `firstMs`, log a warning, then keep logging every
// `everyMs` until it does. Used around the discrete Mediabunny calls in the
// open/decode path so a hang tells us exactly which call we're blocked on
// rather than the player silently freezing.

export async function logIfSlow<T>(
    label: string,
    p: Promise<T>,
    opts?: { firstMs?: number; everyMs?: number },
): Promise<T> {
    const firstMs = opts?.firstMs ?? 5000;
    const everyMs = opts?.everyMs ?? 10000;
    const start = performance.now();
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
        if (done) return;
        console.warn(`[wait] still waiting on "${label}" after ${((performance.now() - start) / 1000).toFixed(1)}s`);
        timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, firstMs);
    try {
        return await p;
    } finally {
        done = true;
        clearTimeout(timer);
    }
}
