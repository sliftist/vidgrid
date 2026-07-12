import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { reaction, IReactionDisposer } from "mobx";
import {
    state,
    switchFolder,
    files,
    characters,
    thumbnails,
    keyframes as keyframesDb,
    maybeScan,
    runFileScanOnly,
    runThumbnailScanOnly,
    runThumbnailScanForced,
    runKeyframesScanOnly,
    runFacesScanOnly,
    stopScan,
    extractMetadataForKey,
    extractKeyframesForKey,
    isExtracting,
    gridSize,
    setGridSize,
    detailedGridView,
    setDetailedGridView,
    sortOrder,
    setSortOrder,
    sortReversed,
    setSortReversed,
    shuffleSeed,
    setShuffleSeed,
    SortOrder,
    durationMinMinutes,
    setDurationMinMinutes,
    durationMaxMinutes,
    setDurationMaxMinutes,
    filterErrors,
    setFilterErrors,
    filterKeyframes,
    setFilterKeyframes,
    filterFaces,
    setFilterFaces,
    filterInvert,
    setFilterInvert,
    noteVisibleKeys,
    noteFilteredKeys,
    removeManyFromLibrary,
    keyboardHoveredKey,
    autoFlipPreview,
    previewCycleMs,
    setAutoFlipPreview,
    accurateThumbnails,
    displayMode,
    setDisplayMode,
    GridSize,
    DisplayMode,
    facesScanEnabled,
    setFacesScanEnabled,
    keyframesScanEnabled,
    setKeyframesScanEnabled,
    showTime,
    setShowTime,
    fastOpenSeries,
    hoverExpandEnabled,
    globalTransition,
    keyframesCollectionAllowed,
    keyframesHasBeenAccessed,
    markKeyframesAccessed,
    isStorageRemote,
    forceScanOnRemote,
    setForceScanOnRemote,
    hoverGraceMs,
    resultPageSize,
    evalSidebarWidth,
    sidebarWidthFormula,
    setSidebarWidthFormula,
    resetSidebarWidthFormula,
    DEFAULT_SIDEBAR_WIDTH_FORMULA,
    disableThemeBackgrounds, setDisableThemeBackgrounds,
    heygoogleEnabled, setHeygoogleEnabled,
} from "../appState";
import { openSettings } from "../modals/SettingsModal";
import { openScanReport } from "../modals/ScanReportModal";
import { openRestyling } from "../restyle/RestylingModal";
import { getActiveThemeId, allThemes } from "../restyle/themes";
import { disconnect as hgDisconnect } from "../heygoogle/client";
import { ListMode } from "./ListMode";
import { AddToList } from "../lists/AddToList";
import { getItemListsSync, getListsSync } from "../lists/lists";
import { SeriesGroup } from "./series";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { openThumbnailPicker } from "../modals/ThumbnailPickerModal";
import { openEditList } from "../lists/EditListModal";
import { moveListUp, moveListDown } from "../lists/lists";
import {
    cellPad, cellPadTitle, titleStripH,
    chipDim, chipBtn, chipPrimary, chipWarn, chipScan, chipError, dangerBtn,
    selectorBtn, selectorBtnActive, checkboxInput,
    durationInput, durationInputWrap, durationClearBtn, durationLabel,
    fieldInput,
    gridTagChip,
    seriesCountBadge, cellActionBtn, reparseStatusPill, extractionErrorBadge, cellExpandBtn,
    rearrangeTileWrap, rearrangeDragStripe, rearrangeTitle,
    sidebarSectionTitle, SIDEBAR_SECTION_GAP, SIDEBAR_SECTION_INNER_GAP,
    GRID_GAP, GRID_SCROLLBAR_W, buttonDown,
} from "../styles";
import { RS } from "../restyle/classNames";
import { searchQuery, goToPlayer, goToPlayerFromSeries, seriesPath, page, faceShowAll, faceSort, FaceSort } from "../router";
import { URLParam, batchURLParamUpdate } from "sliftutils/render-utils/URLParam";
import { HeyGoogleChip } from "../heygoogle/HeyGoogleChip";
import { playSound } from "../sounds";
import { primeAudioContext } from "../player/AudioPlayback";
import { isMissingPointerInput } from "../platform";
import {
    pickThumbForDisplay,
    formatDurationHM,
    formatBytes,
    findKeyframeAtOrBefore,
    getNearestKeyframeUrlSync,
} from "../scan/thumbnails";
import {
    showFaces,
    perFrameSearch, setPerFrameSearch,
    setFaceSearch, getFaceSearchEmbedding,
    imageToFaceEmbedding,
} from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { getCompletionTimestamps, FRESHNESS_WINDOW_MS } from "../scan/ScanCoordinator";
import { formatTime } from "socket-function/src/formatting/format";

import { GridCell } from "./GridCell";
import { SeriesCell } from "./SeriesCell";
import { FrameCell } from "./FrameCell";
import { RearrangeTile } from "./RearrangeTile";
import { ListTile } from "./ListTile";
import {
    cap, activateSeries, lastPlayedInSeries, seriesDisplayThumbKey,
    installMouseTracker, isEditableFocused,
    pickNextKey, pickTabKey, scrollKeyIntoView,
    readAllCellRects, cellsInSameRow, ROW_Y_TOLERANCE,
    SIZES,
} from "./gridShared";
import { SearchKey, Tile, search, rehydrate, hydrateKey, getLastUncachedSearchMs, faceSearchProgress, faceSearchStale, refreshFaceSearch } from "./searchPipeline";
import { GridScrollbar, buildScrollLabels, ScrollLabel } from "./GridScrollbar";
import { VirtualGrid } from "./VirtualGrid";

// Hides the grid's native scrollbar (both engines) while the custom one is
// shown. Only mounted on the non-list paths, so list mode keeps its native bar.
const HIDE_NATIVE_SCROLLBAR_CSS = `[data-grid-scroll]{scrollbar-width:none;}[data-grid-scroll]::-webkit-scrollbar{width:0;height:0;}`;

// Seed values when the user adds a duration bound — immediately selected for
// retype, so they're just sensible starting points, not meaningful defaults.
const DURATION_DEFAULT_MIN = 5;
const DURATION_DEFAULT_MAX = 60;

// One titled, spaced group of sidebar controls. The title is deliberately
// faint; spacing (not borders) is what separates sections.
// Display name of the active theme, for the Restyling button label. Reads the
// theme observables so the label re-renders when the active theme changes.
function activeThemeName(): string {
    const id = getActiveThemeId();
    return allThemes().find(t => t.id === id)?.name ?? "Default";
}

function SidebarSection(props: { title: string; children: preact.ComponentChildren }) {
    return <div className={css.vbox(SIDEBAR_SECTION_INNER_GAP).alignItems("flex-start").fillWidth}>
        <div className={sidebarSectionTitle}>{props.title}</div>
        {props.children}
    </div>;
}

// The wrapping per-file line under a scan-phase chip. Long file keys are
// forced to wrap. A file that has previously timed out goes yellow with a
// ⚠️ and a hover note, since it's being processed last on purpose.
function ScanFileLine(props: { fileKey: string; timedOut?: boolean }) {
    const { fileKey, timedOut } = props;
    const text = fileKey;
    return <div
        className={css.fontSize(10).hsla(0, 0, 0, 0.5)
            .color(timedOut ? "hsl(45, 90%, 62%)" : "hsl(0, 0%, 78%)")
            .fillWidth.minWidth(0).overflowWrap("break-word").pad2(2, 6)}
        title={timedOut ? "This file has previously timed out" : text}
    >
        {timedOut ? "⚠️ " : ""}{text}
    </div>;
}

// Indicator chips for every active result-affecting filter, shown inside the
// search input ahead of the typed text. Surfaces face/duration/attribute
// filters so a missing result is never silently blamed on the query — the
// active filter is right there in the box. Ordering chips (sort/shuffle) are
// excluded: they reorder results, they don't hide any.
function activeSearchFilterChips(): preact.JSX.Element[] {
    const chips: preact.JSX.Element[] = [];
    const push = (key: string, label: string, cls: string) =>
        chips.push(<span key={key} className={cls + css.flexShrink0.whiteSpace("nowrap") + RS.SearchFilterChip}>{label}</span>);

    if (getFaceSearchEmbedding()) push("face", cap("Face filter"), chipScan);

    const dMin = durationMinMinutes.get();
    const dMax = durationMaxMinutes.get();
    if (dMin !== undefined || dMax !== undefined) {
        const label = dMin !== undefined && dMax !== undefined ? `${dMin}–${dMax} min`
            : dMin !== undefined ? `≥ ${dMin} min` : `≤ ${dMax} min`;
        push("dur", label, chipDim);
    }

    const inv = filterInvert.get();
    if (filterErrors.get()) push("err", cap(inv ? "No errors" : "Errors"), chipDim);
    if (filterKeyframes.get()) push("kf", cap(inv ? "No keyframes" : "Keyframes"), chipDim);
    if (filterFaces.get()) push("hasFaces", cap(inv ? "No faces" : "Has faces"), chipDim);

    return chips;
}

