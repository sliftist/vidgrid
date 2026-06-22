import { observable, runInAction } from "mobx";
import { css } from "typesafecss";
import {
    files,
    gridSize,
    GridSize,
    keyboardHoveredKey,
    markKeyframesAccessed,
    fastOpenSeries,
    globalTransition,
    hoverGraceMs,
} from "../appState";
import { titleStripH } from "../styles";
import { SeriesGroup, SeriesVideo } from "./series";
import { goToPlayerFromSeries, seriesPath } from "../router";

// Grid item sizing — hbox-with-wrap, fixed slot per item, GRID_GAP between. Hover
// expands the card from the slot's center, with edge clamping so it never
// goes off-screen. Three preset sizes; the active one is read from a mobx
// observable so changing the selector re-renders every cell.
export interface GridSizing {
    slotW: number;
    slotH: number;
    hoverW: number;
    // Derived from cellPadTitle + fontSize via titleStripH(); cached here so
    // the rest of the layout math can read it like a plain dimension.
    titleH: number;
    infoH: number;
    fontSize: number;
    // Square face-avatar size + how many to render in the grid / hover
    // strips when showFaces is on. The strip lives below the title in
    // grid state and below the info panel on hover.
    faceSize: number;
    facesPerStrip: number;
    facesPerHoverStrip: number;
}
export function gridSizing(slotW: number, slotH: number, hoverW: number, infoH: number, fontSize: number, faceSize: number, facesPerStrip: number, facesPerHoverStrip: number): GridSizing {
    return { slotW, slotH, hoverW, infoH, fontSize, titleH: titleStripH(fontSize), faceSize, facesPerStrip, facesPerHoverStrip };
}
// hoverW is exactly 2× slotW per spec — sets the displayed <img>'s width
// in the hover state; height comes from the image's intrinsic aspect.
export const SIZES: Record<GridSize, GridSizing> = {
    small:  gridSizing(160, 116, 320, 100, 11, 26, 5,  10),
    medium: gridSizing(220, 154, 440, 110, 12, 30, 6,  12),
    large:  gridSizing(300, 200, 600, 124, 13, 34, 7,  14),
    huge:   gridSizing(440, 290, 880, 140, 14, 38, 10, 20),
};
export const FACE_STRIP_PAD = 3;
// Reserved space at the bottom of an expanded grid cell for the
// AddToList chrome. Sized for one row of tile chips (the common
// case) — multiple wrap rows clip behind the card's overflow:hidden,
// which is the lesser evil than reserving a big dark band on every
// cell when most have only one row of list chips.
export const HOVER_ADD_TO_LIST_H = 44;
// 2× face avatars in the hover (expanded) state. The hover card is 2×
// wider so doubling the avatar size keeps roughly the same count of
// faces visible at a *useful* size for picking out who's who.
export const HOVER_FACE_SCALE = 2;
export function hoverFaceSize(s: GridSizing): number {
    return s.faceSize * HOVER_FACE_SCALE;
}
// Regular-grid avatars are rendered taller (2×) and wider (1.5×) than the
// base square to better show faces while keeping a portrait-ish crop.
export function faceWidth(s: GridSizing): number {
    return s.faceSize * 1.5;
}
export function faceHeight(s: GridSizing): number {
    return s.faceSize * 2;
}
export function faceStripH(s: GridSizing): number {
    return faceHeight(s) + 2 * FACE_STRIP_PAD;
}
export function hoverFaceStripH(s: GridSizing): number {
    return hoverFaceSize(s) + 2 * FACE_STRIP_PAD;
}
export const EDGE_MARGIN = 8;

// True iff this was an unmodified left-click — the case where we want to
// run our SPA navigation and block the anchor's default href follow.
// Anything else (right-click, middle-click, ctrl/cmd/shift/alt + click)
// is left alone so the browser can do its native thing: context menu,
// open in new tab, open in new window, etc.
export function isPlainLeftClick(e: MouseEvent): boolean {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

// Build the href that a cell's <a> tag advertises. Browsers use it for
// right-click → "Open in new tab", middle-click → background tab,
// ctrl/cmd+click → new tab, etc. Plain left-clicks are intercepted and
// done as SPA navigation; the href is never actually followed in that case.
export function buildPlayerHref(videoKey: string, opts?: { fromSeriesPath?: string; seekSec?: number }): string {
    const url = new URL(location.href);
    url.searchParams.set("video", videoKey);
    if (opts?.fromSeriesPath) url.searchParams.set("from_series", opts.fromSeriesPath);
    else url.searchParams.delete("from_series");
    if (opts?.seekSec !== undefined) url.searchParams.set("t", opts.seekSec.toFixed(2));
    else url.searchParams.delete("t");
    return url.pathname + url.search;
}
export function buildSeriesHref(parentPath: string): string {
    const url = new URL(location.href);
    url.searchParams.set("series", parentPath);
    // A series drill-in shouldn't carry stale player params.
    url.searchParams.delete("video");
    url.searchParams.delete("from_series");
    url.searchParams.delete("t");
    return url.pathname + url.search;
}

// Title-case a label at the UI layer. Lets us write button labels and enum
// values as plain lowercase strings everywhere else and capitalize only on
// display.
export function cap(s: string): string {
    return s.replace(/(?:^|\s)\w/g, c => c.toUpperCase());
}

export function startOfDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
// True when an editable element (text input, textarea, contenteditable) has
// focus — arrow keys belong to them in that case, not to grid navigation.
export function isEditableFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
}

