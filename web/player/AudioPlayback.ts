// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import { AudioSample } from "mediabunny/dist/bundles/mediabunny.cjs";

// Schedules decoded AudioSamples on a WebAudio AudioContext. One short
// AudioBufferSourceNode per AC-3 frame (typically ~32 ms each at 48 kHz),
// chained back-to-back via AudioContext.currentTime so playback is seamless
// as long as the decoder can keep up.

const SCHEDULE_LEAD_SEC = 0.05;

// -3 dB. Standard ATSC/ITU down-mix attenuation for the center and surround
// channels when folding multichannel audio to stereo.
const R2 = Math.SQRT1_2;

// Fold multichannel PCM down to stereo. WebAudio only defines correct down-mix
// equations for mono/stereo/quad/5.1 — an 8-channel (7.1) AudioBuffer routed to
// a stereo output falls back to "discrete" mixing, which keeps channels 0-1
// (FL/FR) and silently DROPS the center, LFE and surround channels, so dialogue
// and effects vanish. We therefore down-mix ourselves. The plane order is
// FFmpeg's native layout (what the AC-3/E-AC-3 and DTS decoders emit):
// FL, FR, FC, LFE, BL, BR, SL, SR. LFE is dropped (standard for a stereo fold).
function downmixToStereo(planes: Float32Array[], frames: number): [Float32Array, Float32Array] {
    const ch = planes.length;
    const L = new Float32Array(frames);
    const R = new Float32Array(frames);
    const p = planes;
    for (let i = 0; i < frames; i++) {
        let l: number;
        let r: number;
        switch (ch) {
            case 3: // FL FR FC
                l = p[0][i] + R2 * p[2][i];
                r = p[1][i] + R2 * p[2][i];
                break;
            case 4: // FL FR BL BR (quad)
                l = p[0][i] + R2 * p[2][i];
                r = p[1][i] + R2 * p[3][i];
                break;
            case 5: // FL FR FC BL BR
                l = p[0][i] + R2 * p[2][i] + R2 * p[3][i];
                r = p[1][i] + R2 * p[2][i] + R2 * p[4][i];
                break;
            case 6: // FL FR FC LFE SL SR (5.1) — matches the WebAudio spec formula
                l = p[0][i] + R2 * p[2][i] + R2 * p[4][i];
                r = p[1][i] + R2 * p[2][i] + R2 * p[5][i];
                break;
            case 7: // FL FR FC LFE BC SL SR (6.1)
                l = p[0][i] + R2 * p[2][i] + 0.5 * p[4][i] + R2 * p[5][i];
                r = p[1][i] + R2 * p[2][i] + 0.5 * p[4][i] + R2 * p[6][i];
                break;
            case 8: // FL FR FC LFE BL BR SL SR (7.1)
                l = p[0][i] + R2 * p[2][i] + R2 * p[4][i] + R2 * p[6][i];
                r = p[1][i] + R2 * p[2][i] + R2 * p[5][i] + R2 * p[7][i];
                break;
            default: { // unexpected count: keep FL/FR, fold the rest in at -3 dB
                l = p[0][i];
                r = p[1][i];
                for (let c = 2; c < ch; c++) { const v = R2 * p[c][i]; l += v; r += v; }
            }
        }
        L[i] = l;
        R[i] = r;
    }
    return [L, R];
}
// If we ever fall behind by more than this against the audio clock, we reset
// the wall-clock baseline rather than queueing audio in the past (which would
// just be dropped and create a long silent gap).
const UNDERFLOW_THRESHOLD_SEC = 0.005;

// Chrome creates AudioContexts in `suspended` state unless `new AudioContext()`
// runs during transient user activation. By the time we get to play() through
// several awaits, the activation has expired — so we build a singleton context
// from a click handler and hand it to AudioPlayback later.
let sharedCtx: AudioContext | undefined;

