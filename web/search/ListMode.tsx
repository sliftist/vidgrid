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
import { FileRecord, gridSize, noteVisibleKeys } from "../appState";
import { SeriesGroup } from "./series";
import { ListRecord, getListsSync, getListMembersSync, reorderListMembers } from "../lists/lists";
import { listRowHeaderPad, dropLineBefore, dropLineAfter, GRID_GAP, actionBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { SIZES, seriesPriorityKeys, computeFlushColumns } from "./gridShared";

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

// Default state is expanded — the user wants to land on the list page
// and see contents without having to click each chevron. We track
// *collapsed* lists instead, so a brand-new list defaults to open
// automatically without needing to seed it into a Set.
const collapsedLists = observable.box<Set<string>>(new Set());

function setExpanded(listKey: string, expanded: boolean) {
    runInAction(() => {
        const next = new Set(collapsedLists.get());
        if (expanded) next.delete(listKey);
        else next.add(listKey);
        collapsedLists.set(next);
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
        const collapsed = collapsedLists.get();

        // Thumbnail in-view prioritization for list mode. SearchPage only
        // notes the windowed-grid / non-uniform paths; list mode renders its
        // own rows, so without this the scan falls back to the whole-library
        // filtered set and ignores which list members are actually on screen.
        // Expanded lists' members come first (series flattened display-first
        // via seriesPriorityKeys); collapsed lists clip to one nowrap row, so
        // their members rank below.
        const visibleKeys: string[] = [];
        const collect = (collapsedPass: boolean) => {
            for (const list of allLists) {
                if (collapsed.has(list.key) !== collapsedPass) continue;
                for (const m of getListMembersSync(list.key)) {
                    if (m.itemType === "series") {
                        const g = this.props.getSeriesGroup(m.itemKey);
                        if (g) visibleKeys.push(...seriesPriorityKeys(g));
                        else visibleKeys.push(m.itemKey);
                    } else {
                        visibleKeys.push(m.itemKey);
                    }
                }
            }
        };
        collect(false);
        collect(true);
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
            {allLists.map(list => <ListRow
                key={list.key}
                list={list}
                expanded={!collapsed.has(list.key)}
                onToggle={() => setExpanded(list.key, collapsed.has(list.key))}
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
    });

    render() {
        const { list, expanded, onToggle, renderers, colWidths } = this.props;
        const members = getListMembersSync(list.key);
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
        const rowCls = css.display("flex").alignItems("flex-start").gap(GRID_GAP)
            + (expanded ? css.wrap.overflowX("visible") : css.flexWrap("nowrap").overflowX("hidden"));
        return <div className={rowCls}>
            {renderers.renderListTile({
                list, expanded, memberCount: members.length, onToggle,
                rearranging,
                onToggleRearrange: () => runInAction(() => {
                    this.synced.rearranging = !this.synced.rearranging;
                    this.synced.dragKey = undefined;
                }),
                slotWidth: widthFor(0),
            })}
            {members.map((m, idx) => {
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
            })}
        </div>;
    }
}

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
