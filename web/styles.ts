// Shared styling. Anything used in more than one place — paddings, header
// chip looks, action button shells — lives here so a single edit retunes
// the whole app. Inline style props are forbidden across the codebase;
// every styling decision goes through this file and the css helper.

import { css } from "typesafecss";

// ────────────────────────────────────────────────────────────────────────
// Grid layout.
// ────────────────────────────────────────────────────────────────────────

// Gap (px) between grid cells, and the matching list-mode between-cell /
// between-list / series-row gaps. One source of truth so the main grid, list
// mode, and series rows stay in lockstep instead of being hand-synced.
export const GRID_GAP = 2;

// ────────────────────────────────────────────────────────────────────────
// Interactive control look — THE SINGLE SOURCE OF TRUTH for every button,
// selector, and clickable chip in the app. Every button is controlSurface
// (or a color variant of it) + controlPad. The ONLY things a button may
// change are its color (a variant defined beside the base) and its font
// size. Never the padding, never a bespoke per-place look.
// ────────────────────────────────────────────────────────────────────────

// Layered drop shadow + scale-up-on-hover / scale-down-on-press feedback.
export const controlMotion = css
    .transition("transform .14s ease, box-shadow .14s ease")
    .boxShadow("0 1px 2px rgba(0,0,0,.8), 0 4px 12px rgba(0,0,0,.7)")
    .transform("scale(1.04)", "hover")
    .boxShadow("0 2px 4px rgba(0,0,0,.9), 0 9px 22px rgba(0,0,0,.8)", "hover")
    .transform("scale(.96)", "active")
    .boxShadow("0 1px 2px rgba(0,0,0,.8)", "active");

// Neutral surface: dark fill, hairline border, square corners + the motion.
export const controlSurface = controlMotion
    .background("#24242a").color("#e8e8ea").bord(1, "#3a3a42")
    .fontWeight(500).lineHeight("1").fontFamily("inherit").pointer;

// Accent surface for the primary / active control in a group.
export const controlSurfaceAccent = controlSurface
    .background("hsl(220, 60%, 42%)").color("white").bord(1, "hsl(220, 50%, 58%)");

// Danger surface for destructive controls (delete / remove / unlink).
export const controlSurfaceDanger = controlSurface
    .background("hsl(0, 55%, 42%)").color("white").bord(1, "hsl(0, 50%, 58%)");

// THE button padding — the one value every button uses. 5px on the sides,
// 3px on the top/bottom. The 2 extra horizontal pixels exist ONLY to cancel
// the ~2px of optical padding text carries above/below the glyphs, so the
// result LOOKS evenly padded — a true 5px on every side. The goal is
// even-LOOKING padding. Never give a button a different padding.
const controlPad = css.pad2(5, 3).fontSize(13);

// ────────────────────────────────────────────────────────────────────────
// Paddings (non-button). typesafecss `pad2(horizontal, vertical)` → CSS
// `padding: vertical horizontal`. Button padding is controlPad above; these
// are container / badge paddings. Containers use equal padding on all sides.
// ────────────────────────────────────────────────────────────────────────

// Grid cell info panel — multi-line metadata block that shows on hover.
export const cellPad = css.pad2(8, 4);

// Title strip inside a grid cell. Stays uniform-but-small; the
// titleStripH math below depends on the vertical value matching.
export const cellPadTitle = css.pad2(4, 2);

const TITLE_PAD_FOR_HEIGHT = 2;
const TITLE_LINE_HEIGHT = 1.2;
export function titleStripH(fontSize: number): number {
    return Math.ceil(fontSize * TITLE_LINE_HEIGHT) + 2 * TITLE_PAD_FOR_HEIGHT;
}

// The cell info-panel buttons (Info / Thumb / Reparse). Same button look as
// everywhere else; only the font size is smaller.
export const cellActionBtn = controlSurface + controlPad.fontSize(11);

// Reparse-status pill that appears between buttons while a Reparse is
// in flight.
export const reparseStatusPill = css.fontSize(10).color("hsl(48, 85%, 70%)")
    .ellipsis.maxWidth(220).pad(3);

// ────────────────────────────────────────────────────────────────────────
// Cell corner overlays. The top corners of a grid/series cell host small
// badges and buttons (the expand "?", the extraction-error ⚠️, list-
// membership chips, the series count). Rather than have each badge
// absolutely position ITSELF — which forces every badge to know the size
// and position of every other one so they don't collide (a quadratic
// tangle of hard-coded offsets like `.left(32)` / `rightOffset`) — there
// is exactly ONE slot per corner, defined here. Each slot is an
// absolutely-positioned flex row; badges are plain flow children separated
// by a gap, so they pack automatically and never reference a sibling. The
// slot itself ignores pointer events; interactive / tooltip children opt
// back in (see `.pointerEvents("auto")` on the badge styles below).
// ────────────────────────────────────────────────────────────────────────
const cellCornerSlot = css.absolute.top(4).zIndex(4)
    .display("flex").alignItems("flex-start").gap(4)
    .pointerEvents("none");
