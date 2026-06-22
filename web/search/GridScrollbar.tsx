// Wide custom scrollbar for the result grid. It maps the WHOLE sorted result
// list (not just the rendered window) onto its height, drawing sort-aware
// labels — first letters for name order, month/year for date & unified order —
// at the vertical position of the first item in each bucket. Clicking a label
// (or anywhere on the track) jumps there; a translucent thumb reflects the
// current scroll position and can be dragged. The grid keeps scrolling
// normally; this just rides alongside it.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import {
    gridScrollbarTrack, gridScrollbarThumb, gridScrollbarLabel,
    GRID_SCROLLBAR_LABEL_MIN_GAP, GRID_GAP,
} from "../styles";
import { SortValue } from "./searchPipeline";
import { SortOrder } from "../appState";
import { readAllCellRects } from "./gridShared";
import { playSound } from "../sounds";

export type ScrollLabel = { text: string; index: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// One label per bucket boundary, walking the ordered list. A "bucket" is the
// first letter (name order) or the month (date / unified order); the label is
// emitted at the index where a new bucket begins, so its vertical position is
// that bucket's start fraction. The caller thins them to fit.
export function buildScrollLabels(sortValues: SortValue[], sortOrder: SortOrder): ScrollLabel[] {
    const out: ScrollLabel[] = [];
    let lastBucket: string | undefined;
    for (let i = 0; i < sortValues.length; i++) {
        const v = sortValues[i];
        let bucket: string;
        let text: string;
        if (sortOrder === "name") {
            const c = (v.name.trim()[0] || "#").toUpperCase();
            bucket = /[A-Z]/.test(c) ? c : "#";
            text = bucket;
        } else {
            // date → file mtime; unified → ingest date (its primary sort key).
            const ms = sortOrder === "date" ? v.modified : v.added;
            if (!ms) { bucket = "—"; text = "—"; }
            else {
                const d = new Date(ms);
                bucket = `${d.getFullYear()}-${d.getMonth()}`;
                text = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
            }
        }
        if (bucket !== lastBucket) { out.push({ text, index: i }); lastBucket = bucket; }
    }
    return out;
}

@observer
export class GridScrollbar extends preact.Component<{
    count: number;
    labels: ScrollLabel[];
    // Maps a cell's data-cell-key (raw video key, or "s:"+parentPath for a
    // series tile) back to its index in the full list, so the topmost visible
    // cell tells us the scroll fraction.
    cellKeyToIndex: Map<string, number>;
    jumpToIndex: (index: number) => void;
}> {
    private geom = observable({ topPct: 0, heightPct: 8, trackPx: 600 });
    private trackEl: HTMLDivElement | null = null;
    private container: HTMLElement | null = null;
    private rafPending = false;
    private dragging = false;
    private moveRaf = false;

    componentDidMount() {
        this.container = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
        if (this.container) this.container.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("resize", this.onScroll);
        this.recompute();
    }
    componentWillUnmount() {
        if (this.container) this.container.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("resize", this.onScroll);
    }
    // New search / window growth changes the geometry without firing a scroll
    // event; recompute after every render (guarded so it can't loop).
    componentDidUpdate() { this.recompute(); }

    private onScroll = () => {
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => { this.rafPending = false; this.recompute(); });
    };

    private recompute() {
        const container = this.container;
        const track = this.trackEl;
        const { count } = this.props;
        if (!container || !track || count <= 0) return;
        const cells = readAllCellRects();
        if (cells.length === 0) return;
        const containerRect = container.getBoundingClientRect();

        // Topmost cell still intersecting the viewport → its index is where
        // the visible window starts.
        let top: typeof cells[number] | undefined;
        for (const c of cells) {
            if (c.rect.bottom <= containerRect.top + 1) continue;
            if (!top || c.rect.top < top.rect.top) top = c;
        }
        const topIndex = top ? this.props.cellKeyToIndex.get(top.key) ?? 0 : 0;

        // Estimate the full content height from the first row's geometry so the
        // thumb is sized like "viewport / everything", not "viewport / loaded".
        const firstRowTop = cells[0].rect.top;
        const cols = cells.filter(c => Math.abs(c.rect.top - firstRowTop) <= 4).length || 1;
        const rowH = cells[0].rect.height + GRID_GAP;
        const totalRows = Math.ceil(count / cols);
        const fullH = Math.max(1, totalRows * rowH);

        const heightFrac = Math.max(0.03, Math.min(1, containerRect.height / fullH));
        const topFrac = Math.max(0, Math.min(1 - heightFrac, topIndex / count));

        const topPct = topFrac * 100;
        const heightPct = heightFrac * 100;
        const trackPx = track.clientHeight;
        const g = this.geom;
        if (Math.abs(g.topPct - topPct) > 0.05 || Math.abs(g.heightPct - heightPct) > 0.05 || g.trackPx !== trackPx) {
            runInAction(() => { g.topPct = topPct; g.heightPct = heightPct; g.trackPx = trackPx; });
        }
    }

    private fracToIndex(clientY: number): number {
        const track = this.trackEl;
        if (!track) return 0;
        const r = track.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height)));
        return Math.max(0, Math.min(this.props.count - 1, Math.round(frac * (this.props.count - 1))));
    }

    private onTrackPointerDown = (e: PointerEvent) => {
        // Labels handle their own clicks.
        if ((e.target as HTMLElement).getAttribute("data-scroll-label") !== null) return;
        e.preventDefault();
        this.dragging = true;
        this.trackEl?.setPointerCapture(e.pointerId);
        playSound("navMove");
        this.props.jumpToIndex(this.fracToIndex(e.clientY));
    };
    private onTrackPointerMove = (e: PointerEvent) => {
        if (!this.dragging || this.moveRaf) return;
        this.moveRaf = true;
        const y = e.clientY;
        requestAnimationFrame(() => { this.moveRaf = false; this.props.jumpToIndex(this.fracToIndex(y)); });
    };
    private onTrackPointerUp = (e: PointerEvent) => {
        if (!this.dragging) return;
        this.dragging = false;
        this.trackEl?.releasePointerCapture(e.pointerId);
    };
    // Wheeling over the bar scrolls the grid, not the page.
    private onWheel = (e: WheelEvent) => {
        if (!this.container) return;
        e.preventDefault();
        this.container.scrollTop += e.deltaY;
    };

    render() {
        const { count, labels } = this.props;
        const g = this.geom;

        // Thin labels so two never draw within MIN_GAP px of each other.
        const drawn: ScrollLabel[] = [];
        let lastY = -Infinity;
        for (const l of labels) {
            const y = (l.index / Math.max(1, count)) * g.trackPx;
            if (y - lastY >= GRID_SCROLLBAR_LABEL_MIN_GAP) { drawn.push(l); lastY = y; }
        }

        return <div
            ref={r => { this.trackEl = r; }}
            className={gridScrollbarTrack}
            onPointerDown={this.onTrackPointerDown}
            onPointerMove={this.onTrackPointerMove}
            onPointerUp={this.onTrackPointerUp}
            onWheel={this.onWheel}
        >
            <div className={gridScrollbarThumb + css.top(`${g.topPct}%`).height(`${g.heightPct}%`)} />
            {drawn.map(l => <div
                key={l.index}
                data-scroll-label=""
                className={gridScrollbarLabel + css.top(`${(l.index / Math.max(1, count)) * 100}%`)}
                onMouseDown={(e: MouseEvent) => { e.stopPropagation(); playSound("navMove"); this.props.jumpToIndex(l.index); }}
                title={`Jump to ${l.text}`}
            >
                {l.text}
            </div>)}
        </div>;
    }
}