// Cluster grid cells into rows by Y position. Items within ROW_Y_TOLERANCE of
// each other are in the same row (handles sub-pixel layout fuzz).
export const ROW_Y_TOLERANCE = 4;

export interface CellRect {
    key: string;
    rect: DOMRect;
}

export function readAllCellRects(): CellRect[] {
    const container = document.querySelector("[data-grid-scroll]");
    if (!container) return [];
    return Array.from(container.querySelectorAll("[data-cell-key]"))
        .map(el => ({
            key: (el as HTMLElement).getAttribute("data-cell-key") ?? "",
            rect: (el as HTMLElement).getBoundingClientRect(),
        }))
        .filter(c => c.key);
}

export function cellsInSameRow(all: CellRect[], top: number): CellRect[] {
    return all.filter(c => Math.abs(c.rect.top - top) <= ROW_Y_TOLERANCE);
}

// The cell currently sitting under the mouse cursor (via CSS :hover) if any.
// Browser tracks this for us, so we don't need to mirror it as state.
export function readMouseHoveredKey(): string | undefined {
    const hovered = document.querySelectorAll("[data-cell-key]:hover");
    if (hovered.length === 0) return undefined;
    return (hovered[hovered.length - 1] as HTMLElement).getAttribute("data-cell-key") ?? undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Global cell-hover tracking.
//
// Every cell wrapper has data-cell-key. We attach a single document-level
// mousemove listener that walks up from the element under the cursor to
// the nearest data-cell-key and stores that key in an observable. Each
// cell renders as "hovered" iff this observable matches its own key.
//
// The big win is that "moving the mouse from the card to the sibling
// bottom-UI block" no longer counts as a leave-then-enter — both
// elements live under the same wrapper, so the key under the mouse
// doesn't change, and nothing re-runs (including updateHoverGeometry,
// which was the thing shifting the card near screen edges).
//
// Cells that need to recompute geometry on the hover transition (the
// grow-from-centre card) register themselves below so the mousemove
// handler can call their updateHoverGeometry() synchronously *before*
// flipping the observable. That preserves the "no first-render with
// stale offsets" property that the per-cell onEnter used to give us.
// ─────────────────────────────────────────────────────────────────────

export const mouseHoveredCellKey = observable.box<string | undefined>(undefined);

// When hover-expand is disabled, the per-cell "?" button expands a cell on
// click instead. This holds the click-expanded cell's key (at most one), which
// the cells OR into their hover state. Cleared by clicking outside the cell.
export const clickExpandedKey = observable.box<string | undefined>(undefined);

export interface HoverGeometryConsumer { updateHoverGeometry(): void; }
export const hoverGeometryRegistry = new Map<string, HoverGeometryConsumer>();

export function registerHoverGeometry(key: string, consumer: HoverGeometryConsumer): void {
    hoverGeometryRegistry.set(key, consumer);
}
export function unregisterHoverGeometry(key: string, consumer: HoverGeometryConsumer): void {
    if (hoverGeometryRegistry.get(key) === consumer) hoverGeometryRegistry.delete(key);
}

export function findCellKeyFromNode(node: Element | null): string | undefined {
    while (node) {
        const k = node.getAttribute("data-cell-key");
        if (k !== null) return k;
        node = node.parentElement;
    }
    return undefined;
}

export function findCellKeyAt(x: number, y: number): string | undefined {
    return findCellKeyFromNode(document.elementFromPoint(x, y));
}

export function setClickExpanded(key: string | undefined): void {
    if (key === clickExpandedKey.get()) return;
    if (key !== undefined) {
        markKeyframesAccessed();
        const consumer = hoverGeometryRegistry.get(key);
        if (consumer) consumer.updateHoverGeometry();
    }
    runInAction(() => clickExpandedKey.set(key));
}

export function toggleClickExpanded(key: string): void {
    setClickExpanded(clickExpandedKey.get() === key ? undefined : key);
}

// Grace window: once a cell is expanded, the mouse moving off it doesn't
// immediately collapse it or expand something else. We hold the expanded
// cell for hoverGraceMs (user-configurable in Settings); when the window
// elapses we re-check the cursor's current position and expand whatever
// it's over *then* (even if the mouse has since stopped moving).

// Commit a new hovered cell: unlock the keyframes sticky gate, recompute
// the freshly-entered cell's geometry BEFORE flipping the observable (so
// its first hovered render already has correct offsets — the invariant the
// old onEnter path enforced), then flip it.
export function commitHover(key: string | undefined): void {
    if (key === mouseHoveredCellKey.get()) return;
    if (key !== undefined) {
        markKeyframesAccessed();
        const consumer = hoverGeometryRegistry.get(key);
        if (consumer) consumer.updateHoverGeometry();
    }
    runInAction(() => mouseHoveredCellKey.set(key));
}

export let mouseTrackerInstalled = false;
export let lastMouseX = 0;
export let lastMouseY = 0;
export let hoverGraceTimer: number | undefined;
export function installMouseTracker(): void {
    if (mouseTrackerInstalled) return;
    mouseTrackerInstalled = true;
    // Collapse a click-expanded cell when the next pointer-down lands outside
    // it (the click analogue of the mouse leaving a hovered cell).
    document.addEventListener("mousedown", e => {
        if (clickExpandedKey.get() === undefined) return;
        const cellKey = findCellKeyFromNode(e.target as Element | null);
        if (cellKey !== clickExpandedKey.get()) setClickExpanded(undefined);
    });
    // Losing window focus drops mouse hover: a card expanded under a cursor
    // that's now interacting with another window is stale. Keyboard navigation
    // is exempt — that selection is intentional and outlives focus changes.
    window.addEventListener("blur", () => {
        if (keyboardHoveredKey.get() !== undefined) return;
        if (hoverGraceTimer !== undefined) {
            clearTimeout(hoverGraceTimer);
            hoverGraceTimer = undefined;
        }
        commitHover(undefined);
    });
    document.addEventListener("mousemove", e => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        // Only hover while the page is focused (unless keyboard nav is driving).
        if (!document.hasFocus() && keyboardHoveredKey.get() === undefined) return;
        const next = findCellKeyAt(e.clientX, e.clientY);
        const current = mouseHoveredCellKey.get();
        if (next === current) {
            // Back on (or never left) the committed cell — cancel any
            // pending collapse/switch from a brief excursion off it.
            if (hoverGraceTimer !== undefined) {
                clearTimeout(hoverGraceTimer);
                hoverGraceTimer = undefined;
            }
            return;
        }
        if (current === undefined) {
            // Nothing is expanded yet — no grace to honour, expand now.
            commitHover(next);
            return;
        }
        // The mouse just moved off the expanded cell onto a different cell
        // or empty space. Hold the current cell for the grace window and
        // ignore intermediate cells; when the timer fires we expand
        // whatever the cursor is over at that moment. Don't restart the
        // timer on later moves — the window runs from when we first left.
        const graceMs = hoverGraceMs.get();
        if (graceMs <= 0) {
            commitHover(next);
            return;
        }
        if (hoverGraceTimer === undefined) {
            hoverGraceTimer = window.setTimeout(() => {
                hoverGraceTimer = undefined;
                commitHover(findCellKeyAt(lastMouseX, lastMouseY));
            }, graceMs);
        }
    });
}

