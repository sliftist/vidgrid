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
import { state, files, openFileByKey, pathKey, PlayerEngine, MediaFile, defaultPlayerEngine, runWebGpuProbe, seriesMinVideos, subtitlesOnByDefault, subtitleLanguage, ensureFolder, playerVolume, setPlayerVolume, monitorSide, monitorSplit, setMonitorSide, setMonitorSplit, softwareDecode, setSoftwareDecode } from "../appState";
import { loadSidecarSubtitles, activeCue, SubtitleCue } from "./subtitles";
import { extractMkvSubtitles } from "./mkv";
import { resolveFileHandle } from "../scan/folderTraversal";
import { currentVideo, seekParam, goToSearch, fromSeries, goToPlayerFromSeries, goToSeriesGrid } from "../router";
import { isTabHidden, onVisibilityChange } from "../visibility";
import { AddToList } from "../lists/AddToList";
import { getSeries, locateInSeries } from "../search/series";
import { VideoPlayer, PlayerStatus } from "./VideoPlayer";
import { NativeVideoPlayer } from "./NativeVideoPlayer";
import { WebDemuxerPlayer } from "./WebDemuxerPlayer";
import { primeAudioContext } from "./AudioPlayback";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { openFacesModal } from "../modals/FacesModal";
import { openSettings } from "../modals/SettingsModal";
import { MouseIdleTracker } from "./MouseIdleTracker";
import { PlayerOverlay } from "./PlayerOverlay";
import { SeekController } from "./SeekController";
import { HotkeyController } from "./HotkeyController";
import { PlayerFavicon } from "./PlayerFavicon";
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
// While "playing", we treat playback as stalled only once no new frame has
// rendered for this long — so brief decode hitches don't flap the play
// button, but a genuine freeze surfaces what we're stuck on. (Initial
// open/decode is shown as "waiting" immediately, without this grace period.)
const FRAME_STALL_THRESHOLD_MS = 5000;
// A seek tears down the decode pipeline and rebuilds it from the target. If
// that rebuild wedges (e.g. WebCodecs decoder churn under rapid seeking leaves
// a new decoder that never emits a frame), no status ever advances and the
// SeekController, which only un-blocks on a rendered frame, stalls forever —
// the "seek and it never loads until I refresh" symptom. If no frame lands
// within this window we restart playback in place at the target, doing what a
// manual refresh does without losing the user's position.
const SEEK_WATCHDOG_MS = 4000;
// Minimum gap between automatic GPU-loss restarts. A GPU that's still wedged
// will lose the fresh device too — don't restart-loop at full speed.
const GPU_RESTART_MIN_INTERVAL_MS = 5000;
// The engine reports a rolling 1s render rate every rendered frame, which is
// far too jittery to read. We snapshot it into the overlay this often so the
// live-fps pill updates at a glanceable cadence instead of flickering.
const LIVE_FPS_SAMPLE_MS = 3000;

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
                + css.pad2(8, 4).fontSize(11)
                + (props.engine === o ? RS.ButtonActive : RS.Button)}
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
    private rootEl: HTMLDivElement | null = null;
    private idleTracker = new MouseIdleTracker(5000);
    private hotkeys = new HotkeyController();
    private seekController = new SeekController({
        seek: sec => this.doPlayerSeek(sec),
        getCurrentTimeSec: () => player?.getCurrentTimeSec() ?? 0,
    });
    private favicon = new PlayerFavicon();

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
        // True while the page element is in the browser fullscreen state.
        // Drives the monitor-confine controls (only meaningful fullscreen).
        fullscreen: false,
        // True while the user is dragging the monitor-split line. The line
        // shows only during this; releasing it hides the line again.
        adjustingSplit: false,
        // Glanceable snapshot of the live render rate (status.fps), refreshed
        // every LIVE_FPS_SAMPLE_MS so the pill doesn't flicker every frame.
        liveFps: 0,
        // Sidecar subtitles for the current video. `on` starts from the
        // user's default and is toggled per-session by the CC button.
        subtitleCues: [] as SubtitleCue[],
        subtitleLabel: undefined as string | undefined,
        subtitlesOn: subtitlesOnByDefault.get(),
    });
    // Key whose subtitles we've already loaded, so the load runs once per video.
    private subtitleKey: string | undefined;
    // Dead-zone after a loop-back seek so a stream of status callbacks
    // (each reporting the pre-seek currentTimeMs while the new frame is
    // still landing) don't issue a second seek for the same crossing.
    private lastLoopSeekAt = 0;

    // Self-heal watchdog for a wedged seek (see SEEK_WATCHDOG_MS). Armed on
    // each live seek; disarmed when a frame lands; on timeout it restarts
    // playback at the target.
    private seekWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
    private seekWatchdogTarget = 0;
    private seekWatchdogFrames = 0;
    // Last automatic GPU-loss restart, for rate limiting (see
    // GPU_RESTART_MIN_INTERVAL_MS).
    private lastGpuRestartAt = 0;

    private activeKey: string | undefined;
    private appliedEngine: PlayerEngine | undefined;
    private positionKey: string | undefined;
    private lastSavedSec = 0;
    private lastLiveFpsSampleAt = 0;
    // framesRendered captured at the last live-fps sample, so the next sample
    // can derive an honest rate from how many frames actually landed since.
    private liveFpsSampleFrames = 0;
    // Key whose durationSec we've already backfilled this playback, so the
    // per-status-callback check writes at most once.
    private durationPersistedKey: string | undefined;
    // Set when playback was started while the tab was hidden (e.g. middle-click
    // "open in new tab"). The status callback pauses once real playback begins,
    // so a backgrounded tab doesn't autoplay. Cleared after it's applied.
    private pauseOnFirstPlay = false;
    private statusUnsub: (() => void) | undefined;
    private visibilityUnsub: (() => void) | undefined;
    private urlReaction: IReactionDisposer | undefined;
    private engineReaction: IReactionDisposer | undefined;
    private tickInterval: number | undefined;

    componentDidMount() {
        this.idleTracker.attach();
        this.hotkeys.setBindings({
            " ": { onTick: () => this.onTogglePause() },
            // While fullscreen, let Escape do its native job (exit fullscreen)
            // instead of also navigating back to the grid.
            "Escape": { onTick: () => { if (document.fullscreenElement) return; this.onBack(); } },
            "ArrowLeft": { onTick: () => { this.seekController.requestRelative(-SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "ArrowRight": { onTick: () => { this.seekController.requestRelative(+SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "ArrowUp": { onTick: () => this.adjustVolume(+VOLUME_STEP), repeat: true },
            "ArrowDown": { onTick: () => this.adjustVolume(-VOLUME_STEP), repeat: true },
            ",": { onTick: () => { this.seekController.frameStep(-1, this.synced.playerStatus.nominalFps); this.idleTracker.poke(); }, repeat: true },
            ".": { onTick: () => { this.seekController.frameStep(+1, this.synced.playerStatus.nominalFps); this.idleTracker.poke(); }, repeat: true },
            // Toggle full screen. Bound on both cases so caps lock / shift still
            // triggers it (bindings match event.key verbatim).
            "f": { onTick: () => { this.toggleFullscreen(); this.idleTracker.poke(); } },
            "F": { onTick: () => { this.toggleFullscreen(); this.idleTracker.poke(); } },
            // TV-remote transport keys. Play/pause toggles; track skip and
            // rewind/fast-forward jump ±15s (same path as the arrow keys).
            "MediaPlayPause": { onTick: () => this.onTogglePause() },
            // Track skip: prev/next episode when in a series; falls back to
            // ±15s seek if not in a series (or already at the ends).
            "MediaTrackNext": { onTick: () => this.mediaSkipNext() },
            "MediaTrackPrevious": { onTick: () => this.mediaSkipPrev() },
            "MediaFastForward": { onTick: () => { this.seekController.requestRelative(+REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
            "MediaRewind": { onTick: () => { this.seekController.requestRelative(-REMOTE_SEEK_STEP_SEC); this.idleTracker.poke(); }, repeat: true },
        });
        this.hotkeys.attach();
        this.attachMediaSession();
        this.favicon.attach();
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
        document.addEventListener("fullscreenchange", this.onFullscreenChange);
        registerPlayerControls(this.playerControls);
        // A backgrounded tab must not read the disk. Pause decode (which stops
        // the sample pump pulling from disk) and stand down any pending seek
        // when the tab is hidden. Playback stays paused until the user resumes.
        this.visibilityUnsub = onVisibilityChange(hidden => {
            if (!hidden) return;
            this.clearSeekWatchdog();
            this.seekController.cancel();
            if (player && !this.synced.playerStatus.paused) player.togglePause();
        });
    }

    componentWillUnmount() {
        document.removeEventListener("fullscreenchange", this.onFullscreenChange);
        clearPlayerControls(this.playerControls);
        if (this.urlReaction) this.urlReaction();
        if (this.engineReaction) this.engineReaction();
        if (this.statusUnsub) this.statusUnsub();
        if (this.visibilityUnsub) this.visibilityUnsub();
        if (this.tickInterval !== undefined) window.clearInterval(this.tickInterval);
        this.clearSeekWatchdog();
        this.hotkeys.detach();
        this.detachMediaSession();
        this.favicon.detach();
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
        setPlayerVolume(newVol);
        this.idleTracker.poke();
    }

    private async maybeStartPlayback() {
        const key = currentVideo.value;
        if (!key) return;
        if (key === this.activeKey) return;
        this.activeKey = key;
        this.positionKey = key;
        this.durationPersistedKey = undefined;
        void this.loadSubtitles(key);
        void this.loadLoop(key);
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

    // Load the sidecar subtitle for the current video (once per key). Resets
    // the on/off toggle to the user's default for each new video.
    private async loadSubtitles(key: string) {
        if (key === this.subtitleKey) return;
        this.subtitleKey = key;
        runInAction(() => {
            this.synced.subtitleCues = [];
            this.synced.subtitleLabel = undefined;
            this.synced.subtitlesOn = subtitlesOnByDefault.get();
        });
        let relativePath: string | undefined;
        try {
            relativePath = await files.getSingleField(key, "relativePath");
        } catch { return; }
        if (!relativePath) return;
        const lang = subtitleLanguage.get();
        let found = await loadSidecarSubtitles(relativePath, lang);
        // No sidecar — for Matroska, dig the subtitle track out of the
        // container itself (mediabunny can't decode it, so we parse it).
        if (!found && /\.(mkv|webm)$/i.test(relativePath)) {
            try {
                const root = await ensureFolder();
                if (this.subtitleKey !== key) return;
                if (root) {
                    const handle = await resolveFileHandle(root, relativePath);
                    if (this.subtitleKey !== key) return;
                    found = await extractMkvSubtitles(await handle.getFile(), lang);
                }
            } catch { /* unreadable / not a parseable Matroska — leave found undefined. */ }
        }
        // A newer video may have started loading while we awaited.
        if (this.subtitleKey !== key || !found) return;
        const result = found;
        runInAction(() => {
            this.synced.subtitleCues = result.cues;
            this.synced.subtitleLabel = result.label;
        });
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
        this.clearSeekWatchdog();
        // Stop whatever player is still running before we replace the
        // module-level reference below. A VideoPlayer's decode/render loop only
        // ends when its own `cancelled` flag is set (via stop()); if we just
        // overwrite `player` with a new instance, the old loop keeps running
        // headless — decoding, importing GPU textures and painting the shared
        // canvas forever. Every video change would then stack another live loop,
        // so playback gets progressively slower until a page refresh clears
        // them. Some callers (engine swap, seek watchdog) already pre-stop;
        // stop() is idempotent, so doing it here too is safe.
        player?.stop();
        // New playback session — reset the live-fps sampler so the first sample
        // measures this video, not a delta against the previous one.
        this.lastLiveFpsSampleAt = 0;
        runInAction(() => { this.synced.loadError = undefined; this.synced.liveFps = 0; });

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
            } else {
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
        // Start every video at the globally-persisted volume. Set before
        // subscribe so the first reported status already carries it (and the
        // persistence below doesn't clobber the saved value with the default).
        player.setVolume(playerVolume.get());
        // Don't autoplay into a backgrounded tab (e.g. middle-click "open in
        // new tab"). We still open + decode the first frame; pausing happens
        // once the engine actually reports playback (below), which is the only
        // point that's reliable across all three engines.
        this.pauseOnFirstPlay = document.hidden;

        if (this.statusUnsub) this.statusUnsub();
        this.statusUnsub = player.subscribe(s => {
            runInAction(() => {
                if (s.framesRendered !== this.synced.lastFramesRendered) {
                    this.synced.lastFramesRendered = s.framesRendered;
                    this.synced.lastFrameRenderedAt = performance.now();
                }
                this.synced.playerStatus = s;
                const nowMs = performance.now();
                // Live fps = frames actually rendered since the last sample,
                // over the real time elapsed. This is the true painted rate:
                // unlike the engine's rolling status.fps it can't be inflated by
                // a catch-up burst (many late frames flushed back-to-back) nor
                // read stale through a stall (0 frames → 0 fps), which is why
                // the old readout showed a healthy number while playback was
                // visibly skipping. First callback of a session only seeds the
                // baseline (no elapsed window to measure yet).
                if (this.lastLiveFpsSampleAt === 0) {
                    this.lastLiveFpsSampleAt = nowMs;
                    this.liveFpsSampleFrames = s.framesRendered;
                } else if (nowMs - this.lastLiveFpsSampleAt > LIVE_FPS_SAMPLE_MS) {
                    const dtSec = (nowMs - this.lastLiveFpsSampleAt) / 1000;
                    const dFrames = s.framesRendered - this.liveFpsSampleFrames;
                    this.synced.liveFps = dtSec > 0 && dFrames >= 0 ? dFrames / dtSec : 0;
                    this.lastLiveFpsSampleAt = nowMs;
                    this.liveFpsSampleFrames = s.framesRendered;
                }
            });
            (window as any).__lastStatus = s;
            // Persist volume changes made via native controls (the keyboard
            // path already persists in adjustVolume). Guard against the tiny
            // float noise that would otherwise rewrite localStorage every tick.
            if (s.volume !== undefined && Math.abs(s.volume - playerVolume.get()) > 0.001) {
                setPlayerVolume(s.volume);
            }
            void this.maybePersistDuration(s.durationMs);
            // Resolve a deferred fraction-seek once a duration is available.
            if (this.pendingSeekFraction !== undefined && s.durationMs && s.durationMs > 0) {
                const fr = this.pendingSeekFraction;
                this.pendingSeekFraction = undefined;
                this.doPlayerSeek(fr * (s.durationMs / 1000));
            }
            this.seekController.onStatus(s);
            // A rendered frame means the in-flight seek landed — stand the
            // watchdog down so it can't restart a healthy player.
            if (this.seekWatchdogTimer !== undefined && s.framesRendered > this.seekWatchdogFrames) {
                this.clearSeekWatchdog();
            }
            // The renderer's GPU device died (driver reset / GPU wedged by
            // another app). Everything after that silently no-ops — the video
            // freezes or stutters while the decode loop looks healthy, and
            // only a refresh used to fix it. Rebuild the whole pipeline in
            // place (fresh GPUDevice AND fresh decoders — a GPU reset can
            // kill the hardware VideoDecoder too), rate-limited so a
            // still-wedged GPU doesn't restart-loop.
            if (s.gpuDeviceLost && performance.now() - this.lastGpuRestartAt > GPU_RESTART_MIN_INTERVAL_MS) {
                this.lastGpuRestartAt = performance.now();
                console.warn(`[player] GPU device lost — restarting playback in place`);
                this.restartPlaybackInPlace((s.currentTimeMs ?? 0) / 1000);
                return;
            }
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
            // Suppress autoplay into a backgrounded tab. Done after the status
            // commit above so togglePause's re-entrant update isn't clobbered by
            // this stale (still-unpaused) status. Reaching "playing" means the
            // engine's own video.play() has resolved, so toggling reliably
            // pauses across all three engines.
            if (this.pauseOnFirstPlay && s.state === "playing") {
                this.pauseOnFirstPlay = false;
                if (!s.paused) player?.togglePause();
            }
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

    // Backfill durationSec from the duration the player just computed. Older
    // records (e.g. files whose metadata extraction predated support for their
    // container, like AVI) can be marked extracted with no durationSec and
    // never retry — leaving the grid's watched-progress bar blank even though
    // resume works (that only needs positionSec). Persisting it on play
    // self-heals those records.
    private async maybePersistDuration(durationMs: number | undefined): Promise<void> {
        if (!this.positionKey) return;
        if (!durationMs || durationMs <= 0) return;
        const key = this.positionKey;
        if (this.durationPersistedKey === key) return;
        this.durationPersistedKey = key;
        const durationSec = durationMs / 1000;
        try {
            const stored = await files.getSingleField(key, "durationSec");
            if (stored !== undefined && Math.abs(stored - durationSec) < 1) return;
            await files.update({ key, durationSec });
        } catch (err) {
            console.warn("[duration] backfill failed:", err);
        }
    }

    private async savePositionNow(force: boolean): Promise<void> {
        if (!this.positionKey) return;
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

    // Reset the loop to off for the new video, then restore any region we
    // saved for it. Resetting up front stops the previous video's loop from
    // leaking onto an unsaved one. The loop lives in the (IndexedDB-backed)
    // files DB, so it reads back fine before the folder handle is granted.
    private async loadLoop(key: string): Promise<void> {
        runInAction(() => {
            this.synced.loopEnabled = false;
            this.synced.loopStartSec = 0;
            this.synced.loopEndSec = 0;
        });
        try {
            const [enabled, startSec, endSec] = await Promise.all([
                files.getSingleField(key, "loopEnabled"),
                files.getSingleField(key, "loopStartSec"),
                files.getSingleField(key, "loopEndSec"),
            ]);
            if (this.activeKey !== key) return; // a newer video took over.
            if (enabled && startSec !== undefined && endSec !== undefined && endSec > startSec) {
                runInAction(() => {
                    this.synced.loopEnabled = true;
                    this.synced.loopStartSec = startSec;
                    this.synced.loopEndSec = endSec;
                    this.lastLoopSeekAt = 0;
                });
            }
        } catch (err) {
            console.warn("[loop] load failed:", err);
        }
    }

    private async persistLoop(): Promise<void> {
        if (!this.positionKey) return;
        try {
            await files.update({
                key: this.positionKey,
                loopEnabled: this.synced.loopEnabled,
                loopStartSec: this.synced.loopStartSec,
                loopEndSec: this.synced.loopEndSec,
            });
        } catch (err) {
            console.warn("[loop] write failed:", err);
        }
    }

    private async writeEngine(engine: PlayerEngine): Promise<void> {
        if (!this.positionKey) return;
        try {
            await files.update({
                key: this.positionKey,
                engine,
            });
        } catch (err) {
            console.warn("[engine] write failed:", err);
        }
    }

    // Do we intend to be playing right now? True from the moment a video is
    // selected until the user pauses or it ends/errors — so the button shows
    // the pause glyph (and, via waitReason, a yellow "still getting there"
    // state) all through loading/opening/decoding, not just once frames flow.
    private get intendedPlaying(): boolean {
        if (!currentVideo.value) return false;
        const s = this.synced.playerStatus;
        if (s.paused) return false;
        if (s.state === "error" || s.state === "ended") return false;
        return true;
    }

    // When we intend to play but aren't actually rendering frames, this is the
    // single human-readable description of what the whole pipeline is blocked
    // on — surfaced on the play button (yellow + hover title). undefined means
    // we're genuinely playing (or deliberately paused/idle), so no warning.
    //
    // It walks the pipeline outside-in: page-level steps (engine swap, getting
    // a player up) first, then the engine's own reported step (status.waitingFor).
    // During "playing" we only consider it stalled once frames stop arriving
    // for FRAME_STALL_THRESHOLD_MS, so normal playback shows nothing.
    private get waitReason(): string | undefined {
        if (!this.intendedPlaying) return undefined;
        if (this.synced.loadError) return undefined; // surfaced separately
        if (this.synced.engineSwitching) return "Switching player engine…";
        const s = this.synced.playerStatus;
        if (s.state === "idle") return "Starting playback…";
        if (s.state === "opening") return s.waitingFor ?? "Opening video…";
        // state === "playing"
        const flowing = this.synced.lastFramesRendered > 0
            && this.synced.nowTick - this.synced.lastFrameRenderedAt < FRAME_STALL_THRESHOLD_MS;
        if (flowing) return undefined;
        if (this.synced.lastFramesRendered === 0) return s.waitingFor ?? "Decoding first frame…";
        return s.waitingFor ?? "Stalled — waiting for next frame";
    }

    // Shared seek dispatcher: forwards to the live player when one is
    // running, or kicks off a fresh playback at the requested position
    // when the previous loop has terminated (end / error / idle —
    // VideoPlayer drops its videoSink and seek() no-ops in those
    // states). Routes BOTH the trackbar click (onSeek) AND the
    // SeekController-driven arrow-key path through this.
    private doPlayerSeek = (sec: number): void => {
        // A seek tears down and rebuilds the decode pipeline from the target —
        // i.e. disk reads. A hidden tab must not do that. (Restarting an ended
        // video would also read; suppress that too.)
        if (isTabHidden()) return;
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
        if (player) {
            player.seek(target);
            this.armSeekWatchdog(target);
        }
    };

    private armSeekWatchdog(target: number): void {
        this.clearSeekWatchdog();
        this.seekWatchdogTarget = target;
        this.seekWatchdogFrames = this.synced.playerStatus.framesRendered;
        this.seekWatchdogTimer = setTimeout(() => {
            this.seekWatchdogTimer = undefined;
            const st = this.synced.playerStatus;
            // A frame landed after we armed — the seek completed normally.
            if (st.framesRendered > this.seekWatchdogFrames) return;
            // Only a live engine wedges this way; ended/error/idle already
            // route through the restart branch above.
            if (st.state !== "playing" && st.state !== "opening") return;
            console.warn(`[player] seek watchdog: no frame ${SEEK_WATCHDOG_MS}ms after seeking to ${this.seekWatchdogTarget.toFixed(2)}s — restarting playback in place`);
            this.restartPlaybackInPlace(this.seekWatchdogTarget);
        }, SEEK_WATCHDOG_MS);
    }

    private clearSeekWatchdog(): void {
        if (this.seekWatchdogTimer !== undefined) {
            clearTimeout(this.seekWatchdogTimer);
            this.seekWatchdogTimer = undefined;
        }
    }

    // The "manual refresh" the user does today, performed in place: tear down
    // the (possibly wedged) engine — demuxer, decoders, GPU device — and start
    // a fresh one at the target position. Used by the seek watchdog, the
    // GPU-loss auto-recovery, and the bottom-bar Reset button.
    private restartPlaybackInPlace(target: number): void {
        if (isTabHidden()) return;
        const key = this.activeKey ?? currentVideo.value;
        if (!key) return;
        const engine = this.appliedEngine ?? "mediabunny";
        console.log(`[player] restarting playback in place at ${target.toFixed(2)}s`);
        this.seekController.cancel();
        player?.stop();
        if (this.statusUnsub) { this.statusUnsub(); this.statusUnsub = undefined; }
        void this.startPlayback(key, engine, target);
    };

    // Bottom-bar Reset: explicit user-driven pipeline rebuild for when
    // playback got into a bad state we didn't (or couldn't) auto-detect.
    private onResetPlayback = () => {
        this.restartPlaybackInPlace((this.synced.playerStatus.currentTimeMs ?? 0) / 1000);
    };

    // Toggle CPU (software) decoding and rebuild the pipeline in place — the
    // decoder preference only applies at pipeline construction.
    private onToggleCpuDecode = () => {
        playSound("toggle");
        setSoftwareDecode(!softwareDecode.get());
        this.restartPlaybackInPlace((this.synced.playerStatus.currentTimeMs ?? 0) / 1000);
    };

    private onSeek = (sec: number) => {
        this.seekController.cancel();
        this.doPlayerSeek(sec);
    };

    // Fraction (0..1) seek used when no duration is known (e.g. an ended AVI
    // whose live player reports no duration). If a duration is already known we
    // resolve immediately; otherwise we remember the fraction and kick playback
    // so a duration flows in, then jump to fraction×duration (see the status
    // subscription, which consumes `pendingSeekFraction`).
    private pendingSeekFraction: number | undefined;
    private onSeekFraction = (fr: number) => {
        const knownSec = (this.synced.playerStatus.durationMs ?? 0) / 1000;
        if (knownSec > 0) { this.onSeek(fr * knownSec); return; }
        this.pendingSeekFraction = fr;
        this.seekController.cancel();
        this.doPlayerSeek(0);
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
        void this.persistLoop();
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

    // Releasing the start thumb plays from there; releasing the end thumb
    // plays from 2s before it. The 2s lead-in lets the user nudge the end
    // thumb and immediately hear/see the loop boundary so start/end line up.
    private playFromLoopThumb = (sec: number) => {
        primeAudioContext();
        this.lastLoopSeekAt = 0;
        this.onSeek(sec);
        if (this.synced.playerStatus.paused) player?.togglePause();
    };
    private onLoopStartRelease = (sec: number) => {
        this.onLoopStartChange(sec);
        this.playFromLoopThumb(this.synced.loopStartSec);
        void this.persistLoop();
    };
    private onLoopEndRelease = (sec: number) => {
        this.onLoopEndChange(sec);
        this.playFromLoopThumb(Math.max(0, this.synced.loopEndSec - 2));
        void this.persistLoop();
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

    private onFullscreenChange = () => {
        const fs = !!document.fullscreenElement;
        runInAction(() => {
            this.synced.fullscreen = fs;
            // The monitor-confine letterbox only applies fullscreen; drop the
            // adjust line when we leave it so it can't linger.
            if (!fs) this.synced.adjustingSplit = false;
        });
    };

    private toggleFullscreen = () => {
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(err => console.warn("[fullscreen] exit:", err));
        } else if (this.rootEl) {
            void this.rootEl.requestFullscreen().catch(err => console.warn("[fullscreen] enter:", err));
        }
    };

    // Confine all rendering to one monitor (the other half goes black) and pop
    // the drag line so the user can place the divide on the physical seam.
    // Clicking the already-active side turns the confine off again.
    private selectMonitor = (side: "left" | "right") => {
        if (monitorSide.get() === side) {
            setMonitorSide("off");
            runInAction(() => { this.synced.adjustingSplit = false; });
        } else {
            setMonitorSide(side);
            runInAction(() => { this.synced.adjustingSplit = true; });
        }
    };

    // Live during the split-line drag — update the observable without touching
    // localStorage on every mousemove; persistence happens once on release.
    private onSplitChange = (fr: number) => {
        runInAction(() => monitorSplit.set(Math.max(0.05, Math.min(0.95, fr))));
    };
    private onSplitRelease = () => {
        setMonitorSplit(monitorSplit.get());
        runInAction(() => { this.synced.adjustingSplit = false; });
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
        const map = getSeries(recs, seriesMinVideos.get());
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
    // Media-key skip: prev/next episode in the current series, else ±15s seek.
    // Shared by the keyboard hotkey and the MediaSession action handler so
    // whichever route the OS delivers a media key through behaves the same.
    private mediaSkipNext = () => {
        if (this.playerControls.playNext()) return;
        this.seekController.requestRelative(+REMOTE_SEEK_STEP_SEC);
        this.idleTracker.poke();
    };
    private mediaSkipPrev = () => {
        if (this.playerControls.playPrev()) return;
        this.seekController.requestRelative(-REMOTE_SEEK_STEP_SEC);
        this.idleTracker.poke();
    };

    // Route OS-level media keys (Bluetooth headset, keyboard media keys the
    // browser eats before keydown fires) to the same skip handlers.
    private attachMediaSession() {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        try {
            navigator.mediaSession.setActionHandler("nexttrack", () => this.mediaSkipNext());
            navigator.mediaSession.setActionHandler("previoustrack", () => this.mediaSkipPrev());
        } catch { /* browser lacks these actions — nothing to route. */ }
    }
    private detachMediaSession() {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        try {
            navigator.mediaSession.setActionHandler("nexttrack", null);
            navigator.mediaSession.setActionHandler("previoustrack", null);
        } catch { /* nothing was attached. */ }
    }

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

        const confineMonitor = this.synced.fullscreen && monitorSide.get() !== "off";
        const split = monitorSplit.get();
        const regionLayout = !confineMonitor
            ? css.absolute.left(0).top(0).right(0).bottom(0)
            : monitorSide.get() === "left"
                ? css.absolute.left(0).top(0).bottom(0).width(`${split * 100}%`).overflowHidden
                : css.absolute.top(0).bottom(0).right(0).left(`${split * 100}%`).overflowHidden;

        return <div
            ref={el => { this.rootEl = el; }}
            className={css.fixed.left(0).top(0).right(0).bottom(0).hsl(0, 0, 0)
                + (!overlayVisible ? css.cursor("none") : "")}
        >
            {/* Everything the user should SEE lives inside this region. When the
              * player is fullscreen and confined to one monitor, the region is
              * just that monitor's half of the viewport; the rest of the (black)
              * root shows through as the blanked-out screen. Children position
              * `absolute`ly against this wrapper, not the viewport. */}
            <div className={regionLayout}>
            {/* Both elements are always mounted. The inactive one is hidden via
              * `display: none` so its ref is still set and we never have to
              * remount + re-wait when toggling engines. */}
            <canvas
                ref={c => { this.canvas = c; this.maybeStartPlayback(); }}
                onMouseDown={() => {
                    if (ps.state === "playing" && engine === "mediabunny") this.onTogglePause();
                }}
                className={css.absolute.left(0).top(0).right(0).bottom(0).fillBoth
                    .objectFit("contain").display(engine === "mediabunny" ? "block" : "none")}
            />
            <video
                ref={el => { this.videoElement = el; this.maybeStartPlayback(); }}
                onMouseDown={() => {
                    if (ps.state === "playing" && (engine === "native" || engine === "tv-hack")) this.onTogglePause();
                }}
                playsInline
                className={css.absolute.left(0).top(0).right(0).bottom(0).fillBoth
                    .objectFit("contain").background("black").display(engine === "native" || engine === "tv-hack" ? "block" : "none") + RS.Surface}
            />

            {/* Top bar — Back button + file metadata. Hover-only (see comment
              * at the top of this file for the UI visibility rule). */}
            <div
                onMouseEnter={() => this.idleTracker.setHoveringOverlay(true)}
                onMouseLeave={() => this.idleTracker.setHoveringOverlay(false)}
                title={fileInfoText || undefined}
                className={css.absolute.top(0).left(0).right(0).zIndex(20)
                    .pad2(8, 8).hbox(12).alignCenter
                    .hsla(0, 0, 0, 0.5).color("white")
                    .transition("opacity 180ms")
                    .opacity(overlayVisible ? 1 : 0)
                    .pointerEvents(overlayVisible ? "auto" : "none") + RS.PlayerBar}
            >
                <button
                    className={controlSurface + css.pad2(10, 4).fontSize(13) + RS.Button}
                    onMouseDown={this.onBack}
                    title="Back (Esc)"
                >
                    ← Back
                </button>
                {key && <div
                    className={css.minWidth(280).flexShrink(1).flexGrow(1)}
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
                waitReason={this.waitReason}
                liveFps={this.synced.liveFps}
                onMouseEnter={() => this.idleTracker.setHoveringOverlay(true)}
                onMouseLeave={() => this.idleTracker.setHoveringOverlay(false)}
                onSeek={this.onSeek}
                onSeekFraction={this.onSeekFraction}
                fallbackDurationSec={fileDurationSec}
                onTogglePause={this.onTogglePause}
                loopStartSec={this.synced.loopEnabled ? this.synced.loopStartSec : undefined}
                loopEndSec={this.synced.loopEnabled ? this.synced.loopEndSec : undefined}
                onLoopStartChange={this.onLoopStartChange}
                onLoopEndChange={this.onLoopEndChange}
                onLoopStartRelease={this.onLoopStartRelease}
                onLoopEndRelease={this.onLoopEndRelease}
                leftExtras={<>
                    <button
                        onMouseDown={this.toggleFullscreen}
                        className={controlSurface + css.pad2(10, 4).fontSize(11) + RS.Button}
                        title={this.synced.fullscreen ? "Exit full screen (f)" : "Full screen (f)"}
                    >
                        {this.synced.fullscreen ? "Exit ⛶ (f)" : "⛶ Full screen (f)"}
                    </button>
                    {this.synced.fullscreen && <>
                        <button
                            onMouseDown={() => this.selectMonitor("left")}
                            className={(monitorSide.get() === "left" ? controlSurfaceAccent : controlSurface) + css.pad2(10, 4).fontSize(11) + (monitorSide.get() === "left" ? RS.ButtonActive : RS.Button)}
                            title="Render everything on the LEFT monitor, black out the right. Click to drag the split onto the seam between your screens; click again to turn off."
                        >
                            Left monitor
                        </button>
                        <button
                            onMouseDown={() => this.selectMonitor("right")}
                            className={(monitorSide.get() === "right" ? controlSurfaceAccent : controlSurface) + css.pad2(10, 4).fontSize(11) + (monitorSide.get() === "right" ? RS.ButtonActive : RS.Button)}
                            title="Render everything on the RIGHT monitor, black out the left. Click to drag the split onto the seam between your screens; click again to turn off."
                        >
                            Right monitor
                        </button>
                    </>}
                    <NativeLinkButton
                        rootName={state.rootName}
                        relativePath={relativePath ?? undefined}
                    />
                    <button
                        onMouseDown={() => key && openVideoInfo(key)}
                        className={controlSurface + css.pad2(10, 4).fontSize(11) + RS.Button}
                        title="Show all info"
                    >
                        Info
                    </button>
                    <button
                        onMouseDown={() => key && openFacesModal(key)}
                        className={controlSurface + css.pad2(10, 4).fontSize(11) + RS.Button}
                        title="Show detected faces, where else each person appears, and when"
                    >
                        Faces
                    </button>
                    <button
                        onMouseDown={() => openSettings()}
                        className={controlSurface + css.pad2(10, 4).fontSize(11) + RS.Button}
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
                            + (this.synced.loopEnabled ? RS.ButtonActive : RS.Button)
                        }
                        title={this.synced.loopEnabled
                            ? "Loop on — drag the thumbs above the trackbar to change the region. Click to disable."
                            : "Loop a region of the video — adds drag handles above the trackbar at [current, current+30s]."}
                    >
                        Loop
                    </button>
                    {this.synced.subtitleCues.length > 0 && <button
                        onMouseDown={() => { playSound("toggle"); runInAction(() => { this.synced.subtitlesOn = !this.synced.subtitlesOn; }); }}
                        className={(this.synced.subtitlesOn ? controlSurfaceAccent : controlSurface) + css.pad2(10, 4).fontSize(11) + (this.synced.subtitlesOn ? RS.ButtonActive : RS.Button)}
                        title={this.synced.subtitlesOn
                            ? `Subtitles on (${this.synced.subtitleLabel}) — click to hide`
                            : `Show subtitles (${this.synced.subtitleLabel})`}
                    >
                        CC
                    </button>}
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
                                className={controlSurface + css.pad2(8, 2).fontSize(11) + RS.Button}
                                title="Previous in series"
                            >
                                ‹ Prev
                            </button>
                            <button
                                onMouseDown={() => goToSeriesGrid(pos.group!.group.parentPath)}
                                className={controlSurface + css.pad2(8, 2).fontSize(11) + RS.Button}
                                title={`Open this series in the grid (${pos.group.group.parentPath})`}
                            >
                                {idx + 1} / {total}
                            </button>
                            <button
                                onMouseDown={() => this.playSeriesAt(idx + 1)}
                                disabled={idx >= total - 1}
                                className={controlSurface + css.pad2(8, 2).fontSize(11) + RS.Button}
                                title="Next in series"
                            >
                                Next ›
                            </button>
                        </div>;
                    })()}
                </>}
                rightExtras={<>
                    <button
                        onMouseDown={this.onResetPlayback}
                        className={controlSurface + css.pad2(10, 4).fontSize(11) + RS.Button}
                        title="Rebuild playback from scratch at the current position — releases the decoders and GPU device and requests fresh ones. Use when playback is stuttering or frozen (e.g. after the GPU was wedged by another app)."
                    >
                        Reset
                    </button>
                    {engine === "mediabunny" && <button
                        onMouseDown={this.onToggleCpuDecode}
                        className={(softwareDecode.get() ? controlSurfaceAccent : controlSurface)
                            + css.pad2(10, 4).fontSize(11)
                            + (softwareDecode.get() ? RS.ButtonActive : RS.Button)}
                        title={softwareDecode.get()
                            ? "CPU (software) decoding on — click to go back to hardware decoding. Applies immediately (restarts playback in place)."
                            : "Decode on the CPU instead of the GPU — smoother when the GPU is busy with other apps. Applies immediately (restarts playback in place)."}
                    >
                        CPU decode
                    </button>}
                    <EngineToggle
                        engine={engine}
                        switching={this.synced.engineSwitching}
                        onChange={this.onEngineChange}
                        canvasFallback={this.synced.webGpuSupported === false}
                    />
                </>}
            />

            {/* Subtitle overlay — sibling of the transport bar, but NOT gated
              * on overlayVisible (subtitles stay up while the chrome fades).
              * Sits higher when the trackbar is showing so it never overlaps. */}
            {this.synced.subtitlesOn && this.synced.subtitleCues.length > 0 && (() => {
                const cue = activeCue(this.synced.subtitleCues, ps.currentTimeMs ?? 0);
                if (!cue) return null;
                return <div className={css.absolute.left(0).right(0).zIndex(15).pointerEvents("none")
                    .bottom(overlayVisible ? 150 : 56).hbox(0).justifyContent("center").pad2(0, 32)}>
                    <div className={css.maxWidth("82%").textAlign("center").color("white")
                        .fontSize(24).lineHeight("1.3").whiteSpace("pre-wrap").overflowWrap("break-word")
                        .textShadow("0 0 4px black, 0 2px 4px black, 2px 0 3px black, -2px 0 3px black, 0 -2px 3px black")
                        + RS.Subtitle}>
                        {cue.text}
                    </div>
                </div>;
            })()}

            {this.synced.engineSwitching && <div className={css.absolute.center.zIndex(30)
                .pad2(10, 16).hsla(0, 0, 0, 0.7).color("white").fontSize(14)
                .top("50%").left("50%").transform("translate(-50%, -50%)") + RS.Surface}>
                Switching to {engine}…
            </div>}

            {this.synced.loadError && <div className={css.absolute.left(16).bottom(80).zIndex(30)
                .pad2(8).hsl(0, 60, 30).color("white") + RS.Surface}>
                {this.synced.loadError}
            </div>}
            {ps.error && <div className={css.absolute.left(16).bottom(80).zIndex(30)
                .pad2(8).hsl(0, 60, 30).color("white").fontSize(12).maxWidth(800) + RS.Surface}>
                {ps.error}
            </div>}
            </div>

            {/* The split line lives on the FULL-viewport root (not the region),
              * so it can be dragged across the whole span to land on the seam
              * between the two monitors. Visible only while actively placing it. */}
            {confineMonitor && this.synced.adjustingSplit && <MonitorSplitLine
                fraction={split}
                onChange={this.onSplitChange}
                onRelease={this.onSplitRelease}
            />}
        </div>;
    }
}

// Full-height vertical divider the user drags to set where the monitor split
// sits. mousedown installs document-level move/up listeners (read fresh each
// move so resizing mid-drag can't desync) and reports the divide as a 0..1
// fraction of the viewport width. onRelease hides it again.
class MonitorSplitLine extends preact.Component<{
    fraction: number;
    onChange: (fr: number) => void;
    onRelease: () => void;
}> {
    private dragging = false;

    private apply = (e: MouseEvent) => {
        const w = window.innerWidth || 1;
        this.props.onChange(Math.max(0, Math.min(1, e.clientX / w)));
    };
    private onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        this.dragging = true;
        document.addEventListener("mousemove", this.onMouseMove);
        document.addEventListener("mouseup", this.onMouseUp);
        this.apply(e);
    };
    private onMouseMove = (e: MouseEvent) => { if (this.dragging) this.apply(e); };
    private onMouseUp = () => {
        this.dragging = false;
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
        this.props.onRelease();
    };
    componentWillUnmount() {
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
    }

    render() {
        const { fraction } = this.props;
        return <div
            onMouseDown={this.onMouseDown}
            title="Drag onto the seam between your monitors — release to set"
            className={css.fixed.top(0).bottom(0).left(`${fraction * 100}%`).width(24).marginLeft(-12)
                .zIndex(40).cursor("ew-resize").hbox(0).justifyContent("center")}
        >
            <div className={css.width(2).height("100%").hsl(50, 90, 55) + RS.PlayerSplit} />
        </div>;
    }
}
