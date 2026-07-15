// The scan COORDINATOR — a SharedWorker (one instance across all tabs). It does
// NO scanning/decoding itself (a SharedWorker has no WebCodecs). Its only job is
// to appoint exactly ONE tab to host the dedicated scan Worker (which CAN decode),
// preferring a tab that:
//   1. has the folder handle,
//   2. isn't playing video (scanning there would lag playback — the thing we're
//      most trying to avoid), and
//   3. is unfocused, and has been unfocused the longest.
// If the host starts playing / gets focused (while a better tab exists) / closes,
// it appoints another. Tabs report their state on a heartbeat; a tab that stops
// heartbeating is considered gone.

declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    interface Tab {
        port: MessagePort;
        focused: boolean;
        playing: boolean;
        hasHandle: boolean;
        lastFocusedAt: number; // kept at "now" while focused; frozen when it blurs
        lastSeenAt: number;    // heartbeat liveness
    }
    const tabs: Tab[] = [];
    let host: Tab | undefined;

    // No heartbeat for this long ⇒ the tab is gone.
    const STALE_MS = 15_000;

    const eligible = (t: Tab): boolean => t.hasHandle && !t.playing;

    function pickBest(): Tab | undefined {
        const cands = tabs.filter(eligible);
        if (cands.length === 0) return undefined;
        cands.sort((a, b) =>
            (Number(a.focused) - Number(b.focused)) ||   // unfocused before focused
            (a.lastFocusedAt - b.lastFocusedAt));         // unfocused longest first
        return cands[0];
    }

    function setHost(next: Tab | undefined): void {
        if (next === host) return;
        const prev = host;
        host = next;
        if (prev && tabs.includes(prev)) { try { prev.port.postMessage({ type: "host", isHost: false }); } catch { /* gone */ } }
        if (host) { try { host.port.postMessage({ type: "host", isHost: true }); } catch { /* gone */ } }
    }

    function reevaluate(): void {
        // Keep the current host unless it's gone/ineligible, or it's now focused
        // while an unfocused eligible tab exists (move scanning off the tab the
        // user just switched to). Avoids thrashing on every focus blip.
        if (host && tabs.includes(host) && eligible(host)) {
            if (host.focused) {
                const best = pickBest();
                if (best && !best.focused) { setHost(best); return; }
            }
            return;
        }
        setHost(pickBest());
    }

    function prune(): void {
        const now = Date.now();
        let changed = false;
        for (let i = tabs.length - 1; i >= 0; i--) {
            if (now - tabs[i].lastSeenAt > STALE_MS) {
                if (tabs[i] === host) host = undefined;
                tabs.splice(i, 1);
                changed = true;
            }
        }
        if (changed) reevaluate();
    }
    setInterval(prune, 5_000);

    (self as any).onconnect = (e: MessageEvent) => {
        const port: MessagePort = e.ports[0];
        const tab: Tab = { port, focused: false, playing: false, hasHandle: false, lastFocusedAt: Date.now(), lastSeenAt: Date.now() };
        tabs.push(tab);
        port.onmessage = (ev: MessageEvent) => {
            const d = ev.data;
            if (!d || d.type !== "state") return;
            tab.lastSeenAt = Date.now();
            tab.focused = !!d.focused;
            tab.playing = !!d.playing;
            tab.hasHandle = !!d.hasHandle;
            if (tab.focused) tab.lastFocusedAt = Date.now();
            reevaluate();
        };
        port.start?.();
        reevaluate();
    };
}