// Top-left: expand "?" then extraction-error ⚠️ (source order, left→right).
export const cellCornerTL = cellCornerSlot.left(4);
// Top-right: list chips then the series count badge, packed against the
// right edge and wrapping onto new rows when there are many.
export const cellCornerTR = cellCornerSlot.right(4)
    .wrap.justifyContent("flex-end").maxWidth("70%");

// Persistent extraction-error indicator. Flows inside cellCornerTL.
export const extractionErrorBadge = css.pad2(5, 1).fontSize(14)
    .background("hsla(0, 0%, 0%, 0.75)").color("white").cursor("help")
    .pointerEvents("auto");

// "?" button shown in every grid/series cell when hover-expand is disabled.
// Clicking it expands the cell to the same view a hover would show (the
// reparse / pick-thumbnail / add-to-list stack). Flows inside cellCornerTL.
export const cellExpandBtn = css.size(24, 24).pad(0).border("none").pointer
    .display("inline-flex").alignItems("center").justifyContent("center")
    .fontSize(14).lineHeight("1")
    .background("hsla(0, 0%, 0%, 0.65)").color("hsl(0, 0%, 90%)")
    .hslahover(0, 0, 0, 0.85)
    .pointerEvents("auto");

// Header chip + chip-button baseline. Even-looking 5px gutter (3px vertical
// compensates for text's ~2px optical top/bottom padding).
export const chipPad = css.pad2(5, 3);

// ────────────────────────────────────────────────────────────────────────
// AddToList styling. Used in expanded grid cells, the info modal, and
// the player. Centralised so the look stays consistent.
// ────────────────────────────────────────────────────────────────────────

// Outer panel wrapping the input + list blocks. Even gutter around the chips.
export const listPanelPad = css.pad2(6, 6);

// The text field — minimal hairline-underline input.
export const listInputPad = css.pad2(4, 1);

// The list-block / create-tile chip. Even-looking 5px (3px vertical for text).
export const listTilePad = css.pad2(5, 3);

// Tiny "Tab" / "Enter" key hint badges.
export const listKeyBadgePad = css.pad2(4, 0);

// ────────────────────────────────────────────────────────────────────────
// Settings modal + List-mode rows. Reuse the same scale as the chips so
// the page feels uniform.
// ────────────────────────────────────────────────────────────────────────

export const settingsPanelPad = css.pad2(18, 10);

// One row in ListMode — list header. Tight vertical (less space than
// the list rows below) so the row reads as a divider, not a card.
export const listRowHeaderPad = css.pad2(10, 3);
// Stale-row placeholder when a list member no longer exists.
export const listStalePad = css.pad2(8, 2);

// Tag chip shown in the top-right corner of a grid cell — one per
// list the video belongs to. Sized small + low-vis so it doesn't
// fight the thumbnail.
export const gridTagPad = css.pad2(6, 1);

// ────────────────────────────────────────────────────────────────────────
// Chip looks. chipDim / chipWarn / chipScan / chipError are non-clickable
// status indicators (no button surface). The clickable chips reuse
// controlSurface so they match every other button — only their sizing
// (chipSize) differs.
// ────────────────────────────────────────────────────────────────────────

// Shared chip sizing — no color/look (that comes from controlSurface).
export const chipBase = chipPad.fontSize(11).minWidth(0).overflowWrap("break-word");
export const chipDim = chipBase.hsl(0, 0, 14).color("hsl(0, 0%, 78%)");
export const chipBtn = controlSurface + chipBase;
export const chipPrimary = controlSurfaceAccent + chipBase;
export const chipWarn = chipBase.hsl(40, 50, 25).color("hsl(40, 90%, 88%)");
export const chipScan = chipBase.hsl(120, 30, 14).color("hsl(120, 50%, 75%)");
export const chipError = chipBase.hsl(0, 60, 25).color("white");

// Very subtle uppercase label that heads each sidebar section. Low-contrast
// on purpose — it groups controls without competing with them.
// marginBottom(-1) pulls the title 1px closer to its section's controls
// (trims the vbox gap under just the title, not between the controls).
export const sidebarSectionTitle = css.fontSize(10).fontWeight(600)
    .letterSpacing("0.6px").textTransform("uppercase").color("hsl(0, 0%, 40%)")
    .marginBottom(-1);
