import * as preact from "preact";
import { observable, runInAction, reaction, IReactionDisposer } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import {
    files,
    thumbnails,
    gridSize,
    detailedGridView,
    fastOpenSeries,
    hoverExpandEnabled,
    keyboardHoveredKey,
} from "../appState";
import { SeriesGroup } from "./series";
import { goToPlayerFromSeries, seriesPath } from "../router";
import { pickThumbForDisplay, resolveSeriesThumbKey } from "../scan/thumbnails";
import {
    cellPad, cellPadTitle, seriesCountBadge, cellExpandBtn,
    cellCornerTL, cellCornerTR,
} from "../styles";
import { RS } from "../restyle/classNames";
import { AddToList } from "../lists/AddToList";
import { GridTagChips } from "./GridTagChips";
import {
    GridSizing, SIZES, EDGE_MARGIN, HOVER_ADD_TO_LIST_H,
    isPlainLeftClick, buildSeriesHref, buildPlayerHref, cardTransition, lastPlayedInSeries,
    registerHoverGeometry, unregisterHoverGeometry, clickExpandedKey, toggleClickExpanded,
} from "./gridShared";

// Series tile — same slot dimensions + hover geometry as GridCell, but the
// content is a thumbnail of the last-played video in the series, the folder
// name as the title, plus a small count badge. Click drills into the series
// (sets the seriesPath URL param), and the SearchPage shows the contents.
@observer
export class SeriesCell extends preact.Component<{ series: SeriesGroup; slotWidth?: number }> {
    cardRef: HTMLDivElement | null = null;
    // Outer slot wrapper — see GridCell.slotRef for the rationale.
    slotRef: HTMLDivElement | null = null;
    synced = observable({
        mouseHovered: false,
        topOffset: 0,
        leftOffset: 0,
        imgNaturalW: 0,
        imgNaturalH: 0,
    });
    private kbReaction: IReactionDisposer | undefined;

    private cellKey(): string { return `s:${this.props.series.parentPath}`; }

    componentDidMount() {
        // Register with the global mouse tracker so its enter event
        // triggers updateHoverGeometry() before flipping the observable.
        registerHoverGeometry(this.cellKey(), this);
        // And recompute geometry whenever the keyboard cursor lands
        // on this series — same wiring GridCell uses.
        this.kbReaction = reaction(
            () => keyboardHoveredKey.get() === this.cellKey(),
            isOurs => { if (isOurs) this.updateHoverGeometry(); },
        );
    }

    componentWillUnmount() {
        unregisterHoverGeometry(this.cellKey(), this);
        if (this.kbReaction) this.kbReaction();
    }