export function pickNextKey(arrow: string): string | undefined {
    const cells = readAllCellRects();
    if (cells.length === 0) return undefined;

    let current = keyboardHoveredKey.get();
    if (!current) {
        // Seed nav from whatever the mouse is over, then fall through to
        // the arrow logic so the very first press *moves* off that cell
        // (rather than just adopting it as the keyboard cursor — which
        // would do nothing visible because the mouse already had it).
        // No mouse hover → first press enters at the top-left cell.
        const mouseKey = readMouseHoveredKey();
        if (mouseKey && cells.some(c => c.key === mouseKey)) current = mouseKey;
        else return cells[0].key;
    }

    const idx = cells.findIndex(c => c.key === current);
    if (idx < 0) return cells[0].key;
    const cur = cells[idx];

    if (arrow === "ArrowLeft" || arrow === "ArrowRight") {
        // Wrap within the same row only — per spec.
        const row = cellsInSameRow(cells, cur.rect.top);
        const rowIdx = row.findIndex(c => c.key === current);
        const len = row.length;
        const nextIdx = arrow === "ArrowLeft"
            ? (rowIdx - 1 + len) % len
            : (rowIdx + 1) % len;
        return row[nextIdx].key;
    }

    if (arrow === "ArrowUp") {
        // Find the closest row whose top is strictly less than ours.
        const above = cells.filter(c => c.rect.top < cur.rect.top - ROW_Y_TOLERANCE);
        if (above.length === 0) return current; // Stop at top.
        const targetTop = Math.max(...above.map(c => c.rect.top));
        const row = cellsInSameRow(cells, targetTop);
        return closestByLeft(row, cur.rect.left);
    }

    if (arrow === "ArrowDown") {
        const below = cells.filter(c => c.rect.top > cur.rect.top + ROW_Y_TOLERANCE);
        if (below.length === 0) return current; // Stop at bottom.
        const targetTop = Math.min(...below.map(c => c.rect.top));
        const row = cellsInSameRow(cells, targetTop);
        return closestByLeft(row, cur.rect.left);
    }

    return current;
}

