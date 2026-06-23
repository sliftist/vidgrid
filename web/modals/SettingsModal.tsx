// Settings modal. One-stop place for every persisted user preference.
// Backed by localStorage via the setters in appState; observables drive
// the live reactivity so toggling a setting here updates the grid the
// same render tick.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { formatBytes } from "../scan/thumbnails";
import {
    autoFlipPreview, setAutoFlipPreview,
    accurateThumbnails, setAccurateThumbnails,
    facesScanEnabled, setFacesScanEnabled,
    keyframesScanEnabled, setKeyframesScanEnabled,
    facesFp16, setFacesFp16,
    fastOpenSeries, setFastOpenSeries,
    disableThemeBackgrounds, setDisableThemeBackgrounds,
    hoverExpandDisabled, setDisableHoverExpand, disableHoverExpandExplicit,
    keyframePreviewDisabled, setDisableKeyframePreview, disableKeyframePreviewExplicit,
    forceScanOnRemote, setForceScanOnRemote,
    animationMs, setAnimationMs,
    hoverGraceMs, setHoverGraceMs,
    previewCycleMs, setPreviewCycleMs,
    hdrExposure, setHdrExposure,
    resultPageSize, setResultPageSize,
    seriesMinVideos, setSeriesMinVideos,
    sidebarWidthFormula, setSidebarWidthFormula, resetSidebarWidthFormula,
    DEFAULT_SIDEBAR_WIDTH_FORMULA, evalSidebarWidth,
    defaultPlayerEngine, setDefaultPlayerEngine, PlayerEngine,
    faceThumbnailMode, setFaceThumbnailMode, FaceThumbnailMode,
    files, thumbnails, keyframes, faceFrames, characters,
} from "../appState";
import { lists, listMemberships } from "../lists/lists";
import { settingsPanelPad, checkboxInput, actionBtn, selectorBtn, selectorBtnActive, fieldInput } from "../styles";
import { RS } from "../restyle/classNames";
import { modalParam } from "../router";
import { playSound } from "../sounds";

export function openSettings() {
    playSound("modalOpen");
    modalParam.set("settings");
}

export function closeSettings() {
    playSound("modalClose");
    if (modalParam.get() === "settings") modalParam.set("");
}

interface SettingDef {
    label: string;
    description: string;
    get: () => boolean;
    set: (v: boolean) => void;
    // When provided, lets the row tell a user's explicit choice apart from a
    // per-device default. If the user hasn't chosen and the effective value is
    // on, the checkbox renders indeterminate — "on for this device, not
    // because you turned it on".
    isExplicit?: () => boolean;
}

