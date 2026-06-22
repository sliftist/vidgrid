import { PlayerStatus } from "./VideoPlayer";
import { MediaFile } from "../appState";
import { disposeFileURL } from "sliftutils/storage/FileFolderAPI";
import { TvHackAudio } from "./TvHackAudio";

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
            this.update({ volume: video.volume });
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
            volume: this.video.volume,
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

    setVolume(v: number): void {
        const clamped = Math.max(0, Math.min(1, v));
        this.video.volume = clamped;
        // In tv-hack mode the element is muted, so route output volume to our
        // own audio pipeline. volumechange still fires and propagates status.
        if (this.tvAudio) this.tvAudio.setVolume(clamped);
    }

    getVolume(): number {
        return this.video.volume;
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
