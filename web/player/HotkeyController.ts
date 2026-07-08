// Global keyboard hotkeys with our own key-repeat. We intentionally ignore the
// OS auto-repeat (`event.repeat === true`) and drive repeats from a setInterval
// — that way the user gets instant first-tick + a fast, consistent cadence
// regardless of their OS-level repeat delay/rate. Press-and-release cycles also
// cleanly snap to "exactly one tick" for non-repeat actions like Space.

const REPEAT_INTERVAL_MS = 80;

export interface HotkeyBinding {
    onTick: () => void;
    repeat?: boolean; // default false — set true for seek/volume/frame keys
}

export type HotkeyBindings = { [key: string]: HotkeyBinding };

export class HotkeyController {
    private bindings: HotkeyBindings = {};
    private active = new Map<string, number>();
    private bound = false;

    constructor(bindings: HotkeyBindings = {}) {
        this.bindings = bindings;
    }

    setBindings(bindings: HotkeyBindings) {
        this.bindings = bindings;
    }

    attach() {
        if (this.bound) return;
        this.bound = true;
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onBlur);
    }

    detach() {
        if (!this.bound) return;
        this.bound = false;
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        for (const id of this.active.values()) window.clearInterval(id);
        this.active.clear();
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (e.repeat) return;
        // Only fire on the bare key — a command modifier means the user is
        // invoking a browser/OS shortcut (Ctrl/Cmd+F find, Alt+←, etc.), not our
        // hotkey. Shift is deliberately allowed: the uppercase "F"/"M" bindings
        // exist to catch the shifted/CapsLock form of those keys.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const binding = this.bindings[e.key];
        if (!binding) return;
        // Don't hijack typing in form fields.
        const target = e.target as HTMLElement | null;
        if (target) {
            const tag = target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            if (target.isContentEditable) return;
        }
        e.preventDefault();
        binding.onTick();
        if (binding.repeat) {
            if (this.active.has(e.key)) return;
            const id = window.setInterval(() => {
                try { binding.onTick(); } catch (err) { console.error("[hotkey] tick failed:", err); }
            }, REPEAT_INTERVAL_MS);
            this.active.set(e.key, id);
        }
    };

    private onKeyUp = (e: KeyboardEvent) => {
        const id = this.active.get(e.key);
        if (id !== undefined) {
            window.clearInterval(id);
            this.active.delete(e.key);
        }
    };

    private onBlur = () => {
        for (const id of this.active.values()) window.clearInterval(id);
        this.active.clear();
    };
}