@observer
export class SearchPage extends preact.Component {
    synced = observable({
        displayLimit: resultPageSize.get(),
        // Drives the sidebar width formula (vw). Updated on window resize.
        windowWidth: typeof window !== "undefined" ? window.innerWidth : 1280,
        // Measured width of the grid body (scroller + custom scrollbar). The
        // uniform grid divides this into integer cell widths and hands the
        // few undividable px to the scrollbar so the row stays flush.
        bodyWidth: 0,
        // Paste/drop image face search status card. "working" while the
        // embedding computes, "done" when it finished without a search being
        // applied (no faces / error) — nothing at all would look broken.
        imageSearch: undefined as undefined | { phase: "working" | "done"; message: string },
    });

    // Bumped to invalidate an in-flight paste/drop image search — the stale
    // result is dropped instead of applying a search the user cancelled.
    private imageSearchGen = 0;

    private bodyEl: HTMLElement | null = null;
    private bodyResizeObs: ResizeObserver | undefined;
    private setBodyEl = (el: HTMLElement | null) => {
        if (this.bodyEl === el) return;
        if (this.bodyResizeObs && this.bodyEl) this.bodyResizeObs.unobserve(this.bodyEl);
        this.bodyEl = el;
        if (!el) return;
        if (typeof ResizeObserver !== "undefined") {
            if (!this.bodyResizeObs) {
                this.bodyResizeObs = new ResizeObserver(entries => {
                    const w = entries[0]?.contentRect.width ?? 0;
                    if (Math.abs(this.synced.bodyWidth - w) > 0.5) runInAction(() => { this.synced.bodyWidth = w; });
                });
            }
            this.bodyResizeObs.observe(el);
        }
        // Seed immediately so the first paint already has a width.
        const w = el.clientWidth;
        if (Math.abs(this.synced.bodyWidth - w) > 0.5) runInAction(() => { this.synced.bodyWidth = w; });
    };

    private observer: IntersectionObserver | undefined;
    private sentinel: HTMLDivElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    // When a duration bound switches from blank (a "+min"/"+max" button) to an
    // input, this names which one to auto-focus+select. The input's ref callback
    // fires on mount, sees the match, and focuses — preact has no built-in
    // "focus on appear", so we drive it manually.
    private pendingDurationFocus: "min" | "max" | null = null;
    // Cached during render() so the Enter keyboard handler can look up
    // a series by its data-cell-key prefix without re-running getSeries.
    private lastSeriesMap: Map<string, SeriesGroup> | undefined;
    // The full ordered key list of the last render — the custom scrollbar's
    // jumps index into it (the rendered window is only a prefix of it).
    private lastKeys: SearchKey[] = [];
    // True when the last render used the windowed VirtualGrid (uniform layout):
    // jumps then resolve to an exact scrollTop instead of growing a window.
    private lastUniform = false;

    // The data-cell-key a given index renders with: a series tile carries
    // "s:"+parentPath, everything else its raw key.
    private cellKeyForIndex(index: number): string | undefined {
        const k = this.lastKeys[index]?.key;
        if (k === undefined) return undefined;
        return this.lastSeriesMap?.has(k) ? `s:${k}` : k;
    }
    private scrollIndexToTop(index: number, retry = true) {
        const cellKey = this.cellKeyForIndex(index);
        if (!cellKey) return;
        const el = document.querySelector(`[data-cell-key="${CSS.escape(cellKey)}"]`) as HTMLElement | null;
        const container = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
        if (!el || !container) {
            // The target cell may not be laid out for one more frame after a
            // displayLimit bump — retry once.
            if (retry) requestAnimationFrame(() => this.scrollIndexToTop(index, false));
            return;
        }
        const cr = el.getBoundingClientRect();
        const co = container.getBoundingClientRect();
        container.scrollTop += cr.top - co.top;
    }
    // Scroll the grid so the item at `index` in the full list sits at the top.
    // In the windowed (uniform) layout the whole height is known, so the target
    // row maps to an exact scrollTop — no window growth, no lag. The non-uniform
    // fallback grows the rendered window first if the target is past it.
    private jumpToIndex = (index: number) => {
        if (index < 0 || index >= this.lastKeys.length) return;
        const container = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
        if (this.lastUniform && container) {
            const s = SIZES[gridSize.get()];
            // Mirror the flush-fill column count (computed from the body width,
            // scroller + scrollbar) so jumps land on the same rows the grid laid
            // out — the scroller's own clientWidth excludes the scrollbar.
            const avail = Math.max(0, this.synced.bodyWidth - GRID_SCROLLBAR_W);
            const cols = Math.max(1, Math.floor((avail + GRID_GAP) / (s.slotW + GRID_GAP)));
            container.scrollTop = Math.floor(index / cols) * (s.slotH + GRID_GAP);
            return;
        }
        if (index >= this.synced.displayLimit) {
            runInAction(() => { this.synced.displayLimit = Math.min(this.lastKeys.length, index + resultPageSize.get()); });
            requestAnimationFrame(() => this.scrollIndexToTop(index));
            return;
        }
        this.scrollIndexToTop(index);
    };