const SETTINGS: SettingDef[] = [
    {
        label: "Keyframe scanning",
        description: "Extract one frame per 15/30/60s from every video for hover previews and accurate thumbnails. Decodes frames across the whole library, so it's slow on large collections — off by default. Prerequisite for face scanning.",
        get: () => keyframesScanEnabled.get(),
        set: setKeyframesScanEnabled,
    },
    {
        label: "Face scanning",
        description: "Scan keyframes for faces, cluster into characters, enable face search. GPU-heavy and downloads ~190 MB of models on first use — off by default.",
        get: () => facesScanEnabled.get(),
        set: setFacesScanEnabled,
    },
    {
        label: "Face models: float16 (experimental)",
        description: "Run the face detection + embedding models in half precision. Can be faster on some GPUs (neutral on others); detection/match quality is essentially unchanged. Downloads separate ~half-size model files. Off by default — turn on to test if your GPU benefits.",
        get: () => facesFp16.get(),
        set: setFacesFp16,
    },
    {
        label: "Fast-open series",
        description: "Clicking a series tile jumps straight to the last-played video (or the first, if none played) instead of drilling into the series.",
        get: () => fastOpenSeries.get(),
        set: setFastOpenSeries,
    },
    {
        label: "Disable hover-expand",
        description: "Stop tiles from expanding when hovered. Each tile instead gets a \"?\" button that expands it on click — the same view a hover would show. On by default for devices with no mouse pointer (e.g. a TV remote).",
        get: () => hoverExpandDisabled(),
        set: setDisableHoverExpand,
        isExplicit: disableHoverExpandExplicit,
    },
    {
        label: "Accurate thumbnails",
        description: "For cells with a saved playback position, use the nearest keyframe-preview frame at-or-before that position as the thumbnail.",
        get: () => accurateThumbnails.get(),
        set: setAccurateThumbnails,
    },
    {
        label: "Auto-flip previews",
        description: "Cycle every cell's keyframe-preview strip continuously, not just the hovered one.",
        get: () => autoFlipPreview.get(),
        set: setAutoFlipPreview,
    },
    {
        label: "Disable keyframe preview",
        description: "Stop reading the per-video keyframe strip used for hover previews and accurate thumbnails. On by default for network-served libraries.",
        get: () => keyframePreviewDisabled(),
        set: setDisableKeyframePreview,
        isExplicit: disableKeyframePreviewExplicit,
    },
    {
        label: "Scan remote libraries",
        description: "Run scans even when the library is served over the network. Off by default — a network-served library is normally built on another device, and this one is just a viewer (e.g. a TV).",
        get: () => forceScanOnRemote.get(),
        set: setForceScanOnRemote,
    },
    {
        label: "Disable theme backgrounds",
        description: "Drop a theme's wallpaper scene image and use its plain background gradient instead. Useful when a theme's background feels too busy behind the grid and sidebar.",
        get: () => disableThemeBackgrounds.get(),
        set: setDisableThemeBackgrounds,
    },
];

