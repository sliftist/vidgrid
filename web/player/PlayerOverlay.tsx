import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { actionBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { PlayerStatus } from "./VideoPlayer";
import { ioStats, readRatePerSec } from "./ioStats";
import { formatBytes } from "../scan/thumbnails";

// Bottom overlay for the player page: track bar + filename + play/pause
// indicator (showing both intended and actual states so a slow seek/decoder
// doesn't leave the user wondering what they clicked).
//
// Flat backgrounds only — no gradients. Caller controls visibility via the
// `visible` prop driven by MouseIdleTracker.

export interface PlayerOverlayProps {
    visible: boolean;
    fileName: string;
    fileSizeText?: string;
    status: PlayerStatus;
    intendedPlaying: boolean;
    // Non-undefined when we want to be playing but the pipeline is blocked on
    // something (opening, decoding, stalled, …). Drives the play button's
    // yellow "not playing yet" state + hover title. undefined = playing fine.
    waitReason?: string;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onSeek: (sec: number) => void;
    // Clicked-fraction (0..1) seek for when no duration is known yet (e.g. an
    // AVI that has ended, so the live player reports no duration). The parent
    // resolves it to an absolute time once a duration becomes available.
    onSeekFraction?: (fr: number) => void;
    // Last-known duration for this file (persisted from a prior play). Lets the
    // trackbar stay usable when the live player has no duration — e.g. AVIs that
    // drop their duration on completion.
    fallbackDurationSec?: number;
    onTogglePause: () => void;
    // Loop region. When both are defined, two draggable thumbs render
    // above the trackbar; dragging them calls the change callbacks.
    // Undefined = no loop, no thumbs.
    loopStartSec?: number;
    loopEndSec?: number;
    onLoopStartChange?: (sec: number) => void;
    onLoopEndChange?: (sec: number) => void;
    // Fired when a loop thumb is released (mouseup), with the final
    // seconds. Lets the parent start playback from the released point.
    onLoopStartRelease?: (sec: number) => void;
    onLoopEndRelease?: (sec: number) => void;
    rightExtras?: preact.ComponentChildren;
    // Rendered right after the play/pause button so it sits visually beside
    // the primary transport control.
    leftExtras?: preact.ComponentChildren;
}

@observer
export class PlayerOverlay extends preact.Component<PlayerOverlayProps> {
    render() {
        const { visible, fileName, fileSizeText, status, intendedPlaying, waitReason,
            onMouseEnter, onMouseLeave, onSeek, onSeekFraction, fallbackDurationSec, onTogglePause,
            rightExtras, leftExtras,
            loopStartSec, loopEndSec, onLoopStartChange, onLoopEndChange,
            onLoopStartRelease, onLoopEndRelease } = this.props;
        const liveDurMs = status.durationMs ?? 0;
        const durMs = liveDurMs > 0 ? liveDurMs : (fallbackDurationSec ?? 0) * 1000;
        const curMs = status.currentTimeMs ?? 0;
        const pct = durMs > 0 ? Math.min(100, (curMs / durMs) * 100) : 0;
        const waiting = waitReason !== undefined;
        const durSec = durMs / 1000;
        const showLoop = loopStartSec !== undefined && loopEndSec !== undefined && durSec > 0;

        return <div
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            className={css.fixed.left(0).right(0).bottom(0).zIndex(20)
                .vbox(8)
                .hsla(0, 0, 0, 0.55).color("white")
                .transition("opacity 180ms")
                .opacity(visible ? 1 : 0)
                .pointerEvents(visible ? "auto" : "none") + RS.PlayerBar}
        >
            <div className={css.hbox(12).alignCenter.pad2(10, 4).paddingBottom(0)}>
                <button
                    className={actionBtn + css.minWidth(72)
                        + (waiting ? css.hsl(45, 90, 50).color("hsl(0, 0%, 10%)") : "")}
                    onMouseDown={onTogglePause}
                    title={waitReason}
                >
                    {intendedPlaying ? "⏸" : "▶"}
                </button>
                {leftExtras}
                <span className={css.fontSize(13).pad2(3, 8).whiteSpace("nowrap")
                    .hsla(0, 0, 0, 0.7).color("white") + RS.PlayerPill}>
                    {fmtTime(curMs / 1000)} / {fmtTime(durMs / 1000)}
                </span>
                <span className={css.fontSize(13).pad2(3, 8).whiteSpace("nowrap")
                    .hsla(0, 0, 0, 0.7).color("white") + RS.PlayerPill}
                    title="↑/↓ to change volume">
                    vol: {Math.round((status.volume ?? 1) * 100)}%
                </span>
                {status.nominalFps && <span className={css.fontSize(11).pad2(3, 8).whiteSpace("nowrap")
                    .hsla(0, 0, 0, 0.7).color("hsl(0, 0%, 80%)") + RS.PlayerPill}
                    title="step a frame with , / .">
                    {status.nominalFps.toFixed(2)}fps
                </span>}
                {rightExtras}
                {/* Filename last + flex-grow so an arbitrarily long title
                  * ellipsizes into the remaining space instead of pushing
                  * the fixed transport/volume/fps controls off-screen. */}
                <div className={css.fontSize(13).flexGrow(1).ellipsis.minWidth(0) + RS.PlayerName} title={fileName}>
                    {fileName}
                    {fileSizeText && <span className={css.marginLeft(8).opacity(0.7)}>{fileSizeText}</span>}
                </div>
                <span className={css.fontSize(11).pad2(3, 8).whiteSpace("nowrap")
                    .hsla(0, 0, 0, 0.7).color(ioStats.outstandingBytes > 0 ? "hsl(45, 90%, 70%)" : "hsl(0, 0%, 80%)") + RS.PlayerPill}
                    title="Disk reads: total this session · throughput over the last 60s · outstanding (requested but not yet returned)">
                    disk: {formatBytes(ioStats.totalBytes)} · {formatBytes(readRatePerSec())}/s · out {formatBytes(ioStats.outstandingBytes)}
                </span>
            </div>
            {/* Trackbar always renders, even with no known duration (e.g. an
              * ended AVI) — otherwise there's no way to scrub back. With an
              * unknown duration the click is sent as a fraction and resolved
              * once a duration is available. */}
            <div
                data-loop-trackbar
                className={css.relative.width("100%").height(36).hsla(0, 0, 100, 0.18).pointer
                    + (showLoop ? css.marginTop(14) : "") + RS.Surface}
                onMouseDown={e => {
                    // A loop-thumb mousedown stops propagation so we only
                    // get bare-trackbar clicks here.
                    const target = e.currentTarget as HTMLDivElement;
                    const rect = target.getBoundingClientRect();
                    const fr = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    if (durMs > 0) onSeek(fr * (durMs / 1000));
                    else onSeekFraction?.(fr);
                }}
            >
                <div className={css.absolute.height("100%").hsl(220, 70, 55)
                    .width(`${pct}%`) + RS.PlayerSeek}
                />
                {showLoop && (() => {
                    const startPct = Math.max(0, Math.min(100, (loopStartSec! / durSec) * 100));
                    const endPct = Math.max(0, Math.min(100, (loopEndSec! / durSec) * 100));
                    return <>
                        {/* Loop region highlight between the two thumbs. */}
                        <div className={
                            css.absolute.top(0).bottom(0)
                                .left(`${startPct}%`).width(`${endPct - startPct}%`)
                                .hsla(50, 80, 50, 0.35)
                                .pointerEvents("none") + RS.Accent
                        } />
                        <LoopThumb
                            pct={startPct}
                            label={fmtTime(loopStartSec!)}
                            durSec={durSec}
                            onChange={onLoopStartChange!}
                            onRelease={onLoopStartRelease}
                        />
                        <LoopThumb
                            pct={endPct}
                            label={fmtTime(loopEndSec!)}
                            durSec={durSec}
                            onChange={onLoopEndChange!}
                            onRelease={onLoopEndRelease}
                        />
                    </>;
                })()}
            </div>
        </div>;
    }
}

// Loop-region drag handle that sits above the trackbar with a thin line
// running down through it, so it's visually clear which trackbar point
// each thumb pins. mousedown on the thumb installs document-level
// mousemove/mouseup listeners that read the trackbar's bounding rect
// fresh on every move, so the math doesn't drift if the page resizes
// mid-drag.
class LoopThumb extends preact.Component<{
    pct: number;
    label: string;
    durSec: number;
    onChange: (sec: number) => void;
    // Fired once on mouseup with the final dragged-to seconds, so the
    // parent can start playback from the released position.
    onRelease?: (sec: number) => void;
}> {
    private dragging = false;
    private trackbarEl: HTMLDivElement | undefined;
    // Last seconds computed during this drag, replayed to onRelease on
    // mouseup. Falls back to the thumb's resting position if the user
    // clicked without moving.
    private lastSec: number | undefined;

    private onMouseDown = (e: MouseEvent) => {
        // Don't let the trackbar's onMouseDown fire (which would seek
        // playback to the thumb's location).
        e.stopPropagation();
        e.preventDefault();
        if (e.button !== 0) return;
        const target = e.currentTarget as HTMLElement;
        const host = target.closest("[data-loop-trackbar]") as HTMLDivElement | null;
        if (!host) return;
        this.trackbarEl = host;
        this.dragging = true;
        this.lastSec = undefined;
        document.addEventListener("mousemove", this.onMouseMove);
        document.addEventListener("mouseup", this.onMouseUp);
    };
    private onMouseMove = (e: MouseEvent) => {
        if (!this.dragging || !this.trackbarEl) return;
        const rect = this.trackbarEl.getBoundingClientRect();
        const fr = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.lastSec = fr * this.props.durSec;
        this.props.onChange(this.lastSec);
    };
    private onMouseUp = () => {
        this.dragging = false;
        this.trackbarEl = undefined;
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
        const sec = this.lastSec ?? (this.props.pct / 100) * this.props.durSec;
        this.props.onRelease?.(sec);
    };

    componentWillUnmount() {
        // Defensive — if the thumb is unmounted mid-drag, lose the doc listeners.
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
    }

    render() {
        const { pct, label } = this.props;
        return <div
            onMouseDown={this.onMouseDown}
            title={`drag to change · ${label}`}
            className={
                css.absolute.top(-14).left(`${pct}%`).marginLeft(-7)
                    .width(14).zIndex(2).pointer
                    .display("flex").flexDirection("column").alignItems("center")
            }
        >
            <div className={
                css.size(14, 14).hsl(50, 90, 55)
                    .bord(1, "hsl(40, 80%, 30%)") + RS.Accent
            } />
            {/* Vertical line down through the full trackbar. */}
            <div className={
                css.width(2).height(36).hsl(50, 90, 55).opacity(0.85)
                    .pointerEvents("none") + RS.Accent
            } />
        </div>;
    }
}

function fmtTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