    private onImgLoad = (e: Event) => {
        const img = e.currentTarget as HTMLImageElement;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            runInAction(() => {
                this.synced.imgNaturalW = img.naturalWidth;
                this.synced.imgNaturalH = img.naturalHeight;
            });
        }
    };

    private aspectRatio(): number {
        // Authoritative source — the actually-rendered image after load.
        const nw = this.synced.imgNaturalW;
        const nh = this.synced.imgNaturalH;
        if (nw > 0 && nh > 0) return nw / nh;
        const lp = lastPlayedInSeries(this.props.series);
        const sourceKey = lp?.video.key ?? this.props.series.videos[0]?.key;
        if (!sourceKey) return 16 / 9;
        const tw = thumbnails.getSingleFieldSync(sourceKey, "thumbW");
        const th = thumbnails.getSingleFieldSync(sourceKey, "thumbH");
        if (tw && th && tw > 0 && th > 0) return tw / th;
        const w = files.getSingleFieldSync(sourceKey, "width");
        const h = files.getSingleFieldSync(sourceKey, "height");
        if (w && h && w > 0 && h > 0) return w / h;
        return 16 / 9;
    }

    private hoverCardHeight(s: GridSizing): number {
        const imgH = Math.round(s.hoverW / this.aspectRatio());
        return imgH + s.titleH + s.infoH;
    }

    public updateHoverGeometry(): void {
        const measure = this.slotRef ?? this.cardRef;
        if (!measure) return;
        const rect = measure.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const s = SIZES[gridSize.get()];
        const cardH = this.hoverCardHeight(s);
        // Clamp against the scroll container's edges (not the viewport) so a
        // popped card avoids the sidebar the same way it avoids the page edge.
        const scrollContainer = measure.closest("[data-grid-scroll]") as HTMLElement | null;
        const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
        const upperBound = (containerRect ? containerRect.top : 0) + EDGE_MARGIN;
        const leftBound = (containerRect ? containerRect.left : 0) + EDGE_MARGIN;
        const rightBound = (containerRect ? containerRect.right : vw) - EDGE_MARGIN;
        // Centre over the actual (possibly stretched) slot footprint — see
        // GridCell.updateHoverGeometry for the rationale.
        let topOffset = -(cardH - rect.height) / 2;
        let leftOffset = -(s.hoverW - rect.width) / 2;
        const top = rect.top + topOffset;
        const bottom = top + cardH;
        if (top < upperBound) topOffset += upperBound - top;
        else if (bottom > vh - EDGE_MARGIN) topOffset -= bottom - (vh - EDGE_MARGIN);
        const left = rect.left + leftOffset;
        const right = left + s.hoverW;
        if (left < leftBound) leftOffset += leftBound - left;
        else if (right > rightBound) leftOffset -= right - rightBound;
        runInAction(() => {
            this.synced.topOffset = topOffset;
            this.synced.leftOffset = leftOffset;
        });
    }

    private onEnter = () => {
        this.updateHoverGeometry();
        runInAction(() => { this.synced.mouseHovered = true; });
    };
    private onLeave = () => {
        runInAction(() => { this.synced.mouseHovered = false; });
    };
    private drillIn = () => {
        // Fast-open mode (Settings → "Fast-open series"): jump straight
        // to the player on the most recently played video, or the first
        // if nothing's been played. Skips the series-detail grid.
        // The count badge bypasses it — see drillInForce.
        if (fastOpenSeries.get()) {
            const series = this.props.series;
            const lp = lastPlayedInSeries(series);
            const target = lp?.video.key ?? series.videos[0]?.key;
            if (target) {
                goToPlayerFromSeries(target, series.parentPath);
                return;
            }
        }
        runInAction(() => { seriesPath.value = this.props.series.parentPath; });
    };

    // Force the series-detail grid open regardless of the fast-open
    // setting. Used by the count-badge click.
    private drillInForce = () => {
        runInAction(() => { seriesPath.value = this.props.series.parentPath; });
    };

    private onTileMouseDown = (e: MouseEvent) => {
        // Middle-click, right-click, ctrl/cmd/shift+click etc. fall
        // through so the anchor's native behaviour (open href in a new
        // tab, context menu, …) runs unmodified — the tile's href always
        // mirrors what a plain click does (player when Fast-open is on,
        // the series grid otherwise), so middle-click is exactly "what
        // click does, in a new tab".
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        this.drillIn();
    };
    private onTileClick = (e: MouseEvent) => {
        // mousedown already SPA-navigated on plain left-click; block the
        // anchor's default href follow so we don't double-fire.
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
    };

    render() {
        const series = this.props.series;
        const lp = lastPlayedInSeries(series);
        // The tile's href mirrors what a plain click does: with Fast-open on
        // it points at the player for the video drillIn would play, otherwise
        // at the series grid. Middle/ctrl-click then natively opens the same
        // destination in a new tab.
        const fastTarget = lp?.video.key ?? series.videos[0]?.key;
        const tileHref = fastOpenSeries.get() && fastTarget
            ? buildPlayerHref(fastTarget, { fromSeriesPath: series.parentPath })
            : buildSeriesHref(series.parentPath);
        const thumbSourceKey = resolveSeriesThumbKey(series.videos, lp?.video.key);
        // Resume bar for the series, mirroring the single-video cell: how far
        // into the last-played video the user got. 0 when nothing has been
        // played. (The thumbnail may come from a different video when someone
        // in the series has a user-picked thumbnail.)
        const lpPositionSec = lp ? files.getSingleFieldSync(lp.video.key, "positionSec") : undefined;
        const lpDurationSec = lp ? files.getSingleFieldSync(lp.video.key, "durationSec") : undefined;
        const watchedPct = (lpPositionSec && lpDurationSec && lpDurationSec > 0)
            ? Math.max(0, Math.min(100, (lpPositionSec / lpDurationSec) * 100))
            : 0;
        // Either the keyboard cursor is on this series, or it's elsewhere
        // and the mouse is on us. (When the keyboard cursor is on a
        // different cell we still want to suppress mouse hover so two
        // cells aren't expanded at once.)
        const expandOnHover = hoverExpandEnabled();
        const kbKey = keyboardHoveredKey.get();
        const ourKey = this.cellKey();
        const hovered = (expandOnHover && (
            kbKey === ourKey
            || (kbKey === undefined && this.synced.mouseHovered)
        )) || clickExpandedKey.get() === ourKey;
        const s = SIZES[gridSize.get()];
        // Detailed view — every cell statically expanded in the grid; see
        // GridCell for the full rationale. The series card is self-contained
        // (info + AddToList live inside it), so the expanded height is just
        // cardHoverH.
        const detailed = detailedGridView.get();
        const expanded = hovered || detailed;
        const popHover = hovered && !detailed;
        // Grid-state width: the parent may stretch it past s.slotW so a uniform
        // grid fills the row exactly. Hover/detailed keep s.hoverW.
        const slotW = this.props.slotWidth ?? s.slotW;
        const imgHoverH = Math.round(s.hoverW / this.aspectRatio());
        const cardHoverH = imgHoverH + s.titleH + s.infoH + HOVER_ADD_TO_LIST_H;
        const thumbUrl = thumbSourceKey
            ? pickThumbForDisplay(thumbSourceKey, s.hoverW)
            : undefined;

        const cardTop = popHover ? this.synced.topOffset : 0;
        const cardLeft = popHover ? this.synced.leftOffset : 0;
        const cardW = expanded ? s.hoverW : slotW;
        const cardH = expanded ? cardHoverH : s.slotH;
        const imgH = expanded ? imgHoverH : s.slotH;
        // Bottom-anchor — see GridCell for the rationale.
        const titleBottom = expanded ? s.infoH + HOVER_ADD_TO_LIST_H : 0;
        const infoTop = expanded ? imgHoverH + s.titleH : s.slotH;

        return <div
            ref={r => { this.slotRef = r; }}
            data-cell-key={`s:${series.parentPath}`}
            className={
                css.relative.flexShrink(0)
                + (detailed
                    ? css.size(s.hoverW, cardHoverH).overflowHidden
                    : css.size(slotW, s.slotH))
            }
        >
            <div
                ref={r => { this.cardRef = r; }}
                onMouseEnter={this.onEnter}
                onMouseLeave={this.onLeave}
                title={series.parentPath}
                className={
                    css.absolute.top(cardTop).left(cardLeft).size(cardW, cardH).zIndex(popHover ? 100 : 1)
                    + css.hsl(0, 0, 7).overflowHidden.transition(cardTransition())
                    + css.boxShadow(popHover ? "0 6px 24px hsla(0,0%,0%,0.7)" : "none")
                    + RS.GridCell
                }
            >
                <a
                    href={tileHref}
                    onMouseDown={this.onTileMouseDown}
                    onClick={this.onTileClick}
                    className={
                        css.absolute.top(0).left(0).width("100%").height(imgH)
                        + css.hsl(0, 0, 5).pointer.overflowHidden.transition(cardTransition())
                        + css.textDecoration("none").color("inherit").display("block")
                        + RS.GridCellThumb
                    }
                >
                    {thumbUrl ? <img
                        src={thumbUrl}
                        onLoad={this.onImgLoad}
                        // Always fill the container with object-fit:cover so
                        // the image scales smoothly with the (animating)
                        // container instead of snapping to a fixed pixel
                        // size the moment hovered flips. The hover container
                        // is sized to hoverW × hoverW/aspect, so cover stops
                        // cropping exactly when fully expanded — same final
                        // visual as before, but the transition is now
                        // genuinely "grow from the centre".
                        className={css.size("100%", "100%").display("block").objectFit("cover")}
                    /> : <div
                        className={
                            css.fillBoth.display("flex").alignItems("center").justifyContent("center")
                            + css.fontSize(12).color("hsl(0, 0%, 40%)")
                        }
                    >
                        (no thumbnail)
                    </div>}
                    {/* Top-left slot: expand "?" — shown only when
                      * hover-expand is off and this series isn't already
                      * click-expanded. Clicking the tile still drills in. */}
                    <div className={cellCornerTL}>
                        {!expandOnHover && !expanded && <button
                            onMouseDown={(e: MouseEvent) => {
                                e.stopPropagation();
                                e.preventDefault();
                                toggleClickExpanded(ourKey);
                            }}
                            onClick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); }}
                            title="Show actions and lists for this series"
                            className={cellExpandBtn}
                        >
                            ?
                        </button>}
                    </div>

                    {/* Top-right slot: list chips then the count badge
                      * (badge ends up at the corner). Clicking the badge
                      * forces the drill-in even when Fast-open Series is on,
                      * giving a way to see all videos without going to the
                      * player; stopPropagation so the tile's left-click
                      * (fast-open) doesn't also fire. */}
                    <div className={cellCornerTR}>
                        <GridTagChips itemKey={series.parentPath} />
                        {(() => {
                            // If any video in this series has a saved
                            // playback position, show "<position>/<total>"
                            // instead of just the total. Position is the
                            // 1-indexed slot of the last-played video in
                            // the alphabetically-sorted series.videos list
                            // (series.ts already sorts by name). This is
                            // also the video Fast-open Series plays — same
                            // lp lookup used by drillIn.
                            const total = series.videos.length;
                            const idx = lp ? series.videos.findIndex(v => v.key === lp.video.key) : -1;
                            const label = idx >= 0 ? `${idx + 1}/${total}` : `${total}`;
                            const title = idx >= 0
                                ? (fastOpenSeries.get()
                                    ? `${idx + 1} of ${total} — last played; click to bypass fast-open`
                                    : `${idx + 1} of ${total} — last played`)
                                : (fastOpenSeries.get()
                                    ? `Open ${total} videos in this series (bypass fast-open)`
                                    : `Open ${total} videos in this series`);
                            return <div
                                onMouseDown={(e: MouseEvent) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    this.drillInForce();
                                }}
                                onClick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); }}
                                title={title}
                                className={seriesCountBadge + RS.SeriesCount}
                            >
                                {label}
                            </div>;
                        })()}
                    </div>
                </a>
                <a
                    href={tileHref}
                    onMouseDown={this.onTileMouseDown}
                    onClick={this.onTileClick}
                    className={
                        cellPadTitle.absolute.bottom(titleBottom).left(0).width("100%")
                        + css.background("hsla(0, 0%, 0%, 0.6)").pointer.overflowHidden.transition(cardTransition())
                        + css.textDecoration("none").color("inherit").display("block")
                    }
                >
                    {watchedPct > 0 && <div
                        className={css.absolute.top(0).left(0).bottom(0).width(`${watchedPct}%`)
                            .background("hsla(0, 0%, 100%, 0.18)").pointerEvents("none") + RS.GridCellProgress}
                    />}
                    <div className={css.relative.zIndex(1).ellipsis.color("white").lineHeight("1.2").fontSize(s.fontSize) + RS.GridCellTitle}>
                        {series.parentPath}
                    </div>
                </a>
                <div
                    className={
                        cellPad.absolute.top(infoTop).left(0).width("100%").height(s.infoH).vbox(3)
                        + css.hsl(0, 0, 11).color("hsl(0, 0%, 82%)").fontSize(11)
                        + css.opacity(expanded ? 1 : 0).pointerEvents(expanded ? "auto" : "none")
                        + css.userSelect("text").cursor("default").overflowHidden.transition(cardTransition())
                        + RS.GridCellInfo
                    }
                >
                    <div>{series.videos.length} videos</div>
                    {lp && <div className={css.color("hsl(0, 0%, 60%)")} title={lp.video.relativePath}>
                        Last played: {lp.video.name}
                    </div>}
                </div>
                {expanded && <div
                    className={
                        css.absolute.top(infoTop + s.infoH).left(0).width("100%").height(HOVER_ADD_TO_LIST_H)
                        + css.hsl(0, 0, 9).opacity(expanded ? 1 : 0).transition(cardTransition())
                    }
                >
                    <AddToList itemKey={series.parentPath} itemType="series" />
                </div>}
            </div>
        </div>;
    }
}
