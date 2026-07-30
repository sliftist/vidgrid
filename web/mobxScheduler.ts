// Global mobx reaction scheduler — installed once at boot (browser.tsx),
// replacing sliftutils' configureMobxNextFrameScheduler.
//
// Why: without a scheduler, every observable write runs all its reactions
// SYNCHRONOUSLY inline — a stream of per-frame status/DB writes re-renders
// observers at write rate, on the same main thread as the video decode loop
// and the audio scheduling pump. Batching reaction flushes to animation
// frames caps reaction-driven render work at display rate no matter how hot
// the writes are. (The sliftutils version also mixed Date.now() into a
// performance.now() comparison, so its "recent render" check never behaved.)
//
// Variable delay:
//   - A reaction arriving after a LULL flushes on a 0ms timeout — a click's
//     re-render lands immediately instead of waiting up to a frame.
//   - Under sustained update pressure (something flushed within the last
//     LULL_MS), reactions batch to requestAnimationFrame — one flush per
//     displayed frame, no matter how many writes occurred.
//   - No rAF in this context (workers) → 16ms timeout stands in for a frame.

import * as mobx from "mobx";

const LULL_MS = 50;

export function configureMobxRafScheduler(): void {
    const pending: (() => void)[] = [];
    let flushScheduled = false;
    let lastFlushAt = 0;

    const flush = () => {
        flushScheduled = false;
        lastFlushAt = performance.now();
        // Callbacks can queue more reactions; those belong to the NEXT flush,
        // so snapshot before running.
        const callbacks = pending.splice(0, pending.length);
        for (const cb of callbacks) cb();
    };

    mobx.configure({
        enforceActions: "never",
        reactionScheduler(callback: () => void) {
            pending.push(callback);
            if (flushScheduled) return;
            flushScheduled = true;
            if (performance.now() - lastFlushAt >= LULL_MS) {
                // Lull — run promptly (but off the current stack, so the write
                // that triggered us finishes first).
                setTimeout(flush, 0);
                return;
            }
            if (typeof requestAnimationFrame !== "undefined") {
                requestAnimationFrame(flush);
                return;
            }
            setTimeout(flush, 16);
        },
    });
}
