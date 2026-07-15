import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatTime } from "socket-function/src/formatting/format";

import {
    scanEnabled, setScanEnabled,
    keyframesScanEnabled, setKeyframesScanEnabled,
    facesScanEnabled, setFacesScanEnabled,
} from "../appState";
import { scanCounts } from "./scanCounts";
import { currentScanSnapshot, ScanPhase } from "./scanStatusBus";
import { goToScanning } from "../router";
import { cap } from "../search/gridShared";
import { buttonDown } from "../styles";
import { playSound } from "../sounds";

// Shared background-scan status bar. Rendered in three places (grid sidebar,
// player bottom bar, top of the Scanning page) so scan state + control looks
// the same everywhere and there's one implementation to maintain.
//
// Layout left→right: master toggle · metadata · keyframes · faces · total ·
// link to the Scanning page. The phase currently doing work is highlighted and
// pulses (scanning is CPU/GPU heavy — it should be obvious). Each phase count
// is a toggle: click disables it (or re-enables, with the same cascade the
// setters enforce). On hover the count turns red and reveals an annotation
// BELOW it via an absolutely-positioned overlay, so hovering never resizes the
// button (no layout shift).

// Only one cell can be hovered at a time and only one ScanStatus is mounted per
// page, so a single module-level box is enough to drive the red/annotation
// state without per-instance state plumbing.
const hoveredPhase = observable.box<ScanPhase | undefined>(undefined, { deep: false });
function setHovered(p: ScanPhase | undefined) {
    runInAction(() => hoveredPhase.set(p));
}

// The pulse keyframes, injected once via a <style> tag. Static (not a per-frame
// css.* dynamic value) so it doesn't churn the stylesheet — see memory
// feedback_css_dynamic_values.
const SCAN_PULSE_CSS =
    "@keyframes vidgrid-scan-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }";

