import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { gridSize } from "../appState";
import { css } from "typesafecss";
import { moveListUp, moveListDown, deleteList } from "../lists/lists";
import { openEditList } from "../lists/EditListModal";
import { tileActionBtn, primaryBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { SIZES } from "./gridShared";

// ListTile — the first cell in each row of List mode. Names the list +
// shows the member count + acts as the expand/collapse toggle. Sized to
// match a regular grid cell (uses the same SIZES table) so it slots in
// alongside videos/series cleanly.
@observer
export class ListTile extends preact.Component<{
    list: { key: string; name: string };
    expanded: boolean;
    memberCount: number;
    onToggle: () => void;
    rearranging: boolean;
    onToggleRearrange: () => void;
}> {
    render() {
        const { list, expanded, memberCount, onToggle, rearranging, onToggleRearrange } = this.props;
        const s = SIZES[gridSize.get()];
        const tileLayout = css.relative.size(s.slotW, s.slotH).flexShrink(0)
            .pad(0).overflowHidden.display("flex").alignItems("stretch").pointer;
        const tileAppearance = expanded
            ? css.color("white").hsl(220, 50, 18).bord(1, "hsl(220, 60%, 35%)")
            : css.color("white").hsl(0, 0, 13).bord(1, "hsl(0, 0%, 22%)");
        return <div
            data-cell-key={`list:${list.key}`}
            onMouseDown={(e: MouseEvent) => { e.preventDefault(); onToggle(); }}
            title={expanded ? `${list.name} — click to collapse` : `${list.name} — click to expand`}
            className={tileLayout + tileAppearance + RS.ListItem}
        >
            <div className={css.flexGrow(1).vbox(0).pad(8).textAlign("center")
                .minWidth(0).justifyContent("center").alignItems("center")}>
                <div className={css.fontSize(18).lineHeight("1.15").overflowWrap("break-word")}>
                    {list.name}
                </div>
                <div className={css.fontSize(12).color("hsl(0, 0%, 65%)").marginTop(6)
                    .hbox(6).alignItems("center") + RS.Muted}>
                    <span>{memberCount} item{memberCount === 1 ? "" : "s"}</span>
                    {/* Expand/collapse triangle — inline with the
                      * count so it reads as part of the same row. */}
                    <span className={css.fontSize(13).color("hsl(0, 0%, 75%)").marginLeft(4) + RS.Muted}>
                        {expanded ? "▼" : "▶"}
                    </span>
                </div>
            </div>
            {/* Action stack — list-ordering ↑/↓, rename/delete, and
              * rearrange-toggle live together at the bottom-right.
              * Glyphs flex-centred via tileActionBtn so emojis sit on
              * the visual middle, not the text baseline. */}
            <div className={css.absolute.bottom(4).right(4).hbox(4).alignItems("center")}>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void moveListUp(list.key);
                    }}
                    title="Move this list up"
                    className={tileActionBtn}
                >
                    ↑
                </button>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void moveListDown(list.key);
                    }}
                    title="Move this list down"
                    className={tileActionBtn}
                >
                    ↓
                </button>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        e.preventDefault();
                        openEditList(list.key);
                    }}
                    title="Rename or change ordering of this list"
                    className={tileActionBtn}
                >
                    ✎
                </button>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (!confirm(`Delete the list "${list.name}"? It will be removed from every item it's on. Items stay in the library.`)) return;
                        void deleteList(list.key);
                    }}
                    title="Delete this list"
                    className={tileActionBtn}
                >
                    🗑
                </button>
                <button
                    onMouseDown={(e: MouseEvent) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onToggleRearrange();
                    }}
                    title={rearranging
                        ? "Done — exit rearrange mode"
                        : "Rearrange items in this list — drag to reorder"}
                    className={rearranging ? primaryBtn : tileActionBtn}
                >
                    {rearranging ? "Done" : "⇅"}
                </button>
            </div>
        </div>;
    }
}
