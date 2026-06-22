// PLAYER UI VISIBILITY RULE
// Every chrome element on this page (back button, top info, bottom track bar,
// engine toggle, etc.) is shown ONLY while `MouseIdleTracker.state.active` is
// true. Hovering any of those elements keeps the overlay alive via
// `idleTracker.setHoveringOverlay(true/false)`. After ~5s of mouse idleness
// outside any overlay element, *everything* fades back to bare video.
// Add new transport/overlay UI by wiring it through the same `overlayVisible`
// gate and the same mouseenter/mouseleave hover handlers.

import * as preact from "preact";
import { observable, runInAction, reaction, IReactionDisposer } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { controlSurface, controlSurfaceAccent, controlSurfaceSwitching, controlMotion } from "../styles";
import { RS } from "../restyle/classNames";
import { state, files, openFileByKey, pathKey, PlayerEngine, MediaFile, defaultPlayerEngine, runWebGpuProbe } from "../appState";
import { currentVideo, seekParam, goToSearch, fromSeries, goToPlayerFromSeries, goToSeriesGrid } from "../router";
import { AddToList } from "../lists/AddToList";
import { getSeries, locateInSeries } from "../search/series";
import { VideoPlayer, PlayerStatus } from "./VideoPlayer";
import { NativeVideoPlayer } from "./NativeVideoPlayer";
import { WebDemuxerPlayer } from "./WebDemuxerPlayer";
import { primeAudioContext } from "./AudioPlayback";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { openSettings } from "../modals/SettingsModal";
import { MouseIdleTracker } from "./MouseIdleTracker";
import { PlayerOverlay } from "./PlayerOverlay";
import { SeekController } from "./SeekController";
import { HotkeyController } from "./HotkeyController";
import { NativeLinkButton } from "./NativeLinkButton";
import { buildFileInfoText, formatBytes } from "../scan/thumbnails";
import { registerPlayerControls, clearPlayerControls, PlayerControls } from "../heygoogle/playerControls";
import { playSound } from "../sounds";

interface IPlayer {
    play(file: MediaFile, startSec?: number): Promise<void>;
    stop(): void;
    togglePause(): void;
    seek(sec: number): void;
    setVolume(v: number): void;
    getCurrentTimeSec(): number;
    subscribe(cb: (status: PlayerStatus) => void): () => void;
}

let player: IPlayer | undefined;

const SEEK_STEP_SEC = 5;
// TV-remote transport keys (track skip / rewind / fast-forward) jump further
// than the arrow keys — a remote tap should move a meaningful chunk.
const REMOTE_SEEK_STEP_SEC = 15;
const VOLUME_STEP = 0.05;
const FRAME_STALL_THRESHOLD_MS = 500;

function EngineToggle(props: { engine: PlayerEngine; onChange: (e: PlayerEngine) => void; switching: boolean; canvasFallback?: boolean }) {
    const opts: PlayerEngine[] = ["mediabunny", "tv-hack", "native", "web-demuxer"];
    return <div className={css.hbox(0).fontSize(11)}>
        {props.switching && <style>{"@keyframes control-switch-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }"}</style>}
        {props.canvasFallback && props.engine === "mediabunny" && <div
            className={css.pad2(4, 8).fontSize(11).hsl(0, 70, 42).color("white").maxWidth(230) + RS.Surface}
            title="WebGPU isn't available, so Mediabunny is painting frames with a slower 2D-canvas fallback. Switch to Native playback for the smoothest result."
        >
            Canvas fallback — recommend native playback
        </div>}
        {opts.map(o => <button
            key={o}
            disabled={props.switching}
            className={(props.engine === o
                ? (props.switching ? controlSurfaceSwitching : controlSurfaceAccent)
                : controlSurface)
                + css.pad2(8, 4).fontSize(11)}
            onMouseDown={() => props.onChange(o)}
        >
            {o}
        </button>)}
    </div>;
}

