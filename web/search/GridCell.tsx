import * as preact from "preact";
import { observable, runInAction, reaction, IReactionDisposer } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import {
    files,
    characters,
    thumbnails,
    keyframes as keyframesDb,
    gridSize,
    keyboardHoveredKey,
    autoFlipPreview,
    previewCycleMs,
    accurateThumbnails,
    detailedGridView,
    hoverExpandEnabled,
    facesScanEnabled,
    keyframesCollectionAllowed,
    isExtracting,
    extractMetadataForKey,
    extractKeyframesForKey,
    showMediaIcons,
    FileRecord,
} from "../appState";
import { KEYFRAMES_VERSION } from "../MetadataExtractor";
import { goToPlayer, goToPlayerFromSeries, seriesPath } from "../router";
import { primeAudioContext } from "../player/AudioPlayback";
import {
    pickThumbForDisplay, formatDurationHM, formatBytes,
    findKeyframeAtOrBefore,
} from "../scan/thumbnails";
import { decodeKeyframes2, getKeyframes2BlobUrls } from "../scan/keyframes2";
import {
    cellPad, cellPadTitle, extractionErrorBadge, cellExpandBtn,
    cellActionBtn, reparseStatusPill, cellCornerTL, cellCornerTR,
    mediaIconBadge,
} from "../styles";
import { RS } from "../restyle/classNames";
import {
    showFaces, getFaceSearchEmbedding, setFaceSearch,
    getCharacterKeysForFileSync, getClosestCharacterSync, SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { extractFacesForKey } from "../faces/faceExtraction";
import { FaceAvatar } from "../faces/FaceAvatar";
import { l2Distance } from "../faceEmbed/arcface";
import { GridTagChips } from "./GridTagChips";
import { AddToList } from "../lists/AddToList";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { openThumbnailPicker } from "../modals/ThumbnailPickerModal";
import { formatTime } from "socket-function/src/formatting/format";
import {
    GridSizing, SIZES, EDGE_MARGIN, HOVER_ADD_TO_LIST_H, FACE_STRIP_PAD,
    hoverFaceSize, faceWidth, faceHeight, faceStripH, hoverFaceStripH,
    isPlainLeftClick, buildPlayerHref, cardTransition,
    mouseHoveredCellKey, clickExpandedKey,
    registerHoverGeometry, unregisterHoverGeometry, toggleClickExpanded,
} from "./gridShared";

// Each cell is its own @observer so a single thumbnail/metadata write only
// re-renders that one cell.
@observer
export class GridCell extends preact.Component<{ record: Pick<FileRecord, "key" | "name" | "relativePath" | "size">; highlighted?: boolean; slotWidth?: number }> {
    cardRef: HTMLDivElement | null = null;
    // The OUTER wrapper that holds the slot's footprint. Always at
    // the slot position because it's not position:absolute — unlike
    // the inner card, whose top/left animate. updateHoverGeometry
    // measures from this so a still-running hover-out transition
    // (or any other in-flight card animation) doesn't bleed into the
    // computed offsets.
    slotRef: HTMLDivElement | null = null;
    synced = observable({
        // Mouse-driven hover state now lives in the module-level
        // mouseHoveredCellKey observable — see installMouseTracker.
        // Keyboard hover is derived from keyboardHoveredKey.get() ===
        // this key (see render below).
        topOffset: 0,
        leftOffset: 0,
        // Index of the currently-displayed frame from the keyframe preview
        // strip. Advances via a 4 FPS interval when we're cycling.
        previewIdx: 0,
        // True while the Reparse button is mid-flight (both extract phases).
        reparsing: false,
        // Latest worker-heartbeat string for the current reparse — ~once
        // per 10s while a phase is running. Cleared when reparse ends.
        // Not persisted; just for the in-cell status line.
        reparseStatus: "" as string,
        // Actual rendered image dimensions, captured from the <img> via its
        // load event. Authoritative source of aspect ratio for sizing the
        // hover card so there's no empty space below the image when the
        // stored thumbW/thumbH don't match (e.g. old data, mid-rescan).
        imgNaturalW: 0,
        imgNaturalH: 0,
    });

    private onImgLoad = (e: Event) => {
        // Card geometry follows the base thumbnail only. The cycling preview
        // frames can have a different aspect (they're letterbox-cropped), so
        // letting them drive imgNaturalW/H would resize the card on every
        // frame — cycling must be a pure src swap, nothing more.
        if (this.thumbIsKeyframe) return;
        const img = e.currentTarget as HTMLImageElement;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            runInAction(() => {
                this.synced.imgNaturalW = img.naturalWidth;
                this.synced.imgNaturalH = img.naturalHeight;
            });
        }
    };
    // True while the displayed image is a keyframe-preview frame (cycling or
    // accurate-thumb), not the saved thumbnail. Set in render, read by onImgLoad.
    private thumbIsKeyframe = false;
    private kbReaction: IReactionDisposer | undefined;
    private cycleReaction: IReactionDisposer | undefined;
    private cycleTimer: number | undefined;

    componentDidMount() {
        // Register so the global mouse tracker can recompute our
        // hover geometry the instant the mouse enters our subtree.
        registerHoverGeometry(this.props.record.key, this);
        // Recompute geometry whenever the keyboard-nav target becomes us.
        this.kbReaction = reaction(
            () => keyboardHoveredKey.get() === this.props.record.key,
            isOurs => { if (isOurs) this.updateHoverGeometry(); },
        );
        // Start/stop the preview cycle based on whether the cell wants to
        // animate: either it's hovered (mouse or keyboard), or auto-flip is
        // globally enabled.
        // Track the delay too (only while cycling, via short-circuit) so a
        // change to previewCycleMs restarts the timer at the new speed live.
        this.cycleReaction = reaction(
            () => this.shouldCycle() && previewCycleMs.get(),
            () => this.setCycling(this.shouldCycle()),
            { fireImmediately: true },
        );
    }

    componentWillUnmount() {
        unregisterHoverGeometry(this.props.record.key, this);
        if (this.kbReaction) this.kbReaction();
        if (this.cycleReaction) this.cycleReaction();
        this.stopCycle();
    }

    private shouldCycle(): boolean {
        // While keyboard nav is active, the keyboard cursor is the *only*
        // expanded cell. Mouse hover is suppressed so we never have two
        // cells expanded at once.
        const kbKey = keyboardHoveredKey.get();
        const isHovered = kbKey !== undefined
            ? kbKey === this.props.record.key
            : mouseHoveredCellKey.get() === this.props.record.key;
        return isHovered || autoFlipPreview.get();
    }

    private setCycling(active: boolean) {
        if (active) {
            // Reset index to 0 each time cycling starts so a fresh hover
            // begins at the start of the strip.
            runInAction(() => { this.synced.previewIdx = 0; });
            this.stopCycle();
            this.cycleTimer = window.setInterval(() => {
                runInAction(() => { this.synced.previewIdx = this.synced.previewIdx + 1; });
            }, previewCycleMs.get());
        } else {
            this.stopCycle();
        }
    }

    private stopCycle() {
        if (this.cycleTimer !== undefined) {
            window.clearInterval(this.cycleTimer);
            this.cycleTimer = undefined;
        }
    }

    private aspectRatio(): number {
        // Prefer the *actually rendered* image dimensions — captured via
        // the img's load event. That way the hover card sizes itself to
        // exactly what the user is going to see, regardless of whether the
        // stored thumbW/thumbH happen to match (they may not for legacy
        // data, mid-rescan, etc.).
        const nw = this.synced.imgNaturalW;
        const nh = this.synced.imgNaturalH;
        if (nw > 0 && nh > 0) return nw / nh;
        const k = this.props.record.key;
        const tw = thumbnails.getSingleFieldSync(k, "thumbW");
        const th = thumbnails.getSingleFieldSync(k, "thumbH");
        if (tw && th && tw > 0 && th > 0) return tw / th;
        const w = files.getSingleFieldSync(k, "width");
        const h = files.getSingleFieldSync(k, "height");
        if (w && h && w > 0 && h > 0) return w / h;
        return 16 / 9;
    }

    private hoverCardHeight(s: GridSizing): number {
        // Just the visible "tile" (thumbnail). The face strip rides on
        // top via stripH at render time; the bottom info + AddToList
        // block is a sibling sized by flow content, so it's not part of
        // what we centre on.
        return Math.round(s.hoverW / this.aspectRatio());
    }

    // Called by the global mousemove handler (when this cell becomes the
    // one under the cursor) and by the keyboard-arrives-here reaction.
    // Public so the cell registry can call it on the rising edge of
    // hover — must run before the card's first hovered render so the
    // initial top/left are correct and the card grows from the centre.
    public updateHoverGeometry(): void {
        const measure = this.slotRef ?? this.cardRef;
        if (!measure) return;
        const rect = measure.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const s = SIZES[gridSize.get()];
        const cardH = this.hoverCardHeight(s);
        // Rough estimate of the sibling info+AddToList block below the
        // card — used only for the bottom-edge clamp so the chrome
        // doesn't get pushed off the viewport on small screens. Actual
        // content height is flow-driven and not known here.
        const bottomChromeEst = 200;

        // Clamp against the scroll container's edges (not the viewport) so a
        // popped card avoids the sidebar the same way it avoids the page edge
        // — the container starts at the sidebar boundary, so cards never shift
        // under it.
        const scrollContainer = measure.closest("[data-grid-scroll]") as HTMLElement | null;
        const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : null;
        const upperBound = (containerRect ? containerRect.top : 0) + EDGE_MARGIN;
        const leftBound = (containerRect ? containerRect.left : 0) + EDGE_MARGIN;
        const rightBound = (containerRect ? containerRect.right : vw) - EDGE_MARGIN;

        // Centre the (fixed-size) hover card over the cell's *actual* slot
        // footprint — which may be stretched a few px wider than s.slotW so the
        // grid fills the row flush — so it grows from the middle either way.
        let topOffset = -(cardH - rect.height) / 2;
        let leftOffset = -(s.hoverW - rect.width) / 2;

        const top = rect.top + topOffset;
        const bottom = top + cardH + bottomChromeEst;
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

    // Hover is read from the global mouseHoveredCellKey observable now —
    // see installMouseTracker / registerHoverGeometry above. No per-cell
    // mouseenter/mouseleave handlers.

    private navigate = () => {
        primeAudioContext();
        // If the user reached this video via the drilled series view, carry
        // that breadcrumb to the player as `from_series` so the player can
        // show the series UI (count, prev/next, autoplay next).
        const sp = seriesPath.value;
        if (sp) goToPlayerFromSeries(this.props.record.key, sp);
        else goToPlayer(this.props.record.key);
    };

    // Plain left-click: snappy SPA nav on mousedown. Anything else
    // (right-click, middle-click, ctrl/cmd/shift+click) is ignored
    // here so the anchor's href can do the browser-native thing.
    private onCellMouseDown = (e: MouseEvent) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        this.navigate();
    };
    // Block the anchor's default href follow on plain left-click —
    // we already navigated above. Modified clicks are left alone.
    private onCellClick = (e: MouseEvent) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
    };

    // ────────────────────────────────────────────────────────────────────
    // !! REPARSE: must run EVERY extraction phase the project has for the
    // file. If a new extraction phase is added (faces was the last one;
    // a future phase might be transcripts / audio fingerprints / etc.)
    // you MUST also wire it in here. Forgetting is silent — the new phase
    // just never gets a single-file path.
    //
    // Current phases (in order): metadata + thumbnails, keyframe-preview
    // strip, faces. Reparse runs them sequentially against the current
    // file regardless of cache versions — it's the explicit "redo
    // everything" path.
    // ────────────────────────────────────────────────────────────────────
    private reparse = async () => {
        const key = this.props.record.key;
        if (this.synced.reparsing) return;
        runInAction(() => {
            this.synced.reparsing = true;
            this.synced.reparseStatus = "";
        });
        // Same throttled heartbeat that drives the scan-loop console
        // log; here we also mirror it into the synced state so the cell
        // can show what the worker is on.
        const onProgress = (phase: string) => (info: { message: string }) => {
            console.log(`[reparse ${phase}] ${key}: ${info.message}`);
            runInAction(() => { this.synced.reparseStatus = `${phase}: ${info.message}`; });
        };
        try {
            runInAction(() => { this.synced.reparseStatus = "metadata…"; });
            await extractMetadataForKey(key);
            runInAction(() => { this.synced.reparseStatus = "keyframes…"; });
            await extractKeyframesForKey(key, onProgress("keyframes"));
            // Skip face extraction if the user has it disabled in
            // Settings — same kill-switch as the background phase.
            // Other reparse phases (metadata, keyframes) still run
            // since they're cheap and always wanted.
            if (facesScanEnabled.get()) {
                runInAction(() => { this.synced.reparseStatus = "faces…"; });
                await extractFacesForKey(key, onProgress("faces"));
            }
        } finally {
            runInAction(() => {
                this.synced.reparsing = false;
                this.synced.reparseStatus = "";
            });
        }
    };

    render() {
        const { record } = this.props;
        const key = record.key;

        // Reactive reads — refresh when the DB updates.
        const durationSec = files.getSingleFieldSync(key, "durationSec");
        const w = files.getSingleFieldSync(key, "width");
        const h = files.getSingleFieldSync(key, "height");
        const videoCodec = files.getSingleFieldSync(key, "videoCodec");
        const audioCodec = files.getSingleFieldSync(key, "audioCodec");
        const fileModifiedAt = files.getSingleFieldSync(key, "fileModifiedAt");
        const addedAt = files.getSingleFieldSync(key, "addedAt");
        const extractionMs = files.getSingleFieldSync(key, "metadataExtractionMs");
        const extractionError = files.getSingleFieldSync(key, "extractionError");
        const positionSec = files.getSingleFieldSync(key, "positionSec");
        // Media-presence corner icons (opt-in setting). Faces are cheap
        // (characterCount is an already-loaded files column). Keyframes are
        // gated — reading the version column forces the multi-MB stream-file
        // load — so only touch it when the master gate is open.
        const iconsOn = showMediaIcons.get();
        const hasFacesIcon = iconsOn && (files.getSingleFieldSync(key, "characterCount") ?? 0) > 0;
        const hasKeyframesIcon = iconsOn && keyframesCollectionAllowed()
            && keyframesDb.getSingleFieldSync(key, "keyframesVersion") === KEYFRAMES_VERSION;
        const watchedPct = (positionSec && durationSec && durationSec > 0)
            ? Math.max(0, Math.min(100, (positionSec / durationSec) * 100))
            : 0;
        const extracting = isExtracting(key);

        // See shouldCycle — keyboard nav suppresses mouse hover so only
        // one cell is ever visually expanded.
        const kbKey = keyboardHoveredKey.get();
        const isFocused = kbKey !== undefined
            ? kbKey === key
            : mouseHoveredCellKey.get() === key;
        // Master "expand on hover" switch from Settings. When off, the
        // cell stays at slot size until its "?" button is clicked, which
        // click-expands it (clickExpandedKey) to the same view hover shows.
        // Face mode forces it off regardless: the avatar strip is what the
        // user is aiming for, and a cell that grows out from under the
        // cursor makes the faces hard to click.
        const expandOnHover = hoverExpandEnabled() && !showFaces.get();
        const hovered = (expandOnHover && isFocused) || clickExpandedKey.get() === key;
        const s = SIZES[gridSize.get()];
        // Detailed view: every cell renders statically in its expanded form,
        // laid out in the grid at the hover (2×) size. `expanded` drives the
        // content (big thumb, full face strip, info/actions block); `popHover`
        // is the absolute pop-over, suppressed in detailed mode so cells sit
        // in flow instead of jumping over their neighbours.
        const detailed = detailedGridView.get();
        const expanded = hovered || detailed;
        const popHover = hovered && !detailed;
        // Grid-state width: the parent may stretch it a few px past s.slotW so
        // a uniform grid fills the row exactly. Hover/detailed keep s.hoverW.
        const slotW = this.props.slotWidth ?? s.slotW;
        const facesOn = showFaces.get();
        // Pull the per-file characters here (instead of inside the
        // face strip render) so we can drop the strip's reserved
        // height when there's nothing to show. Without this, a video
        // with face mode on but no detected characters reserved a
        // dark empty band the height of the avatar row.
        const charKeysForFile = facesOn ? getCharacterKeysForFileSync(key) : [];
        const hasFaceContent = charKeysForFile.length > 0;
        const baseStripH = hasFaceContent ? faceStripH(s) : 0;
        const hoverStripH = hasFaceContent ? hoverFaceStripH(s) : 0;
        const stripH = expanded ? hoverStripH : baseStripH;

        const imgHoverH = Math.round(s.hoverW / this.aspectRatio());
        // Card now only owns the thumbnail + face strip — info / AddToList
        // are a sibling block sized by flow content. Keeping the card
        // small means the hover footprint matches the visible "tile"
        // the user is looking at, not a rectangle the size of the
        // text section that's just appended below.
        const cardHoverH = imgHoverH + hoverStripH;

        // Thumbnail selection — three sources, in priority order:
        //  1. Cycling preview: when this cell is hovered or auto-flip is on
        //     AND a keyframe strip exists, show the rotating frame.
        //  2. Accurate-thumbnail mode: when the option is on AND the user
        //     has a saved position AND we have a keyframe strip, show the
        //     nearest keyframe at-or-before that position.
        //  3. Plain saved thumbnail (160 / 320 / 640).
        //
        // The keyframes BLOB is several MB per video — only touch it
        // when we're actually going to draw a keyframe AND the master
        // gate is open (setting on + storage local + probe resolved).
        // Reading it on every visible cell triggers the keyframes
        // collection's stream-file load on first paint, pulling tens
        // of MB the user never sees.
        const wantKeyframes = keyframesCollectionAllowed() && (
            this.shouldCycle()
            || (accurateThumbnails.get() && positionSec !== undefined && positionSec > 0)
        );
        const keyframeBytes = wantKeyframes ? keyframesDb.getSingleFieldSync(key, "keyframes2") : undefined;
        const keyframeData = decodeKeyframes2(keyframeBytes);
        const keyframeUrls = (keyframeBytes && keyframeData && keyframeData.complete && keyframeData.count > 0)
            ? getKeyframes2BlobUrls(keyframeBytes, keyframeData.offsets)
            : undefined;
        let thumbUrl: string | undefined;
        let usingKeyframe = false;
        if (keyframeUrls && this.shouldCycle()) {
            thumbUrl = keyframeUrls[this.synced.previewIdx % keyframeUrls.length];
            usingKeyframe = true;
        } else if (keyframeUrls && accurateThumbnails.get() && positionSec && positionSec > 0 && keyframeData) {
            const idx = findKeyframeAtOrBefore(keyframeData.times, positionSec);
            if (idx >= 0) {
                thumbUrl = keyframeUrls[idx];
                usingKeyframe = true;
            }
        }
        this.thumbIsKeyframe = usingKeyframe;
        // Use the hover width when selecting the thumbnail even in grid
        // state — the larger thumb still downscales cleanly in the small
        // slot, and using one URL for both states means hovering doesn't
        // visibly switch images / quality.
        if (!thumbUrl) thumbUrl = pickThumbForDisplay(key, s.hoverW);

        // Reserved height for the detailed-view bottom block (info + actions
        // + AddToList). Matches the SeriesCell reservation so the two cell
        // types line up to the same height in a mixed grid.
        const detailBottomH = s.infoH + HOVER_ADD_TO_LIST_H;

        // Geometry — all dimensions transition smoothly between states.
        const cardTop = popHover ? this.synced.topOffset : 0;
        const cardLeft = popHover ? this.synced.leftOffset : 0;
        const cardW = expanded ? s.hoverW : slotW;
        const cardH = expanded ? cardHoverH : (s.slotH + baseStripH);
        const imgH = expanded ? imgHoverH : s.slotH;
        // The hover-only bottomUI sibling sits directly below the
        // card. Track the card's bottom edge with a transition on
        // top so the block follows the card as it grows.
        const bottomUITop = cardTop + cardH;

        // Per face-search results: the closest character (regardless of
        // threshold) gets floated to the front of the strip; only the
        // ones actually within SAME_CHARACTER_THRESHOLD get the gold
        // ring. Distance to the search embedding is also pulled per
        // avatar so the title-tooltip can surface it.
        const fs = getFaceSearchEmbedding();
        let closestCharIdx: number | undefined;
        if (fs) {
            const match = getClosestCharacterSync(key, fs);
            if (match) closestCharIdx = match.characterIdx;
        }

        return <div
            ref={r => { this.slotRef = r; }}
            data-cell-key={key}
            className={
                css.relative.flexShrink(0)
                + (detailed
                    ? css.size(s.hoverW, cardHoverH + detailBottomH).overflowHidden
                    : css.size(slotW, s.slotH + baseStripH))
            }
        >
            {/* The CARD — animates position + size. Holds the thumbnail,
              * the title overlay, the face strip, and the corner chrome
              * (chips, error badge, cogwheel). Everything inside it
              * either fills the card or is absolutely placed on it
              * because it needs to animate with the card. */}
            <div
                ref={r => { this.cardRef = r; }}
                title={record.relativePath}
                className={
                    css.absolute.top(cardTop).left(cardLeft).size(cardW, cardH).zIndex(popHover ? 100 : 1)
                    + css.hsl(0, 0, 7).overflowHidden.transition(cardTransition())
                    + css.boxShadow(popHover ? "0 6px 24px hsla(0,0%,0%,0.7)" : "none")
                    + (this.props.highlighted
                        ? css.boxShadow("inset 0 0 0 2px hsl(220, 80%, 55%)")
                        : css)
                    + RS.GridCell
                }
            >
                {/* Image area — an <a> so right-click → "Open in new tab"
                  * and middle-click → background tab work natively. Plain
                  * left-clicks are intercepted in onCellMouseDown for a
                  * snappy SPA navigation; the href is the same URL the
                  * navigate() call would produce. Animates with the card;
                  * object-fit:cover handles the slot → hover aspect-ratio
                  * change without snap. */}
                <a
                    href={buildPlayerHref(key, { fromSeriesPath: seriesPath.value || undefined })}
                    onMouseDown={this.onCellMouseDown}
                    onClick={this.onCellClick}
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
                        className={css.size("100%", "100%").display("block").objectFit("cover")}
                    /> : <div
                        className={
                            css.fillBoth.display("flex").alignItems("center").justifyContent("center")
                            + css.fontSize(12).color(extracting ? "hsl(40, 80%, 70%)" : "hsl(0, 0%, 40%)")
                        }
                    >
                        {extracting ? "Generating…" : "(no thumbnail)"}
                    </div>}

                    {/* Title strip — pinned to the image's bottom edge in
                      * both states. Lives inside the image div so it
                      * naturally tracks imgH as the image grows. */}
                    <div
                        className={
                            css.absolute.bottom(0).left(0).width("100%")
                            + css.background("hsla(0, 0%, 0%, 0.6)").overflowHidden
                        }
                    >
                        {watchedPct > 0 && <div
                            className={css.absolute.top(0).left(0).bottom(0).width(`${watchedPct}%`)
                                .background("hsla(0, 0%, 100%, 0.18)").pointerEvents("none") + RS.GridCellProgress}
                        />}
                        <div
                            className={
                                cellPadTitle.relative.zIndex(1).ellipsis
                                + css.color("white").lineHeight("1.2").fontSize(s.fontSize)
                                + RS.GridCellTitle
                            }
                        >
                            {record.name}
                        </div>
                    </div>

                    {/* Top-left slot: expand "?" then extraction-error ⚠️.
                      * The "?" shows only when hover-expand is off and the
                      * cell isn't already click-expanded. Layout (gap, no
                      * overlap) is owned by cellCornerTL. */}
                    <div className={cellCornerTL}>
                        {!expandOnHover && !expanded && <button
                            onMouseDown={(e: MouseEvent) => {
                                e.stopPropagation();
                                e.preventDefault();
                                toggleClickExpanded(key);
                            }}
                            onClick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); }}
                            title="Show info, actions, and lists for this video"
                            className={cellExpandBtn}
                        >
                            ?
                        </button>}
                        {extractionError && <div title={extractionError} className={extractionErrorBadge}>
                            ⚠️
                        </div>}
                        {hasKeyframesIcon && <div title="Has extracted keyframes" className={mediaIconBadge}>
                            🎞️
                        </div>}
                        {hasFacesIcon && <div title="Has detected faces" className={mediaIconBadge}>
                            🙂
                        </div>}
                    </div>

                    {/* Top-right slot: list-membership chips. */}
                    <div className={cellCornerTR}>
                        <GridTagChips itemKey={key} />
                    </div>
                </a>

                {/* Face strip — sits below the image, inside the card.
                  * Height animates between baseStripH and hoverStripH so
                  * the avatars grow as the card grows. Only rendered when
                  * the file actually has characters. */}
                {hasFaceContent && <div
                    className={
                        css.absolute.top(imgH).left(0).width("100%").height(stripH)
                            .hbox(3).alignItems("center").padh(FACE_STRIP_PAD)
                        + css.hsl(0, 0, 9).overflowHidden.transition(cardTransition())
                    }
                >
                    {(() => {
                        // Score by centroid distance only when a face search is
                        // active — that's the only field we need to read off the
                        // (heavy) embedding column here; everything else is read
                        // lazily by the avatar / its handlers.
                        const scored = charKeysForFile.map(ck => {
                            if (!fs) return { ck, d: undefined as number | undefined };
                            const centroid = characters.getSingleFieldSync(ck.key, "centroid");
                            const d = centroid ? l2Distance(centroid, fs) : Infinity;
                            return { ck, d };
                        });
                        if (fs) {
                            scored.sort((a, b) => (a.d as number) - (b.d as number));
                        }
                        return scored
                            .slice(0, expanded ? s.facesPerHoverStrip : s.facesPerStrip)
                            .map(({ ck, d }) => {
                                const isMatch = d !== undefined && d < SAME_CHARACTER_THRESHOLD;
                                const distLabel = d !== undefined ? ` · distance ${d.toFixed(2)}` : "";
                                const memberCount = characters.getSingleFieldSync(ck.key, "memberCount") ?? 0;
                                return <FaceAvatar
                                    key={ck.key}
                                    characterKey={ck.key}
                                    size={expanded ? hoverFaceSize(s) : faceWidth(s)}
                                    height={expanded ? undefined : faceHeight(s)}
                                    highlighted={isMatch}
                                    title={`${memberCount} faces${distLabel} · click to search`}
                                    onClick={async () => {
                                        const emb = await characters.getSingleField(ck.key, "bestFaceEmbedding");
                                        if (!emb) return;
                                        setFaceSearch(emb);
                                    }}
                                />;
                            });
                    })()}
                </div>}
            </div>

            {/* Bottom UI — sibling of the card. Renders only when
              * hovered. Position absolute so its top can track the
              * card's bottom edge with the same animated values; the
              * INSIDE is plain flow layout so info content and the
              * AddToList row both grow naturally from their content. */}
            {expanded && <div
                data-cell-key={key}
                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                className={
                    css.absolute.top(bottomUITop).left(cardLeft).width(cardW).zIndex(popHover ? 100 : 1)
                    + css.hsl(0, 0, 11).color("hsl(0, 0%, 82%)").fontSize(11)
                    + css.boxShadow(popHover ? "0 6px 24px hsla(0,0%,0%,0.7)" : "none")
                    + css.transition(cardTransition())
                    + RS.GridCellInfo
                }
            >
                <div className={cellPad + css.vbox(3) + css.userSelect("text").cursor("default")}>
                    <div>
                        {durationSec !== undefined && <span>{formatDurationHM(durationSec)}</span>}
                        {w && h && <span className={css.marginLeft(durationSec !== undefined ? 8 : 0)}>{w}×{h}</span>}
                        {record.size !== undefined && <span className={css.marginLeft(8)}>{formatBytes(record.size)}</span>}
                    </div>
                    {(videoCodec || audioCodec) && <div className={css.color("hsl(0, 0%, 60%)")}>
                        {videoCodec && `video: ${videoCodec}`}
                        {videoCodec && audioCodec && " · "}
                        {audioCodec && `audio: ${audioCodec}`}
                    </div>}
                    {(addedAt || fileModifiedAt) && <div className={css.color("hsl(0, 0%, 60%)")}>
                        {addedAt && `added: ${new Date(addedAt).toLocaleDateString()}`}
                        {addedAt && fileModifiedAt && " · "}
                        {fileModifiedAt && `modified: ${new Date(fileModifiedAt).toLocaleDateString()}`}
                    </div>}
                    {/* ~1 line of breathing room between the meta block
                      * and the extraction time + action buttons. */}
                    <div className={css.height(14)} />
                    <div className={css.hbox(0).alignItems("center").fillWidth.color("hsl(0, 0%, 50%)")}>
                        <span>{extractionMs !== undefined && `extracted in ${formatTime(extractionMs)}`}</span>
                        <div className={css.hbox(4).marginLeft("auto")}>
                            <button
                                className={cellActionBtn}
                                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                                onClick={(e: MouseEvent) => {
                                    e.stopPropagation();
                                    openVideoInfo(key);
                                }}
                                title="Show all info"
                            >
                                Info
                            </button>
                            <button
                                className={cellActionBtn}
                                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                                onClick={(e: MouseEvent) => {
                                    e.stopPropagation();
                                    openThumbnailPicker(key);
                                }}
                                title="Pick a custom thumbnail from the video's keyframes"
                            >
                                Thumb
                            </button>
                            {this.synced.reparsing && this.synced.reparseStatus && <div
                                className={reparseStatusPill}
                                title={this.synced.reparseStatus}
                            >
                                {this.synced.reparseStatus}
                            </div>}
                            <button
                                className={cellActionBtn}
                                disabled={extracting || this.synced.reparsing}
                                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                                onClick={(e: MouseEvent) => {
                                    e.stopPropagation();
                                    void this.reparse();
                                }}
                                title="Re-run metadata + thumbnail + keyframe extraction for this file"
                            >
                                {(extracting || this.synced.reparsing) ? "…" : "Reparse"}
                            </button>
                        </div>
                    </div>
                </div>
                <AddToList itemKey={key} itemType="video" />
            </div>}
        </div>;
    }
}
