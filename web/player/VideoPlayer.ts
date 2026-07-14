// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import {
    Input,
    CustomSource,
    ALL_FORMATS,
    VideoSampleSink,
    AudioSampleSink,
    EncodedPacketSink,
    InputVideoTrack,
    InputAudioTrack,
} from "mediabunny/dist/bundles/mediabunny.cjs";
import { WebGpuRenderer } from "./WebGpuRenderer";
import { Canvas2DRenderer } from "./Canvas2DRenderer";

interface FrameRenderer {
    init(): Promise<void>;
    // May be async: the HDR path reads back the frame's planes via copyTo().
    render(frame: VideoFrame): void | Promise<void>;
    // Optional: repaint the last frame with current settings. Lets the HDR
    // tone-map update while paused (no new frames are being decoded). Only the
    // WebGPU renderer implements it.
    redraw?(): void;
    destroy(): void;
    // Optional: hint that the stream is HDR so the renderer tone-maps to SDR.
    // Only the WebGPU renderer needs it; the 2D canvas already tone-maps.
    setHdrHint?(hdr: boolean): void;
    // Optional: fired when the renderer's GPU device is lost out from under it
    // (driver reset / GPU wedged). Submits silently no-op after this, so the
    // player must rebuild the whole pipeline.
    onDeviceLost?: (message: string) => void;
}
import { ensureAc3Decoder } from "./AudioCodecLoader";
import { AudioPlayback, isAudioContextRunning } from "./AudioPlayback";
import { DtsAudioSink, looksLikeDtsCore } from "./DtsAudioSink";
import { ensureMp4vDecoder } from "./Mp4vDecoder";
import { logIfSlow } from "./waitLogger";
import { MediaFile, softwareDecode, hdrExposure } from "../appState";
import { reaction } from "mobx";

export interface PlayerStatus {
    state: "idle" | "opening" | "playing" | "ended" | "error";
    framesDecoded: number;
    framesRendered: number;
    framesDropped: number;
    // Rolling 1s render rate (telemetry).
    fps: number;
    // Nominal frame rate of the source as reported by Mediabunny's packet
    // stats — used for frame-by-frame stepping. May be undefined if the source
    // didn't have enough packets to estimate or it isn't a frame-paced stream.
    nominalFps?: number;
    paused: boolean;
    audioEnabled: boolean;
    volume: number;
    codecString?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    currentTimeMs?: number;
    durationMs?: number;
    error?: string;
    // The pipeline step currently in flight (e.g. "Opening file", "Decoding
    // video frame", "Waiting for audio clock"). Continuously overwritten as
    // the engine works; the UI only surfaces it when playback is stalled, so
    // it always points at whatever we're blocked on at that moment.
    waitingFor?: string;
    // The renderer's GPU device was lost (driver reset / GPU wedged by another
    // app). Frames keep "rendering" but nothing paints — the owner should
    // rebuild playback with a fresh pipeline.
    gpuDeviceLost?: boolean;
}

export type PlayerListener = (s: PlayerStatus) => void;

const LOG_PREFIX = "[player]";
function log(...args: unknown[]) { console.log(LOG_PREFIX, ...args); }

// Seconds of decoded audio we allow ahead of the audio clock before pausing the
// decoder. Two seconds is plenty of cushion for a slow decoder hiccup while
// keeping the AudioContext's scheduled-source list small.
const AUDIO_BUFFER_AHEAD_SEC = 2;

// If the audio clock fails to advance toward the next video frame for this
// long, stop waiting on it and render anyway — a stalled AudioContext must
// not freeze the picture.
const AUDIO_SYNC_MAX_WAIT_MS = 3000;