@observer
export class PlayerPage extends preact.Component {
    canvas: HTMLCanvasElement | null = null;
    videoElement: HTMLVideoElement | null = null;
    private idleTracker = new MouseIdleTracker(5000);
    private hotkeys = new HotkeyController();
    private seekController = new SeekController({
        seek: sec => this.doPlayerSeek(sec),
        getCurrentTimeSec: () => player?.getCurrentTimeSec() ?? 0,
    });

    // Only the parts of UI state that aren't backed by the BulkDatabase2 live
    // here. Engine + saved position come from `files` directly.
    synced = observable({
        playerStatus: { state: "idle", framesDecoded: 0, framesRendered: 0, framesDropped: 0, fps: 0, paused: false, audioEnabled: false, volume: 1 } as PlayerStatus,
        loadError: undefined as string | undefined,
        lastFrameRenderedAt: 0,
        lastFramesRendered: 0,
        nowTick: performance.now(),
        engineSwitching: false,
        // Loop region. Both seconds in [0, durationSec]. When enabled,
        // playback wraps from loopEndSec back to loopStartSec.
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
        // undefined until probed. false → the mediabunny engine is on the 2D
        // canvas fallback renderer (drives the engine-toggle warning).
        webGpuSupported: undefined as boolean | undefined,
    });
    // Dead-zone after a loop-back seek so a stream of status callbacks
    // (each reporting the pre-seek currentTimeMs while the new frame is
    // still landing) don't issue a second seek for the same crossing.
    private lastLoopSeekAt = 0;

    private activeKey: string | undefined;
    private appliedEngine: PlayerEngine | undefined;
    private positionKey: string | undefined;
    private lastSavedSec = 0;
    private statusUnsub: (() => void) | undefined;
    private urlReaction: IReactionDisposer | undefined;
    private engineReaction: IReactionDisposer | undefined;
    private tickInterval: number | undefined;

