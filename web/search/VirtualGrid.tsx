// Windowed grid for the uniform layouts (non-detailed, non-face), where every
// cell is exactly cellW × cellH. Because the slot size is fixed, the full
// scroll height is known up front (ceil(count / cols) rows) without rendering
// or measuring a single item — so we lay out a spacer of the total height and
// mount only the rows intersecting the viewport (plus a small buffer), each
// absolutely positioned at its computed slot. Scrolling never appends; it just
// shifts which window is mounted. The scroller is the surrounding
// [data-grid-scroll] element (shared with the hover-geometry clamp and the
// custom scrollbar), so this component reads geometry off it rather than owning
// the scroll itself.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { GRID_GAP } from "../styles";

const BUFFER_ROWS = 4;

@observer
export class VirtualGrid extends preact.Component<{
    count: number;
    // Column count and per-cell width come from the parent (derived from the
    // body width, which is stable regardless of the scrollbar's own width), so
    // the horizontal layout can't oscillate when the scrollbar absorbs leftover
    // px. cellH is the cell's height; the gap is added internally.
    cols: number;
    cellW: number;
    cellH: number;
    renderCell: (index: number) => preact.ComponentChild;
    keyForIndex: (index: number) => string;
    // Called (after layout, never during render) whenever the mounted window
    // moves, so the parent can prioritise thumbnail loads for what's on screen.
    onWindowChange?: (first: number, last: number) => void;
}> {
    private scroller: HTMLElement | null = null;
    private view = observable({ scrollTop: 0, height: 0 });
    private rafPending = false;
    private lastWindow: [number, number] = [-1, -1];

    componentDidMount() {
        this.scroller = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
        if (this.scroller) this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("resize", this.measure);
        this.measure();
        this.flushWindow();
    }
    componentWillUnmount() {
        if (this.scroller) this.scroller.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("resize", this.measure);
    }
    componentDidUpdate() {
        // A parent re-render can change the scroller's width (sidebar resize,
        // the custom scrollbar appearing) without a window-resize event — pick
        // that up here. measure() only writes when something actually changed,
        // so this converges in one extra pass.
        this.measure();
        this.flushWindow();
    }

    private onScroll = () => {
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => { this.rafPending = false; this.measure(); });
    };

    private measure = () => {
        const c = this.scroller;
        if (!c) return;
        const v = this.view;
        if (v.height !== c.clientHeight || Math.abs(v.scrollTop - c.scrollTop) > 0.5) {
            runInAction(() => { v.height = c.clientHeight; v.scrollTop = c.scrollTop; });
        }
    };

    // Notify the parent of the current window once layout has settled (called
    // from did-mount / did-update so we never mutate observables mid-render).
    private flushWindow() {
        const { count, cols, cellH, onWindowChange } = this.props;
        if (!onWindowChange || count <= 0) return;
        const rowH = cellH + GRID_GAP;
        const totalRows = Math.ceil(count / cols);
        const first = Math.max(0, Math.floor(this.view.scrollTop / rowH) - BUFFER_ROWS);
        const last = Math.min(totalRows - 1, Math.ceil((this.view.scrollTop + this.view.height) / rowH) + BUFFER_ROWS);
        const firstIdx = first * cols;
        const lastIdx = Math.min(count - 1, (last + 1) * cols - 1);
        if (firstIdx === this.lastWindow[0] && lastIdx === this.lastWindow[1]) return;
        this.lastWindow = [firstIdx, lastIdx];
        onWindowChange(firstIdx, lastIdx);
    }

    render() {
        const { count, cols, cellW, cellH, renderCell, keyForIndex } = this.props;
        const rowH = cellH + GRID_GAP;
        const totalRows = Math.ceil(count / cols);
        const totalH = totalRows > 0 ? totalRows * rowH - GRID_GAP : 0;

        const maxRow = Math.max(0, totalRows - 1);
        const firstRow = Math.min(maxRow, Math.max(0, Math.floor(this.view.scrollTop / rowH) - BUFFER_ROWS));
        const lastRow = Math.min(maxRow, Math.ceil((this.view.scrollTop + this.view.height) / rowH) + BUFFER_ROWS);

        const cells: preact.ComponentChild[] = [];
        for (let row = firstRow; row <= lastRow; row++) {
            for (let col = 0; col < cols; col++) {
                const index = row * cols + col;
                if (index >= count) break;
                cells.push(<div
                    key={keyForIndex(index)}
                    className={css.position("absolute").top(row * rowH).left(col * (cellW + GRID_GAP))}
                >
                    {renderCell(index)}
                </div>);
            }
        }

        return <div className={css.position("relative").fillWidth.height(totalH)}>
            {cells}
        </div>;
    }
}
