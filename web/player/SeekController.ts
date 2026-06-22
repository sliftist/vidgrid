import { PlayerStatus } from "./VideoPlayer";

// Coalesces seek requests so a stream of "+5s" hotkey presses doesn't issue a
// seek faster than the decoder can render. Each requestRelative bumps the
// running target; we only issue one seek at a time, and don't issue the next
// until `onStatus` shows that the previous one has produced a rendered frame.
//
// Net effect: when paused and the user holds → for half a second, we end up at
// the right time but in one or two big jumps instead of many tiny seeks that
// each abort each other mid-decode.

const DEFAULT_FPS = 24;

export interface SeekControllerHost {
    seek(sec: number): void;
    getCurrentTimeSec(): number;
}

export class SeekController {
    // Pending target — the seek the user has asked for but we haven't yet
    // issued. Cleared the moment we issue; new requests put a new value here.
    // The distinction between "pending" and "in-flight" is what keeps us from
    // re-firing the same seek when the decoder lands on a slightly different
    // frame than the request (e.g. Mediabunny snaps to its nearest decoded
    // frame, which may be ~1 frame before the request).
    private pendingTarget: number | undefined;
    private inFlightSec: number | undefined;
    private framesAtIssue = 0;
    private lastFramesRendered = 0;

    constructor(private host: SeekControllerHost) { }

    requestRelative(deltaSec: number): void {
        // Compose against whichever target is most recent: the one we're still
        // queuing, the one we already sent to the player, or our current time.
        const base = this.pendingTarget ?? this.inFlightSec ?? this.host.getCurrentTimeSec();
        this.pendingTarget = Math.max(0, base + deltaSec);
        this.tryIssue();
    }

    requestAbsolute(sec: number): void {
        this.pendingTarget = Math.max(0, sec);
        this.tryIssue();
    }

    // Steps exactly one frame in `direction` (+1 forward, -1 backward).
    // We snap to the floor frame of the current target, step by 1, and place
    // playback at the *middle* of the destination frame so rounding doesn't
    // accidentally skip or duplicate a frame on the next call.
    frameStep(direction: 1 | -1, fps: number | undefined): void {
        const f = (fps && fps > 0) ? fps : DEFAULT_FPS;
        const base = this.pendingTarget ?? this.inFlightSec ?? this.host.getCurrentTimeSec();
        const baseFrame = Math.floor(base * f);
        const targetFrame = Math.max(0, baseFrame + direction);
        this.pendingTarget = (targetFrame + 0.5) / f;
        this.tryIssue();
    }

    onStatus(s: PlayerStatus): void {
        this.lastFramesRendered = s.framesRendered;
        if (this.inFlightSec === undefined) return;
        // Any new rendered frame after we issued the seek counts as "landed".
        // The frame may be a few ms off the request (Mediabunny snaps to the
        // nearest decoded frame) — we don't try to chase that; if the user
        // wanted to go further they'll have put a new value in pendingTarget.
        if (s.framesRendered > this.framesAtIssue) {
            this.inFlightSec = undefined;
            this.tryIssue();
        }
    }

    cancel(): void {
        this.pendingTarget = undefined;
        this.inFlightSec = undefined;
    }

    private tryIssue(): void {
        if (this.pendingTarget === undefined) return;
        if (this.inFlightSec !== undefined) return;
        const t = this.pendingTarget;
        // Consume — if the seek lands "off by a frame" we won't loop because
        // pendingTarget is now empty until the next user request.
        this.pendingTarget = undefined;
        this.inFlightSec = t;
        this.framesAtIssue = this.lastFramesRendered;
        this.host.seek(t);
    }
}