export function primeAudioContext(): AudioContext {
    if (!sharedCtx) {
        sharedCtx = new AudioContext();
        sharedCtx.addEventListener("statechange", () => {
            console.log(`[audio] shared ctx state → ${sharedCtx?.state}`);
        });
        console.log(`[audio] primed shared AudioContext (state=${sharedCtx.state})`);
    } else if (sharedCtx.state === "suspended") {
        void sharedCtx.resume().then(() => {
            console.log(`[audio] shared ctx resumed (state=${sharedCtx?.state})`);
        });
    }
    return sharedCtx;
}

// Whether the shared context exists and is actually running. Chrome refuses to
// start an AudioContext outside a user gesture, leaving it "suspended" — in that
// state scheduling audio is silently dropped. Callers use this to avoid starting
// video that would race ahead of muted audio.
export function isAudioContextRunning(): boolean {
    return !!sharedCtx && sharedCtx.state === "running";
}

export class AudioPlayback {
    private ctx: AudioContext | undefined;
    private gain: GainNode | undefined;
    private scheduled = new Set<AudioBufferSourceNode>();
    // The first scheduled sample anchors media-time → ctx-time.
    private firstSampleMediaSec: number | undefined;
    private firstSampleCtxSec: number | undefined;
    // Media timestamp of the END of the last sample we scheduled. Used by the
    // caller to throttle how far ahead it pre-queues audio.
    private scheduledThroughMediaSec: number | undefined;
    private totalScheduled = 0;
    // Caller-set volume in [0, 1]. Stored even before the ctx/gain exist so we
    // can apply it the moment they're created.
    private volume = 1;

    private ensureCtx(): AudioContext {
        if (!this.ctx) {
            // Prefer the shared (pre-primed) context. Falls back to creating one
            // here for code paths that don't go through a click handler (tests).
            this.ctx = sharedCtx ?? primeAudioContext();
            console.log(`[audio] AudioPlayback using ctx (state=${this.ctx.state}, rate=${this.ctx.sampleRate}Hz, maxOutCh=${this.ctx.destination.maxChannelCount})`);
            // Single gain node we route everything through, so we can adjust the
            // volume on the fly without rebuilding the graph for each chunk.
            this.gain = this.ctx.createGain();
            this.gain.gain.value = this.volume;
            this.gain.connect(this.ctx.destination);
        }
        if (this.ctx.state === "suspended") {
            void this.ctx.resume();
        }
        return this.ctx;
    }

    setVolume(v: number): void {
        const clamped = Math.max(0, Math.min(1, v));
        this.volume = clamped;
        if (this.gain && this.ctx) {
            // setTargetAtTime gives a tiny smoothing so a step change doesn't
            // click. Time constant of ~10ms is inaudibly fast.
            this.gain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
        }
    }

    getVolume(): number { return this.volume; }

    // How far ahead of the current audio playhead we've queued samples, in
    // seconds. The iterator uses this for backpressure.
    get bufferAheadSec(): number {
        if (this.scheduledThroughMediaSec === undefined) return 0;
        return this.scheduledThroughMediaSec - this.currentMediaTimeSec;
    }

    get scheduledCount(): number { return this.scheduled.size; }

    async resume(): Promise<void> {
        if (this.ctx && this.ctx.state === "suspended") {
            await this.ctx.resume();
            console.log(`[audio] resumed (ctx.currentTime=${this.ctx.currentTime.toFixed(3)})`);
        }
    }

    async suspend(): Promise<void> {
        if (this.ctx && this.ctx.state === "running") {
            await this.ctx.suspend();
            console.log(`[audio] suspended`);
        }
    }

    // Media-time projection from the audio clock. Used as the master clock for
    // A/V sync. Returns 0 before the first sample is scheduled.
    get currentMediaTimeSec(): number {
        if (!this.ctx || this.firstSampleMediaSec === undefined || this.firstSampleCtxSec === undefined) return 0;
        return this.firstSampleMediaSec + (this.ctx.currentTime - this.firstSampleCtxSec);
    }