    componentDidMount() {
        // Install once: document-level mousemove tracker that drives
        // mouseHoveredCellKey and the per-cell registry. Idempotent.
        installMouseTracker();
        // Focus + select any current query text so the user can land on the
        // page and immediately start typing — overwrites or appends naturally.
        // Skipped when there's no pointer input (e.g. Fire TV / Silk): a
        // remote can't dismiss the on-screen keyboard a focused field summons,
        // so it would trap the user. They focus it explicitly via MediaPlayPause.
        if (this.searchInput && !isMissingPointerInput()) {
            this.searchInput.focus();
            this.searchInput.select();
        }
        // Deep-link arrived as list mode + a search query — list mode
        // hides the grid so the search would be invisible. Snap the URL
        // to hybrid so back/forward stays consistent.
        if (displayMode.get() === "list" && searchQuery.value.trim()) {
            setDisplayMode("hybrid");
        }
        this.observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    runInAction(() => {
                        this.synced.displayLimit += resultPageSize.get();
                    });
                }
            }
        }, { rootMargin: "400px" });
        document.addEventListener("keydown", this.onKeyDown);
        document.addEventListener("mousedown", this.onDocumentMouseDown, true);
        window.addEventListener("paste", this.onPaste);
        window.addEventListener("dragover", this.onDragOver);
        window.addEventListener("drop", this.onDrop);
        window.addEventListener("resize", this.onResize);
    }

    private onResize = () => {
        runInAction(() => { this.synced.windowWidth = window.innerWidth; });
    };

    componentWillUnmount() {
        if (this.observer) this.observer.disconnect();
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
        window.removeEventListener("paste", this.onPaste);
        window.removeEventListener("dragover", this.onDragOver);
        window.removeEventListener("drop", this.onDrop);
        window.removeEventListener("resize", this.onResize);
        if (this.bodyResizeObs) this.bodyResizeObs.disconnect();
        // Switching pages exits nav mode — clear the selection so coming back
        // to the search page later starts fresh.
        runInAction(() => keyboardHoveredKey.set(undefined));
    }

    // Click-outside-to-exit nav mode. Walks up from the click target and
    // ignores the click if it lands inside (a) the currently-expanded cell
    // or (b) any modal — keyed by data-modal so any modal that opts in
    // gets the same treatment without us having to enumerate them here.
    // Anywhere else (header chips, scroll background, other cells, search
    // input, etc.) clears keyboardHoveredKey so the user is back to plain
    // mouse-hover mode. Capture phase so we run before per-element
    // handlers (which can call stopPropagation).
    private onDocumentMouseDown = (e: MouseEvent) => {
        const navKey = keyboardHoveredKey.get();
        if (navKey === undefined) return;
        let node: Node | null = e.target as Node | null;
        while (node && node instanceof Element) {
            if (node.getAttribute("data-modal")) return;
            const cellKey = node.getAttribute("data-cell-key");
            if (cellKey === navKey) return;
            node = node.parentNode;
        }
        runInAction(() => keyboardHoveredKey.set(undefined));
    };

    private async runImageSearch(file: File, source: string) {
        const gen = ++this.imageSearchGen;
        runInAction(() => { this.synced.imageSearch = { phase: "working", message: `Detecting faces in ${source}…` }; });
        try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = e => reject(new Error(`image load failed: ${(e as any).message ?? "unknown"}`));
                i.src = URL.createObjectURL(file);
            });
            const embedding = await imageToFaceEmbedding(img);
            if (gen !== this.imageSearchGen) return;
            if (embedding) {
                setFaceSearch(embedding);
                runInAction(() => { this.synced.imageSearch = undefined; });
            } else {
                runInAction(() => { this.synced.imageSearch = { phase: "done", message: `No faces detected in the ${source}.` }; });
            }
        } catch (err) {
            console.warn(`[search] image-search failed:`, err);
            if (gen !== this.imageSearchGen) return;
            runInAction(() => { this.synced.imageSearch = { phase: "done", message: `Face detection failed: ${String(err)}` }; });
        }
    }

    private dismissImageSearch = () => {
        this.imageSearchGen++;
        runInAction(() => { this.synced.imageSearch = undefined; });
    };

    private onPaste = (e: ClipboardEvent) => {
        if (isEditableFocused()) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind !== "file") continue;
            const file = it.getAsFile();
            if (!file || !file.type.startsWith("image/")) continue;
            e.preventDefault();
            void this.runImageSearch(file, "pasted image");
            return;
        }
    };

    private onDragOver = (e: DragEvent) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.items).map(i => i.type);
        if (types.some(t => t.startsWith("image/"))) e.preventDefault();
    };

    private onDrop = (e: DragEvent) => {
        if (!e.dataTransfer) return;
        const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
        for (const it of items) {
            if (it.kind !== "file") continue;
            const file = it.getAsFile();
            if (!file || !file.type.startsWith("image/")) continue;
            e.preventDefault();
            void this.runImageSearch(file, "dropped image");
            return;
        }
    };

    private onKeyDown = async (e: KeyboardEvent) => {
        // Tab is the one navigation key that's allowed while the search
        // input is focused — the spec is "type your query, press Tab,
        // then Enter on the highlighted result". Handle it before the
        // editable guard so it fires from inside the input too.
        if (e.key === "Tab") {
            e.preventDefault();
            // Drop focus off the search input so subsequent keystrokes
            // (Enter, arrows) route through the document handler instead
            // of being captured by the input.
            if (this.searchInput && document.activeElement === this.searchInput) {
                this.searchInput.blur();
            }
            const next = pickTabKey(!e.shiftKey);
            if (next === undefined) return;
            runInAction(() => keyboardHoveredKey.set(next));
            scrollKeyIntoView(next);
            return;
        }

        // TV-remote keys, handled before the editable guard so they work even
        // while the search input is focused.
        // Channel up/down page the grid (the only scrollable region).
        if (e.key === "ChannelUp" || e.key === "ChannelDown") {
            e.preventDefault();
            const container = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
            if (container) {
                const delta = container.clientHeight * 0.85;
                container.scrollTop += e.key === "ChannelDown" ? delta : -delta;
            }
            return;
        }
        // No video to toggle in search mode, so play/pause focuses the search
        // input instead (PlayerPage handles it as a real toggle in player mode).
        if (e.key === "MediaPlayPause") {
            if (this.searchInput) {
                e.preventDefault();
                this.searchInput.focus();
                this.searchInput.select();
            }
            return;
        }

        if (isEditableFocused()) return;

        // Quick-search shortcut: `S` focuses + selects the search input so
        // the user can immediately type to overwrite. Gated by the
        // isEditableFocused() check above so it doesn't fire while typing.
        if (e.key === "s" || e.key === "S") {
            if (this.searchInput) {
                e.preventDefault();
                this.searchInput.focus();
                this.searchInput.select();
            }
            return;
        }

        if (e.key === "Escape") {
            if (this.synced.imageSearch) {
                e.preventDefault();
                this.dismissImageSearch();
            } else if (keyboardHoveredKey.get() !== undefined) {
                e.preventDefault();
                runInAction(() => keyboardHoveredKey.set(undefined));
            }
            return;
        }
        if (e.key === "Enter") {
            const cur = keyboardHoveredKey.get();
            if (cur) {
                e.preventDefault();
                primeAudioContext();
                // Cell keys are prefixed by tile type so Enter dispatches
                // to the right action: `s:` = series tile (drill in), `f:`
                // = frame tile (play at timestamp), `list:` = list tile
                // (no-op for Enter — those are click-to-toggle). Anything
                // else is a plain video key.
                if (cur.startsWith("s:")) {
                    const path = cur.slice(2);
                    const group = this.lastSeriesMap?.get(path);
                    if (group) activateSeries(group);
                    return;
                }
                if (cur.startsWith("f:")) {
                    const rest = cur.slice(2);
                    const hash = rest.indexOf("#");
                    if (hash > 0) {
                        const fileKey = rest.slice(0, hash);
                        const timeMs = Number(rest.slice(hash + 1));
                        if (Number.isFinite(timeMs)) {
                            goToPlayer(fileKey, timeMs / 1000);
                        }
                    }
                    return;
                }
                if (cur.startsWith("list:")) return;
                const sp = seriesPath.value;
                if (sp) goToPlayerFromSeries(cur, sp);
                else goToPlayer(cur);
            }
            return;
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight"
            && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();

        // Moving down past the bottom of the rendered window picks a wrong
        // column when the next row is only partially loaded (intersection
        // observer is mid-batch). Expand the display window and wait one
        // frame for the new cells to lay out before deciding the target.
        if (e.key === "ArrowDown") await this.ensureRowBelowLoaded();

        const next = pickNextKey(e.key);
        if (next === undefined) return;
        playSound("navMove");
        runInAction(() => keyboardHoveredKey.set(next));
        scrollKeyIntoView(next);
    };

    // If the row directly below the current cell is missing OR has fewer
    // columns than the current row (= partial), bump displayLimit and wait
    // one frame so the new cells are in the DOM by the time pickNextKey reads.
    private ensureRowBelowLoaded = async () => {
        // The windowed grid always keeps a buffer of rows below the viewport
        // mounted, so the next row is already laid out — nothing to grow.
        if (this.lastUniform) return;
        const cur = keyboardHoveredKey.get();
        if (!cur) return;
        const cells = readAllCellRects();
        const curCell = cells.find(c => c.key === cur);
        if (!curCell) return;
        const currentRow = cellsInSameRow(cells, curCell.rect.top);
        const below = cells.filter(c => c.rect.top > curCell.rect.top + ROW_Y_TOLERANCE);
        const rowBelowTop = below.length && Math.min(...below.map(c => c.rect.top));
        const rowBelow = rowBelowTop ? cellsInSameRow(cells, rowBelowTop) : [];
        if (below.length === 0 || rowBelow.length < currentRow.length) {
            runInAction(() => { this.synced.displayLimit += resultPageSize.get(); });
            await new Promise(r => requestAnimationFrame(() => r(undefined)));
        }
    };

    private setSentinel = (el: HTMLDivElement | null) => {
        if (this.sentinel === el) return;
        if (this.observer && this.sentinel) this.observer.unobserve(this.sentinel);
        this.sentinel = el;
        if (this.observer && el) this.observer.observe(el);
    };

    // Manual fallback for the auto-loading sentinel — clicking the
    // bottom placeholder reveals another page.
    private loadMore = () => {
        runInAction(() => { this.synced.displayLimit += resultPageSize.get(); });
    };

    private onInput = (e: Event) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        const updates: [URLParam, unknown][] = [];
        // Typing while in list mode flips us into hybrid so the user
        // sees actual search results. List mode shows curated lists,
        // not the file grid, so a query would just sit unused otherwise.
        if (v.trim() && displayMode.get() === "list") {
            updates.push([displayMode, "hybrid"]);
        }
        // Typing while drilled into a series (or switching out of list)
        // exits the drill so the search runs against the whole library,
        // not just the series' few videos. (Drilling back in is a click away.)
        if (v.trim() && (displayMode.get() === "list" || seriesPath.value)) {
            updates.push([seriesPath, ""]);
        }
        runInAction(() => { this.synced.displayLimit = resultPageSize.get(); });
        updates.push([searchQuery, v]);
        batchURLParamUpdate(updates);
    };

    // Trailing ✕ on the input — clears the query (a face search is just a
    // `face:` query, so this drops it too). Stays in whatever view mode.
    private clearSearch = (e: MouseEvent) => {
        e.preventDefault();
        runInAction(() => { this.synced.displayLimit = resultPageSize.get(); });
        searchQuery.value = "";
        if (this.searchInput) this.searchInput.focus();
    };

    // Full render times of the last 2 seconds, used to show the SLOWEST recent
    // render in the header chip. A trailing average would hide a 1s stall after
    // one fast 5ms render; the last value alone would do the opposite. The 2s
    // window keeps the displayed number tied to the user action that caused it.
    private renderSamples: { at: number; ms: number }[] = [];
    private static RENDER_WINDOW_MS = 2000;

    render() {
        const t0 = performance.now();
        const result = this.renderBase();
        const ms = performance.now() - t0;
        this.renderSamples.push({ at: t0, ms });
        this.renderSamples = this.renderSamples.filter(s => t0 - s.at <= SearchPage.RENDER_WINDOW_MS);
        if (ms > 50) console.log(`[search] full render: ${ms.toFixed(2)}ms`);
        return result;
    }

    renderBase() {
        const q = searchQuery.value;
        const fsSpec = getFaceSearchEmbedding();

        // "face" is the effective mode whenever showFaces is on — that's
        // the chip the user uses to enter face mode, and entering it
        // just flips the showFaces switch. Layout-wise it behaves like
        // "flat" (series grouping would bury per-video face relevance).
        // The persisted displayMode is still kept so switching away from
        // face mode returns the user to their prior layout.
        // List mode is incompatible with an active search — the grid is
        // not even rendered there, so a query would just sit invisible.
        // Force-fall back to "hybrid" whenever both are set, including
        // when the user arrives via a deep link with both in the URL.
        let mode: DisplayMode = showFaces.get() ? "face" : displayMode.get();
        if (mode === "list" && q.trim()) mode = "hybrid";

        // Core: produce the ordered key list (face or filtered branch, each
        // cached on its own inputs). Drilling into a series replaces the keys
        // with that series' members — search() still ran so we have its
        // seriesMap to resolve the drilled group.
        const { keys: searchedKeys, seriesMap, totalFiles, sortValues, flatKeys: searchedFlatKeys, loading: searchLoading } = search({ mode, query: q, fsSpec, perFrame: perFrameSearch.get(), sortOrder: sortOrder.get(), sortReversed: sortReversed.get(), shuffleSeed: shuffleSeed.get(), durationMinMinutes: durationMinMinutes.get(), durationMaxMinutes: durationMaxMinutes.get(), filterErrors: filterErrors.get(), filterKeyframes: filterKeyframes.get(), filterFaces: filterFaces.get(), filterInvert: filterInvert.get() });
        this.lastSeriesMap = seriesMap;
        const drilledPath = seriesPath.value;
        const drilledGroup = drilledPath ? seriesMap.get(drilledPath) : undefined;

        let keys: SearchKey[];
        let highlightedKey: string | undefined;
        // The exact underlying file keys the current view represents — drives
        // both thumbnail prioritization and "delete all". When drilled into a
        // series, that's the drilled group's members; otherwise it's the
        // search's filter-respecting flat set.
        let flatKeys: string[];
        if (drilledGroup) {
            keys = drilledGroup.videos.map(v => ({ key: v.key }));
            flatKeys = drilledGroup.videos.map(v => v.key);
            highlightedKey = lastPlayedInSeries(drilledGroup)?.video.key;
        } else {
            keys = searchedKeys;
            flatKeys = searchedFlatKeys;
        }
        this.lastKeys = keys;

        // Thumbnail priority tier 2: the ENTIRE current result set, even the
        // part scrolled past the display limit. Sits below the in-view window
        // but above unrelated files, so the whole active filter finishes
        // generating before the rest. Per-TILE display thumbs only — a series
        // tile shows one thumbnail, so its other members don't belong in the
        // priority set until they're rendered as their own cells (drilled in).
        // flatKeys itself stays fully flattened for "delete all".
        noteFilteredKeys(drilledGroup ? flatKeys : keys.map(k => {
            const series = seriesMap.get(k.key);
            return series ? seriesDisplayThumbKey(series) ?? k.key : k.key;
        }));

        const s = SIZES[gridSize.get()];
        // Uniform layout = every cell is exactly slotW × slotH, so the whole
        // grid height is known and we can window it (VirtualGrid) instead of
        // growing a prefix. Face mode (variable face strips) and detailed mode
        // (per-image aspect heights) are not uniform, so they keep the
        // append-on-demand path below.
        const uniform = mode !== "list" && mode !== "face" && !detailedGridView.get();
        this.lastUniform = uniform;

        // The non-uniform path rehydrates a growing prefix; the uniform path
        // hydrates per-cell inside VirtualGrid and notes its window separately.
        let visible: Tile[] = [];
        let hasMore = false;
        if (!uniform && mode !== "list") {
            const limit = Math.min(this.synced.displayLimit, keys.length);
            hasMore = keys.length > limit;
            visible = rehydrate(keys.slice(0, limit), seriesMap, { highlightedKey });
            // Visible keys for thumbnail prioritization — one key per tile: a
            // series tile only shows its display thumbnail, so only that key
            // gets prioritized (not the whole folder's members).
            noteVisibleKeys(visible.flatMap(t =>
                t.type === "video" ? [t.record.key]
                : t.type === "series" ? (k => k ? [k] : [])(seriesDisplayThumbKey(t.series))
                : [t.fileKey]
            ));
        }

        // Thumbnail prioritization for the windowed grid: one key per mounted
        // tile (series tiles contribute only their displayed thumbnail).
        const noteUniformWindow = (first: number, last: number) => {
            const out: string[] = [];
            for (let i = first; i <= last && i < keys.length; i++) {
                const kk = keys[i].key;
                const series = seriesMap.get(kk);
                if (series) {
                    const dk = seriesDisplayThumbKey(series);
                    if (dk) out.push(dk);
                } else out.push(kk);
            }
            noteVisibleKeys(out);
        };
        // Flush-fill layout (uniform path only). The body width (scroller +
        // scrollbar) is the stable input — computing from it instead of the
        // scroller's own width means the scrollbar absorbing leftover px can't
        // feed back and oscillate. We fit as many base-width cells as possible,
        // then widen each to an integer width that uses the row, and hand the
        // few remaining px to the scrollbar so there's no empty gap beside it.
        let gridCols = 1;
        let gridCellW = s.slotW;
        let scrollbarW = GRID_SCROLLBAR_W;
        if (uniform) {
            const avail = Math.max(0, this.synced.bodyWidth - GRID_SCROLLBAR_W);
            gridCols = Math.max(1, Math.floor((avail + GRID_GAP) / (s.slotW + GRID_GAP)));
            gridCellW = Math.max(s.slotW, Math.floor((avail - (gridCols - 1) * GRID_GAP) / gridCols));
            const used = gridCols * gridCellW + (gridCols - 1) * GRID_GAP;
            scrollbarW = GRID_SCROLLBAR_W + Math.max(0, avail - used);
        }

        // One rendered cell of the uniform grid, hydrated on demand.
        const renderUniformCell = (index: number) => {
            const kk = keys[index];
            if (!kk) return null;
            const series = seriesMap.get(kk.key);
            if (series) return <SeriesCell series={series} slotWidth={gridCellW} />;
            const record = hydrateKey(kk.key) ?? { key: kk.key, name: "", relativePath: "", size: undefined };
            return <GridCell record={record} highlighted={highlightedKey === kk.key} slotWidth={gridCellW} />;
        };
        const uniformKeyForIndex = (index: number) => {
            const kk = keys[index];
            if (!kk) return String(index);
            return seriesMap.has(kk.key) ? `s:${kk.key}` : `v:${kk.key}`;
        };

        // Header timing: the cost of the last real (uncached) core search, and
        // the slowest full render in the last 2s (samples pruned by render()).
        const fmtMs = (x: number) => x < 1 ? "<1" : String(Math.round(x));
        const searchMs = getLastUncachedSearchMs();
        const slowestRenderMs = this.renderSamples.length ? Math.max(...this.renderSamples.map(s => s.ms)) : 0;
        // Streaming face-search progress (undefined when no job is running).
        const faceProgress = faceSearchProgress.get();

        // Sidebar width from the user-editable formula, evaluated against the
        // live viewport width (tracked reactively via the resize handler).
        const sidebarW = evalSidebarWidth(this.synced.windowWidth);

        const currentSize = gridSize.get();
        const sizeOptions: GridSize[] = ["small", "medium", "large", "huge"];
        const currentSort = sortOrder.get();
        // Custom scrollbar: index every key by the data-cell-key it renders
        // with, and build sort-aware position labels (only when not drilled —
        // the drilled list is the series' own members, not the labeled list).
        const showScrollbar = mode !== "list";
        const cellKeyToIndex = new Map<string, number>();
        for (let i = 0; i < keys.length; i++) {
            const kk = keys[i].key;
            cellKeyToIndex.set(seriesMap.has(kk) ? `s:${kk}` : kk, i);
        }
        const scrollLabels: ScrollLabel[] = (!drilledGroup && sortValues)
            ? buildScrollLabels(sortValues, currentSort) : [];
        const sortOptions: SortOrder[] = ["date", "name", "duration", "watched", "shuffle"];
        const sortLabel: Record<SortOrder, string> = { date: "Date", name: "Name", duration: "Duration", watched: "Watched", shuffle: "Shuffle" };
        // "face" is appended so the mode row always shows it; it's
        // selectable only while a face search is active and any click on
        // another mode while face mode is active clears the face search.
        const modeOptions: DisplayMode[] = ["list", "hybrid", "movies", "series", "flat", "face"];

        const isAnyTabScanning = state.scanning || state.otherTabScanning;

        // Phase completion counts for the action buttons. getColumnSync is
        // cheap — these are already in the overlay/baseFields cache for the
        // grid's normal renders. fileCount comes from the name column so
        // a face-mode filter that hides every record (e.g. all current
        // files have zero detected characters) doesn't make the buttons
        // claim "4/0 files have faces". The library-wide total is what
        // the user cares about for these buttons.
        const nameColForCount = files.getColumnSync("name");
        const fileCount = nameColForCount ? nameColForCount.length : totalFiles;
        // metaDoneCount tracks "metadataVersion matches" — a file is "done"
        // once the metadata phase has run at the current version, regardless
        // of whether a thumbnail actually landed. A file that parsed but
        // errored out is still parsed; "auto" treats it as done and won't
        // re-run it. Only the forced "F" button's tooltip breaks out the
        // errored ones (parsed, current version, but no thumbnail).
        const metaVersionCol = files.getColumnSync("metadataVersion");
        const metaDoneCount = metaVersionCol ? metaVersionCol.filter(r => r.value === METADATA_VERSION).length : 0;
        // Read thumbW (a number) instead of thumb160 (the JPEG blob) —
        // both are written together every time, so the count is the
        // same, but this avoids materialising every JPEG into memory
        // just to ask "how many cells have a thumb".
        const thumbDoneCol = thumbnails.getColumnSync("thumbW");
        // Keyframes version column read deferred until the user
        // actually interacts with a cell (or the master gate is closed,
        // in which case we never read it). Without this, even reading
        // the small "version" column triggers the keyframes stream-file
        // load on first paint.
        const kfCol = (keyframesCollectionAllowed() && keyframesHasBeenAccessed.get())
            ? keyframesDb.getColumnSync("keyframesVersion")
            : undefined;
        const facesCol = files.getColumnSync("facesVersion");
        // Errored = metadata ran at the current version (so "auto" treats it
        // as done) but no thumbnail landed. That's what the forced "F" scan
        // would retry, and the number worth surfacing on its tooltip.
        const thumbKeys = new Set<string>(
            thumbDoneCol ? thumbDoneCol.filter(r => typeof r.value === "number" && r.value > 0).map(r => r.key) : [],
        );
        const metaErroredCount = metaVersionCol
            ? metaVersionCol.filter(r => r.value === METADATA_VERSION && !thumbKeys.has(r.key)).length
            : 0;
        const kfDoneCount = kfCol ? kfCol.filter(r => r.value === KEYFRAMES_VERSION).length : undefined;
        const kfDoneLabel = kfDoneCount === undefined ? "?" : String(kfDoneCount);
        const facesDoneCount = facesCol ? facesCol.filter(r => r.value === FACES_VERSION).length : 0;
        // Buttons surface how many files still need each phase (remaining =
        // total − done), which reads more naturally than a done/total ratio.
        const metaRemaining = Math.max(0, fileCount - metaDoneCount);
        const kfRemainingLabel = kfDoneCount === undefined ? "?" : String(Math.max(0, fileCount - kfDoneCount));
        const facesRemaining = Math.max(0, fileCount - facesDoneCount);

        // Auto-scan countdown — each phase has its own 24h freshness window.
        const completions = state.rootName ? getCompletionTimestamps(state.rootName) : {};
        const now = Date.now();
        function untilNextScan(at: number | undefined): string {
            if (!at) return "never run; will run on next page load";
            const remaining = FRESHNESS_WINDOW_MS - (now - at);
            if (remaining <= 0) return "now";
            return formatTime(remaining);
        }
        const fileNext = untilNextScan(completions.fileScan);
        const metaNext = untilNextScan(completions.metadataScan);
        const kfNext = untilNextScan(completions.keyframesScan);
        const facesNext = untilNextScan(completions.facesScan);

        // Outer container: full-viewport flex column with `alignItems: stretch`
        // so the header + scrollable grid both fill the viewport width.
        // (Default `start` made the children only as wide as their content,
        // which is why the search bar wasn't filling.)
        // overflow: clip (not hidden) on the root: clipped elements
        // visually like hidden, but unlike hidden they don't establish
        // a scroll container, so the browser can't auto-scroll the
        // root to bring an off-screen focused descendant into view.
        // That auto-scroll was the reason the page would drift left
        // by ~10px with no scrollbar to reset it.
        return <div className={css.hbox(0).height("100vh").overflow("clip").hsl(0, 0, 6) + RS.Page}>
            {/* Sidebar — real left column. The outer hbox stretches it to
              * full height, so it reaches the very top-left corner; the
              * search bar lives in the right column and only spans the grid
              * width. Its own overflowY handles tall content. */}
            <div className={css.vbox(8).width(sidebarW).flexShrink0
                .fillHeight.alignSelf("flex-start")
                .pad2(10, 10).overflowY("auto").overflowX("hidden")
                .borderRight("1px solid hsl(0, 0%, 16%)").hsl(0, 0, 9) + RS.Sidebar}>
                    <div className={css.vbox(SIDEBAR_SECTION_GAP).alignItems("flex-start").fillWidth}>
                    <SidebarSection title="Folder">
                    <div className={css.hbox(SIDEBAR_SECTION_INNER_GAP).alignCenter.flexWrap("wrap")}>
                        {state.rootName && <div className={chipDim}>
                            Folder: <b>{state.rootName}</b>
                        </div>}
                        <button
                            className={chipBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => { if (confirm("Switch folder? This clears the saved storage location, which you'll have to set up again.")) { playSound("majorAction"); switchFolder(); } }}
                            title="Clear the saved folder and pick a different one"
                        >
                            {cap("Switch folder")}
                        </button>
                    </div>
                    </SidebarSection>
                    {showFaces.get() && <SidebarSection title="Face search">
                    <div className={chipDim}
                        title="Drag-and-drop or paste any image with a face here to start a face search. Or click any character avatar below a video."
                    >
                        {cap("Paste an image to search")}
                    </div>
                    <label className={chipBtn + css.hbox(6).alignCenter}
                        title="Master switch for the background face-extraction phase. Off by default; turn on to start scanning your library. Downloads ~190 MB of models on first use."
                    >
                        <input
                            className={checkboxInput}
                            type="checkbox"
                            checked={facesScanEnabled.get()}
                            onChange={(e: Event) => { playSound("toggle"); setFacesScanEnabled((e.currentTarget as HTMLInputElement).checked); }}
                        />
                        {cap("Face scanning")}
                    </label>
                    </SidebarSection>}
                    <SidebarSection title="Previews">
                    <div className={css.hbox(SIDEBAR_SECTION_INNER_GAP).alignCenter.flexWrap("wrap")}>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Cycle every cell's keyframe-preview strip continuously, not just the hovered one."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={autoFlipPreview.get()}
                                onChange={(e: Event) => { playSound("toggle"); setAutoFlipPreview((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Auto-flip")}
                        </label>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Master switch for the background keyframe-preview phase (one frame per 15/30/60s, used for hover previews and accurate thumbnails). Off by default; turn on to start scanning your library. Prerequisite for face scanning."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={keyframesScanEnabled.get()}
                                onChange={(e: Event) => { playSound("toggle"); setKeyframesScanEnabled((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Keyframe scanning")}
                        </label>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Show each video's length as a small badge in the grid cell's top-left corner."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={showTime.get()}
                                onChange={(e: Event) => { playSound("toggle"); setShowTime((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Show length")}
                        </label>
                    </div>
                    </SidebarSection>
                    <SidebarSection title="More">
                    <div className={css.hbox(4, 2).alignCenter.flexWrap("wrap")}>
                        <button
                            className={chipBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => openSettings()}
                            title="Open settings — face scanning, fast-open series, accurate thumbnails, auto-flip previews"
                        >
                            {cap("Settings")}
                        </button>
                        <button
                            className={chipBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => openScanReport()}
                            title="Breakdown of the last file scan — per-folder times, file/video counts, and ignoring folders"
                        >
                            {cap("Scan report")}
                        </button>
                    </div>
                    <div className={css.hbox(4, 2).alignCenter.flexWrap("wrap")}>
                        <button
                            className={chipBtn}
                            onMouseDown={buttonDown(() => openRestyling())}
                            title="Open restyling — pick, clone, and edit visual themes"
                        >
                            {cap("Restyling")} ({activeThemeName()})
                        </button>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Disable theme background images — use the theme's plain gradient instead"
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={disableThemeBackgrounds.get()}
                                onChange={(e: Event) => { playSound("toggle"); setDisableThemeBackgrounds((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("No backgrounds")}
                        </label>
                    </div>
                    <div className={css.hbox(4, 2).alignCenter.flexWrap("wrap")}>
                        <HeyGoogleChip />
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Enable or disable Hey Google remote control"
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={heygoogleEnabled.get()}
                                onChange={(e: Event) => {
                                    const on = (e.currentTarget as HTMLInputElement).checked;
                                    playSound("toggle");
                                    setHeygoogleEnabled(on);
                                    if (!on) hgDisconnect();
                                }}
                            />
                            {cap("Enabled")}
                        </label>
                    </div>
                    </SidebarSection>
                    <SidebarSection title="View mode">
                    <div className={css.hbox(2, 1).flexWrap("wrap")}>
                        {modeOptions.map(opt => {
                            const isFaceOpt = opt === "face";
                            const isSelected = opt === mode;
                            return <button
                                key={opt}
                                className={isSelected ? selectorBtnActive : selectorBtn}
                                onMouseDown={buttonDown()}
                                onClick={() => {
                                    // Leaving face mode drops a face: query
                                    // (meaningless elsewhere); list mode
                                    // can't show any query, so clear there
                                    // too. Both just blank the search.
                                    if (opt !== "face" && (fsSpec || opt === "list")) {
                                        runInAction(() => { this.synced.displayLimit = resultPageSize.get(); });
                                        searchQuery.value = "";
                                    }
                                    playSound("toggle");
                                    setDisplayMode(opt);
                                }}
                                title={isFaceOpt
                                    ? "Face mode: render the character strip under each cell. Click a face to start a face search; clear the search bar to drop the search."
                                    : (showFaces.get()
                                        ? `Switch to ${opt} mode (hides the face strip${fsSpec ? " and clears the face search" : ""})`
                                        : `Display mode: ${opt}`)}
                            >
                                {cap(opt)}
                            </button>;
                        })}
                    </div>
                    </SidebarSection>
                    <SidebarSection title="Grid size">
                    <div className={css.hbox(2, 1).flexWrap("wrap")}>
                        {sizeOptions.map(opt => <button
                            key={opt}
                            className={opt === currentSize ? selectorBtnActive : selectorBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => { playSound("toggle"); setGridSize(opt); }}
                            title={`Grid size: ${opt}`}
                        >
                            {cap(opt)}
                        </button>)}
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Detailed view: show every cell in its expanded (hover) form, laid out at 2× size"
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={detailedGridView.get()}
                                onChange={(e: Event) => { playSound("toggle"); setDetailedGridView((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Detailed")}
                        </label>
                    </div>
                    </SidebarSection>
                    {/* Face search has its own sort dimensions (matched face
                      * count vs. match distance), so it swaps in its own
                      * options instead of the library sort controls. The
                      * selector only appears when filtering to close matches —
                      * otherwise sort is forced to distance (Faces sort over
                      * every distant match is meaningless), so there's no
                      * choice to offer. */}
                    {fsSpec && !faceShowAll.value && <SidebarSection title="Sort">
                    <div className={css.hbox(2, 1).flexWrap("wrap")}>
                        {(["count", "distance"] as FaceSort[]).map(opt => <button
                            key={opt}
                            className={opt === faceSort.get() ? selectorBtnActive : selectorBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => { playSound("toggle"); faceSort.value = opt; }}
                            title={opt === "count"
                                ? "Most matched faces first (match distance breaks ties)"
                                : "Closest match first (face count breaks ties)"}
                        >
                            {opt === "count" ? "Faces" : "Distance"}
                        </button>)}
                    </div>
                    </SidebarSection>}
                    {!fsSpec && <SidebarSection title="Sort">
                    <div className={css.hbox(2, 1).flexWrap("wrap")}>
                        {sortOptions.map(opt => <button
                            key={opt}
                            className={opt === currentSort ? selectorBtnActive : selectorBtn}
                            onMouseDown={buttonDown()}
                            onClick={() => { playSound("toggle"); setSortOrder(opt); }}
                            title={opt === "date" ? "Date modified, newest first"
                                : opt === "duration" ? "Duration, longest first"
                                : opt === "watched" ? "Last watched, most recent first (never-played last)"
                                : opt === "shuffle" ? "Consistent random order, seeded by the shuffle value"
                                : "Filename, A→Z"}
                        >
                            {sortLabel[opt]}
                        </button>)}
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Reverse the current sort order"
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={sortReversed.get()}
                                onChange={(e: Event) => { playSound("toggle"); setSortReversed((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Reversed")}
                        </label>
                    </div>
                    {currentSort === "shuffle" && <input
                        className={fieldInput}
                        type="text"
                        value={shuffleSeed.get()}
                        placeholder="Shuffle value"
                        title="Items are ordered by a hash of their path plus this value. The same value always gives the same order; change it to reshuffle."
                        onInput={(e: Event) => setShuffleSeed((e.currentTarget as HTMLInputElement).value)}
                    />}
                    </SidebarSection>}
                    <SidebarSection title="Duration">
                    {(() => {
                        const dMin = durationMinMinutes.get();
                        const dMax = durationMaxMinutes.get();
                        const parse = (raw: string): number | undefined => {
                            const t = raw.trim();
                            if (t === "") return undefined;
                            const n = Number(t);
                            if (!Number.isFinite(n) || n < 0) return undefined;
                            return n;
                        };
                        // Each bound is a "+min"/"+max" button while blank, or a
                        // number input with a trailing × clear while set. Pressing
                        // the add button seeds a default, then focuses+selects the
                        // freshly mounted input (via pendingDurationFocus).
                        const boundField = (which: "min" | "max", value: number | undefined, set: (v: number | undefined) => void) => {
                            if (value === undefined) {
                                return <button
                                    className={chipBtn}
                                    title={which === "min" ? "Set a minimum length" : "Set a maximum length"}
                                    onMouseDown={buttonDown(() => { playSound("toggle"); this.pendingDurationFocus = which; set(which === "min" ? DURATION_DEFAULT_MIN : DURATION_DEFAULT_MAX); })}
                                >
                                    +{which}
                                </button>;
                            }
                            return <div className={durationInputWrap}>
                                <input
                                    ref={r => { if (r && this.pendingDurationFocus === which) { this.pendingDurationFocus = null; r.focus(); r.select(); } }}
                                    className={durationInput}
                                    type="number"
                                    min="0"
                                    value={String(value)}
                                    title={which === "min" ? "Minimum length in minutes" : "Maximum length in minutes"}
                                    onInput={(e: Event) => set(parse((e.currentTarget as HTMLInputElement).value))}
                                />
                                <button
                                    className={durationClearBtn}
                                    title={`Clear ${which}`}
                                    onMouseDown={buttonDown(() => { playSound("toggle"); set(undefined); })}
                                >
                                    ×
                                </button>
                            </div>;
                        };
                        return <div className={css.hbox(6).alignCenter}>
                            {boundField("min", dMin, setDurationMinMinutes)}
                            <span className={durationLabel}>–</span>
                            {boundField("max", dMax, setDurationMaxMinutes)}
                        </div>;
                    })()}
                    </SidebarSection>
                    <SidebarSection title="Filter">
                    <div className={css.hbox(SIDEBAR_SECTION_INNER_GAP).alignCenter.flexWrap("wrap")}>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Filter to files with an extraction error (or without one, when Invert is on)."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={filterErrors.get()}
                                onChange={(e: Event) => { playSound("toggle"); setFilterErrors((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Errors")}
                        </label>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Filter to files that have extracted keyframes (or those that don't, when Invert is on)."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={filterKeyframes.get()}
                                onChange={(e: Event) => { playSound("toggle"); setFilterKeyframes((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Keyframes")}
                        </label>
                        <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Filter to files with at least one detected face (or those without, when Invert is on)."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={filterFaces.get()}
                                onChange={(e: Event) => { playSound("toggle"); setFilterFaces((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Faces")}
                        </label>
                        {/* Invert is a mode that flips every active filter above,
                          * not its own attribute filter — rendered as a distinct
                          * toggle chip rather than another checkbox. */}
                        <button
                            className={(filterInvert.get() ? chipPrimary : chipDim) + css.hbox(6).alignCenter}
                            title="Invert every active filter — match files that LACK the selected attribute(s) instead."
                            onMouseDown={buttonDown(() => { playSound("toggle"); setFilterInvert(!filterInvert.get()); })}
                        >
                            ⇄ {cap("Invert")}
                        </button>
                        {/* Face-search-only filters. Placed after Invert because
                          * it doesn't apply to them — they shape the face-search
                          * result set itself. */}
                        {fsSpec && <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Only show videos whose closest character is within the match threshold. Uncheck to show every video ranked by its closest character, however distant."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={!faceShowAll.value}
                                onChange={(e: Event) => { playSound("toggle"); faceShowAll.value = !(e.currentTarget as HTMLInputElement).checked; }}
                            />
                            {cap("Only close matches")}
                        </label>}
                        {fsSpec && <label className={chipBtn + css.hbox(6).alignCenter}
                            title="Expand each matched video into one tile per face: thumbnail = frame, click jumps to that moment in the player (−3s for context)."
                        >
                            <input
                                className={checkboxInput}
                                type="checkbox"
                                checked={perFrameSearch.get()}
                                onChange={(e: Event) => { playSound("toggle"); setPerFrameSearch((e.currentTarget as HTMLInputElement).checked); }}
                            />
                            {cap("Search frames")}
                        </label>}
                    </div>
                    </SidebarSection>
                    </div>
                {/* Spacer — pushes the bottom section below to the bottom. */}
                <div className={css.marginTop("auto")} />
                {/* Scanning controls live at the bottom of the sidebar. During an
                  * active scan these scan-start buttons are hidden (gated on
                  * !isAnyTabScanning), so the section is near-empty and the live
                  * progress below it can grow/shrink freely without shoving them. */}
                <SidebarSection title="Scanning">
                {!state.scanning && state.otherTabScanning && <div className={chipWarn}>
                    Another tab is scanning — results refresh as files appear
                </div>}
                {isStorageRemote.get() === true && <div className={chipWarn}>
                    Remote storage — auto-scan {forceScanOnRemote.get() ? "on" : "off"}
                </div>}
                {/* Scan controls share one wrapping row. */}
                <div className={css.hbox(6, 2).wrap.alignItems("flex-start").fillWidth}>
                {isStorageRemote.get() === true && <button
                    className={chipBtn}
                    onMouseDown={buttonDown(() => { playSound("toggle"); setForceScanOnRemote(!forceScanOnRemote.get()); })}
                    title={forceScanOnRemote.get()
                        ? "Stop scanning this network-served library on this device"
                        : "Allow scanning even though the library is served over the network"}
                >
                    {cap(forceScanOnRemote.get() ? "Turn off scanning" : "Turn on scanning")}
                </button>}
                {!isAnyTabScanning && !state.metadataScanning && !!state.rootName && <button
                    className={chipPrimary}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void maybeScan({ force: true }); }}
                    title={`Force re-scan now (file walk + all phases). ${fileCount} files indexed. Will auto-scan in ${fileNext}.`}
                >
                    {cap("Scan now")} ({fileCount})
                </button>}
                {!isAnyTabScanning && !state.scanning && !state.metadataScanning && !state.keyframesScanning && !!state.rootName && <button
                    className={chipBtn}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void runFileScanOnly(); }}
                    title={`Re-walk the folder for added/removed files only. None of the per-file extraction phases run. ${fileCount} files indexed.`}
                >
                    {cap("Files only")} ({fileCount})
                </button>}
                {!isAnyTabScanning && !state.metadataScanning && !state.keyframesScanning && !!state.rootName && <button
                    className={chipBtn}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void runThumbnailScanOnly(); }}
                    title={`Re-run the metadata + thumbnail phase for new or stale files (files already at the current version, including ones that errored, are skipped). ${metaDoneCount}/${fileCount} files thumbnailed. Will auto-scan in ${metaNext}.`}
                >
                    {cap("Thumbs only")} ({metaRemaining} left)
                </button>}
                {!isAnyTabScanning && !state.metadataScanning && !state.keyframesScanning && !!state.rootName && <button
                    className={chipBtn}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void runThumbnailScanForced(); }}
                    title={`Forced thumbnail re-run: re-extract EVERY file unconditionally (all ${fileCount}), not just new/stale/errored ones. ${metaErroredCount}/${fileCount} currently errored (${fileCount > 0 ? Math.round((metaErroredCount / fileCount) * 100) : 0}%).`}
                >
                    F
                </button>}
                {!isAnyTabScanning && !state.metadataScanning && !state.keyframesScanning && !!state.rootName && keyframesScanEnabled.get() && <button
                    className={chipBtn}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void runKeyframesScanOnly(); }}
                    title={`Force re-run only the keyframe-preview phase now (one frame per 15/30/60s). ${kfDoneLabel}/${fileCount} files have keyframes. Will auto-scan in ${kfNext}.`}
                >
                    {cap("Keyframes only")} ({kfRemainingLabel} left)
                </button>}
                {!isAnyTabScanning && !state.metadataScanning && !state.keyframesScanning && !state.facesScanning && !!state.rootName && facesScanEnabled.get() && <button
                    className={chipBtn}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("scanStart"); void runFacesScanOnly(); }}
                    title={`Force re-run only the face-extraction phase now (every keyframe ≥1s apart, cluster into characters). ${facesDoneCount}/${fileCount} files have faces. Will auto-scan in ${facesNext}.`}
                >
                    {cap("Faces only")} ({facesRemaining} left)
                </button>}
                </div>
                {state.folderError && <div className={chipError}>
                    {state.folderError}
                </div>}
                {state.scanError && <div className={chipError}>
                    Scan failed: {state.scanError}
                </div>}
                </SidebarSection>
                {/* Live scan progress, with the Stop button on the same line just
                  * before it. The progress text (folder / file / counts) grows and
                  * shrinks constantly; Stop is fixed-width and pinned to the left so
                  * those changes never move it. */}
                {(state.scanning || state.metadataScanning || state.keyframesScanning || state.facesScanning) && <div className={css.hbox(6).alignItems("flex-end").fillWidth}>
                    <button
                        className={chipBtn + css.flexShrink(0)}
                        onMouseDown={buttonDown()}
                        onClick={() => stopScan()}
                        title="Stop scanning and mark all phases complete (won't re-run today)"
                    >
                        {cap("Stop")}
                    </button>
                    <div className={css.vbox(4).flexGrow(1).minWidth(0)}>
                {state.scanning && state.scanProgress && <div className={chipScan + css.vbox(1).fillWidth}>
                    <div>
                        {cap("Scanning")}… {state.scanProgress.foldersVisited} folders / {state.scanProgress.videosFound} videos
                    </div>
                    <div className={css.fontSize(10).hsla(0, 0, 0, 0.5).color("hsl(0, 0%, 78%)").fillWidth.minWidth(0).overflowWrap("break-word").pad2(2, 6)}
                        title={state.scanProgress.currentPath || "(root)"}>
                        {state.scanProgress.currentPath || "(root)"}
                    </div>
                </div>}
                {state.scanning && state.fileInfoProgress && <div className={chipScan + css.vbox(1).fillWidth}>
                    <div>
                        {cap("Reading file info")}… {state.fileInfoProgress.done} / {state.fileInfoProgress.total}
                    </div>
                    {state.fileInfoProgress.currentKey && <div className={css.fontSize(10).hsla(0, 0, 0, 0.5).color("hsl(0, 0%, 78%)").fillWidth.minWidth(0).overflowWrap("break-word").pad2(2, 6)}
                        title={state.fileInfoProgress.currentKey}>
                        {state.fileInfoProgress.currentKey}
                    </div>}
                </div>}
                {state.metadataScanning && state.metadataScanProgress && <div className={chipScan + css.vbox(1).fillWidth}>
                    <div>
                        {cap("Generating thumbnails")}… {state.metadataScanProgress.done} / {state.metadataScanProgress.total}
                        {state.metadataScanProgress.etaText && <span className={css.opacity(0.7).marginLeft(6)}>· {state.metadataScanProgress.etaText}</span>}
                    </div>
                    {state.metadataScanProgress.currentKey && <ScanFileLine
                        fileKey={state.metadataScanProgress.currentKey}
                        timedOut={state.metadataScanProgress.currentFilePreviouslyTimedOut} />}
                </div>}
                {state.keyframesScanning && state.keyframesScanProgress && <div className={chipScan + css.vbox(1).fillWidth}>
                    <div>
                        {cap("Extracting keyframes")}… {state.keyframesScanProgress.done} / {state.keyframesScanProgress.total}
                        {state.keyframesScanProgress.etaText && <span className={css.opacity(0.7).marginLeft(6)}>· {state.keyframesScanProgress.etaText}</span>}
                    </div>
                    {state.keyframesScanProgress.currentKey && <ScanFileLine
                        fileKey={state.keyframesScanProgress.currentKey}
                        timedOut={state.keyframesScanProgress.currentFilePreviouslyTimedOut} />}
                </div>}
                {state.facesScanning && state.facesScanProgress && <div className={chipScan + css.vbox(1).fillWidth}>
                    <div>
                        {cap("Extracting faces")}… {state.facesScanProgress.done} / {state.facesScanProgress.total}
                        {state.facesScanProgress.etaText && <span className={css.opacity(0.7).marginLeft(6)}>· {state.facesScanProgress.etaText}</span>}
                    </div>
                    {state.facesScanProgress.currentKey && <ScanFileLine
                        fileKey={state.facesScanProgress.currentKey}
                        timedOut={state.facesScanProgress.currentFilePreviouslyTimedOut} />}
                </div>}
                    </div>
                </div>}
                {/* Search/render timing sits at the very bottom, just above the
                  * width editor. */}
                <SidebarSection title="Results">
                    <div className={chipDim}>
                        {cap("Showing")} {uniform ? keys.length : visible.length} / {keys.length}
                        {keys.length !== totalFiles && ` (of ${totalFiles})`}
                        {` · search ${fmtMs(searchMs)} ms · render ${fmtMs(slowestRenderMs)} ms`}
                    </div>
                    {faceProgress && <div className={chipDim}>
                        {cap("Face search")} {Math.floor(faceProgress.done / Math.max(1, faceProgress.total) * 100)}%
                        {` (${faceProgress.done.toLocaleString()} / ${faceProgress.total.toLocaleString()} ${faceProgress.phase})`}
                    </div>}
                    <button
                        className={dangerBtn}
                        disabled={flatKeys.length === 0}
                        onMouseDown={buttonDown(() => {
                            if (flatKeys.length === 0) return;
                            if (!confirm(`Remove all ${flatKeys.length} file${flatKeys.length === 1 ? "" : "s"} in the current results from the library? They'll be skipped on future scans (files on disk are not deleted).`)) return;
                            playSound("majorAction");
                            void removeManyFromLibrary(flatKeys);
                        })}
                        title="Remove every file in the current result set from the library"
                    >
                        {cap("Delete all")}
                    </button>
                </SidebarSection>
                {/* Sidebar width editor — edits the same width formula as the
                  * Settings modal. */}
                <SidebarSection title="Sidebar width">
                    <div className={chipDim}>
                        <b>{sidebarW}px</b> @ {this.synced.windowWidth}vw
                    </div>
                    <input
                        type="text"
                        value={sidebarWidthFormula.get()}
                        onInput={(e: Event) => setSidebarWidthFormula((e.currentTarget as HTMLInputElement).value)}
                        title="JavaScript expression for the sidebar width in px. vw = viewport width; min/max/clamp(lo,v,hi)/round available."
                        className={css.fillWidth.pad2(8, 4).fontSize(12)
                            .hsl(0, 0, 8).color("white").bord(1, "hsl(0, 0%, 25%)") + RS.Field}
                    />
                    <button
                        className={chipBtn}
                        onMouseDown={buttonDown(() => resetSidebarWidthFormula())}
                        title={`Reset to the default: ${DEFAULT_SIDEBAR_WIDTH_FORMULA}`}
                        disabled={sidebarWidthFormula.get() === DEFAULT_SIDEBAR_WIDTH_FORMULA}
                    >
                        {cap("Reset")}
                    </button>
                </SidebarSection>
            </div>
            {/* Right column — vbox: search bar on top, grid scroller below. */}
            <div className={css.vbox(0).flexGrow(1).minWidth(0).fillHeight.alignSelf("flex-start")}>
                {/* Top bar — search only; does not scroll. Spans just the
                  * right column (grid width), not the full window. */}
                <div className={css.flexShrink0.fillWidth
                    .borderBottom("1px solid hsl(0, 0%, 16%)").hsl(0, 0, 9) + RS.Header}>
                    {/* The bordered surface is the wrapper, not the <input>, so
                      * active-filter chips can sit inside the border ahead of the
                      * text: the box stays put while the text shifts right past
                      * the chips. The input itself is borderless + transparent. */}
                    <div className={css.relative.fillWidth.hbox(4).alignCenter.paddingLeft(6).paddingRight(4)
                        .bord(1, fsSpec ? "hsl(50, 60%, 45%)" : "hsl(0, 0%, 25%)")
                        .hsl(0, 0, 12) + RS.SearchInput}>
                        {activeSearchFilterChips()}
                        <input
                            ref={r => { this.searchInput = r; }}
                            type="text"
                            placeholder="Search… (press S to focus — use & for AND, | for OR, ! to negate — case-insensitive)"
                            value={q}
                            onInput={this.onInput}
                            className={css.pad2(7, 4).fontSize(13).flexGrow(1).minWidth(0)
                                .border("none").background("transparent").outline("none")
                                .color(fsSpec ? "hsl(50, 90%, 75%)" : "white") + RS.SearchInputField}
                        />
                        {q && <button
                            onMouseDown={buttonDown(this.clearSearch)}
                            title="Clear search"
                            className={chipBtn + css.flexShrink0
                                .display("flex").alignItems("center").justifyContent("center")}
                        >
                            {cap("Clear")}
                        </button>}
                    </div>
                </div>
                {/* Band under the search bar — holds the exit-navigation button
                  * (when arrow-key nav is active) and/or the series drill-down
                  * back UI. Shown whenever either is present so the exit button
                  * sits ahead of the series back affordance. */}
                {(keyboardHoveredKey.get() !== undefined || drilledGroup) && <div className={css.hbox(8).alignCenter.pad2(8, 8).flexShrink0.fillWidth
                    .borderBottom("1px solid hsl(0, 0%, 16%)").hsl(0, 0, 9)}>
                    {keyboardHoveredKey.get() !== undefined && <button
                        className={chipPrimary}
                        onMouseDown={buttonDown(() => runInAction(() => keyboardHoveredKey.set(undefined)))}
                        title="Stop arrow-key navigation"
                    >
                        {cap("Exit navigation mode")} <span className={css.opacity(0.7).marginLeft(4)}>(Esc)</span>
                    </button>}
                    {drilledGroup && <button
                        className={chipBtn}
                        onMouseDown={buttonDown(() => runInAction(() => { seriesPath.value = ""; }))}
                        title="Back"
                    >
                        {cap("← Back")}
                    </button>}
                    {drilledGroup && <div className={chipDim}>
                        Series: <b>{drilledGroup.folderName}</b> <span className={css.opacity(0.7)}>({drilledGroup.videos.length} videos)</span>
                    </div>}
                </div>}
                {/* Face data changed under a completed face search. We stop
                  * auto-re-scoring in that case (another tab ingesting faces
                  * would loop the search forever) — surface it here instead. */}
                {fsSpec && faceSearchStale.get() && <div className={css.hbox(8).alignCenter.pad2(8, 8).flexShrink0.fillWidth
                    .borderBottom("1px solid hsl(0, 0%, 16%)").hsl(50, 30, 12)}>
                    <div className={css.fontSize(12).color("hsl(50, 80%, 75%)")}>
                        Face data has changed since this search ran — results may be out of date.
                    </div>
                    <button
                        className={chipPrimary}
                        onMouseDown={buttonDown()}
                        onClick={() => { playSound("majorAction"); refreshFaceSearch(); }}
                        title="Re-run the face search over the current face data"
                    >
                        {cap("Search again")}
                    </button>
                </div>}
                {/* Body row — the vertical scroller plus the custom scrollbar
                  * riding alongside it. */}
                <div ref={this.setBodyEl} className={css.hbox(0).fillHeightFlex.fillWidth.minHeight(0).alignItems("stretch")}>
                {showScrollbar && <style>{HIDE_NATIVE_SCROLLBAR_CSS}</style>}
                {/* Scroller. `data-grid-scroll` marks it for the hover-geometry
                  * clamp and cell-rect queries. */}
                <div data-grid-scroll className={css.flexGrow(1).minWidth(0).fillHeight
                    .overflowY("auto").overflowX("hidden")}>
                {mode === "list" ? <ListMode
                    renderVideo={(rec, w) => <GridCell record={rec} slotWidth={w} inList />}
                    renderSeries={(group, w) => <SeriesCell series={group} slotWidth={w} inList />}
                    renderRearrangeTile={args => <RearrangeTile
                        itemKey={args.itemKey}
                        itemType={args.itemType}
                        seriesMap={seriesMap}
                        slotWidth={args.slotWidth}
                    />}
                    renderListTile={args => <ListTile
                        list={args.list}
                        expanded={args.expanded}
                        memberCount={args.memberCount}
                        onToggle={args.onToggle}
                        rearranging={args.rearranging}
                        onToggleRearrange={args.onToggleRearrange}
                        slotWidth={args.slotWidth}
                    />}
                    getFileRecord={key => hydrateKey(key)}
                    getSeriesGroup={path => seriesMap.get(path)}
                /> : uniform ? <VirtualGrid
                    count={keys.length}
                    cols={gridCols}
                    cellW={gridCellW}
                    cellH={s.slotH}
                    renderCell={renderUniformCell}
                    keyForIndex={uniformKeyForIndex}
                    onWindowChange={noteUniformWindow}
                /> : <div className={css.display("flex").flexWrap("wrap").alignItems("start")
                    .columnGap(GRID_GAP).rowGap(GRID_GAP).fillWidth}>
                    {visible.map(t =>
                        t.type === "video" ? <GridCell key={`v:${t.record.key}`} record={t.record} highlighted={t.highlighted} />
                        : t.type === "series" ? <SeriesCell key={`s:${t.series.parentPath}`} series={t.series} />
                        : <FrameCell
                            key={`f:${t.fileKey}#${t.timeMs}#${t.characterKey}`}
                            fileKey={t.fileKey}
                            fileName={t.fileName}
                            relativePath={t.relativePath}
                            timeMs={t.timeMs}
                            characterKey={t.characterKey}
                            distance={t.distance}
                        />
                    )}
                </div>}

                {mode !== "list" && hasMore && <div
                    ref={this.setSentinel}
                    onMouseDown={this.loadMore}
                    title="Show more results"
                    className={css.fontSize(12).hsl(0, 0, 50).center.pad2(16)
                        .pointer.hslhover(0, 0, 14)}
                >
                    Show more ({keys.length - visible.length} remaining)
                </div>}

                {/* Streaming face search: results above are partial — show how
                  * far along the background scoring job is. */}
                {mode !== "list" && faceProgress && <div className={css.fontSize(12).hsl(0, 0, 55).center.pad2(12)}>
                    Searching faces… {Math.floor(faceProgress.done / Math.max(1, faceProgress.total) * 100)}%
                    {` (${faceProgress.done.toLocaleString()} / ${faceProgress.total.toLocaleString()} ${faceProgress.phase})`}
                </div>}
                {/* A search whose columns are still streaming reports loading
                  * (most visibly a face search before the character data lands)
                  * — say so instead of claiming there's nothing to show. */}
                {mode !== "list" && searchLoading && !faceProgress && keys.length === 0 && <div className={css.fontSize(13).hsl(0, 0, 50).center.pad2(40)}>
                    Loading…
                </div>}
                {mode !== "list" && !searchLoading && !state.scanning && totalFiles === 0 && !!state.rootName && <div className={css.fontSize(13).hsl(0, 0, 50).center.pad2(40)}>
                    No videos found yet.
                </div>}
                {/* line-break anywhere: the query can be a faces string —
                  * one long token with no spaces that would never wrap. */}
                {mode !== "list" && !searchLoading && totalFiles > 0 && keys.length === 0 && <div className={css.fontSize(13).hsl(0, 0, 50).center.pad2(40).raw("lineBreak" as never, "anywhere")}>
                    Nothing matches &ldquo;{q}&rdquo;.
                </div>}
                </div>
                {showScrollbar && keys.length > 0 && <GridScrollbar
                    count={keys.length}
                    labels={scrollLabels}
                    width={scrollbarW}
                    cellKeyToIndex={cellKeyToIndex}
                    jumpToIndex={this.jumpToIndex}
                />}
                </div>
            </div>
            {/* Paste/drop image face search status. position:fixed, so its
              * spot in the tree doesn't matter — data-modal keeps nav-mode
              * click-outside from treating clicks on it as "outside". */}
            {this.synced.imageSearch && <div
                data-modal="1"
                className={css.fixed.left("50%").top("40%").transform("translate(-50%, -50%)").zIndex(4000)
                    .hsl(0, 0, 10).color("white").bord(1, "hsl(0, 0%, 28%)")
                    .pad2(28, 20).vbox(16).alignItems("center").maxWidth(440)
                    .boxShadow("0 6px 28px rgba(0, 0, 0, 0.65)")}
            >
                <div className={css.fontSize(14).textAlign("center").raw("lineBreak" as never, "anywhere")}>
                    {this.synced.imageSearch.message}
                </div>
                <button
                    onMouseDown={buttonDown()}
                    onClick={this.dismissImageSearch}
                    title="Dismiss (Esc)"
                    className={css.pad2(16, 7).fontSize(13).color("white").pointer
                        .hsl(0, 0, 18).hslhover(0, 0, 26).bord(1, "hsl(0, 0%, 38%)")}
                >
                    {this.synced.imageSearch.phase === "working" ? "Cancel" : "Dismiss"}
                </button>
            </div>}
        </div>;
    }
}
