import { PlayerStatus } from "./VideoPlayer";
import { MediaFile, MAX_PLAYER_VOLUME } from "../appState";
import { disposeFileURL } from "sliftutils/storage/FileFolderAPI";
import { TvHackAudio } from "./TvHackAudio";
import { primeAudioContext, ensureAudioContextRunning, createBoostLimiter } from "./AudioPlayback";

export type PlayerListener = (s: PlayerStatus) => void;

const LOG_PREFIX = "[native]";
function log(...args: unknown[]) { console.log(LOG_PREFIX, ...args); }

// Drives an HTMLVideoElement with the same surface area as VideoPlayer so the
// PlayerPage can switch engines transparently. The browser does demux + decode +
// audio routing for us — limited insight into codec/fps metrics, but it handles
// everything the OS knows how to handle (HEVC + AC-3 on Safari/macOS Chrome,
// VP9/AV1 widely, etc).

export class NativeVideoPlayer {
    private status: PlayerStatus = {
        state: "idle",
        framesDecoded: 0,
        framesRendered: 0,
        framesDropped: 0,
        fps: 0,
        paused: false,
        audioEnabled: false,
        volume: 1,
    };
    private listeners = new Set<PlayerListener>();
    private video: HTMLVideoElement;
    // A URL we created and must release via disposeFileURL (blob: from a local
    // file, or a remote /media URL). Stays undefined for an externally-owned
    // file.url that we merely pass through.
    private currentURL: string | undefined;
    // TV-hack mode: we mute the <video> and play audio ourselves through this
    // sidecar, re-syncing it to the video clock. Undefined for plain native.
    private selfAudio: boolean;
    private tvAudio: TvHackAudio | undefined;

    constructor(video: HTMLVideoElement, config: { selfAudio?: boolean } = {}) {
        this.video = video;
        this.selfAudio = config.selfAudio || false;
        video.crossOrigin = "anonymous";
        video.preload = "auto";

        video.addEventListener("playing", () => {
            this.tvAudio?.notifyPlay();
            this.update({ state: "playing", paused: false });
        });
        video.addEventListener("pause", () => {
            this.tvAudio?.notifyPause();
            this.update({ paused: true });
        });
        video.addEventListener("ended", () => {
            log("ended");
            this.update({ state: "ended" });
        });
        video.addEventListener("error", () => {
            const err = video.error;
            const msg = err ? `${err.code}: ${err.message || "unknown"}` : "unknown video error";
            log("error:", msg);
            this.update({ state: "error", error: msg });
        });
        video.addEventListener("timeupdate", () => {
            this.update({
                currentTimeMs: video.currentTime * 1000,
                // The native element doesn't surface per-frame counts in any
                // portable way, so we use timeupdate as a "we're still moving"
                // signal — the intended-vs-actual check reads framesRendered.
                framesRendered: this.status.framesRendered + 1,
            });
        });
        video.addEventListener("durationchange", () => {
            if (Number.isFinite(video.duration)) {
                this.update({ durationMs: video.duration * 1000 });
            }
        });
        video.addEventListener("volumechange", () => {
            // video.volume holds the squared gain, capped at 1 — so once we're
            // boosting it can no longer express the real level and the tracked
            // value is authoritative. Below that the two agree, and reading the
            // element is what picks up volume changed outside setVolume.
            if (this.reportedVolume <= 1) this.reportedVolume = Math.sqrt(video.volume);
            this.update({ volume: this.reportedVolume });
        });
        video.addEventListener("seeked", () => {
            this.tvAudio?.notifySeek();
            // Treat a successful seek as a rendered frame for the batched-seek
            // controller — otherwise it never advances when paused.
            this.update({ framesRendered: this.status.framesRendered + 1 });
        });
    }

    subscribe(l: PlayerListener): () => void {
        this.listeners.add(l);
        l(this.status);
        return () => this.listeners.delete(l);
    }

    async play(file: MediaFile, startSec: number = 0): Promise<void> {
        this.update({
            state: "opening",
            framesDecoded: 0,
            framesRendered: 0,
            framesDropped: 0,
            fps: 0,
            nominalFps: undefined,
            paused: false,
            currentTimeMs: 0,
            durationMs: undefined,
            codecString: undefined,
            audioCodec: undefined,
            width: undefined,
            height: undefined,
            error: undefined,
        });
        this.releaseURL();
        // Native engine needs a URL the <video> can hit directly. getURL()
        // produces one for both local (blob:) and remote (range-capable https)
        // sources; release it via disposeFileURL on stop. Fall back to an
        // explicit file.url or a Blob for sources that predate getURL.
        let src: string | undefined;
        if (file.getURL) {
            this.currentURL = await file.getURL();
            src = this.currentURL;
        } else if (file.url) {
            src = file.url;
        } else if (file.blob instanceof Blob) {
            this.currentURL = URL.createObjectURL(file.blob);
            src = this.currentURL;
        }
        if (!src) {
            throw new Error("Native engine requires a Blob or a URL — this source provides neither. Switch to the mediabunny engine.");
        }
        // TV-hack: silence the element's own audio track; our sidecar owns audio.
        this.video.muted = this.selfAudio;
        log(`opening ${file.name} (${(file.size / 1_048_576).toFixed(1)} MB) via <video>${this.selfAudio && " (tv-hack audio)" || ""}`);
        this.video.src = src;

        await new Promise<void>((resolve, reject) => {
            const onLoaded = () => { cleanup(); resolve(); };
            const onError = () => {
                cleanup();
                reject(new Error(this.video.error?.message || "video load failed"));
            };
            const cleanup = () => {
                this.video.removeEventListener("loadedmetadata", onLoaded);
                this.video.removeEventListener("error", onError);
            };
            this.video.addEventListener("loadedmetadata", onLoaded);
            this.video.addEventListener("error", onError);
        }).catch(err => {
            this.update({ state: "error", error: (err as Error).message });
            throw err;
        });

        if (startSec > 0) this.video.currentTime = startSec;
        this.update({
            width: this.video.videoWidth,
            height: this.video.videoHeight,
            durationMs: Number.isFinite(this.video.duration) ? this.video.duration * 1000 : undefined,
            volume: this.reportedVolume,
        });
        if (this.selfAudio) {
            this.tvAudio = new TvHackAudio({
                getVideoTimeSec: () => this.video.currentTime,
                isVideoPaused: () => this.video.paused,
            });
            void this.tvAudio.start(file).catch(err => log("tv-hack audio failed:", err));
        }
        try {
            await this.video.play();
        } catch (err) {
            // Autoplay blocked — leave it paused, user can click.
            log("autoplay blocked:", (err as Error).message);
            this.update({ paused: true, state: "playing" });
        }
    }

