import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { files, gridSize } from "../appState";
import { SeriesGroup } from "./series";
import { pickThumbForDisplay, resolveSeriesThumbKey } from "../scan/thumbnails";
import {
    cellPadTitle, seriesCountBadge, buttonDown,
    rearrangeTileWrap, rearrangeTitle,
    rearrangeNumberBar, rearrangeNumberBarSet, rearrangeNumberInput, rearrangeNumberClear,
} from "../styles";
import { RS } from "../restyle/classNames";
import { SIZES, lastPlayedInSeries } from "./gridShared";

// Stripped-down thumbnail tile used inside a list's rearrange mode.
// Replaces GridCell / SeriesCell entirely — no hover-state expansion,
// no click-to-play, no inline action buttons. Along its top edge sits
// the position field: type a number to pin the item at that spot in
// the list, clear it to let the item float again.
@observer
export class RearrangeTile extends preact.Component<{
    itemKey: string;
    itemType: "video" | "series";
    seriesMap: Map<string, SeriesGroup>;
    // The position the user has given this item, if any.
    rank: number | undefined;
    onSetRank: (rank: number | undefined) => void;
    slotWidth?: number;
}> {
    // What's currently typed in the field, while it differs from the committed
    // rank. undefined = not editing, so the field shows props.rank — which is
    // how a renumber elsewhere in the list (the collision cascade pushing this
    // item down) shows up here immediately.
    private synced = observable({ draft: undefined as string | undefined });

    // Commit the typed text: blank clears the rank, a number sets it, and
    // anything unparseable reverts to whatever was already stored.
    private commit = () => {
        const draft = this.synced.draft;
        if (draft === undefined) return;
        runInAction(() => { this.synced.draft = undefined; });
        const text = draft.trim();
        if (!text) {
            if (this.props.rank !== undefined) this.props.onSetRank(undefined);
            return;
        }
        const value = Number(text);
        if (!Number.isFinite(value)) return;
        if (Math.round(value) === this.props.rank) return;
        this.props.onSetRank(Math.round(value));
    };

    render() {
        const { itemKey, itemType, seriesMap, rank, onSetRank } = this.props;
        const s = SIZES[gridSize.get()];
        const slotW = this.props.slotWidth ?? s.slotW;
        // Source key for the thumbnail. For a video the itemKey IS the
        // file key. For a series, user-picked thumb → last-played →
        // first video → undefined.
        let thumbKey: string | undefined = itemKey;
        let label = "";
        let badge: number | undefined;
        if (itemType === "video") {
            label = files.getSingleFieldSync(itemKey, "name") ?? itemKey;
        } else {
            const group = seriesMap.get(itemKey);
            if (group) {
                label = group.folderName;
                badge = group.videos.length;
                const lp = lastPlayedInSeries(group);
                thumbKey = resolveSeriesThumbKey(group.videos, lp?.video.key);
            } else {
                label = itemKey;
            }
        }
        const thumbUrl = thumbKey ? pickThumbForDisplay(thumbKey, slotW) : undefined;
        const draft = this.synced.draft;
        const fieldValue = draft ?? (rank !== undefined ? String(rank) : "");
        return <div className={rearrangeTileWrap.size(slotW, s.slotH).flexShrink(0) + RS.RearrangeTile}>
            {/* Position field — top edge, full width. */}
            <div className={rank !== undefined ? rearrangeNumberBarSet : rearrangeNumberBar}>
                <input
                    type="text"
                    inputMode="numeric"
                    value={fieldValue}
                    placeholder="—"
                    title="Position in this list. Type a number to pin this item there — whatever already holds that number is pushed down one. Leave blank to let it float."
                    onInput={(e: Event) => runInAction(() => {
                        this.synced.draft = (e.currentTarget as HTMLInputElement).value;
                    })}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            this.commit();
                            (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            runInAction(() => { this.synced.draft = undefined; });
                            (e.currentTarget as HTMLInputElement).blur();
                        }
                    }}
                    onBlur={this.commit}
                    className={rearrangeNumberInput}
                />
                {rank !== undefined && <button
                    onMouseDown={buttonDown(() => onSetRank(undefined))}
                    title="Un-number this item so it floats with the rest of the list"
                    className={rearrangeNumberClear}
                >
                    ×
                </button>}
            </div>
            <div
                className={
                    css.flexGrow(1).relative
                    + css.background(thumbUrl
                        ? `center / cover no-repeat url("${thumbUrl}")`
                        : "hsl(0, 0%, 12%)")
                }
            >
                {!thumbUrl && <div
                    className={
                        css.absolute.top("50%").left("50%").transform("translate(-50%, -50%)")
                        + css.fontSize(11).color("hsl(0, 0%, 45%)")
                    }
                >
                    (no thumbnail)
                </div>}
                {badge !== undefined && <div className={seriesCountBadge.absolute.top(6).right(6).zIndex(4) + RS.SeriesCount}>{badge}</div>}
            </div>
            <div title={label} className={cellPadTitle + rearrangeTitle.fontSize(s.fontSize) + RS.RearrangeTitle}>
                {label}
            </div>
        </div>;
    }
}
