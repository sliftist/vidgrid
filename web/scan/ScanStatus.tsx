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
import { currentScanSnapshot, coordinatorCounts, isScanRunning, ScanPhase } from "./scanStatusBus";
import { scanErrorCount } from "./scanErrors";
import { goToScanning } from "../router";
import { cap } from "../search/gridShared";
import {
    buttonDown, controlPad,
    controlSurface, controlSurfaceAccent, controlSurfaceSwitching, controlSurfaceDanger, controlSurfaceSuccess,
    actionBtn, chipBtn, chipDim, selectorBtn, chipError, chipSuccess, dangerBtn,
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
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s per`;
}
function etaLabel(etaMs: number | undefined): string | undefined {
    if (etaMs === undefined || !(etaMs > 0)) return undefined;
    return `ETA ${formatTime(etaMs)}`;
}
function countLabel(n: number | undefined): string {
    // "—" (not "?") when the worker hasn't reported yet; it resolves in a second.
    return n === undefined ? "—" : String(n);
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
    // Sub-progress WITHIN the file currently being scanned (active phase only):
    // fraction 0..1 fills the cell's background; detail is the exact per-file
    // status shown in the tooltip. undefined fraction → indeterminate (metadata).
    fraction?: number;
    detail?: string;
    // Relative path of the file being scanned right now (active phase only) —
    // shown at the top of the tooltip so you can see what it's working on.
    currentFile?: string;
    // Initial file-system walk in progress: renders in a distinct (accent)
    // color to say "files are being discovered; nothing is being scanned yet".
    // Only the metadata cell ever passes this true.
    walking?: boolean;
    onToggle: () => void;
}> {
    render() {
        const p = this.props;
        const hovered = hoveredPhase.get() === p.phase;
        const action = p.phaseEnabled ? "disable" : "enable";

        // Surface — shared control styles only, never a bespoke look. Order of
        // precedence: hover (green enable / red disable) → walking (accent blue,
        // metadata-only) → active phase (amber pulse) → phase-off (just the
        // label, dimmed) → idle neutral.
        let surface: string;
        if (hovered) {
            surface = p.phaseEnabled
                ? controlSurfaceDanger + controlPad + RS.ButtonDanger
                : controlSurfaceSuccess + controlPad + RS.ButtonSuccess;
        }
        else if (p.walking) surface = controlSurfaceAccent + controlPad + RS.ButtonActive;
        else if (p.active) surface = controlSurfaceSwitching + controlPad + RS.ButtonActive;
        else if (!p.phaseEnabled) surface = controlSurface + controlPad + css.opacity(0.5) + RS.Button;
        else surface = controlSurface + controlPad + RS.Button;

        // Tooltip: the phase description, plus — while active — the file being
        // scanned right now and the exact in-flight progress.
        const activeLines = (p.active || p.walking)
            ? [p.walking ? "Discovering files..." : undefined, p.currentFile && `Scanning: ${p.currentFile}`, p.detail].filter(Boolean).join("\n")
            : "";
        const title = activeLines ? `${p.title}\n\n${activeLines}` : p.title;
        const showFill = p.active && p.fraction !== undefined;
        const showCount = p.phaseEnabled; // no count when a phase is off — there's nothing to scan

        return <div className={css.position("relative").vbox(0).alignItems("center")}>
            <button
                className={surface + cellContent + css.position("relative").overflowHidden}
                onMouseEnter={() => setHovered(p.phase)}
                onMouseLeave={() => setHovered(undefined)}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("toggle"); p.onToggle(); }}
                title={title}
            >
                {/* Filling progress bar for the current file — a brighter band that
                  * grows left→right behind the number. Width is an INLINE style
                  * (per feedback_css_dynamic_values: a value that changes over time
                  * in css.* would leak a <style> rule each update). The 1s linear
                  * transition matches the 1/s heartbeat so it glides smoothly. */}
                {showFill && <div
                    className={css.position("absolute").left(0).top(0).height("100%").zIndex(0)
                        .pointerEvents("none").background("hsla(0, 0%, 100%, 0.2)").transition("width 1s linear")}
                    style={{ width: `${(p.fraction! * 100).toFixed(1)}%` }}
                />}
                <div className={css.position("relative").zIndex(1).vbox(1).alignItems("center")}>
                    {showCount ? (
                        <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>
                            {countLabel(p.remaining)}
                            {p.active && p.rate && <span className={css.fontSize(11).fontWeight("normal").opacity(0.9)}> ({p.rate})</span>}
                        </div>
                    ) : (
                        // Phase disabled: no count — there's nothing to scan. Just
                        // the label, click to enable.
                        <div className={css.fontSize(11).opacity(0.75)}>off</div>
                    )}
                    <div className={css.fontSize(9).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em")}>{p.phase}</div>
                    {p.active && p.eta && <div className={css.fontSize(9).opacity(0.9)}>{p.eta}</div>}
                </div>
            </button>
            {hovered && <div className={(p.phaseEnabled ? chipError : chipSuccess) + css.position("absolute").top("100%").left("50%")
                .marginTop(4).zIndex(50).whiteSpace("nowrap").pointerEvents("none").transform("translateX(-50%)")}>
                {cap(action)} {p.phase}
            </div>}
        </div>;
    }
}

@observer
export class ScanStatus extends preact.Component<{ compact?: boolean }> {
    render() {
        // BOTH come from the same broadcast state object the coordinator sends
        // (full state, 1/s) — counts and progress can never be out of sync.
        const snap = currentScanSnapshot();
        const counts = coordinatorCounts();

        const masterOn = scanEnabled.get();
        const kfOn = keyframesScanEnabled.get();
        const facesOn = facesScanEnabled.get();
        // Phase cells appear whenever autoscan is on OR a scan is actually
        // running (the "Scan Now" one-shot case: autoscan is off but the coord
        // is burning through pending work — the user needs to see progress).
        const showPhases = masterOn || isScanRunning();

        const rate = rateLabel(snap.ratePerItemMs);
        const eta = etaLabel(snap.etaMs);
        const errorCount = scanErrorCount();

        return <div className={css.hbox(8, 2).wrap.alignItems("center")}>
            <style>{SWITCH_PULSE_CSS}</style>

            {/* Master enable/disable, leading the bar. Labeled by the ACTION
              * the click performs. Neutral surface — it's a plain toggle in
              * either direction, not a warning or a success. */}
            <button
                className={selectorBtn}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("toggle"); setScanEnabled(!masterOn); }}
                title={masterOn
                    ? "Autoscan is ON — the background scanner is running. Click to turn it off."
                    : "Autoscan is OFF — nothing is scanning in the background. Click to turn it on."}
            >
                {masterOn ? cap("disable autoscan") : cap("enable autoscan")}
            </button>

            {/* Phase cells appear whenever autoscan is on OR a scan is
              * actively running (the one-shot Scan-Now case). When neither is
              * true, "N files still need scanning" is misleading — nothing
              * would scan them — so we hide the phase cells and show only the
              * file count + view-files link (below). */}
            {showPhases && <>
                <PhaseCell
                    phase="metadata"
                    title={masterOn
                        ? `${countLabel(counts.metadataRemaining)} files still need metadata + poster (of ${countLabel(counts.total)}). Click to turn off all scanning.`
                        : `${countLabel(counts.metadataRemaining)} files still need metadata + poster (of ${countLabel(counts.total)}). Click to turn autoscan back on so this keeps running after the current one-shot pass.`}
                    remaining={counts.metadataRemaining}
                    phaseEnabled={showPhases}
                    active={snap.phase === "metadata"}
                    rate={rate} eta={eta}
                    fraction={snap.phase === "metadata" ? snap.fileFraction : undefined}
                    detail={snap.phase === "metadata" ? snap.fileDetail : undefined}
                    currentFile={snap.phase === "metadata" ? snap.currentKey : undefined}
                    walking={snap.walking}
                    onToggle={() => setScanEnabled(!masterOn)}
                />
                <PhaseCell
                    phase="keyframes"
                    title={kfOn
                        ? `${countLabel(counts.keyframesRemaining)} files still need keyframe strips (of ${countLabel(counts.total)}). Click to disable keyframe scanning.`
                        : `Keyframe scanning is off. Click to enable it.`}
                    remaining={counts.keyframesRemaining}
                    phaseEnabled={kfOn}
                    active={snap.phase === "keyframes"}
                    rate={rate} eta={eta}
                    fraction={snap.phase === "keyframes" ? snap.fileFraction : undefined}
                    detail={snap.phase === "keyframes" ? snap.fileDetail : undefined}
                    currentFile={snap.phase === "keyframes" ? snap.currentKey : undefined}
                    onToggle={() => setKeyframesScanEnabled(!kfOn)}
                />
                <PhaseCell
                    phase="faces"
                    title={facesOn
                        ? `${countLabel(counts.facesRemaining)} files still need face extraction (of ${countLabel(counts.total)}). Click to disable face scanning.`
                        : `Face scanning is off. Click to enable it.`}
                    remaining={counts.facesRemaining}
                    phaseEnabled={facesOn}
                    active={snap.phase === "faces"}
                    rate={rate} eta={eta}
                    fraction={snap.phase === "faces" ? snap.fileFraction : undefined}
                    detail={snap.phase === "faces" ? snap.fileDetail : undefined}
                    currentFile={snap.phase === "faces" ? snap.currentKey : undefined}
                    onToggle={() => setFacesScanEnabled(!facesOn)}
                />
            </>}

            {/* Total discovered — a non-clickable status chip. */}
            <div className={chipDim + cellContent}>
                <div className={css.fontSize(15).fontWeight("bold").lineHeight("1.1")}>{countLabel(counts.total)}</div>
                <div className={css.fontSize(9).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em")}>files</div>
            </div>

            {/* Error indicator — shows in every context (incl. the player bar) so
              * failures are noticed; clicking opens the Scanning page's error log. */}
            {errorCount > 0 && <button
                className={dangerBtn}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("navMove"); goToScanning(); }}
                title={`${errorCount} scan ${errorCount === 1 ? "error" : "errors"} — click to view`}
            >
                ⚠ {errorCount} {errorCount === 1 ? cap("error") : cap("errors")}
            </button>}

            {/* Always shown — it's part of the scanning info. */}
            <button
                className={chipBtn}
                onMouseDown={buttonDown()}
                onClick={() => { playSound("navMove"); goToScanning(); }}
                title="Open the background-scanning page (per-file scan status + controls)."
            >
                {cap("view files")} →
            </button>
        </div>;
    }
}