@observer
export class SettingsModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && modalParam.get() === "settings") {
            e.preventDefault();
            closeSettings();
        }
    };

    render() {
        if (modalParam.get() !== "settings") return null;
        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeSettings(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(840).fillWidth.maxHeight("85vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={settingsPanelPad + css.flexGrow(1).minHeight(0).overflowAuto.vbox(12)}>
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>Settings</div>
                    <button
                        onMouseDown={() => closeSettings()}
                        className={actionBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.vbox(10)}>
                    {SETTINGS.map(s => <SettingRow key={s.label} setting={s} />)}
                    <ResultPageSizeRow />
                    <SidebarFormulaRow />
                    <SliderRow
                        label="Animation duration"
                        description="Global transition time (ms) used everywhere the UI animates. Crank it up to see where elements are supposed to land during a hover-expand; drop it to 0 to disable motion."
                        value={animationMs.get()}
                        min={0} max={2000} step={50} unit="ms"
                        onChange={setAnimationMs}
                    />
                    <SliderRow
                        label="Hover grace delay"
                        description="After the mouse leaves an expanded grid cell it stays expanded for this long, and no other cell expands during the window. When it elapses, whatever the cursor is over then expands. 0 ms switches instantly."
                        value={hoverGraceMs.get()}
                        min={0} max={3000} step={50} unit="ms"
                        onChange={setHoverGraceMs}
                    />
                    <SliderRow
                        label="Preview cycle speed"
                        description="Delay between keyframe-preview frames when a cell is cycling (hovered, or all cells when Auto-flip is on). Lower is faster."
                        value={previewCycleMs.get()}
                        min={50} max={3000} step={50} unit="ms"
                        onChange={setPreviewCycleMs}
                    />
                    <SliderRow
                        label="HDR brightness"
                        description="Exposure for the approximate HDR→SDR tone map applied to HDR (HDR10/PQ/HLG) video in the player. Lower is darker, higher is brighter. Can't recover highlights the browser already clipped to white."
                        value={hdrExposure.get()}
                        min={0} max={1} step={0.05}
                        onChange={setHdrExposure}
                    />
                    <SliderRow
                        label="Series threshold"
                        description="A folder is grouped into a single series tile once it directly contains at least this many videos. Lower it to fold smaller folders into series; raise it to keep them as loose files."
                        value={seriesMinVideos.get()}
                        min={2} max={20} step={1}
                        onChange={setSeriesMinVideos}
                    />
                    <FaceThumbnailModeRow />
                    <DefaultPlayerEngineRow />
                </div>
                <div className={css.vbox(6)}>
                    <div className={css.fontSize(13).color("hsl(0, 0%, 75%)") + RS.Muted}>
                        Storage
                    </div>
                    {COLLECTIONS.map(db => <CollectionRow key={db.name}
                        db={db}
                    />)}
                </div>
                </div>
            </div>
        </div>;
    }
}

const COLLECTIONS: BulkDatabase2<any>[] = [
    files, thumbnails, keyframes, characters, faceFrames, lists, listMemberships,
] as BulkDatabase2<any>[];

@observer
class CollectionRow extends preact.Component<{
    db: BulkDatabase2<any>;
}> {
    synced = observable({
        info: undefined as {
            rowCount: number;
            columnCount: number;
            totalBytes: number;
            // Fraction of totalBytes still sitting in stream (uncompacted)
            // files vs. bulk (compacted, merged, per-cell-readable)
            // files. Compact moves bytes the other way and unlocks the
            // fast per-cell read path — high % here = collection wants
            // a Compact press. undefined for empty collections.
            uncompactedFraction: number | undefined;
            fileCount: number;
            // Fraction in [0,1) — rawKeys vs finalKeys after dedup;
            // surfaces how much compaction would reclaim. undefined
            // when the collection is empty.
            duplicateFraction: number | undefined;
            // Per-column byte sizes from getReaderInfo, sorted
            // largest-first so the expanded view leads with the
            // columns actually driving the on-disk size.
            columns: { column: string; byteSize: number }[];
        } | undefined,
        loading: false,
        compacting: false,
        error: undefined as string | undefined,
        expanded: false,
    });

    componentDidMount() {
        void this.refresh();
    }

    private async refresh() {
        runInAction(() => { this.synced.loading = true; this.synced.error = undefined; });
        try {
            const [reader, files, keyStats] = await Promise.all([
                this.props.db.getReaderInfo(),
                this.props.db.getFileInfo(),
                this.props.db.getKeyStats(),
            ]);
            const columns = [...reader.columns].sort((a, b) => b.byteSize - a.byteSize);
            const streamBytes = files.files
                .filter(f => f.type === "stream")
                .reduce((a, f) => a + f.bytes, 0);
            runInAction(() => {
                this.synced.info = {
                    rowCount: reader.rowCount,
                    columnCount: reader.columns.length,
                    // Prefer getFileInfo()'s totalBytes — that's the real
                    // on-disk size including stream-file overhead, where
                    // getReaderInfo() is the live-row byte count.
                    totalBytes: files.totalBytes,
                    fileCount: files.count,
                    duplicateFraction: keyStats.rawKeys > 0
                        ? keyStats.wastedKeys / keyStats.rawKeys
                        : undefined,
                    uncompactedFraction: files.totalBytes > 0
                        ? streamBytes / files.totalBytes
                        : undefined,
                    columns,
                };
            });
        } catch (err) {
            runInAction(() => { this.synced.error = (err as Error).message ?? String(err); });
        } finally {
            runInAction(() => { this.synced.loading = false; });
        }
    }

    private compact = async () => {
        if (this.synced.compacting) return;
        runInAction(() => { this.synced.compacting = true; this.synced.error = undefined; });
        try {
            await this.props.db.compact();
            await this.refresh();
        } catch (err) {
            runInAction(() => { this.synced.error = (err as Error).message ?? String(err); });
        } finally {
            runInAction(() => { this.synced.compacting = false; });
        }
    };

    private toggleExpanded = () => {
        runInAction(() => { this.synced.expanded = !this.synced.expanded; });
    };

    render() {
        const label = this.props.db.name;
        const info = this.synced.info;
        const { loading, compacting, error, expanded } = this.synced;
        const canExpand = !!info && info.columns.length > 0;
        return <div className={css.vbox(0).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.hbox(10).alignCenter.pad(8)
                + (canExpand ? css.pointer : css)}
                onMouseDown={canExpand ? this.toggleExpanded : undefined}
                title={canExpand
                    ? (expanded ? "Click to collapse" : "Click to expand the per-column size breakdown")
                    : undefined}
            >
                <div className={css.vbox(3).flexGrow(1)}>
                    <div className={css.hbox(6).alignCenter}>
                        {canExpand && <span className={css.fontSize(10).color("hsl(0, 0%, 55%)")
                            .width(10).textAlign("center") + RS.Muted}>
                            {expanded ? "▾" : "▸"}
                        </span>}
                        <div className={css.fontSize(13)}>{label}</div>
                    </div>
                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>
                        {info
                            ? `${info.rowCount.toLocaleString()} row${info.rowCount === 1 ? "" : "s"} · ${info.columnCount.toLocaleString()} column${info.columnCount === 1 ? "" : "s"} · ${info.fileCount.toLocaleString()} file${info.fileCount === 1 ? "" : "s"} · ${formatBytes(info.totalBytes)}${info.duplicateFraction !== undefined ? ` · ${(info.duplicateFraction * 100).toFixed(info.duplicateFraction < 0.1 ? 1 : 0)}% duplicates` : ""}${info.uncompactedFraction !== undefined ? ` · ${(info.uncompactedFraction * 100).toFixed(info.uncompactedFraction < 0.1 ? 1 : 0)}% uncompacted` : ""}`
                            : loading ? "loading…" : (error ?? "—")}
                    </div>
                </div>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        void this.compact();
                    }}
                    disabled={compacting || loading}
                    className={actionBtn + css.minWidth(110)
                        + (compacting ? css.opacity(0.7) : css)
                        + (compacting || loading ? css.cursor("wait") : css)}
                    title="Consolidate on-disk files for this collection — reclaims space from deletes and superseded writes."
                >
                    {compacting ? "Compacting…" : "Compact"}
                </button>
            </div>
            {expanded && info && <div className={css.vbox(2).pad2(12, 8).hsl(0, 0, 11)
                .bord(1, "hsl(0, 0%, 18%)").fontSize(11) + RS.Surface}>
                {info.columns.map(c => <div
                    key={c.column}
                    className={css.hbox(10).alignCenter}
                >
                    <span className={css.color("hsl(0, 0%, 80%)").flexGrow(1).ellipsis + RS.Muted}>
                        {c.column}
                    </span>
                    <span className={css.color("hsl(0, 0%, 60%)").textAlign("right") + RS.Muted}>
                        {formatBytes(c.byteSize)}
                    </span>
                </div>)}
            </div>}
        </div>;
    }
}