// Gap between sidebar sections and gap inside a section (title → content).
export const SIDEBAR_SECTION_GAP = 18;
export const SIDEBAR_SECTION_INNER_GAP = 6;

// ────────────────────────────────────────────────────────────────────────
// Custom grid scrollbar. A wide vertical track on the right of the grid that
// distributes sort-aware labels (letters / dates) by their position in the
// full result list; the labels are clickable jumps and a draggable thumb
// reflects + drives scroll. Square corners; the native scrollbar is hidden.
// ────────────────────────────────────────────────────────────────────────
export const GRID_SCROLLBAR_W = 54;
// Minimum vertical px between two drawn labels so a dense run (many months,
// every letter) thins instead of overprinting.
export const GRID_SCROLLBAR_LABEL_MIN_GAP = 16;
// Width is applied by the component (GRID_SCROLLBAR_W plus any leftover px the
// grid couldn't evenly distribute into its cells, so the row stays flush).
export const gridScrollbarTrack = css.position("relative").flexShrink0
    .fillHeight.overflow("hidden")
    .borderLeft("1px solid hsl(0, 0%, 16%)").hsl(0, 0, 8).userSelect("none");
// The draggable position indicator. Sits behind the labels (which stay
// readable) as a faint translucent band.
export const gridScrollbarThumb = css.position("absolute").left(0).right(0)
    .background("hsla(220, 60%, 60%, 0.22)").borderTop("1px solid hsla(220, 60%, 70%, 0.5)")
    .borderBottom("1px solid hsla(220, 60%, 70%, 0.5)").pointer;
// One position label. Anchored by its vertical center at its index fraction.
export const gridScrollbarLabel = css.position("absolute").left(0).right(0)
    .textAlign("center").fontSize(10).lineHeight("1").color("hsl(0, 0%, 62%)")
    .pad2(2, 1).whiteSpace("nowrap").overflow("hidden").textOverflow("ellipsis")
    .pointer.color("white", "hover");

// ────────────────────────────────────────────────────────────────────────
// Button color variants. Each is the base look + controlPad; only the color
// differs (derived from controlSurface, never re-typed). Font size is the
// only other thing a variant may change.
// ────────────────────────────────────────────────────────────────────────

// Standard action button (management / dialog UIs).
export const actionBtn = controlSurface + controlPad;
// Accent button for the primary action in a section.
export const primaryBtn = controlSurfaceAccent + controlPad;
// Text input field — same surface colors, but no hover/press motion.
export const fieldInput = css.fillWidth.pad2(12, 8).fontSize(13).fontFamily("inherit")
    .lineHeight("1.3").background("#1a1a1f").color("#e8e8ea").bord(1, "#3a3a42");

// Small numeric input for the duration filter — sized for a couple of digits.
// Square corners; vertical padding trimmed for optical evenness. Extra right
// padding leaves room for the trailing × clear button.
export const durationInput = css.width(56).paddingLeft(5).paddingRight(15)
    .paddingTop(3).paddingBottom(3).fontSize(11).fontFamily("inherit")
    .lineHeight("1.3").textAlign("center").background("#1a1a1f").color("#e8e8ea")
    .bord(1, "#3a3a42");
// Wraps an input + its trailing × so the button can sit inside the field's edge.
export const durationInputWrap = css.position("relative").display("inline-flex")
    .alignItems("center");
// The × clear button pinned to the input's right edge.
export const durationClearBtn = css.position("absolute").right(2).top(0).bottom(0)
    .display("flex").alignItems("center").pad(0).border("none")
    .background("transparent").color("hsl(0, 0%, 50%)").fontSize(13).lineHeight("1")
    .pointer.color("white", "hover");
// The faint "–" separator between the two duration bounds.
export const durationLabel = css.fontSize(11).color("hsl(0, 0%, 70%)");

// Selector toggle — a row of mutually-exclusive options where exactly one is
// active. Pick the active or inactive look per option by selection state.
export const selectorBtn = controlSurface + controlPad;
export const selectorBtnActive = controlSurfaceAccent + controlPad;
// Destructive action button (delete / remove / unlink).
export const dangerBtn = controlSurfaceDanger + controlPad;

// Checkbox input. Apply to every <input type="checkbox"> so they restyle here.
export const checkboxInput = css.pointer;

