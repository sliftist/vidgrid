// List mode — replaces the file grid with a column of user-curated
// lists. Each list collapses to a one-line header; clicking expands
// it to a 70vh-tall scrollable grid using the same GridCell /
// SeriesCell components as the main grid.
//
// Series-in-list behaviour: clicking a series tile while inside an
// expanded list replaces the list's contents with that series'
// videos (the list itself stays expanded; this is local state, no
// URL change).

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { FileRecord, files, gridSize, noteVisibleKeys } from "../appState";
import { SeriesGroup } from "./series";
import { ListRecord, getListsSync, getListMembersSync, reorderListMembers, MembershipEntry, RECENT_VIDEOS_LIST_KEY } from "../lists/lists";
import { listRowHeaderPad, dropLineBefore, dropLineAfter, GRID_GAP, actionBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { SIZES, seriesDisplayThumbKey, computeFlushColumns, lastPlayedInSeries } from "./gridShared";

// Sort key for a list entry: the most recent of when it was added to the list
// and when it was last played — for a series, the latest play across any of its
// videos; for a lone video, its own play time. Descending, so freshly added or
// freshly watched entries rise to the top.
function listEntryActivityAt(m: MembershipEntry, getSeriesGroup: (p: string) => SeriesGroup | undefined): number {
    let played = 0;
    if (m.itemType === "series") {
        const g = getSeriesGroup(m.itemKey);
        played = g ? (lastPlayedInSeries(g)?.at ?? 0) : 0;
    } else {
        played = files.getSingleFieldSync(m.itemKey, "positionUpdatedAt") ?? 0;
    }
    return Math.max(m.addedAt, played);
}

function getSortedListMembers(
    listKey: string,
    getSeriesGroup: (p: string) => SeriesGroup | undefined,
): MembershipEntry[] {
    if (listKey === RECENT_VIDEOS_LIST_KEY) return getRecentVideosMembers();
    return getListMembersSync(listKey).sort(
        (a, b) => listEntryActivityAt(b, getSeriesGroup) - listEntryActivityAt(a, getSeriesGroup),
    );
}

// The built-in "most recent videos" list stores no memberships; its contents
// are the N most-recently-*active* videos — per video, the newest of when it
// was added to the library and when it was last played — newest first.
// Mirrors the grid's notion of a valid file (must have a name + relativePath).
const RECENT_VIDEOS_LIMIT = 20;
function getRecentVideosMembers(): MembershipEntry[] {
    const addedCol = files.getColumnSync("addedAt");
    if (!addedCol) return [];
    const playedAt = new Map<string, number>();
    for (const { key, value } of files.getColumnSync("positionUpdatedAt") ?? []) {
        if (typeof value === "number") playedAt.set(key, value);
    }
    const byActivity = addedCol
        .filter(e => typeof e.value === "number")
        .map(e => ({
            key: e.key,
            addedAt: e.value as number,
            at: Math.max(e.value as number, playedAt.get(e.key) ?? 0),
        }))
        .sort((a, b) => b.at - a.at);
    const out: MembershipEntry[] = [];
    for (const { key, addedAt } of byActivity) {
        if (out.length >= RECENT_VIDEOS_LIMIT) break;
        if (typeof files.getSingleFieldSync(key, "name") !== "string") continue;
        if (typeof files.getSingleFieldSync(key, "relativePath") !== "string") continue;
        out.push({ itemKey: key, itemType: "video", addedAt });
    }
    return out;
}

// What GridCell accepts as `record` — just the fields it needs. Keep
// this in sync with GridCell's prop signature.
export type ListGridRecord = Pick<FileRecord, "key" | "name" | "relativePath" | "size">;

// Render-prop boundary so this file doesn't need to import the heavy
// GridCell/SeriesCell types directly. SearchPage owns those and passes
// renderers down.
export interface ListTileArgs {
    list: ListRecord;
    expanded: boolean;
    memberCount: number;
    onToggle: () => void;
    rearranging: boolean;
    onToggleRearrange: () => void;
    slotWidth?: number;
}

export interface ListModeRenderers {
    renderVideo: (record: ListGridRecord, slotWidth?: number) => preact.ComponentChildren;
    renderSeries: (series: SeriesGroup, slotWidth?: number) => preact.ComponentChildren;
    // Stripped-down thumbnail used inside rearrange mode — replaces
    // the full GridCell/SeriesCell. No hover-state expansion, no
    // click-to-play, no inline action buttons. Drag-and-drop wrapping
    // happens here in ListMode; the rendered tile only needs to draw
    // the thumbnail + name + a "drag handle" indicator.
    renderRearrangeTile: (args: {
        itemKey: string;
        itemType: "video" | "series";
        slotWidth?: number;
    }) => preact.ComponentChildren;
    // The list-row "tile" that names the list + member count and is
    // the expand/collapse affordance. Same slot size as a grid cell —
    // SearchPage owns the sizing tables so the renderer lives there.
    renderListTile: (args: ListTileArgs) => preact.ComponentChildren;
    // Lookup helpers — the list stores raw keys, the renderers need
    // the matching record / group. Either returns undefined for stale
    // memberships (item removed from the library after being listed).
    getFileRecord: (key: string) => ListGridRecord | undefined;
    getSeriesGroup: (parentPath: string) => SeriesGroup | undefined;
}

interface ListModeProps extends ListModeRenderers {
    // No props beyond the renderers; lists come from getListsSync().
}

// Default state is collapsed — we track *expanded* lists, so every list
// (including brand-new ones) starts as a one-line header until clicked.
const expandedLists = observable.box<Set<string>>(new Set());

function setExpanded(listKey: string, expanded: boolean) {
    runInAction(() => {
        const next = new Set(expandedLists.get());
        if (expanded) next.add(listKey);
        else next.delete(listKey);
        expandedLists.set(next);
    });
}

@observer
export class ListMode extends preact.Component<ListModeProps> {
    // Own-width measurement. List mode uses the native scrollbar (not the
    // custom one), so SearchPage's bodyWidth over-counts by the scrollbar
    // width — measuring this container directly gives the true row width,
    // and the observer updates it as the scrollbar appears/disappears.
    private rootEl: HTMLDivElement | null = null;
    private resizeObs: ResizeObserver | undefined;
    private synced = observable({ width: 0 });
    private setRoot = (el: HTMLDivElement | null) => {
        if (this.rootEl === el) return;
        if (this.resizeObs && this.rootEl) this.resizeObs.unobserve(this.rootEl);
        this.rootEl = el;
        if (!el) return;
        if (typeof ResizeObserver !== "undefined") {
            if (!this.resizeObs) {
                this.resizeObs = new ResizeObserver(entries => {
                    const w = entries[0]?.contentRect.width ?? 0;
                    if (Math.abs(this.synced.width - w) > 0.5) runInAction(() => { this.synced.width = w; });
                });
            }
            this.resizeObs.observe(el);
        }
        const w = el.clientWidth;
        if (Math.abs(this.synced.width - w) > 0.5) runInAction(() => { this.synced.width = w; });
    };

    componentWillUnmount() {
        if (this.resizeObs) this.resizeObs.disconnect();
    }

    render() {
        const allLists = getListsSync();
        const expandedSet = expandedLists.get();

        // Thumbnail in-view prioritization for list mode. SearchPage only
        // notes the windowed-grid / non-uniform paths; list mode renders its
        // own rows, so without this the scan falls back to the whole-library
        // filtered set and ignores which list members are actually on screen.
        // Only thumbnails that are actually SHOWN get prioritized: expanded
        // lists contribute all their members (they're all rendered); collapsed
        // lists clip to a single nowrap row, so only the members that fit that
        // row count — the rest are off-screen and must not drag the scan
        // through the whole list. Series members contribute exactly their one
        // displayed thumbnail key.
        const s0 = SIZES[gridSize.get()];
        const visibleCols = Math.max(1, Math.floor((this.synced.width + GRID_GAP) / (s0.slotW + GRID_GAP)));
        const visibleKeys: string[] = [];
        const collect = (expandedPass: boolean) => {
            for (const list of allLists) {
                if (expandedSet.has(list.key) !== expandedPass) continue;
                let members = getSortedListMembers(list.key, this.props.getSeriesGroup);
                // Collapsed row = ListTile + as many member cells as fit.
                if (!expandedPass) members = members.slice(0, Math.max(0, visibleCols - 1));
                for (const m of members) {
                    if (m.itemType === "series") {
                        const g = this.props.getSeriesGroup(m.itemKey);
                        const dk = g && seriesDisplayThumbKey(g);
                        if (dk) visibleKeys.push(dk);
                    } else {
                        visibleKeys.push(m.itemKey);
                    }
                }
            }
        };
        collect(true);
        collect(false);
        noteVisibleKeys(visibleKeys);

        if (allLists.length === 0) {
            return <div className={css.fontSize(13).color("hsl(0, 0%, 60%)").center.pad2(60) + RS.Muted}>
                <div className={css.vbox(8).alignCenter}>
                    <div>No lists yet.</div>
                    <div className={css.fontSize(12).color("hsl(0, 0%, 45%)") + RS.Muted}>
                        Open any video and use "Add to a list" to create one.
                    </div>
                </div>
            </div>;
        }
        // Flush-fill column widths, same as the main grid: widen cells to
        // integer widths so an expanded row exactly fills the available
        // width with no trailing gap (leftover px spread one-per-column).
        const s = SIZES[gridSize.get()];
        const { colWidths } = computeFlushColumns(this.synced.width, s.slotW, GRID_GAP);

        // Between-list gap matches the between-cell gap (GRID_GAP) so rows
        // read as the same grid, just chunked by tile. No outer padding.
        return <div ref={this.setRoot} className={css.vbox(GRID_GAP).fillWidth}>
            {/* Collapsed strips scroll natively but use the ‹ › overlay
              * buttons as their chrome — hide the native scrollbar. */}
            <style>{`[data-list-strip]{scrollbar-width:none;}[data-list-strip]::-webkit-scrollbar{width:0;height:0;}`}</style>
            {allLists.map(list => <ListRow
                key={list.key}
                list={list}
                expanded={expandedSet.has(list.key)}
                onToggle={() => setExpanded(list.key, !expandedSet.has(list.key))}
                renderers={this.props}
                colWidths={colWidths}
            />)}
        </div>;
    }
}

@observer
class ListRow extends preact.Component<{
    list: ListRecord;
    expanded: boolean;
    onToggle: () => void;
    renderers: ListModeRenderers;
    colWidths: number[];
}> {
    // Per-list state. drilledSeriesPath only matters outside rearrange
    // mode. rearranging gates the DnD chrome.
    //   dragKey      — the itemKey currently being dragged (set on
    //                  dragstart, cleared on dragend).
    //   dropKey/side — the slot the cursor is currently over, plus
    //                  whether the cursor is on its left half ("before")
    //                  or right half ("after"). Drives the drop-line
    //                  overlay that previews where the drop will land.
    synced = observable({
        drilledSeriesPath: undefined as string | undefined,
        rearranging: false,
        dragKey: undefined as string | undefined,
        dropKey: undefined as string | undefined,
        dropSide: "before" as "before" | "after",
        // Whether the collapsed member strip has scroll distance in each
        // direction — drives the ‹ › overlay buttons (each only rendered
        // when there's actually somewhere to go).
        stripCanLeft: false,
        stripCanRight: false,
    });

    // Collapsed-row member strip: horizontally scrollable. Vertical wheel
    // over it pans sideways (there's no vertical content to scroll), and
    // ‹ › overlay buttons page through it.
    private stripEl: HTMLDivElement | null = null;
    private stripResizeObs: ResizeObserver | undefined;
    private setStrip = (el: HTMLDivElement | null) => {
        if (this.stripEl === el) return;
        if (this.stripResizeObs) { this.stripResizeObs.disconnect(); this.stripResizeObs = undefined; }
        this.stripEl = el;
        if (el && typeof ResizeObserver !== "undefined") {
            this.stripResizeObs = new ResizeObserver(() => this.updateStripScroll());
            this.stripResizeObs.observe(el);
        }
        this.updateStripScroll();
    };
    componentDidUpdate() {
        // Member count / widths change without the ref re-firing.
        this.updateStripScroll();
    }
    componentWillUnmount() {
        if (this.stripResizeObs) this.stripResizeObs.disconnect();
    }
    private updateStripScroll = () => {
        const el = this.stripEl;
        const canLeft = !!el && el.scrollLeft > 1;
        const canRight = !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        if (canLeft !== this.synced.stripCanLeft || canRight !== this.synced.stripCanRight) {
            runInAction(() => {
                this.synced.stripCanLeft = canLeft;
                this.synced.stripCanRight = canRight;
            });
        }
    };
    private onStripWheel = (e: WheelEvent) => {
        const el = this.stripEl;
        if (!el) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!delta) return;
        const before = el.scrollLeft;
        el.scrollLeft = before + delta;
        // Only consume the wheel when the strip actually moved — at either
        // end the event falls through so the page keeps scrolling normally.
        if (el.scrollLeft !== before) e.preventDefault();
    };
    private stripPage = (dir: -1 | 1) => {
        const el = this.stripEl;
        if (!el) return;
        el.scrollBy({ left: dir * Math.max(100, el.clientWidth * 0.8), behavior: "smooth" });
    };

    render() {
        const { list, expanded, onToggle, renderers, colWidths } = this.props;
        const members = getSortedListMembers(list.key, renderers.getSeriesGroup);
        const drilledPath = this.synced.drilledSeriesPath;
        const drilledGroup = drilledPath ? renderers.getSeriesGroup(drilledPath) : undefined;
        if (drilledGroup) {
            return <DrilledSeriesView
                group={drilledGroup}
                onBack={() => runInAction(() => { this.synced.drilledSeriesPath = undefined; })}
                renderers={renderers}
                colWidths={colWidths}
            />;
        }
        const rearranging = this.synced.rearranging;
        // Flush-fill width per cell by its position in the wrapping row. The
        // tile is flow-slot 0, member i is flow-slot i+1; each row holds
        // colWidths.length cells whose widths sum (with gaps) to the full row,
        // so flexbox wraps exactly on the column boundary. Only when expanded
        // (collapsed rows nowrap-clip, so widening them is pointless).
        const cols = colWidths.length;
        const widthFor = (flowSlot: number): number | undefined =>
            expanded && cols > 0 ? colWidths[flowSlot % cols] : undefined;
        // Members render in BOTH states — collapsed just nowraps so the
        // row clips at the page edge instead of wrapping. Expanded
        // wraps to as many lines as needed. No overflow:auto so hover
        // cards aren't clipped by an ancestor scroll container.
        const tileEl = renderers.renderListTile({
            list, expanded, memberCount: members.length, onToggle,
            rearranging,
            onToggleRearrange: () => runInAction(() => {
                this.synced.rearranging = !this.synced.rearranging;
                this.synced.dragKey = undefined;
            }),
            slotWidth: widthFor(0),
        });
        const memberCells = members.map((m, idx) => {
                const isVideo = m.itemType === "video";
                const w = widthFor(idx + 1);
                // In rearrange mode, swap the heavy GridCell/SeriesCell
                // out for a simple thumbnail tile (renderRearrangeTile)
                // — the playback chrome was eating the drag events and
                // making the gesture impossible to start.
                const inner = (() => {
                    if (rearranging) {
                        return renderers.renderRearrangeTile({
                            itemKey: m.itemKey,
                            itemType: isVideo ? "video" : "series",
                            slotWidth: w,
                        });
                    }
                    if (isVideo) {
                        const rec = renderers.getFileRecord(m.itemKey);
                        if (!rec) return <StaleRow label={`Missing video: ${m.itemKey}`} slotWidth={w} />;
                        return renderers.renderVideo(rec, w);
                    }
                    const group = renderers.getSeriesGroup(m.itemKey);
                    if (!group) return <StaleRow label={`Missing series: ${m.itemKey}`} slotWidth={w} />;
                    return renderers.renderSeries(group, w);
                })();
                const isDropTarget = this.synced.dropKey === m.itemKey;
                return <DragSlot
                    key={m.itemKey}
                    rearranging={rearranging}
                    itemKey={m.itemKey}
                    isDragSource={this.synced.dragKey === m.itemKey}
                    isDropTarget={isDropTarget}
                    dropSide={this.synced.dropSide}
                    onSeriesClick={!isVideo && !rearranging ? () => runInAction(() => { this.synced.drilledSeriesPath = m.itemKey; }) : undefined}
                    onDragStartItem={() => runInAction(() => { this.synced.dragKey = m.itemKey; })}
                    onDragEndItem={() => runInAction(() => {
                        this.synced.dragKey = undefined;
                        this.synced.dropKey = undefined;
                    })}
                    onDragOverItem={(side) => {
                        if (this.synced.dropKey !== m.itemKey || this.synced.dropSide !== side) {
                            runInAction(() => {
                                this.synced.dropKey = m.itemKey;
                                this.synced.dropSide = side;
                            });
                        }
                    }}
                    onDropAt={async (sourceKey, side) => {
                        if (sourceKey === m.itemKey) return;
                        const order = members.map(x => x.itemKey);
                        const sourceIdx = order.indexOf(sourceKey);
                        if (sourceIdx < 0) return;
                        order.splice(sourceIdx, 1);
                        // targetIdx is the post-removal position of the
                        // drop-target cell. "after" pushes one past it.
                        let targetIdx = order.indexOf(m.itemKey);
                        if (targetIdx < 0) targetIdx = idx;
                        if (side === "after") targetIdx += 1;
                        order.splice(targetIdx, 0, sourceKey);
                        await reorderListMembers(list.key, order);
                    }}
                >
                    {inner}
                </DragSlot>;
        });
        if (expanded) {
            return <div className={css.display("flex").alignItems("flex-start").gap(GRID_GAP).wrap.overflowX("visible")}>
                {tileEl}
                {memberCells}
            </div>;
        }
        // Collapsed: the tile stays put; the members live in a horizontally
        // scrollable strip beside it. Wheel over the strip pans it sideways
        // (the row has no vertical content of its own), and the ‹ › overlay
        // buttons page through it — each rendered only while there's actual
        // scroll distance in that direction.
        // fillWidth is load-bearing: the vbox parent uses align-items:start
        // (not stretch), so without an explicit width this row sizes to its
        // content — the strip then never overflows and can't scroll.
        return <div className={css.display("flex").alignItems("flex-start").gap(GRID_GAP).flexWrap("nowrap").fillWidth}>
            {tileEl}
            <div className={css.relative.flexGrow(1).minWidth(0)}>
                <div
                    ref={this.setStrip}
                    data-list-strip=""
                    onScroll={this.updateStripScroll}
                    onWheel={this.onStripWheel}
                    className={css.display("flex").alignItems("flex-start").gap(GRID_GAP).flexWrap("nowrap").overflowX("auto")}
                >
                    {memberCells}
                </div>
                {this.synced.stripCanLeft && <button
                    onMouseDown={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={() => this.stripPage(-1)}
                    title="Scroll this list left"
                    className={stripArrowBtn.left(0)}
                >
                    ‹
                </button>}
                {this.synced.stripCanRight && <button
                    onMouseDown={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={() => this.stripPage(1)}
                    title="Scroll this list right"
                    className={stripArrowBtn.right(0)}
                >
                    ›
                </button>}
            </div>
        </div>;
    }
}

// Edge-overlay paging buttons for a collapsed row's member strip. Chainable —
// callers add .left(0) / .right(0).
const stripArrowBtn = css.absolute.top(0).height("100%").width(26)
    .display("flex").alignItems("center").justifyContent("center")
    .background("hsla(0, 0%, 5%, 0.7)").hslahover(0, 0, 5, 0.9)
    .color("white").fontSize(22).border("none").pointer.zIndex(5);

// Wrapper around a single item cell in the rearrangeable list view.
//
// In rearrange mode, the wrapper turns into a real HTML5 DnD slot:
//   - draggable=true so the cursor grabs from anywhere on the image
//   - the browser handles ghost rendering itself (the source stays in
//     place at full opacity; the translucent ghost follows the cursor)
//   - onDragOver computes "before" vs "after" by checking whether the
//     cursor's X is in the left or right half of the cell
//   - a blue 3px line is overlaid on the appropriate edge of the
//     hovered cell — sits in the inter-cell gap so it doesn't change
//     anything's size
//   - drop calls back with side, parent re-orders accordingly
class DragSlot extends preact.Component<{
    rearranging: boolean;
    itemKey: string;
    isDragSource: boolean;
    isDropTarget: boolean;
    dropSide: "before" | "after";
    onSeriesClick?: () => void;
    onDragStartItem: () => void;
    onDragEndItem: () => void;
    onDragOverItem: (side: "before" | "after") => void;
    onDropAt: (sourceItemKey: string, side: "before" | "after") => void | Promise<void>;
}> {
    render() {
        const {
            rearranging, itemKey, isDropTarget, dropSide,
            onSeriesClick, onDragStartItem, onDragEndItem, onDragOverItem, onDropAt, children,
        } = this.props;
        return <div
            draggable={rearranging}
            onMouseDownCapture={(e: MouseEvent) => {
                if (!rearranging) return;
                // Don't preventDefault — that kills the native drag.
                // stopPropagation alone is enough to keep the cell's
                // navigation/click handlers from firing.
                e.stopPropagation();
            }}
            onMouseDown={!rearranging && onSeriesClick ? onSeriesClick : undefined}
            onDragStart={(e: DragEvent) => {
                if (!rearranging) return;
                e.dataTransfer?.setData("text/plain", itemKey);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                onDragStartItem();
            }}
            onDragEnd={() => {
                if (rearranging) onDragEndItem();
            }}
            onDragOver={(e: DragEvent) => {
                if (!rearranging) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const side: "before" | "after" = e.clientX < rect.left + rect.width / 2
                    ? "before"
                    : "after";
                onDragOverItem(side);
            }}
            onDrop={async (e: DragEvent) => {
                if (!rearranging) return;
                e.preventDefault();
                const sourceKey = e.dataTransfer?.getData("text/plain");
                if (!sourceKey) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const side: "before" | "after" = e.clientX < rect.left + rect.width / 2
                    ? "before"
                    : "after";
                await onDropAt(sourceKey, side);
            }}
            className={rearranging
                ? css.relative.cursor("grab").boxShadow("inset 0 0 0 1px hsl(220, 60%, 55%)")
                : ""}
        >
            {children}
            {/* Drop-line overlay. Lives inside the slot so its
              * positioning is naturally relative to it. The line spans
              * the slot's full height, sits in the inter-cell (GRID_GAP) gap
              * between neighbours so nothing shifts. */}
            {isDropTarget && rearranging && (dropSide === "before"
                ? <div className={dropLineBefore} />
                : <div className={dropLineAfter} />)}
        </div>;
    }
}

@observer
class DrilledSeriesView extends preact.Component<{
    group: SeriesGroup;
    onBack: () => void;
    renderers: ListModeRenderers;
    colWidths: number[];
}> {
    render() {
        const { group, onBack, renderers, colWidths } = this.props;
        const cols = colWidths.length;
        const widthFor = (i: number): number | undefined => cols > 0 ? colWidths[i % cols] : undefined;
        return <div className={css.vbox(0)}>
            <div className={listRowHeaderPad + css.hbox(6).alignCenter
                .hsl(0, 0, 11).borderBottom("1px solid hsl(0, 0%, 18%)") + RS.ListHeader}>
                <button
                    onMouseDown={(e: MouseEvent) => { e.preventDefault(); onBack(); }}
                    className={actionBtn + css.fontSize(11)}
                >
                    ← Back
                </button>
                <span className={css.fontSize(12).color("hsl(0, 0%, 70%)") + RS.Muted}>
                    {group.parentPath} · {group.videos.length} videos
                </span>
            </div>
            <div className={css.display("flex").wrap.alignItems("flex-start").gap(GRID_GAP)}>
                {group.videos.map((v, i) => {
                    const rec = renderers.getFileRecord(v.key);
                    if (!rec) return <StaleRow key={v.key} label={v.name} slotWidth={widthFor(i)} />;
                    return <preact.Fragment key={v.key}>
                        {renderers.renderVideo(rec, widthFor(i))}
                    </preact.Fragment>;
                })}
            </div>
        </div>;
    }
}

// Sized to a full grid slot (not a thin one-liner) so a member still
// reserves its cell footprint while its file record is loading from the
// DB — otherwise the row has no height until each thumbnail hydrates.
function StaleRow(props: { label: string; slotWidth?: number }) {
    const s = SIZES[gridSize.get()];
    const slotW = props.slotWidth ?? s.slotW;
    return <div className={css.size(slotW, s.slotH).flexShrink(0)
        .vbox(0).alignItems("center").justifyContent("center").textAlign("center")
        .pad2(8, 6).overflowHidden.hsl(0, 0, 9)
        .fontSize(11).color("hsl(0, 0%, 50%)").bord(1, "hsl(0, 0%, 20%)") + RS.Muted}>
        {props.label}
    </div>;
}
