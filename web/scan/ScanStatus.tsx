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
import { currentScanSnapshot, walkTiming, ScanPhase } from "./scanStatusBus";
import { requestFileWalkNow } from "./scanClient";
import { goToScanning } from "../router";
import { cap } from "../search/gridShared";
import {
    buttonDown, controlPad,
    controlSurface, controlSurfaceSwitching, controlSurfaceDanger,
    actionBtn, chipBtn, chipDim, selectorBtn, selectorBtnActive, chipError,
} from "../styles";
import { RS } from "../restyle/classNames";
import { playSound } from "../sounds";

// Shared background-scan status bar. Rendered in three places (grid sidebar,
// player bottom bar, top of the Scanning page) so scan state + control looks the
// same everywhere and there's one implementation to maintain.
//
// Layout left→right: master toggle · metadata · keyframes · faces · total ·
// link to the Scanning page. The phase currently doing work uses the app's
// "switching" surface (amber + control-switch-pulse) so it's obvious work is
// happening. Each phase count is a toggle: click disables it (or re-enables,
// with the same cascade the setters enforce). On hover the count uses the
// danger surface and reveals an annotation BELOW it via an absolutely-positioned
// overlay, so hovering never shifts layout.

// Only one cell can be hovered at a time and only one ScanStatus is mounted per
// page, so a single module-level box drives the danger/annotation state.
const hoveredPhase = observable.box<ScanPhase | undefined>(undefined, { deep: false });
function setHovered(p: ScanPhase | undefined) {
    runInAction(() => hoveredPhase.set(p));
}

// controlSurfaceSwitching references these keyframes; inject once (mirrors how
// PlayerPage/EngineToggle provide them where the switching surface is used).
const SWITCH_PULSE_CSS =
    "@keyframes control-switch-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }";

function rateLabel(ratePerItemMs: number | undefined): string | undefined {
    if (ratePerItemMs === undefined || !(ratePerItemMs > 0)) return undefined;
    const s = ratePerItemMs / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s/video`;
}
function etaLabel(etaMs: number | undefined): string | undefined {
    if (etaMs === undefined || !(etaMs > 0)) return undefined;
    return `ETA ${formatTime(etaMs)}`;
}
function countLabel(n: number | undefined): string {
    // "—" (not "?") when the worker hasn't reported yet; it resolves in a second.
    return n === undefined ? "—" : String(n);
}

// Title for the "check for new files" button — how long until the next automatic
// (daily) disk walk. Reactive: reads the worker-published walk timing.
function nextCheckTitle(): string {
    const { nextWalkAt } = walkTiming();
    if (!nextWalkAt) return "Check the folder for new files now. (Runs automatically once a day.)";
    const remaining = nextWalkAt - Date.now();
    if (remaining <= 0) return "Check the folder for new files now. (An automatic check is due.)";
    return `Check the folder for new files now. Next automatic check in ${formatTime(remaining)}.`;
}

// Content layout shared by every count cell (stack the number over its label).
const cellContent = css.vbox(1).alignItems("center").minWidth(56);

@observer
export class PhaseCell extends preact.Component<{
    phase: ScanPhase;
    title: string;
    remaining: number | undefined;      // undefined → "?"
    phaseEnabled: boolean;
    active: boolean;                     // this phase is doing work right now
    rate: string | undefined;
    eta: string | undefined;
    onToggle: () => void;
}> {
    render() {
        const p = this.props;
        const hovered = hoveredPhase.get() === p.phase;
        const action = p.phaseEnabled ? "disable" : "enable";

        // Surface comes from the shared control styles — never a bespoke look.
        // hovered → danger (red), active → switching (amber pulse), disabled →
        // dimmed neutral, else neutral.
        let surface: string;
        if (hovered) surface = controlSurfaceDanger + controlPad + RS.ButtonDanger;
        else if (p.active) surface = controlSurfaceSwitching + controlPad + RS.ButtonActive;
        else if (!p.phaseEnabled) surface = controlSurface + controlPad + css.opacity(0.5) + RS.Button;
        else surface = controlSurface + controlPad + RS.Button;

        return <div className={css.position("relative").vbox(0).alignItems("center")}>
            <button
                className={surface + cellContent}
                onMouseEnter={() => setHovered(p.phase)}
                onMouseLeave={() => setHovered(undefined)}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("toggle"); p.onToggle(); }}
                title={p.title}
            >
                <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>{countLabel(p.remaining)}</div>
                <div className={css.fontSize(9).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em")}>{p.phase}</div>
                {p.active && (p.rate || p.eta) && <div className={css.fontSize(9).opacity(0.9)}>
                    {[p.rate, p.eta].filter(Boolean).join(" · ")}
                </div>}
            </button>
            {hovered && <div className={chipError + css.position("absolute").top("100%").left("50%")
                .marginTop(4).zIndex(50).whiteSpace("nowrap").pointerEvents("none").transform("translateX(-50%)")}>
                {cap(action)} {p.phase}
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
            <style>{SWITCH_PULSE_CSS}</style>

            {/* Master enable/disable, leading the bar. Accent when on. */}
            <button
                className={masterOn ? selectorBtnActive : selectorBtn}
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
                rate={rate} eta={eta}
                onToggle={() => setScanEnabled(!masterOn)}
            />
            <PhaseCell
                phase="keyframes"
                title={`${countLabel(counts.keyframesRemaining)} files still need keyframe strips (of ${counts.total}). Click to ${kfOn ? "disable" : "enable"} keyframe scanning.`}
                remaining={counts.keyframesRemaining}
                phaseEnabled={kfOn}
                active={snap.phase === "keyframes"}
                rate={rate} eta={eta}
                onToggle={() => setKeyframesScanEnabled(!kfOn)}
            />
            <PhaseCell
                phase="faces"
                title={`${counts.facesRemaining} files still need face extraction (of ${counts.total}). Click to ${facesOn ? "disable" : "enable"} face scanning.`}
                remaining={counts.facesRemaining}
                phaseEnabled={facesOn}
                active={snap.phase === "faces"}
                rate={rate} eta={eta}
                onToggle={() => setFacesScanEnabled(!facesOn)}
            />

            {/* Total discovered — a non-clickable status chip. */}
            <div className={chipDim + cellContent}>
                <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>{counts.total}</div>
                <div className={css.fontSize(9).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em")}>total</div>
            </div>

            {/* Force a fresh disk walk for new files now. The library is otherwise
              * re-walked automatically once a day; hovering says how long until then. */}
            <button
                className={chipBtn}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("scanStart"); requestFileWalkNow(); }}
                title={nextCheckTitle()}
            >
                {cap("check for new files")}
            </button>

            {!this.props.compact && <button
                className={chipBtn}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("navMove"); goToScanning(); }}
                title="Open the background-scanning page (per-file scan status + controls)."
            >
                {cap("scanning page")} →
            </button>}
        </div>;
    }
}