export class VideoPlayer {
    private canvas: HTMLCanvasElement;
    private renderer: FrameRenderer | undefined;
    private status: PlayerStatus = {
        state: "idle", framesDecoded: 0, framesRendered: 0, framesDropped: 0,
        fps: 0, paused: false, audioEnabled: false, volume: 1,
    };
    private listeners = new Set<PlayerListener>();
    private cancelled = false;
    private paused = false;
    private pauseStartedAtMs: number | undefined;
    private firstWallClockMs: number | undefined;
    private firstSampleTsMs: number | undefined;
    // Wall-clock timestamps of recent renders, trimmed to a 1s window. Length = FPS.
    private renderTimes: number[] = [];
    // When set, the running iteration breaks out and play() restarts from this
    // timestamp. Used by seek().
    private pendingSeekSec: number | undefined;
    private input: Input | undefined;
    private videoSink: VideoSampleSink | undefined;
    private videoTrack: InputVideoTrack | undefined;
    private audioSink: AudioSampleSink | DtsAudioSink | undefined;
    private audioTrack: InputAudioTrack | undefined;
    private audioPlayback: AudioPlayback | undefined;
    // DTS (DCA) tracks are demuxed by mediabunny but decoded by our pure-JS
    // decoder via DtsAudioSink instead of the WebCodecs-backed AudioSampleSink.
    private audioIsDts = false;
    // The step currently in flight; see setOp / PlayerStatus.waitingFor.
    private currentOp: string | undefined;
    // Disposes the reaction that repaints the current frame when the HDR
    // exposure changes while paused.
    private exposureReactionDispose: (() => void) | undefined;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        // While paused, the frame loop is parked, so a tone-map (HDR exposure)
        // change wouldn't be visible until playback resumes. Repaint the last
        // frame on change so tuning the slider while paused updates the picture.
        this.exposureReactionDispose = reaction(
            () => hdrExposure.get(),
            () => { if (this.paused) this.renderer?.redraw?.(); },
        );
    }

    subscribe(l: PlayerListener): () => void {
        this.listeners.add(l);
        l(this.status);
        return () => this.listeners.delete(l);
    }

    private update(patch: Partial<PlayerStatus>) {
        this.status = { ...this.status, ...patch };
        for (const l of this.listeners) l(this.status);
    }

    // Record (and publish) the step we're about to block on. Deduped so the
    // steady frame loop, which re-asserts the same op every iteration, only
    // emits an update when the op actually changes.
    private setOp(op: string | undefined) {
        if (this.currentOp === op) return;
        this.currentOp = op;
        this.update({ waitingFor: op });
    }

    // setOp + logIfSlow in one: publish the step to the UI and warn to the
    // console if the awaited call hangs. For the discrete open-path calls.
    private step<T>(label: string, p: Promise<T>): Promise<T> {
        this.setOp(label);
        return logIfSlow(label, p);
    }

    async play(file: MediaFile, startSec: number = 0): Promise<void> {
        this.cancelled = false;
        this.paused = false;
        this.pauseStartedAtMs = undefined;
        this.firstWallClockMs = undefined;
        this.firstSampleTsMs = undefined;
        this.renderTimes = [];
        this.pendingSeekSec = undefined;
        this.currentOp = undefined;
        this.update({
            state: "opening",
            waitingFor: "Opening file",
            framesDecoded: 0,
            framesRendered: 0,
            framesDropped: 0,
            fps: 0,
            nominalFps: undefined,
            paused: false,
            audioEnabled: false,
            currentTimeMs: 0,
            durationMs: undefined,
            codecString: undefined,
            audioCodec: undefined,
            width: undefined,
            height: undefined,
            error: undefined,
            gpuDeviceLost: false,
        });

        let input: Input;
        try {
            log(`opening ${file.name} (${(file.size / 1_048_576).toFixed(1)} MB) via Mediabunny`);
            const t0 = performance.now();
            input = new Input({
                source: new CustomSource({
                    getSize: () => file.size,
                    read: (start, end) => file.read(start, end),
                    prefetchProfile: "fileSystem",
                }),
                formats: ALL_FORMATS,
            });
            // Keep a reference so stop() can dispose it even while the loop is
            // wedged inside a mediabunny await (see stop()).
            this.input = input;
            const vt = await this.step("Reading video track", input.getPrimaryVideoTrack());
            if (!vt) throw new Error("No video track found");
            this.videoTrack = vt;
            const codec = await this.step("Reading video codec", vt.getCodec());
            const codecParam = await vt.getCodecParameterString();
            const codedW = await vt.getCodedWidth();
            const codedH = await vt.getCodedHeight();
            const dispW = await vt.getDisplayWidth();
            const dispH = await vt.getDisplayHeight();

            // MPEG-4 Part 2 (XviD/DivX, e.g. in AVIs) isn't decodable by the
            // browser's WebCodecs — register our pure-TS custom decoder
            // before opening the VideoSampleSink on the track.
            if (codec === "mp4v") {
                log(`loading MPEG-4 Part 2 (mp4v) decoder…`);
                await this.step("Loading MPEG-4 decoder", ensureMp4vDecoder());
            }

            // Audio: optional. If present and is AC-3 / E-AC-3, ensure the WASM
            // decoder is loaded and registered with mediabunny before we open
            // an AudioSampleSink on the track.
            const at = await this.step("Reading audio track", input.getPrimaryAudioTrack());
            this.audioIsDts = false;
            let audioCodec: string | undefined;
            if (at) {
                this.audioTrack = at;
                const ac = await at.getCodec();
                audioCodec = ac ?? undefined;
                log(`audio track codec=${audioCodec}`);
                if (ac === "ac3" || ac === "eac3") {
                    log(`loading AC-3 decoder…`);
                    await this.step("Loading AC-3 decoder", ensureAc3Decoder());
                } else if (!ac) {
                    // mediabunny doesn't recognize this codec (getCodec()===null).
                    // Sniff the first packet for the DTS core sync word; if it's
                    // DTS, decode it with our pure-JS decoder via DtsAudioSink.
                    try {
                        const first = await this.step("Sniffing audio codec", new EncodedPacketSink(at).getFirstPacket());
                        if (first && looksLikeDtsCore(first.data)) {
                            this.audioIsDts = true;
                            audioCodec = "dts";
                            log(`audio track is DTS (DCA core) — using pure-JS decoder`);
                        }
                    } catch (err) {
                        console.warn(`[player] DTS sniff failed:`, (err as Error).message);
                    }
                }
            }
            let duration: number | undefined;
            try {
                duration = await this.step("Computing duration", input.computeDuration());
            } catch (err) {
                // Some streamed sources can't tell us duration up front — not fatal.
                console.warn(`[player] could not compute duration:`, (err as Error).message);
            }
            log(`opened in ${(performance.now() - t0).toFixed(0)}ms: codec=${codec} param=${codecParam} coded=${codedW}x${codedH} display=${dispW}x${dispH} duration=${duration ?? "?"}s audio=${audioCodec ?? "none"}`);
            this.update({
                codecString: codecParam ?? codec ?? undefined,
                audioCodec,
                audioEnabled: !!this.audioTrack,
                width: codedW ?? undefined,
                height: codedH ?? undefined,
                durationMs: duration !== undefined ? duration * 1000 : undefined,
            });

            // Nominal FPS for frame-step hotkeys. Mediabunny scans a small slice
            // of packets to get a precise average without reading the whole file.
            // Failure here is non-fatal — frame step falls back to a 24fps guess.
            void vt.computePacketStats(150).then(stats => {
                if (stats.averagePacketRate > 0) {
                    log(`nominal fps ≈ ${stats.averagePacketRate.toFixed(3)}`);
                    this.update({ nominalFps: stats.averagePacketRate });
                }
            }).catch(err => console.warn(`[player] computePacketStats failed:`, err));

            if (!this.renderer) {
                // WebGPU paints decoded frames fastest, but it's not required —
                // fall back to a 2D canvas (drawImage) where WebGPU is absent
                // (e.g. Amazon Silk on Fire TV) so playback still works.
                if (await WebGpuRenderer.isSupported()) {
                    log(`initializing WebGPU renderer`);
                    this.renderer = new WebGpuRenderer(this.canvas);
                } else {
                    log(`WebGPU unavailable — using 2D canvas fallback renderer`);
                    this.renderer = new Canvas2DRenderer(this.canvas);
                }
                await this.step("Initializing renderer", this.renderer.init());
                log(`renderer ready`);
                // GPU device loss (driver reset, GPU wedged by another app):
                // after this every submit silently no-ops, so playback looks
                // frozen/stuttering while the decode loop stays "healthy".
                // Flag it in status — the page restarts the whole pipeline
                // (fresh device AND fresh decoders, which a GPU reset can
                // also kill).
                this.renderer.onDeviceLost = () => {
                    if (this.cancelled) return;
                    this.update({ gpuDeviceLost: true });
                };
            }

            // HDR (PQ/HLG, e.g. HDR10) must be tone-mapped to look right on an
            // SDR canvas — the WebGPU external-texture path otherwise clips the
            // highlights and blows out the lighting. Mediabunny reads the
            // track's color metadata so we know before the first frame.
            try {
                const isHdr = await vt.hasHighDynamicRange();
                if (isHdr) log(`source is HDR — enabling tone-mapping in renderer`);
                this.renderer.setHdrHint?.(isHdr);
            } catch (err) {
                console.warn(`[player] HDR detection failed (assuming SDR):`, (err as Error).message);
            }
        } catch (err) {
            log(`open failed:`, err);
            this.fail((err as Error).message ?? String(err));
            return;
        }

        // CPU-decode toggle: prefer-software keeps playback smooth when the
        // GPU is busy/wedged. Read at pipeline build time — toggling restarts
        // playback to apply.
        const preferSoftware = softwareDecode.get();
        if (preferSoftware) log(`video decode: prefer-software (CPU)`);
        this.videoSink = new VideoSampleSink(
            this.videoTrack!,
            preferSoftware ? { hardwareAcceleration: "prefer-software" } : undefined,
        );
        if (this.audioTrack) {
            this.audioSink = this.audioIsDts
                ? new DtsAudioSink(this.audioTrack)
                : new AudioSampleSink(this.audioTrack);
            this.audioPlayback = new AudioPlayback();
        }

        // If there's audio but the browser hasn't let the AudioContext start
        // (no user gesture yet — e.g. landing on the player via a direct URL),
        // begin paused on the first frame instead of letting silent video run
        // ahead and then stall. The user's click on play resumes the context.
        if (this.audioTrack && !isAudioContextRunning()) {
            this.paused = true;
            log(`audio context suspended (autoplay blocked) — starting paused; click play to start`);
        }

        try {
            this.update({ state: "playing", paused: this.paused });
            // Outer loop restarts iteration after a seek. iterateFrom() returns
            // when either playback ends naturally or pendingSeekSec is set.
            while (!this.cancelled) {
                this.pendingSeekSec = undefined;
                if (this.audioPlayback) this.audioPlayback.flush();
                const videoP = this.iterateVideoFrom(startSec);
                const audioP = this.audioSink ? this.iterateAudioFrom(startSec) : Promise.resolve();
                await Promise.all([videoP, audioP]);
                if (this.cancelled || this.pendingSeekSec === undefined) break;
                startSec = this.pendingSeekSec;
                log(`seeking to ${startSec.toFixed(2)}s`);
            }
            if (!this.cancelled) {
                log(`playback finished: decoded=${this.status.framesDecoded} rendered=${this.status.framesRendered} dropped=${this.status.framesDropped}`);
                this.update({ state: "ended" });
            }
        } catch (err) {
            // A stop() mid-flight disposes the input, which rejects any pending
            // mediabunny await with InputDisposedError — that's expected
            // teardown, not a playback failure, so don't surface it as an error.
            if (!this.cancelled) {
                log(`playback failed:`, err);
                this.fail((err as Error).message ?? String(err));
            }
        } finally {
            this.teardown();
        }
    }

    // Free every heavy resource this player holds: the mediabunny Input (and
    // with it the demuxer, open decoders and any in-flight reads), the WebAudio
    // graph, and the renderer's GPUDevice. Idempotent — safe to call from both
    // the play() finally (natural end) and stop() (forced/wedged teardown).
    private teardown(): void {
        if (this.audioPlayback) {
            try { this.audioPlayback.close(); } catch {}
            this.audioPlayback = undefined;
        }
        this.videoSink = undefined;
        this.videoTrack = undefined;
        this.audioSink = undefined;
        this.audioTrack = undefined;
        // Release the renderer's GPU device — a fresh VideoPlayer (and a fresh
        // WebGpuRenderer, each requesting its own GPUDevice) is built per video,
        // so leaving the device alive would leak one adapter per playback.
        try { this.renderer?.destroy(); } catch {}
        this.renderer = undefined;
        try { this.input?.dispose(); } catch {}
        this.input = undefined;
        if (this.exposureReactionDispose) { this.exposureReactionDispose(); this.exposureReactionDispose = undefined; }
    }

    private async iterateAudioFrom(startSec: number): Promise<void> {
        const sink = this.audioSink!;
        const playback = this.audioPlayback!;
        log(`audio iterating from ${startSec.toFixed(2)}s`);
        try {
            for await (const sample of sink.samples(startSec)) {
                if (this.cancelled || this.pendingSeekSec !== undefined) {
                    sample.close();
                    return;
                }
                while (this.paused && !this.cancelled && this.pendingSeekSec === undefined) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (this.cancelled || this.pendingSeekSec !== undefined) {
                    sample.close();
                    return;
                }
                try {
                    playback.schedule(sample);
                } catch (err) {
                    console.error(`[audio] schedule failed:`, err);
                }
                sample.close();
                // Backpressure: keep ~2s of audio buffered ahead of the audio
                // clock, no more. Without this, we'd queue tens of thousands of
                // AudioBufferSourceNodes for a long file, eat gigabytes of RAM,
                // and the audio rendering thread eventually gives up.
                while (
                    playback.bufferAheadSec > AUDIO_BUFFER_AHEAD_SEC &&
                    !this.cancelled &&
                    this.pendingSeekSec === undefined
                ) {
                    await new Promise(r => setTimeout(r, 50));
                }
            }
        } catch (err) {
            console.error(`[audio] iteration failed:`, err);
            throw err;
        }
    }

    private async iterateVideoFrom(startSec: number): Promise<void> {
        const renderer = this.renderer!;
        const sink = this.videoSink!;
        // Reset wall-clock anchors so the new sample stream sets a fresh baseline.
        this.firstWallClockMs = undefined;
        this.firstSampleTsMs = undefined;
        this.renderTimes = [];
        log(`iterating from ${startSec.toFixed(2)}s`);
        let lastLog = performance.now();
        this.setOp("Decoding video frame");
        for await (const sample of sink.samples(startSec)) {
            if (this.cancelled || this.pendingSeekSec !== undefined) {
                sample.close();
                return;
            }
            this.update({ framesDecoded: this.status.framesDecoded + 1 });

            // Render the *first* frame of a fresh iteration even when the
            // player is paused — that's the user landing point after a
            // seek-while-paused, and they need to actually see the new
            // position rather than the previous one. The pause-wait
            // moves to after the render below in that case.
            const firstFrameOfIteration = this.firstSampleTsMs === undefined;
            if (!firstFrameOfIteration) {
                while (this.paused && !this.cancelled && this.pendingSeekSec === undefined) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (this.cancelled || this.pendingSeekSec !== undefined) {
                    sample.close();
                    return;
                }
            }

            const tsMs = sample.timestamp * 1000;
            if (this.firstSampleTsMs === undefined) {
                this.firstSampleTsMs = tsMs;
                this.firstWallClockMs = performance.now();
                log(`first frame ts=${tsMs.toFixed(1)}ms — wall clock anchored`);
            } else {
                // Audio-master sync: when audio is playing and has scheduled
                // its first sample, drive video off the AudioContext clock
                // instead of the wall clock. The two are usually close but
                // can drift by several ms over a minute, which is exactly
                // what made audio sound slow vs. video. We also account for
                // the 50ms SCHEDULE_LEAD_SEC audio uses for its first sample
                // — currentMediaTimeSec already factors that in.
                const playback = this.audioPlayback;
                if (playback && playback.isAnchored) {
                    // Wait until audio clock reaches this frame's timestamp.
                    this.setOp("Waiting for audio clock");
                    const waitStart = performance.now();
                    while (!this.cancelled && this.pendingSeekSec === undefined && !this.paused) {
                        const mediaSec = playback.currentMediaTimeSec;
                        const delayMs = (sample.timestamp - mediaSec) * 1000;
                        if (delayMs <= 0) break;
                        // Robustness: if the audio clock stops advancing (e.g. the
                        // AudioContext gets suspended/interrupted mid-play), don't
                        // spin here forever and freeze the video — after a few
                        // seconds give up on strict sync and render anyway so
                        // playback keeps moving.
                        if (performance.now() - waitStart > AUDIO_SYNC_MAX_WAIT_MS) {
                            log(`audio clock stalled at ${mediaSec.toFixed(2)}s — rendering frame ${sample.timestamp.toFixed(2)}s without waiting`);
                            break;
                        }
                        // Cap the sleep so we re-check fairly often; the audio
                        // anchor can slip under decoder pressure.
                        await new Promise(r => setTimeout(r, Math.min(delayMs, 30)));
                    }
                    if (this.cancelled || this.pendingSeekSec !== undefined) {
                        sample.close();
                        return;
                    }
                    const lagMs = (playback.currentMediaTimeSec - sample.timestamp) * 1000;
                    if (lagMs > 100) {
                        sample.close();
                        this.update({ framesDropped: this.status.framesDropped + 1 });
                        continue;
                    }
                } else {
                    // No audio (or audio not yet anchored) — wall clock as
                    // before, including the late-frame drop.
                    const targetWall = this.firstWallClockMs! + (tsMs - this.firstSampleTsMs);
                    const delay = targetWall - performance.now();
                    if (delay > 0) await new Promise(r => setTimeout(r, delay));
                    else if (delay < -100) {
                        sample.close();
                        this.update({ framesDropped: this.status.framesDropped + 1 });
                        continue;
                    }
                }
            }

            const frame = sample.toVideoFrame();
            try {
                this.setOp("Rendering frame");
                await renderer.render(frame);
            } catch (err) {
                console.error(`[render] render call failed:`, err);
            }
            frame.close();
            sample.close();
            // Back to decoding: attribute the next for-await suspension (which
            // pulls + decodes the next packet) to decoding, so a stall there
            // reads "Decoding video frame".
            this.setOp("Decoding video frame");

            const now = performance.now();
            this.renderTimes.push(now);
            while (this.renderTimes.length > 0 && this.renderTimes[0] < now - 1000) {
                this.renderTimes.shift();
            }
            // Rate from the actual spacing of the buffered frames, not the raw
            // count — a count over a 1s window can only ever land on whole
            // numbers (e.g. 23 or 24), hiding the true 23.976 cadence. With n
            // timestamps spanning (now - oldest) ms there are (n-1) intervals,
            // so the mean rate is (n-1)/span. Falls back to the count when
            // there's only a single sample (no interval to measure yet).
            const span = now - this.renderTimes[0];
            const fps = this.renderTimes.length >= 2 && span > 0
                ? (this.renderTimes.length - 1) / (span / 1000)
                : this.renderTimes.length;
            this.update({
                framesRendered: this.status.framesRendered + 1,
                currentTimeMs: tsMs,
                fps,
            });

            if (now - lastLog > 1000) {
                console.log(`[render] decoded=${this.status.framesDecoded} rendered=${this.status.framesRendered} dropped=${this.status.framesDropped} fps=${this.renderTimes.length}`);
                lastLog = now;
            }

            // First frame after a seek while paused: we let it render
            // above instead of blocking; now hold here until the user
            // resumes. Re-anchor the pause-start time to "now" so the
            // unpause bump to firstWallClockMs only counts the wait we
            // *just* entered — not the longer pre-seek pause window,
            // which would otherwise push subsequent frame deadlines
            // arbitrarily into the future.
            if (firstFrameOfIteration && this.paused) {
                this.pauseStartedAtMs = performance.now();
                while (this.paused && !this.cancelled && this.pendingSeekSec === undefined) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (this.cancelled || this.pendingSeekSec !== undefined) return;
            }
        }
    }

    seek(seconds: number): void {
        if (!this.videoSink) {
            log(`seek ignored: no video loaded`);
            return;
        }
        this.pendingSeekSec = Math.max(0, seconds);
        log(`seek queued to ${this.pendingSeekSec.toFixed(2)}s`);
    }

    setVolume(v: number): void {
        const clamped = Math.max(0, Math.min(1, v));
        // The slider value is linear (and what we report in status), but the
        // gain applied is squared so the lower half of the range gets finer,
        // more useful control (0.5→0.25, 0.8→0.64).
        if (this.audioPlayback) this.audioPlayback.setVolume(clamped * clamped);
        this.update({ volume: clamped });
    }

    getVolume(): number {
        return this.status.volume;
    }

    getCurrentTimeSec(): number {
        return (this.status.currentTimeMs ?? 0) / 1000;
    }

    setPaused(paused: boolean): void {
        if (this.paused === paused) return;
        if (paused) {
            this.paused = true;
            this.pauseStartedAtMs = performance.now();
            if (this.audioPlayback) void this.audioPlayback.suspend();
            log(`paused at t=${(this.status.currentTimeMs ?? 0) / 1000}s`);
        } else {
            if (this.pauseStartedAtMs !== undefined && this.firstWallClockMs !== undefined) {
                const pausedFor = performance.now() - this.pauseStartedAtMs;
                this.firstWallClockMs += pausedFor;
                log(`resumed after ${pausedFor.toFixed(0)}ms pause`);
            }
            this.paused = false;
            this.pauseStartedAtMs = undefined;
            this.renderTimes = [];
            if (this.audioPlayback) void this.audioPlayback.resume();
        }
        this.update({ paused: this.paused });
    }

    togglePause(): void {
        this.setPaused(!this.paused);
    }

    stop(): void {
        this.cancelled = true;
        // A healthy loop notices `cancelled` at its next checkpoint and tears
        // down via play()'s finally. But a loop wedged inside a mediabunny await
        // — a seek that never yields a sample, the exact state the seek watchdog
        // restarts us out of — never reaches that checkpoint, so it would hold
        // its demuxer, VideoDecoder and GPUDevice open forever. Each watchdog
        // restart would then leak another wedged pipeline, and the stacked
        // decoders are what make playback stutter worse and worse until a
        // refresh. Dispose eagerly here: mediabunny cancels the pending read and
        // rejects the await, so the wedged loop unwinds and the resources go.
        this.teardown();
    }

    private fail(msg: string) {
        this.update({ state: "error", error: msg });
    }
}
