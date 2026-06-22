import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { files, gridSize } from "../appState";
import { SeriesGroup } from "./series";
import { pickThumbForDisplay } from "../scan/thumbnails";
import {
    cellPadTitle, seriesCountBadge,
    rearrangeTileWrap, rearrangeDragStripe, rearrangeTitle,
} from "../styles";
import { SIZES, lastPlayedInSeries } from "./gridShared";

// Stripped-down thumbnail tile used inside a list's rearrange mode.
// Replaces GridCell / SeriesCell entirely — no hover-state expansion,
// no click-to-play, no inline action buttons (those were swallowing
// the drag events). Visible "drag handle" stripe along the top so it
// reads as a draggable item even without hover.
@observer
export class RearrangeTile extends preact.Component<{
    itemKey: string;
    itemType: "video" | "series";
    seriesMap: Map<string, SeriesGroup>;
}> {
    render() {
        const { itemKey, itemType, seriesMap } = this.props;
        const s = SIZES[gridSize.get()];
        // Source key for the thumbnail. For a video the itemKey IS the
        // file key. For a series, use last-played-in-series → first
        // video → undefined.
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
                thumbKey = lp?.video.key ?? group.videos[0]?.key;
            } else {
                label = itemKey;
            }
        }
        const thumbUrl = thumbKey ? pickThumbForDisplay(thumbKey, s.slotW) : undefined;
        return <div className={rearrangeTileWrap.size(s.slotW, s.slotH).flexShrink(0)}>
            {/* Drag handle stripe — top edge, full width. */}
            <div className={rearrangeDragStripe}>⋮⋮ drag ⋮⋮</div>
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
                {badge !== undefined && <div className={seriesCountBadge.absolute.top(6).right(6).zIndex(4)}>{badge}</div>}
            </div>
            <div title={label} className={cellPadTitle + rearrangeTitle.fontSize(s.fontSize)}>
                {label}
            </div>
        </div>;
    }
}