@observer
class SettingRow extends preact.Component<{ setting: SettingDef }> {
    render() {
        const s = this.props.setting;
        const checked = s.get();
        const explicit = s.isExplicit ? s.isExplicit() : true;
        const indeterminate = !explicit && checked;
        return <label className={css.hbox(10).alignStart.pad(8).hsl(0, 0, 13)
            .bord(1, "hsl(0, 0%, 20%)").pointer.hslhover(0, 0, 16) + RS.Surface}>
            <input
                type="checkbox"
                checked={checked}
                ref={el => { if (el) el.indeterminate = indeterminate; }}
                onChange={(e: Event) => { playSound("toggle"); s.set((e.currentTarget as HTMLInputElement).checked); }}
                className={checkboxInput + css.marginTop(2)}
            />
            <div className={css.vbox(3).flexGrow(1)}>
                <div className={css.fontSize(13)}>{s.label}</div>
                <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>{s.description}</div>
            </div>
        </label>;
    }
}

@observer
class FaceThumbnailModeRow extends preact.Component {
    render() {
        const cur = faceThumbnailMode.get();
        const options: { mode: FaceThumbnailMode; label: string; hint: string }[] = [
            { mode: "auto",   label: "Auto (series-aware)", hint: "Default. Folders with 5+ videos are treated as a series and use the second character (the recurring protagonist is uninteresting); smaller folders are standalone videos and use the first character." },
            { mode: "second", label: "Second character", hint: "Always use the second most-common character's representative face." },
            { mode: "first",  label: "First character",  hint: "Always use the most-common character's representative face." },
            { mode: "off",    label: "Off",             hint: "Don't auto-set a thumbnail from faces. Existing thumbnails are kept." },
        ];
        return <div className={css.vbox(6).pad(8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.fontSize(13)}>Auto face thumbnail</div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                After face scanning, promote a clustered character's most
                representative face (past the first 30% of the runtime,
                at least 128px wide) to the file thumbnail. User-picked
                thumbnails are always kept.
            </div>
            <div className={css.hbox(6).wrap}>
                {options.map(o => {
                    const selected = cur === o.mode;
                    return <button
                        key={o.mode}
                        onMouseDown={() => setFaceThumbnailMode(o.mode)}
                        title={o.hint}
                        className={selected ? selectorBtnActive : selectorBtn}
                    >
                        {o.label}
                    </button>;
                })}
            </div>
        </div>;
    }
}

@observer
class DefaultPlayerEngineRow extends preact.Component {
    render() {
        const cur = defaultPlayerEngine.get();
        const options: { engine: PlayerEngine; label: string; hint: string }[] = [
            { engine: "mediabunny", label: "Mediabunny", hint: "WebGPU + WebCodecs via mediabunny. Default; works on the broadest set of codecs." },
            { engine: "tv-hack",    label: "TV Hack", hint: "Native <video> for picture, but audio decoded by us and re-synced to the video clock. For TVs (e.g. Fire TV) where the native element plays video but no sound." },
            { engine: "native",     label: "Native <video>", hint: "Hand off to the browser's <video> element. Smallest CPU cost; codec coverage limited to what the OS exposes." },
            { engine: "web-demuxer", label: "web-demuxer", hint: "FFmpeg-WASM + WebCodecs prototype. Loaded on demand from a CDN — handy when neither of the other two opens a file (AVI, etc.)." },
        ];
        return <div className={css.vbox(6).pad(8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.fontSize(13)}>Default player engine</div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                Used when a video has no per-video engine preference saved.
                Switching engines from inside the player still saves the
                choice to that video and overrides this.
            </div>
            <div className={css.hbox(6).wrap}>
                {options.map(o => {
                    const selected = cur === o.engine;
                    return <button
                        key={o.engine}
                        onMouseDown={() => setDefaultPlayerEngine(o.engine)}
                        title={o.hint}
                        className={selected ? selectorBtnActive : selectorBtn}
                    >
                        {o.label}
                    </button>;
                })}
            </div>
        </div>;
    }
}

@observer
class SliderRow extends preact.Component<{
    label: string;
    description: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    onChange: (v: number) => void;
}> {
    // Custom turns on by itself when the value sits outside the slider's
    // range — a previously-saved arbitrary value has nowhere to live on
    // the track, so the number input is the only honest editor for it.
    synced = observable({ custom: false });
    private toggleCustom = () => {
        runInAction(() => { this.synced.custom = !this.synced.custom; });
    };
    render() {
        const { label, description, value, min, max, step, unit, onChange } = this.props;
        const custom = this.synced.custom || value < min || value > max;
        const suffix = unit ? ` ${unit}` : "";
        return <div className={css.vbox(6).pad(8).hsl(0, 0, 13)
            .bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.fontSize(13)}>{label}</div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>{description}</div>
            <div className={css.hbox(10).alignCenter}>
                {custom
                    ? <input
                        type="number"
                        min={min}
                        value={String(value)}
                        onInput={(e: Event) => onChange(Number((e.currentTarget as HTMLInputElement).value))}
                        className={fieldInput + css.flexGrow(1)}
                    />
                    : <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={String(value)}
                        onInput={(e: Event) => onChange(Number((e.currentTarget as HTMLInputElement).value))}
                        className={css.flexGrow(1)}
                    />}
                <span className={css.fontSize(12).minWidth(72).textAlign("right")}>
                    {value}{suffix}
                </span>
                <button
                    onMouseDown={this.toggleCustom}
                    title="Toggle a free-form number input"
                    className={custom ? selectorBtnActive : selectorBtn}
                >
                    Custom
                </button>
            </div>
        </div>;
    }
}

@observer
class ResultPageSizeRow extends preact.Component {
    synced = observable({ custom: false });
    private toggleCustom = () => {
        runInAction(() => { this.synced.custom = !this.synced.custom; });
    };
    render() {
        const value = resultPageSize.get();
        const presets = [20, 50, 100, 250];
        const custom = this.synced.custom || !presets.includes(value);
        return <div className={css.vbox(6).pad(8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.fontSize(13)}>Results per page</div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                How many results to show before infinite scroll loads the
                next batch — and how many each scroll-to-bottom reveals.
            </div>
            <div className={css.hbox(6).wrap.alignCenter}>
                {presets.map(n => {
                    const selected = !custom && value === n;
                    return <button
                        key={n}
                        onMouseDown={() => { runInAction(() => { this.synced.custom = false; }); setResultPageSize(n); }}
                        className={selected ? selectorBtnActive : selectorBtn}
                    >
                        {n}
                    </button>;
                })}
                <button
                    onMouseDown={this.toggleCustom}
                    title="Set any value"
                    className={custom ? selectorBtnActive : selectorBtn}
                >
                    Custom
                </button>
                {custom && <input
                    type="number"
                    min={1}
                    value={String(value)}
                    onInput={(e: Event) => setResultPageSize(Number((e.currentTarget as HTMLInputElement).value))}
                    className={fieldInput + css.width(90)}
                />}
            </div>
        </div>;
    }
}

@observer
class SidebarFormulaRow extends preact.Component {
    render() {
        const formula = sidebarWidthFormula.get();
        const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
        const computed = evalSidebarWidth(vw);
        const isDefault = formula === DEFAULT_SIDEBAR_WIDTH_FORMULA;
        return <div className={css.vbox(6).pad(8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
            <div className={css.fontSize(13)}>Sidebar width formula</div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                JavaScript expression for the left sidebar's width in pixels.
                Variable <b>vw</b> is the viewport width; helpers <b>min</b>,
                <b>max</b>, <b>clamp(lo, v, hi)</b>, <b>round</b> are available.
                Falls back to 220 if the expression is invalid.
            </div>
            <div className={css.hbox(10).alignCenter}>
                <input
                    type="text"
                    value={formula}
                    onInput={(e: Event) => setSidebarWidthFormula((e.currentTarget as HTMLInputElement).value)}
                    className={fieldInput + css.flexGrow(1)}
                />
                <span className={css.fontSize(12).color("hsl(0, 0%, 75%)").minWidth(120).textAlign("right") + RS.Muted}>
                    {computed}px @ {vw}vw
                </span>
                <button
                    onMouseDown={() => resetSidebarWidthFormula()}
                    title={`Reset to the default: ${DEFAULT_SIDEBAR_WIDTH_FORMULA}`}
                    disabled={isDefault}
                    className={actionBtn + (isDefault ? css.opacity(0.5).cursor("default") : css)}
                >
                    Reset
                </button>
            </div>
        </div>;
    }
}
