import { observable, runInAction } from "mobx";

// Tracks whether the user has stopped moving the mouse, so a UI overlay can
// auto-hide. Movements below MIN_MOVE_PX are ignored to avoid bouncing on hand
// jitter; the cursor is also considered "active" while it's hovering any
// element wired up via `setHoveringOverlay`.

const MIN_MOVE_PX = 2;
const DEFAULT_TIMEOUT_MS = 5000;

export interface MouseIdleState {
    active: boolean;
}

export class MouseIdleTracker {
    readonly state: MouseIdleState = observable({ active: true });
    private lastX = 0;
    private lastY = 0;
    private lastMoveAt = performance.now();
    private hoveringOverlay = false;
    private timerId: number | undefined;
    private bound = false;
    private timeoutMs: number;

    constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
    }

    attach() {
        if (this.bound) return;
        this.bound = true;
        window.addEventListener("mousemove", this.onMove);
        window.addEventListener("mousedown", this.onMove);
        window.addEventListener("touchstart", this.onMove);
        window.addEventListener("touchmove", this.onMove);
        window.addEventListener("keydown", this.onMove);
        this.scheduleCheck();
    }

    detach() {
        if (!this.bound) return;
        this.bound = false;
        window.removeEventListener("mousemove", this.onMove);
        window.removeEventListener("mousedown", this.onMove);
        window.removeEventListener("touchstart", this.onMove);
        window.removeEventListener("touchmove", this.onMove);
        window.removeEventListener("keydown", this.onMove);
        if (this.timerId !== undefined) {
            window.clearTimeout(this.timerId);
            this.timerId = undefined;
        }
    }

    // Caller sets this true while the mouse is inside any overlay element, so
    // hovering over a control keeps the overlay visible even without movement.
    setHoveringOverlay(hovering: boolean) {
        this.hoveringOverlay = hovering;
        this.markActive();
    }

    // Force "active" without a real mouse event — e.g. volume changed via
    // keyboard, we want the indicator visible briefly.
    poke() {
        this.markActive();
    }

    private onMove = (e: MouseEvent | TouchEvent | KeyboardEvent) => {
        if (e instanceof MouseEvent) {
            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;
            if (Math.hypot(dx, dy) < MIN_MOVE_PX) return;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
        }
        this.markActive();
    };

    private markActive() {
        this.lastMoveAt = performance.now();
        if (!this.state.active) runInAction(() => { this.state.active = true; });
        this.scheduleCheck();
    }

    private scheduleCheck() {
        if (this.timerId !== undefined) window.clearTimeout(this.timerId);
        this.timerId = window.setTimeout(() => this.check(), this.timeoutMs + 50);
    }

    private check() {
        this.timerId = undefined;
        if (this.hoveringOverlay) {
            // Stay active while hovered — re-check in a moment in case hover ends.
            this.scheduleCheck();
            return;
        }
        const idleMs = performance.now() - this.lastMoveAt;
        if (idleMs >= this.timeoutMs) {
            if (this.state.active) runInAction(() => { this.state.active = false; });
        } else {
            this.timerId = window.setTimeout(() => this.check(), this.timeoutMs - idleMs);
        }
    }
}