    get hasContext(): boolean { return !!this.ctx; }

    // True once the first sample has been scheduled — at that point the
    // anchor (firstSampleMediaSec, firstSampleCtxSec) is set and
    // `currentMediaTimeSec` is meaningful. Video uses this to know when it
    // can switch from wall-clock pacing to audio-master pacing.
    get isAnchored(): boolean {
        return this.firstSampleMediaSec !== undefined && this.firstSampleCtxSec !== undefined;
    }

    schedule(sample: AudioSample): void {
        const ctx = this.ensureCtx();
        const ch = sample.numberOfChannels;
        const frames = sample.numberOfFrames;
        const rate = sample.sampleRate;
        let buffer: AudioBuffer;
        if (ch > 2) {
            // Down-mix multichannel (5.1 / 7.1 / ...) to stereo ourselves — the
            // browser's automatic down-mix drops channels for 7.1. See
            // downmixToStereo.
            const planes: Float32Array[] = [];
            for (let c = 0; c < ch; c++) {
                const arr = new Float32Array(frames);
                sample.copyTo(arr, { planeIndex: c, format: "f32-planar" });
                planes.push(arr);
            }
            const [left, right] = downmixToStereo(planes, frames);
            buffer = ctx.createBuffer(2, frames, rate);
            buffer.copyToChannel(left, 0);
            buffer.copyToChannel(right, 1);
        } else {
            buffer = ctx.createBuffer(ch, frames, rate);
            for (let c = 0; c < ch; c++) {
                const arr = new Float32Array(frames);
                sample.copyTo(arr, { planeIndex: c, format: "f32-planar" });
                buffer.copyToChannel(arr, c);
            }
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain ?? ctx.destination);

        const ts = sample.timestamp;
        if (this.firstSampleMediaSec === undefined) {
            this.firstSampleMediaSec = ts;
            this.firstSampleCtxSec = ctx.currentTime + SCHEDULE_LEAD_SEC;
            console.log(`[audio] first sample mediaTs=${ts.toFixed(3)}s anchored to ctx=${this.firstSampleCtxSec.toFixed(3)}s`);
        }
        let startAt = this.firstSampleCtxSec! + (ts - this.firstSampleMediaSec!);
        if (startAt < ctx.currentTime + UNDERFLOW_THRESHOLD_SEC) {
            // Decoder fell behind. Slip the anchor forward so we don't try to
            // schedule audio in the past (which would just be discarded).
            const slip = (ctx.currentTime + UNDERFLOW_THRESHOLD_SEC) - startAt;
            this.firstSampleCtxSec! += slip;
            startAt += slip;
            console.warn(`[audio] underflow, slipped ${(slip * 1000).toFixed(1)}ms`);
        }
        source.start(startAt);
        this.scheduled.add(source);
        source.onended = () => this.scheduled.delete(source);
        this.scheduledThroughMediaSec = ts + sample.duration;
        this.totalScheduled++;
        if (this.totalScheduled === 1 || this.totalScheduled % 100 === 0) {
            console.log(`[audio] scheduled #${this.totalScheduled} at media=${ts.toFixed(2)}s → ctx=${startAt.toFixed(2)}s (ctxNow=${ctx.currentTime.toFixed(2)}, live=${this.scheduled.size})`);
        }
    }

    // Stops everything queued and clears the anchor. Used for seek and end.
    flush(): void {
        for (const s of this.scheduled) {
            try { s.stop(); } catch { /* already stopped */ }
        }
        this.scheduled.clear();
        this.firstSampleMediaSec = undefined;
        this.firstSampleCtxSec = undefined;
        this.scheduledThroughMediaSec = undefined;
        this.totalScheduled = 0;
    }

    close(): void {
        this.flush();
        // Don't close the shared ctx — other playback sessions reuse it. Just
        // detach our reference.
        this.ctx = undefined;
    }
}
