// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import { Input, CustomSource, ALL_FORMATS, AudioSampleSink } from "mediabunny/dist/bundles/mediabunny.cjs";
import { ensureAc3Decoder } from "./AudioCodecLoader";
import { AudioPlayback } from "./AudioPlayback";
import { MediaFile } from "../appState";

// Audio sidecar for the TV-hack engine. The native <video> element plays the
// picture (and, on a Fire TV, refuses to output audio) so we mute it and run
// our own mediabunny audio-only pipeline alongside it, treating the video
// element's clock as the master and re-syncing the audio to it.

const LOG_PREFIX = "[tv-hack-audio]";
function log(...args: unknown[]) { console.log(LOG_PREFIX, ...args); }

// Allowed gap between the audio clock and the video clock before we flush and
// restart audio from the video's current position.
const MAX_DRIFT_SEC = 0.12;
// How often we compare the two clocks.
const DRIFT_CHECK_INTERVAL_MS = 500;
// Seconds of decoded audio we keep queued ahead of the audio playhead.
const AUDIO_BUFFER_AHEAD_SEC = 2;

export class TvHackAudio {
    private getVideoTimeSec: () => number;
    private isVideoPaused: () => boolean;
    private input: Input | undefined;
    private audioSink: AudioSampleSink | undefined;
    private audioPlayback: AudioPlayback | undefined;
    private driftTimer: ReturnType<typeof setInterval> | undefined;
    private cancelled = false;
    // Bumped to break the running iteration so it can restart at a new time.
    private generation = 0;
    // Serializes restarts so only one sample iterator runs on the sink at once.
    private restartSeq: Promise<void> = Promise.resolve();
    private volume = 1;

    constructor(config: { getVideoTimeSec: () => number; isVideoPaused: () => boolean }) {
        this.getVideoTimeSec = config.getVideoTimeSec;
        this.isVideoPaused = config.isVideoPaused;
    }

    async start(file: MediaFile): Promise<void> {
        this.cancelled = false;
        const input = new Input({
            source: new CustomSource({
                getSize: () => file.size,
                read: (start, end) => file.read(start, end),
                prefetchProfile: "fileSystem",
            }),
            formats: ALL_FORMATS,
        });
        this.input = input;
        const at = await input.getPrimaryAudioTrack();
        if (!at) {
            log("no audio track — nothing to play");
            return;
        }
        const ac = await at.getCodec();
        log(`audio track codec=${ac}`);
        if (ac === "ac3" || ac === "eac3") {
            log("loading AC-3 decoder…");
            await ensureAc3Decoder();
        }
        if (this.cancelled) return;
        this.audioSink = new AudioSampleSink(at);
        this.audioPlayback = new AudioPlayback();
        this.audioPlayback.setVolume(this.volume);

        this.driftTimer = setInterval(() => this.checkDrift(), DRIFT_CHECK_INTERVAL_MS);
        // The <video> may already be playing by the time the async setup above
        // finished, so kick audio off ourselves rather than waiting for an event.
        if (!this.isVideoPaused()) this.requestRestart();
    }

    notifyPlay(): void {
        this.requestRestart();
    }

    notifySeek(): void {
        this.requestRestart();
    }

    notifyPause(): void {
        // Stop the running iteration and drop everything queued — audio stays
        // silent until play/seek re-syncs it to the video position.
        this.generation++;
        if (this.audioPlayback) this.audioPlayback.flush();
    }

    setVolume(v: number): void {
        this.volume = Math.max(0, Math.min(1, v));
        if (this.audioPlayback) this.audioPlayback.setVolume(this.volume);
    }

    stop(): void {
        this.cancelled = true;
        this.generation++;
        if (this.driftTimer) {
            clearInterval(this.driftTimer);
            this.driftTimer = undefined;
        }
        if (this.audioPlayback) {
            this.audioPlayback.close();
            this.audioPlayback = undefined;
        }
        this.audioSink = undefined;
        const input = this.input;
        this.input = undefined;
        if (input) {
            try { input.dispose(); } catch {}
        }
    }

    private checkDrift(): void {
        const playback = this.audioPlayback;
        if (this.cancelled || !playback || !playback.isAnchored) return;
        if (this.isVideoPaused()) return;
        const drift = playback.currentMediaTimeSec - this.getVideoTimeSec();
        if (Math.abs(drift) > MAX_DRIFT_SEC) {
            log(`drift ${(drift * 1000).toFixed(0)}ms — resyncing`);
            this.requestRestart();
        }
    }

    private requestRestart(): void {
        this.generation++;
        const gen = this.generation;
        this.restartSeq = this.restartSeq.then(async () => {
            // A newer restart superseded this one before it got to run.
            if (gen !== this.generation || this.cancelled) return;
            if (this.audioPlayback) this.audioPlayback.flush();
            if (this.isVideoPaused()) return;
            await this.iterate(this.getVideoTimeSec(), gen);
        });
    }

    private async iterate(startSec: number, gen: number): Promise<void> {
        const sink = this.audioSink;
        const playback = this.audioPlayback;
        if (!sink || !playback) return;
        log(`iterating from ${startSec.toFixed(2)}s`);
        try {
            for await (const sample of sink.samples(startSec)) {
                if (this.cancelled || gen !== this.generation) {
                    sample.close();
                    return;
                }
                try {
                    playback.schedule(sample);
                } catch (err) {
                    console.error("[tv-hack-audio] schedule failed:", err);
                }
                sample.close();
                while (
                    playback.bufferAheadSec > AUDIO_BUFFER_AHEAD_SEC &&
                    !this.cancelled &&
                    gen === this.generation
                ) {
                    await new Promise(r => setTimeout(r, 50));
                }
            }
        } catch (err) {
            console.error("[tv-hack-audio] iteration failed:", err);
        }
    }
}