    componentDidMount() {
        this.idleTracker.attach();
        this.hotkeys.setBindings({
            " ": { onTick: () => this.onTogglePause() },
            "Escape": { onTick: () => this.onBack() },
            "ArrowLeft": { onTick: () => { this.seekController.requestRelative(-SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "ArrowRight": { onTick: () => { this.seekController.requestRelative(+SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "ArrowUp": { onTick: () => this.adjustVolume(+VOLUME_STEP), repeat: true },
            "ArrowDown": { onTick: () => this.adjustVolume(-VOLUME_STEP), repeat: true },
            ",": { onTick: () => { this.seekController.frameStep(-1, this.synced.playerStatus.nominalFps); this.idleTracker.poke(); }, repeat: true },
            ".": { onTick: () => { this.seekController.frameStep(+1, this.synced.playerStatus.nominalFps); this.idleTracker.poke(); }, repeat: true },
            // TV-remote transport keys. Play/pause toggles; track skip and
            // rewind/fast-forward jump ±15s (same path as the arrow keys).
            "MediaPlayPause": { onTick: () => this.onTogglePause() },
            "MediaTrackNext": { onTick: () => { this.seekController.requestRelative(+REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "MediaTrackPrevious": { onTick: () => { this.seekController.requestRelative(-REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "MediaFastForward": { onTick: () => { this.seekController.requestRelative(+REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "MediaRewind": { onTick: () => { this.seekController.requestRelative(-REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
        });
        this.hotkeys.attach();
        void runWebGpuProbe().then(ok => {
            runInAction(() => { this.synced.webGpuSupported = ok; });
        });
        this.tickInterval = window.setInterval(() => {
            runInAction(() => { this.synced.nowTick = performance.now(); });
        }, 250);
        this.urlReaction = reaction(
            () => currentVideo.value,
            () => this.maybeStartPlayback(),
            { fireImmediately: true },
        );
        // Watch the engine field in the DB so a user-driven write triggers a
        // swap. The default ("mediabunny") only applies once we know the key
        // exists in the DB.
        this.engineReaction = reaction(
            () => this.engineForCurrentVideo(),
            engine => { void this.applyEngine(engine); },
        );
        registerPlayerControls(this.playerControls);
    }

    componentWillUnmount() {
        clearPlayerControls(this.playerControls);
        if (this.urlReaction) this.urlReaction();
        if (this.engineReaction) this.engineReaction();
        if (this.statusUnsub) this.statusUnsub();
        if (this.tickInterval !== undefined) window.clearInterval(this.tickInterval);
        this.hotkeys.detach();
        this.idleTracker.detach();
        void this.savePositionNow(true);
        player?.stop();
        player = undefined;
        this.activeKey = undefined;
        this.appliedEngine = undefined;
    }

    // Sync — only safe to call from a reactive context (render, mobx.reaction).
    // For use inside async functions, await files.getSingleField(...) directly.
    private engineForCurrentVideo(): PlayerEngine {
        const key = currentVideo.value;
        if (!key) return defaultPlayerEngine.get();
        const saved = files.getSingleFieldSync(key, "engine");
        if (saved === "native") return "native";
        if (saved === "tv-hack") return "tv-hack";
        if (saved === "web-demuxer") return "web-demuxer";
        return defaultPlayerEngine.get();
    }

    private adjustVolume(delta: number) {
        const newVol = Math.max(0, Math.min(1, (this.synced.playerStatus.volume ?? 1) + delta));
        player?.setVolume(newVol);
        this.idleTracker.poke();
    }

    private async maybeStartPlayback() {
        const key = currentVideo.value;
        if (!key) return;
        if (key === this.activeKey) return;
        this.activeKey = key;
        this.positionKey = key;
        // Async path — Sync is not legal inside async functions.
        const savedEngine = await files.getSingleField(key, "engine");
        const fallback = defaultPlayerEngine.get();
        const engine: PlayerEngine = savedEngine === "native" ? "native"
            : savedEngine === "tv-hack" ? "tv-hack"
            : savedEngine === "web-demuxer" ? "web-demuxer"
            : savedEngine === "mediabunny" ? "mediabunny"
            : fallback;
        this.appliedEngine = engine;
        await this.startPlayback(key, engine);
    }

    // Reaction to engine field — tears down the current player and brings up a
    // new one of the other type at the current playback time.
    private async applyEngine(engine: PlayerEngine) {
        if (engine === this.appliedEngine) return;
        const key = currentVideo.value;
        if (!key) return;
        // Save current spot so the new engine resumes there.
        void this.savePositionNow(true);
        runInAction(() => { this.synced.engineSwitching = true; });
        player?.stop();
        if (this.statusUnsub) { this.statusUnsub(); this.statusUnsub = undefined; }
        player = undefined;
        this.appliedEngine = engine;
        try {
            await this.startPlayback(key, engine);
        } finally {
            runInAction(() => { this.synced.engineSwitching = false; });
        }
    }

    private async startPlayback(key: string, engine: PlayerEngine, startSecOverride?: number) {
        runInAction(() => { this.synced.loadError = undefined; });

        let file: MediaFile | undefined;
        try {
            file = await openFileByKey(key);
        } catch (err) {
            runInAction(() => {
                this.synced.loadError = `Could not open file: ${(err as Error).message}`;
            });
            return;
        }
        if (!file) {
            runInAction(() => { this.synced.loadError = "File not found in current folder."; });
            return;
        }

        let startSec = 0;
        if (startSecOverride !== undefined) {
            startSec = startSecOverride;
            console.log(`[player] restarting at ${startSec.toFixed(2)}s (override)`);
        } else {
            const tParam = seekParam.value.trim();
            if (tParam) {
                const tNum = parseFloat(tParam);
                if (Number.isFinite(tNum) && tNum >= 0) {
                    startSec = tNum;
                    console.log(`[player] using ?t=${tNum}`);
                }
                seekParam.value = "";
            } else if (state.folderReady) {
                try {
                    const saved = await files.getSingleField(key, "positionSec");
                    if (saved !== undefined && saved > 0) {
                        startSec = saved;
                        console.log(`[player] resuming at ${startSec.toFixed(2)}s`);
                    }
                } catch (err) {
                    console.warn(`[positions] load failed:`, err);
                }
            }
        }
        // Reuse engine setting passed in; render reads it sync from the DB.
        engine;
        this.lastSavedSec = startSec;

        // Both canvas and video are always in the DOM (see render), so refs
        // are guaranteed to be set by the time we hit this code path through
        // componentDidMount → reaction → startPlayback.
        if (engine === "native") {
            if (!this.videoElement) return;
            player = new NativeVideoPlayer(this.videoElement);
        } else if (engine === "tv-hack") {
            if (!this.videoElement) return;
            player = new NativeVideoPlayer(this.videoElement, { selfAudio: true });
        } else if (engine === "web-demuxer") {
            if (!this.canvas) return;
            player = new WebDemuxerPlayer(this.canvas);
        } else {
            if (!this.canvas) return;
            player = new VideoPlayer(this.canvas);
        }
        if (this.statusUnsub) this.statusUnsub();
        this.statusUnsub = player.subscribe(s => {
            runInAction(() => {
                if (s.framesRendered !== this.synced.lastFramesRendered) {
                    this.synced.lastFramesRendered = s.framesRendered;
                    this.synced.lastFrameRenderedAt = performance.now();
                }
                this.synced.playerStatus = s;
            });
            (window as any).__lastStatus = s;
            this.seekController.onStatus(s);
            // Loop region — if playback has crossed loopEndSec, wrap
            // back to loopStartSec. doPlayerSeek handles the case where
            // the loop end is past the natural video end (state==ended)
            // by restarting playback at loopStartSec.
            if (this.synced.loopEnabled
                && this.synced.loopEndSec > this.synced.loopStartSec) {
                const curSec = (s.currentTimeMs ?? 0) / 1000;
                const now = performance.now();
                const naturalEnd = s.state === "ended";
                if ((curSec >= this.synced.loopEndSec || naturalEnd)
                    && now - this.lastLoopSeekAt > 200) {
                    this.lastLoopSeekAt = now;
                    this.doPlayerSeek(this.synced.loopStartSec);
                }
            }
            // savePositionNow is async (reads DB via the Promise API) — fire
            // and forget, errors logged inside.
            if (s.state === "ended" || s.paused) {
                void this.savePositionNow(true);
            } else {
                void this.savePositionNow(false);
            }
            // Series autoplay — when the user came in via the drilled series
            // view, the URL carries `from_series=<parentPath>` and we
            // advance to the next video in that series on natural end.
            if (s.state === "ended") this.maybePlayNextInSeries();
        });

        primeAudioContext();
        player.stop();
        // Fire-and-forget — VideoPlayer.play() and NativeVideoPlayer.play()
        // contain the playback loop and only resolve when the video ends or
        // is cancelled. Awaiting them would block startPlayback (and through
        // it, applyEngine's finally) for the entire session, leaving the
        // "Switching to <engine>…" overlay stuck on screen. Errors during
        // setup flow through the subscribe() callback as state == "error".
        void player.play(file, startSec);
    }

    private async savePositionNow(force: boolean): Promise<void> {
        if (!this.positionKey) return;
        if (!state.folderReady) return;
        const sec = (this.synced.playerStatus.currentTimeMs ?? 0) / 1000;
        if (!force && Math.abs(sec - this.lastSavedSec) < 5) return;
        this.lastSavedSec = sec;
        try {
            await files.update({
                key: this.positionKey,
                positionSec: sec,
                positionUpdatedAt: Date.now(),
            });
        } catch (err) {
            console.warn("[positions] write failed:", err);
        }
    }

    private async writeEngine(engine: PlayerEngine): Promise<void> {
        if (!this.positionKey) return;
        if (!state.folderReady) return;
        try {
            await files.update({
                key: this.positionKey,
                engine,
            });
        } catch (err) {
            console.warn("[engine] write failed:", err);
        }
    }

    private get intendedPlaying(): boolean {
        const s = this.synced.playerStatus;
        if (s.state === "error" || s.state === "ended" || s.state === "idle") return false;
        return !s.paused;
    }

    private get actuallyPlaying(): boolean {
        const s = this.synced.playerStatus;
        if (s.state !== "playing") return false;
        if (s.paused) return false;
        if (this.synced.lastFramesRendered === 0) return false;
        return this.synced.nowTick - this.synced.lastFrameRenderedAt < FRAME_STALL_THRESHOLD_MS;
    }

    // Shared seek dispatcher: forwards to the live player when one is
    // running, or kicks off a fresh playback at the requested position
    // when the previous loop has terminated (end / error / idle —
    // VideoPlayer drops its videoSink and seek() no-ops in those
    // states). Routes BOTH the trackbar click (onSeek) AND the
    // SeekController-driven arrow-key path through this.
    private doPlayerSeek = (sec: number): void => {
        const target = Math.max(0, sec);
        const s = this.synced.playerStatus.state;
        if (s === "ended" || s === "error" || s === "idle") {
            const key = currentVideo.value;
            if (!key) return;
            // Drop any in-flight SeekController coalescing — the
            // restart absorbs the seek as its startSec, so the
            // controller has nothing left to chase.
            this.seekController.cancel();
            const engine = this.appliedEngine ?? "mediabunny";
            void this.startPlayback(key, engine, target);
            return;
        }
        player?.seek(target);
    };

    private onSeek = (sec: number) => {
        this.seekController.cancel();
        this.doPlayerSeek(sec);
    };

    // Toggle the loop region. Off → on seeds the region with [current,
    // current + 30s] (clamped to the video). On → off clears the region
    // so playback runs straight through.
    private onToggleLoop = () => {
        runInAction(() => {
            if (this.synced.loopEnabled) {
                this.synced.loopEnabled = false;
                return;
            }
            const durSec = (this.synced.playerStatus.durationMs ?? 0) / 1000;
            const curSec = (this.synced.playerStatus.currentTimeMs ?? 0) / 1000;
            if (durSec <= 0) return;
            const start = Math.max(0, Math.min(curSec, durSec - 1));
            const end = Math.min(durSec, start + 30);
            this.synced.loopStartSec = start;
            this.synced.loopEndSec = end;
            this.synced.loopEnabled = true;
            // Reset the dead-zone so the first crossing fires.
            this.lastLoopSeekAt = 0;
        });
    };

    private onLoopStartChange = (sec: number) => {
        runInAction(() => {
            const durSec = (this.synced.playerStatus.durationMs ?? 0) / 1000;
            const max = Math.max(0, Math.min(this.synced.loopEndSec - 0.1, durSec));
            this.synced.loopStartSec = Math.max(0, Math.min(sec, max));
        });
    };
    private onLoopEndChange = (sec: number) => {
        runInAction(() => {
            const durSec = (this.synced.playerStatus.durationMs ?? 0) / 1000;
            const min = this.synced.loopStartSec + 0.1;
            this.synced.loopEndSec = Math.max(min, Math.min(sec, durSec));
        });
    };

    private onTogglePause = () => {
        primeAudioContext();
        // A finished video has no live sink to resume — restart from the top.
        if (this.synced.playerStatus.state === "ended") {
            playSound("play");
            this.doPlayerSeek(0);
            return;
        }
        const willPlay = this.synced.playerStatus.paused;
        playSound(willPlay ? "play" : "pause");
        if (willPlay) this.seekController.cancel();
        player?.togglePause();
    };

    private onBack = () => {
        if (this.statusUnsub) this.statusUnsub();
        player?.stop();
        goToSearch();
    };

    private onEngineChange = (engine: PlayerEngine) => {
        void this.writeEngine(engine);
        // Reaction picks it up via getSingleFieldSync.
    };

    // Look up the series the player came in through (URL `from_series`) and
    // return the current video's position inside it. Used both by the
    // overlay (count, prev/next) and by the autoplay-next logic on end.
    // Reads records via getColumnSync — only safe in reactive contexts
    // (render + callbacks dispatched off it). For the autoplay use this is
    // a callback that already runs after the player status changes, so
    // we're fine.
    private currentSeriesPos(): { group: ReturnType<typeof locateInSeries> } | undefined {
        const sp = fromSeries.value;
        if (!sp) return undefined;
        const key = currentVideo.value;
        if (!key) return undefined;
        const nameCol = files.getColumnSync("name");
        const pathCol = files.getColumnSync("relativePath");
        if (!nameCol || !pathCol) return undefined;
        const pathByKey = new Map<string, string>();
        for (const { key: k, value } of pathCol) pathByKey.set(k, value);
        const recs: { key: string; name: string; relativePath: string }[] = [];
        for (const { key: k, value: n } of nameCol) {
            const rp = pathByKey.get(k);
            if (rp) recs.push({ key: k, name: n, relativePath: rp });
        }
        const map = getSeries(recs);
        const located = locateInSeries(map, key);
        if (!located || located.group.parentPath !== sp) return undefined;
        return { group: located };
    }

    private playSeriesAt = (idx: number) => {
        const pos = this.currentSeriesPos();
        if (!pos || !pos.group) return;
        const videos = pos.group.group.videos;
        if (idx < 0 || idx >= videos.length) return;
        const next = videos[idx];
        goToPlayerFromSeries(next.key, pos.group.group.parentPath);
    };

    private maybePlayNextInSeries() {
        const pos = this.currentSeriesPos();
        if (!pos || !pos.group) return;
        const nextIdx = pos.group.index + 1;
        if (nextIdx >= pos.group.group.videos.length) return;
        console.log(`[series] auto-advancing to next video (${nextIdx + 1}/${pos.group.group.videos.length})`);
        this.playSeriesAt(nextIdx);
    }

    // Bridge for the heygoogle device protocol. Registered while this page is
    // mounted; the device-call dispatcher reaches the live player through it.
    private playerControls: PlayerControls = {
        togglePause: () => this.onTogglePause(),
        pause: () => {
            if (this.synced.playerStatus.state === "ended") return;
            if (!this.synced.playerStatus.paused) player?.togglePause();
        },
        resume: () => {
            if (this.synced.playerStatus.state === "ended") {
                this.doPlayerSeek(0);
                return;
            }
            if (this.synced.playerStatus.paused) {
                this.seekController.cancel();
                player?.togglePause();
            }
        },
        playNext: () => {
            const pos = this.currentSeriesPos();
            if (!pos || !pos.group) return false;
            const nextIdx = pos.group.index + 1;
            if (nextIdx >= pos.group.group.videos.length) return false;
            this.playSeriesAt(nextIdx);
            return true;
        },
        playPrev: () => {
            const pos = this.currentSeriesPos();
            if (!pos || !pos.group) return false;
            const prevIdx = pos.group.index - 1;
            if (prevIdx < 0) return false;
            this.playSeriesAt(prevIdx);
            return true;
        },
        playEpisode: (episode: number) => {
            const pos = this.currentSeriesPos();
            if (!pos || !pos.group) return false;
            const idx = episode - 1;
            if (idx < 0 || idx >= pos.group.group.videos.length) return false;
            this.playSeriesAt(idx);
            return true;
        },
        getStatus: () => {
            const s = this.synced.playerStatus;
            return {
                playing: s.state === "playing" && !s.paused,
                paused: s.paused,
                ended: s.state === "ended",
                currentTimeMs: s.currentTimeMs ?? 0,
                durationMs: s.durationMs ?? 0,
            };
        },
    };

    render() {
        const key = currentVideo.value;
        const name = key ? files.getSingleFieldSync(key, "name") : undefined;
        const relativePath = key ? files.getSingleFieldSync(key, "relativePath") : undefined;
        const fileSize = key ? files.getSingleFieldSync(key, "size") : undefined;
        const fileDurationSec = key ? files.getSingleFieldSync(key, "durationSec") : undefined;
        const fileWidth = key ? files.getSingleFieldSync(key, "width") : undefined;
        const fileHeight = key ? files.getSingleFieldSync(key, "height") : undefined;
        const fileVideoCodec = key ? files.getSingleFieldSync(key, "videoCodec") : undefined;
        const fileAudioCodec = key ? files.getSingleFieldSync(key, "audioCodec") : undefined;
        const fileModifiedAt = key ? files.getSingleFieldSync(key, "fileModifiedAt") : undefined;
        const extractionMs = key ? files.getSingleFieldSync(key, "metadataExtractionMs") : undefined;
        const fileInfoText = buildFileInfoText({
            key: key ?? "",
            relativePath,
            size: fileSize,
            durationSec: fileDurationSec,
            width: fileWidth,
            height: fileHeight,
            videoCodec: fileVideoCodec,
            audioCodec: fileAudioCodec,
            fileModifiedAt,
            metadataExtractionMs: extractionMs,
        });
        const ps = this.synced.playerStatus;
        const overlayVisible = this.idleTracker.state.active;
        const engine = this.engineForCurrentVideo();

        return <div className={css.fixed.left(0).top(0).right(0).bottom(0).hsl(0, 0, 0)
            + (!overlayVisible ? css.cursor("none") : "")}>
            {/* Both elements are always mounted. The inactive one is hidden via
              * `display: none` so its ref is still set and we never have to
              * remount + re-wait when toggling engines. */}
            <canvas
                ref={c => { this.canvas = c; this.maybeStartPlayback(); }}
                onMouseDown={() => {
                    if (ps.state === "playing" && engine === "mediabunny") this.onTogglePause();
                }}
                className={css.fixed.left(0).top(0).right(0).bottom(0).fillBoth
                    .objectFit("contain").display(engine === "mediabunny" ? "block" : "none")}
            />
            <video
                ref={el => { this.videoElement = el; this.maybeStartPlayback(); }}
                onMouseDown={() => {
                    if (ps.state === "playing" && (engine === "native" || engine === "tv-hack")) this.onTogglePause();
                }}
                playsInline
                className={css.fixed.left(0).top(0).right(0).bottom(0).fillBoth
                    .objectFit("contain").background("black").display(engine === "native" || engine === "tv-hack" ? "block" : "none") + RS.Surface}
            />

            {/* Top bar — Back button + file metadata. Hover-only (see comment
              * at the top of this file for the UI visibility rule). */}
            <div
                onMouseEnter={() => this.idleTracker.setHoveringOverlay(true)}
                onMouseLeave={() => this.idleTracker.setHoveringOverlay(false)}
                title={fileInfoText || undefined}
                className={css.fixed.top(0).left(0).right(0).zIndex(20)
                    .pad2(8, 8).hbox(12).alignCenter
                    .hsla(0, 0, 0, 0.5).color("white")
                    .transition("opacity 180ms")
                    .opacity(overlayVisible ? 1 : 0)
                    .pointerEvents(overlayVisible ? "auto" : "none") + RS.PlayerBar}
            >
                <button
                    className={controlSurface + css.pad2(10, 4).fontSize(13)}
                    onMouseDown={this.onBack}
                    title="Back (Esc)"
                >
                    ← Back
                </button>
                {key && <div
                    className={css.minWidth(280).maxWidth(520).flexShrink(1).flexGrow(1)}
                    onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                >
                    <AddToList itemKey={key} itemType="video" />
                </div>}
            </div>

            <PlayerOverlay
                visible={overlayVisible}
                fileName={name ?? key}
                fileSizeText={fileSize !== undefined ? formatBytes(fileSize) : undefined}
                status={ps}
                intendedPlaying={this.intendedPlaying}
                actuallyPlaying={this.actuallyPlaying}
                onMouseEnter={() => this.idleTracker.setHoveringOverlay(true)}
                onMouseLeave={() => this.idleTracker.setHoveringOverlay(false)}
                onSeek={this.onSeek}
                onTogglePause={this.onTogglePause}
                loopStartSec={this.synced.loopEnabled ? this.synced.loopStartSec : undefined}
                loopEndSec={this.synced.loopEnabled ? this.synced.loopEndSec : undefined}
                onLoopStartChange={this.onLoopStartChange}
                onLoopEndChange={this.onLoopEndChange}
                leftExtras={<>
                    <NativeLinkButton
                        rootName={state.rootName}
                        relativePath={relativePath ?? undefined}
                    />
                    <button
                        onMouseDown={() => key && openVideoInfo(key)}
                        className={controlSurface + css.pad2(10, 4).fontSize(11)}
                        title="Show all info"
                    >
                        Info
                    </button>
                    <button
                        onMouseDown={() => openSettings()}
                        className={controlSurface + css.pad2(10, 4).fontSize(11)}
                        title="Settings"
                    >
                        Settings
                    </button>
                    <button
                        onMouseDown={this.onToggleLoop}
                        className={
                            (this.synced.loopEnabled
                                ? controlMotion + css.hsl(50, 80, 45).color("hsl(0, 0%, 10%)").fontWeight(500).lineHeight("1").fontFamily("inherit").pointer
                                : controlSurface)
                            + css.pad2(10, 4).fontSize(11)
                        }
                        title={this.synced.loopEnabled
                            ? "Loop on — drag the thumbs above the trackbar to change the region. Click to disable."
                            : "Loop a region of the video — adds drag handles above the trackbar at [current, current+30s]."}
                    >
                        Loop
                    </button>
                    {(() => {
                        const pos = this.currentSeriesPos();
                        if (!pos || !pos.group) return null;
                        const total = pos.group.group.videos.length;
                        const idx = pos.group.index;
                        return <div className={css.hbox(4).alignCenter
                            .pad2(2, 8).hsla(0, 0, 0, 0.55).color("white").fontSize(11) + RS.PlayerPill}>
                            <button
                                onMouseDown={() => this.playSeriesAt(idx - 1)}
                                disabled={idx <= 0}
                                className={controlSurface + css.pad2(8, 2).fontSize(11)}
                                title="Previous in series"
                            >
                                ‹ Prev
                            </button>
                            <button
                                onMouseDown={() => goToSeriesGrid(pos.group!.group.parentPath)}
                                className={controlSurface + css.pad2(8, 2).fontSize(11)}
                                title={`Open this series in the grid (${pos.group.group.parentPath})`}
                            >
                                {idx + 1} / {total}
                            </button>
                            <button
                                onMouseDown={() => this.playSeriesAt(idx + 1)}
                                disabled={idx >= total - 1}
                                className={controlSurface + css.pad2(8, 2).fontSize(11)}
                                title="Next in series"
                            >
                                Next ›
                            </button>
                        </div>;
                    })()}
                </>}
                rightExtras={<EngineToggle
                    engine={engine}
                    switching={this.synced.engineSwitching}
                    onChange={this.onEngineChange}
                    canvasFallback={this.synced.webGpuSupported === false}
                />}
            />

            {this.synced.engineSwitching && <div className={css.fixed.center.zIndex(30)
                .pad2(10, 16).hsla(0, 0, 0, 0.7).color("white").fontSize(14)
                .top("50%").left("50%").transform("translate(-50%, -50%)") + RS.Surface}>
                Switching to {engine}…
            </div>}

            {this.synced.loadError && <div className={css.fixed.left(16).bottom(80).zIndex(30)
                .pad2(8).hsl(0, 60, 30).color("white") + RS.Surface}>
                {this.synced.loadError}
            </div>}
            {ps.error && <div className={css.fixed.left(16).bottom(80).zIndex(30)
                .pad2(8).hsl(0, 60, 30).color("white").fontSize(12).maxWidth(800) + RS.Surface}>
                {ps.error}
            </div>}
        </div>;
    }
}