function rateLabel(ratePerItemMs: number | undefined): string | undefined {
    if (ratePerItemMs === undefined || !(ratePerItemMs > 0)) return undefined;
    const s = ratePerItemMs / 1000;
    // Sub-10s rates read better with one decimal ("0.5s/video"); slower ones
    // round to whole seconds.
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s/video`;
}
function etaLabel(etaMs: number | undefined): string | undefined {
    if (etaMs === undefined || !(etaMs > 0)) return undefined;
    return `ETA ${formatTime(etaMs)}`;
}

function countLabel(n: number | undefined): string {
    return n === undefined ? "?" : String(n);
}

@observer
export class PhaseCell extends preact.Component<{
    phase: ScanPhase;
    title: string;
    // Remaining count for this phase (undefined → "?").
    remaining: number | undefined;
    // Whether this phase is currently enabled in settings.
    phaseEnabled: boolean;
    // Whether this phase is the one actively doing work right now.
    active: boolean;
    // Rate / ETA to show under the count while this phase is active.
    rate: string | undefined;
    eta: string | undefined;
    onToggle: () => void;
}> {
    render() {
        const p = this.props;
        const hovered = hoveredPhase.get() === p.phase;
        const action = p.phaseEnabled ? "disable" : "enable";

        // Colors: active → bright animated accent; disabled → dim; hovered →
        // red (signals the click will change this phase's state). Base is a
        // neutral control surface.
        let bg = p.phaseEnabled ? "hsl(0, 0%, 18%)" : "hsl(0, 0%, 12%)";
        let fg = p.phaseEnabled ? "hsl(0, 0%, 90%)" : "hsl(0, 0%, 45%)";
        let border = "hsl(0, 0%, 26%)";
        if (p.active) {
            bg = "hsl(140, 60%, 30%)";
            fg = "white";
            border = "hsl(140, 55%, 50%)";
        }
        if (hovered) {
            bg = "hsl(0, 60%, 38%)";
            fg = "white";
            border = "hsl(0, 55%, 58%)";
        }

        // position:relative so the below-annotation overlay anchors here; the
        // overlay is absolutely positioned (top:100%) so it never affects
        // layout (no size change on hover).
        return <div className={css.position("relative").vbox(0).alignItems("center")}>
            <button
                className={
                    css.vbox(1).alignItems("center").pad2(8, 4).minWidth(64)
                        .background(bg).color(fg).border(`1px solid ${border}`).borderRadius(4)
                        .cursor("pointer").fontSize(12)
                        + (p.active ? css.animation("vidgrid-scan-pulse 1.1s ease-in-out infinite") : "")
                }
                onMouseEnter={() => setHovered(p.phase)}
                onMouseLeave={() => setHovered(undefined)}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("toggle"); p.onToggle(); }}
                title={p.title}
            >
                <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>
                    {countLabel(p.remaining)}
                </div>
                <div className={css.fontSize(9).opacity(0.8).textTransform("uppercase").letterSpacing("0.04em")}>
                    {p.phase}
                </div>
                {p.active && (p.rate || p.eta) && <div className={css.fontSize(9).opacity(0.85)}>
                    {[p.rate, p.eta].filter(Boolean).join(" · ")}
                </div>}
            </button>
            {hovered && <div className={
                css.position("absolute").top("100%").left("50%").marginTop(4)
                    .zIndex(50).whiteSpace("nowrap").pointerEvents("none")
                    .pad2(6, 3).borderRadius(4).fontSize(11)
                    .background("hsl(0, 60%, 28%)").color("white").border("1px solid hsl(0, 55%, 50%)")
                    // translateX(-50%) centers under the button without
                    // reserving width in flow (node is absolutely positioned).
                    .transform("translateX(-50%)")
            }>
                {cap(action)} {p.phase} scanning
            </div>}
        </div>;
    }
}

@observer
export class ScanStatus extends preact.Component<{ compact?: boolean }> {
    render() {
        const snap = currentScanSnapshot();
        const counts = scanCounts();

        const masterOn = scanEnabled.get();
        const kfOn = keyframesScanEnabled.get();
        const facesOn = facesScanEnabled.get();

        const rate = rateLabel(snap.ratePerItemMs);
        const eta = etaLabel(snap.etaMs);

        return <div className={css.hbox(8, 2).wrap.alignItems("center")}>
            <style>{SCAN_PULSE_CSS}</style>

            {/* Master enable/disable, leading the bar. */}
            <button
                className={
                    css.pad2(8, 5).borderRadius(4).cursor("pointer").fontSize(12).fontWeight("bold")
                        .border(`1px solid ${masterOn ? "hsl(140, 55%, 50%)" : "hsl(0, 0%, 30%)"}`)
                        .background(masterOn ? "hsl(140, 55%, 32%)" : "hsl(0, 0%, 14%)")
                        .color(masterOn ? "white" : "hsl(0, 0%, 60%)")
                }
                onMouseDown={buttonDown()}
                onClick={() => { playSound("toggle"); setScanEnabled(!masterOn); }}
                title={masterOn
                    ? "Background scanning is ON. Click to stop all scanning (stays off until turned back on)."
                    : "Background scanning is OFF. Click to resume scanning the library."}
            >
                {masterOn ? cap("scanning on") : cap("scanning off")}
            </button>

            <PhaseCell
                phase="metadata"
                title={`${counts.metadataRemaining} files still need metadata + poster (of ${counts.total}). Click to ${masterOn ? "turn off all scanning" : "turn scanning back on"}.`}
                remaining={counts.metadataRemaining}
                phaseEnabled={masterOn}
                active={snap.phase === "metadata"}
                rate={rate}
                eta={eta}
                onToggle={() => setScanEnabled(!masterOn)}
            />
            <PhaseCell
                phase="keyframes"
                title={`${countLabel(counts.keyframesRemaining)} files still need keyframe strips (of ${counts.total}). Click to ${kfOn ? "disable" : "enable"} keyframe scanning.`}
                remaining={counts.keyframesRemaining}
                phaseEnabled={kfOn}
                active={snap.phase === "keyframes"}
                rate={rate}
                eta={eta}
                onToggle={() => setKeyframesScanEnabled(!kfOn)}
            />
            <PhaseCell
                phase="faces"
                title={`${counts.facesRemaining} files still need face extraction (of ${counts.total}). Click to ${facesOn ? "disable" : "enable"} face scanning.`}
                remaining={counts.facesRemaining}
                phaseEnabled={facesOn}
                active={snap.phase === "faces"}
                rate={rate}
                eta={eta}
                onToggle={() => setFacesScanEnabled(!facesOn)}
            />

            {/* Total discovered — informational, not a toggle. */}
            <div className={css.vbox(1).alignItems("center").pad2(8, 4).minWidth(56)
                .color("hsl(0, 0%, 75%)")}>
                <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>{counts.total}</div>
                <div className={css.fontSize(9).opacity(0.8).textTransform("uppercase").letterSpacing("0.04em")}>total</div>
            </div>

            {!this.props.compact && <button
                className={css.pad2(8, 5).borderRadius(4).cursor("pointer").fontSize(12)
                    .border("1px solid hsl(210, 40%, 45%)").background("hsl(210, 40%, 24%)").color("white")}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("navMove"); goToScanning(); }}
                title="Open the background-scanning page (per-file scan status + controls)."
            >
                {cap("scanning page")} →
            </button>}
        </div>;
    }
}