    stop(): void {
        this.video.pause();
        if (this.tvAudio) {
            this.tvAudio.stop();
            this.tvAudio = undefined;
        }
        this.releaseURL();
        // Don't blank src — Safari treats `removeAttribute("src")` differently
        // from setting it to "" and can throw. Leaving the src alone is fine
        // when we follow up with a new play().
    }

    togglePause(): void {
        if (this.video.paused) {
            void this.video.play().catch(err => log("play failed:", err));
        } else {
            this.video.pause();
        }
    }

    seek(sec: number): void {
        this.video.currentTime = Math.max(0, sec);
    }

    // Boost chain for volumes over 100%. An HTMLVideoElement's own `volume` is
    // capped at 1, so the only way past it is routing the element through
    // WebAudio and applying the extra gain there, against a limiter. Built on
    // the first boost and kept afterwards: createMediaElementSource is one-way,
    // the element's audio goes through the graph from then on. The limiter
    // itself is still only patched in while actually boosting, so dropping back
    // to 100% sounds like it always did.
    private boostGain: GainNode | undefined;
    private boostLimiter: DynamicsCompressorNode | undefined;
    private boostRouted: boolean | undefined;
    private boostUnavailable = false;

    private ensureBoostChain(): GainNode | undefined {
        if (this.boostGain) return this.boostGain;
        if (this.boostUnavailable) return undefined;
        try {
            const ctx = primeAudioContext();
            const source = ctx.createMediaElementSource(this.video);
            const gain = ctx.createGain();
            source.connect(gain);
            this.boostGain = gain;
            this.boostLimiter = createBoostLimiter(ctx);
            // Routed through WebAudio now, so a suspended context would mean
            // silence rather than just a missing boost.
            void ensureAudioContextRunning();
            log(`routed element audio through WebAudio for >100% volume`);
            return gain;
        } catch (err) {
            // Leave the element driving the speakers directly — a capped volume
            // beats silencing playback.
            this.boostUnavailable = true;
            log(`volume boost unavailable: ${(err as Error).message}`);
            return undefined;
        }
    }

    private routeBoost(gain: GainNode, boosted: boolean): void {
        if (this.boostRouted === boosted) return;
        const ctx = gain.context;
        gain.disconnect();
        if (boosted && this.boostLimiter) {
            gain.connect(this.boostLimiter);
            this.boostLimiter.connect(ctx.destination);
        } else {
            this.boostLimiter?.disconnect();
            gain.connect(ctx.destination);
        }
        this.boostRouted = boosted;
    }

    setVolume(v: number): void {
        const clamped = Math.max(0, Math.min(MAX_PLAYER_VOLUME, v));
        // Apply gain squared so the slider's lower half has finer control
        // (0.5→0.25, 0.8→0.64). The slider value stays linear — status
        // reports the inverse of this squaring.
        const gain = clamped * clamped;
        // In tv-hack mode the element is muted, so route output volume to our
        // own audio pipeline. volumechange still fires and propagates status.
        if (this.tvAudio) {
            this.video.volume = Math.min(1, gain);
            this.tvAudio.setVolume(gain);
            this.reportedVolume = clamped;
            return;
        }
        // Everything up to unity still rides the element's own volume, so the
        // common case never touches WebAudio at all.
        this.video.volume = Math.min(1, gain);
        if (gain > 1) {
            const boostGain = this.ensureBoostChain();
            if (boostGain) {
                this.routeBoost(boostGain, true);
                boostGain.gain.setTargetAtTime(gain, boostGain.context.currentTime, 0.01);
            }
        } else if (this.boostGain) {
            this.routeBoost(this.boostGain, false);
            this.boostGain.gain.setTargetAtTime(1, this.boostGain.context.currentTime, 0.01);
        }
        this.reportedVolume = clamped;
    }

    // The element can only report its own capped volume, so the boosted value is
    // tracked alongside it; `volumechange` falls back to the element when the
    // two can't disagree (at or below 100%).
    private reportedVolume = 1;

    getVolume(): number {
        return this.reportedVolume;
    }

    getCurrentTimeSec(): number {
        return this.video.currentTime;
    }

    private update(patch: Partial<PlayerStatus>) {
        this.status = { ...this.status, ...patch };
        for (const l of this.listeners) l(this.status);
    }

    private releaseURL() {
        if (this.currentURL) {
            disposeFileURL(this.currentURL);
            this.currentURL = undefined;
        }
    }
}