// Tab traversal: like arrow nav but in flat reading order. Walks every
// cell left-to-right, top-to-bottom, so end-of-row falls into the next
// row's first cell instead of wrapping within the row the way arrows do.
// At the very ends we stop instead of wrapping the whole grid — same
// stop-at-edge behaviour as ArrowUp/ArrowDown.
export function pickTabKey(forward: boolean): string | undefined {
    const cells = readAllCellRects();
    if (cells.length === 0) return undefined;

    const current = keyboardHoveredKey.get();
    if (!current) {
        // First Tab with no selection enters at the natural endpoint:
        // top-left going forward, bottom-right going backward.
        return forward ? cells[0].key : cells[cells.length - 1].key;
    }

    const idx = cells.findIndex(c => c.key === current);
    if (idx < 0) return forward ? cells[0].key : cells[cells.length - 1].key;
    const nextIdx = idx + (forward ? 1 : -1);
    if (nextIdx < 0 || nextIdx >= cells.length) return current; // Stop at ends.
    return cells[nextIdx].key;
}

export function closestByLeft(row: CellRect[], left: number): string | undefined {
    if (row.length === 0) return undefined;
    let best = row[0];
    let bestDist = Math.abs(best.rect.left - left);
    for (let i = 1; i < row.length; i++) {
        const d = Math.abs(row[i].rect.left - left);
        if (d < bestDist) { best = row[i]; bestDist = d; }
    }
    return best.key;
}

// Scroll the target cell so it's comfortably inside the scroll container, with
// a small buffer from the top + bottom edges of the visible area. No-op if
// it's already comfortably in view.
export const SCROLL_BUFFER = 48;
export function scrollKeyIntoView(key: string) {
    const el = document.querySelector(`[data-cell-key="${CSS.escape(key)}"]`) as HTMLElement | null;
    if (!el) return;
    const container = el.closest("[data-grid-scroll]") as HTMLElement | null;
    if (!container) return;
    const cellRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const top = cellRect.top - containerRect.top;
    const bottom = cellRect.bottom - containerRect.top;
    const h = containerRect.height;
    if (top < SCROLL_BUFFER) {
        container.scrollTop -= SCROLL_BUFFER - top;
    } else if (bottom > h - SCROLL_BUFFER) {
        container.scrollTop += bottom - (h - SCROLL_BUFFER);
    }
}

// Inline shorthand for the global transition. The transition string is
// re-evaluated every render so changing animationMs in Settings takes
// effect immediately — same observer reaction that already drives the
// cells, no extra plumbing. `bottom` is included via globalTransition
// so panels anchored from the bottom of the card (the title strip)
// don't snap to their hover-state value while the card height is still
// growing.
export const cardTransition = globalTransition;

// Latest positionUpdatedAt among the videos in a series, with the matching
// video. Used for the series-tile thumbnail and for highlighting in the
// drilled view.
export function lastPlayedInSeries(group: SeriesGroup): { video: SeriesVideo; at: number } | undefined {
    let bestAt = 0;
    let bestV: SeriesVideo | undefined;
    for (const v of group.videos) {
        const t = files.getSingleFieldSync(v.key, "positionUpdatedAt") ?? 0;
        if (t > bestAt) { bestAt = t; bestV = v; }
    }
    if (!bestV) return undefined;
    return { video: bestV, at: bestAt };
}

// Drill into a series the same way SeriesCell.drillIn does — honouring
// the Fast-open setting. Pulled out as a free function so the keyboard
// Enter handler can activate a series tile by its data-cell-key
// without holding a reference to the SeriesCell instance.
export function activateSeries(group: SeriesGroup): void {
    if (fastOpenSeries.get()) {
        const lp = lastPlayedInSeries(group);
        const target = lp?.video.key ?? group.videos[0]?.key;
        if (target) {
            goToPlayerFromSeries(target, group.parentPath);
            return;
        }
    }
    runInAction(() => { seriesPath.value = group.parentPath; });
}
