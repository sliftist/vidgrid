// One tab at a time gets to run the models.
//
// Every tab has its own workers, its own onnxruntime, and its own copy of the
// weights on the GPU. Two tabs generating at once is two Parakeets and two
// language models resident simultaneously -- several gigabytes of VRAM for
// work that is not twice as fast, and on a smaller card it is the difference
// between running and failing to allocate.
//
// So starting a run in one tab tells the others to stop theirs and give their
// weights back. This is deliberately a broadcast rather than a lock: a lock
// would make the new tab wait for whoever holds it, and the tab the viewer is
// looking at is the one that should win.

const CHANNEL = "vidgrid.subtitleGen.work";

// Per-tab, so a tab ignores its own broadcast.
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let channel: BroadcastChannel | undefined;
let onYield: (() => void) | undefined;

function ensureChannel(): BroadcastChannel | undefined {
    if (channel) return channel;
    if (typeof BroadcastChannel === "undefined") return undefined;   // older browser: no coordination
    channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as { type?: string; from?: string } | undefined;
        if (!d || d.type !== "claim" || d.from === tabId) return;
        console.log("[subtitleGen] another tab started generating; stopping this one and freeing the GPU");
        onYield?.();
    });
    return channel;
}

// Called once at startup with whatever "stop everything and unload" means here.
export function onWorkClaimedElsewhere(handler: () => void): void {
    onYield = handler;
    ensureChannel();
}

// Announce that this tab is about to use the models.
export function claimModelWork(): void {
    try { ensureChannel()?.postMessage({ type: "claim", from: tabId }); } catch { /* no channel */ }
}