// ────────────────────────────────────────────────────────────────────────
// Hey Google sidebar chip. Color encodes remote-control state: purple idle,
// green when controlling a device that's on, yellow when controlling one
// that's off, and a rotating rainbow border while actively being controlled.
// The rainbow animation needs the @property/@keyframes injected by
// HeyGoogleChip (CSS custom-property angle animation degrades to a static
// rainbow ring where @property is unsupported).
// ────────────────────────────────────────────────────────────────────────
export const hgChipPurple = controlSurface.background("hsl(280, 45%, 30%)").color("white").bord(1, "hsl(280, 45%, 42%)") + chipBase;
export const hgChipGreen = controlSurface.background("hsl(130, 50%, 28%)").color("white").bord(1, "hsl(130, 50%, 40%)") + chipBase;
export const hgChipYellow = controlSurface.background("hsl(45, 55%, 30%)").color("hsl(45, 95%, 90%)").bord(1, "hsl(45, 55%, 42%)") + chipBase;
export const hgChipControlled = controlMotion.fontWeight(500).lineHeight("1").fontFamily("inherit").pointer.color("white")
    .border("2px solid transparent")
    .background("linear-gradient(hsl(0,0%,12%), hsl(0,0%,12%)) padding-box, "
        + "conic-gradient(from var(--hg-angle, 0deg), "
        + "#ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30) border-box")
    .animation("hg-spin 2.5s linear infinite") + chipBase;

// ────────────────────────────────────────────────────────────────────────
// ListTile chrome — the bottom-right icon action stack (rename / drag-
// rearrange). Square icon-only overlay buttons (no text), so they're a size
// variant: fixed square, no text padding. Text states use a normal button.
// ────────────────────────────────────────────────────────────────────────

// Square action button at the bottom of the ListTile. Glyph centred via
// inline-flex so emojis sit on the visual middle, not the text baseline.
export const tileActionBtnBase = css.size(28, 28)
    .display("inline-flex").alignItems("center").justifyContent("center")
    .border("none").pad(0).fontSize(16).lineHeight("1").cursor("pointer")
    .color("hsl(0, 0%, 88%)");
export const tileActionBtn = tileActionBtnBase.background("hsla(0, 0%, 0%, 0.55)")
    .hslahover(0, 0, 0, 0.75);

// ────────────────────────────────────────────────────────────────────────
// Modal chrome. Black 70% backdrop + dark panel + close button.
// Modals using these still own their own content layout.
// ────────────────────────────────────────────────────────────────────────

export const modalBackdrop = css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
    .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
    .pad2(20, 20);
export const modalPanelBase = css.hsl(0, 0, 10).color("white")
    .bord(1, "hsl(0, 0%, 22%)").vbox(12);
export const modalHeaderRow = css.hbox(12).alignItems("center").flexShrink(0);
export const modalCloseBtn = controlSurface + controlPad.fontSize(12);

// ────────────────────────────────────────────────────────────────────────
// RearrangeTile — the simple thumbnail tile used inside a list's
// rearrange mode (no hover, no click-to-play, only drag).
// ────────────────────────────────────────────────────────────────────────

export const rearrangeTileWrap = css.relative.overflowHidden
    .display("flex").flexDirection("column").cursor("grab")
    .background("hsl(0, 0%, 7%)").bord(1, "hsl(0, 0%, 22%)");
export const rearrangeDragStripe = css.height(14).flexShrink(0)
    .display("flex").alignItems("center").justifyContent("center")
    .background("hsl(220, 50%, 22%)").borderBottom("1px solid hsl(220, 60%, 35%)")
    .color("hsl(220, 70%, 80%)").fontSize(11).letterSpacing("2px").userSelect("none");
export const rearrangeTitle = css.background("black").color("white")
    .lineHeight("1.2").whiteSpace("nowrap").overflowHidden
    .textOverflow("ellipsis").flexShrink(0);

// Drop-indicator line drawn between cells during rearrange drag.
// Lives as an absolute overlay on the source DragSlot so it doesn't
// take any layout space — sits in the inter-cell gap.
const dropLineBase = css.absolute.top(0).bottom(0).width(3).zIndex(5)
    .pointerEvents("none").background("hsl(220, 80%, 60%)");
export const dropLineBefore = dropLineBase.left(-3);
export const dropLineAfter = dropLineBase.right(-3);

// Series count badge — flows inside cellCornerTR (also used by the
// rearrange tile, which positions it itself).
export const seriesCountBadge = css.pad2(7, 2).fontSize(11).color("white")
    .cursor("pointer").background("hsla(220, 60%, 35%, 0.92)")
    .pointerEvents("auto");

// "In this list" tag chip — one per list, flows inside cellCornerTR.
export const gridTagChip = gridTagPad.fontSize(10).color("white")
    .ellipsis.maxWidth(140).background("hsla(0, 0%, 0%, 0.7)")
    .pointerEvents("auto");
