// Raw CSS for the built-in themes. These target only the stable class names in
// `classNames.ts` (RS / RS_NAMES) and touch look only — color, background,
// border, shadow, font — never layout. They live in <body> via ThemeStyle.tsx,
// so plain selectors override typesafecss's <head> rules by document order.
//
// Rather than hand-write ~60 selectors per theme (and miss some — which is
// exactly what happened the first time), each theme is a flat Palette fed
// through buildTheme(). Adding a surface hook to classNames.ts means adding one
// line here, and every theme covers it for free. Per-theme flair (neon glow,
// glass gloss) rides along in the optional shadow / font fields.

interface Palette {
    // Big surfaces.
    bg: string;            // Page (whole-window background; may be a gradient)
    panel: string;         // Sidebar / Header / Modal / PlayerBar / Toast / Card / ListPanel
    panelBorder: string;
    surface: string;       // GridCell / ListRow / ListItem / Surface / settings rows
    surfaceBorder: string;
    // Text.
    text: string;
    muted: string;
    accent: string;        // Sidebar-title / Modal-title / ListHeader / Accent
    titleShadow?: string;  // text-shadow on titles + accents (neon themes)
    font?: string;         // optional font-family that defines the theme's character
    // Inputs.
    input: string;
    inputText: string;
    inputBorder: string;
    placeholder: string;
    // Buttons.
    btn: string;
    btnText: string;
    btnBorder: string;
    btnHover: string;
    btnShadow?: string;    // box-shadow on buttons (gloss / glow)
    // Emphasis.
    primary: string;       // Button--primary / Chip--primary / SeriesCount
    primaryText: string;
    primaryBorder: string;
    active: string;        // Button--active / Chip
    activeText: string;
    // Chips & small pills.
    chip: string;          // Chip / Chip--dim / GridTag / KeyHint
    chipText: string;
    chipBorder: string;
    // State colors.
    warn: string; warnText: string;
    scan: string; scanText: string;
    error: string; errorText: string;
    heygoogle: string; heygoogleText: string;
    // Accents / misc.
    progress: string;      // GridCell-progress / PlayerBar-seek
    scrollThumb: string;
    thumb: string;         // GridCell-thumb letterbox fill
    dotOn: string;
    avatarBorder: string;
    modalShadow: string;
    backdrop: string;      // Modal-backdrop
    // Hover feedback for interactive surfaces. The base look uses a fixed
    // dark-gray hover tint, which reads wrong on light themes — a CSS filter
    // works regardless of the underlying (possibly gradient) color. Light
    // themes darken slightly; dark themes lighten.
    hoverFilter?: string;
    // A CSS-generated backdrop layered over `bg` on the whole page (themed grid
    // wallpaper — grids, scanlines, bubbles, dots). Layered backgrounds, so put
    // the pattern first and `bg` paints underneath. Users can override with their
    // own `.Page { background: … }` in the restyling editor.
    pattern?: string;
    // A real wallpaper scene (SVG data-URI from backgrounds.ts) painted across
    // the whole page AND the sidebar/header — `cover`, `fixed` so the sidebar
    // shows the same viewport-anchored slice and the scene reads as continuous.
    // When the user disables theme backgrounds, the page falls back to `bg`.
    bgImage?: string;
    // Translucent tint layered over `bgImage` on the sidebar/header so text stays
    // legible on top of a busy scene. Required (legibility) when bgImage is set.
    bgOverlay?: string;
    // Custom mouse cursor for the whole app (keyword or url(...) data-URI).
    cursor?: string;
    // Cursor for interactive elements (buttons/links). Defaults to `cursor` so
    // the themed pointer stays consistent instead of reverting to the UA hand.
    pointerCursor?: string;
    // When set, an animated conic-gradient "trace line" races around the border
    // of key elements. The value is the conic-gradient colour stops after the
    // angle, e.g. "transparent 55%, hsl(182, 100%, 72%) 80%, hsl(320, 100%, 59%) 100%". Needs @property
    // (Chromium); degrades to a static border elsewhere.
    beam?: string;
    // Raw extra CSS appended verbatim — per-theme flair that doesn't fit a field.
    extra?: string;
}

import { clouds, neonGrid, sunset, paper } from "./backgrounds";

// The animated racing-border. Drawn as a masked ::after so it's a border-only
// overlay (the element's own background/text stay put) and pointer-transparent.
// Applied to a small, well-bounded set of elements so the conic animation stays
// cheap — chrome + primary controls + the hovered grid cell.
function beamCss(stops: string): string {
    // `.PlayerBar` is deliberately omitted from the position:relative rule — it
    // is already `position: fixed` (its own containing block, so the inset ::after
    // works), and forcing `relative` would override that and drop the bar out of
    // its bottom-pinned spot into normal flow.
    const relTargets = ".Header, .Modal, .Button--primary, .Chip--primary, .SeriesCount, .GridCell";
    const after = ".Header::after, .Modal::after, .PlayerBar::after, .Button--primary::after, .Chip--primary::after, .SeriesCount::after, .GridCell:hover::after";
    return `
@property --rs-beam { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes rs-beam-spin { to { --rs-beam: 360deg; } }
${relTargets} { position: relative; }
${after} {
    content: ""; position: absolute; inset: 0; padding: 1.5px; border-radius: inherit;
    background: conic-gradient(from var(--rs-beam), ${stops});
    -webkit-mask: linear-gradient(hsl(0, 0%, 0%) 0 0) content-box, linear-gradient(hsl(0, 0%, 0%) 0 0);
            mask: linear-gradient(hsl(0, 0%, 0%) 0 0) content-box, linear-gradient(hsl(0, 0%, 0%) 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
    animation: rs-beam-spin 4s linear infinite; pointer-events: none; z-index: 5;
}`;
}

function buildTheme(p: Palette): string {
    const titleShadow = p.titleShadow ? `text-shadow: ${p.titleShadow};` : "text-shadow: none;";
    const btnShadow = p.btnShadow ? `box-shadow: ${p.btnShadow};` : "box-shadow: none;";
    const font = p.font ? `font-family: ${p.font};` : "";
    const hover = p.hoverFilter || "brightness(1.14)";
    const pageBg = p.pattern ? `${p.pattern}, ${p.bg}` : p.bg;
    const cursor = p.cursor ? `cursor: ${p.cursor};` : "";
    const beam = p.beam ? beamCss(p.beam) : "";
    const extra = p.extra || "";
    // Whole-page background: a real scene image (cover, fixed) when the theme has
    // one, otherwise the CSS-pattern wallpaper. `.Page.no-bg` (set by the
    // disable-backgrounds setting) drops both back to the bare `bg` gradient.
    const pageBackground = p.bgImage
        ? `background: ${p.bg}; background-image: ${p.bgImage}; background-size: cover; background-position: center; background-repeat: no-repeat;`
        : `background: ${pageBg};`;
    // Sidebar/header echo the same fixed scene under a translucent tint so the
    // panels feel cut out of the wallpaper rather than pasted on top of it.
    const sceneCss = p.bgImage ? `
.Sidebar, .Header {
    background-image: linear-gradient(${p.bgOverlay || "hsla(0, 0%, 0%, 0.45)"}, ${p.bgOverlay || "hsla(0, 0%, 0%, 0.45)"}), ${p.bgImage};
    background-size: cover; background-position: center; background-attachment: fixed;
}
.Page.no-bg, .no-bg .Page { background: ${p.bg}; background-image: none; }
.no-bg .Sidebar, .no-bg .Header { background: ${p.panel}; background-image: none; }
` : `.Page.no-bg, .no-bg .Page { background: ${p.bg}; background-image: none; }`;
    // Keep the themed cursor over interactive elements (buttons/links/chips)
    // instead of letting the UA pointer take over. Text fields keep a text caret.
    const cursorRules = p.cursor ? `
.Page * { cursor: ${p.pointerCursor || p.cursor}; }
.Page input:not([type=range]):not([type=checkbox]):not([type=button]):not([type=submit]), .Page textarea { cursor: text; }
` : "";
    // Theme the modal scrollbars (the main grid already overrides its own). Square
    // corners — no border-radius. Firefox only takes solid colors for
    // scrollbar-color, so skip it when the palette uses gradients there.
    const ffSolid = !/gradient/.test(p.scrollThumb) && !/gradient/.test(p.panel);
    const modalScroll = `
.Modal::-webkit-scrollbar, .Modal *::-webkit-scrollbar { width: 12px; height: 12px; }
.Modal::-webkit-scrollbar-track, .Modal *::-webkit-scrollbar-track { background: ${p.panel}; }
.Modal::-webkit-scrollbar-thumb, .Modal *::-webkit-scrollbar-thumb { background: ${p.scrollThumb}; border: 2px solid ${p.panel}; }
.Modal::-webkit-scrollbar-thumb:hover, .Modal *::-webkit-scrollbar-thumb:hover { background: ${p.accent}; }
.Modal, .Modal * { scrollbar-width: thin; ${ffSolid ? `scrollbar-color: ${p.scrollThumb} ${p.panel};` : ""} }
`;
    // The base look paints a fixed dark-gray background on :hover (specificity
    // 0,2,0), which beats the theme's non-hover .Surface rule (0,1,0) and repaints
    // light-theme rows near-black under the cursor. Re-assert the themed background
    // at hover specificity and express the feedback as a filter instead.
    return `
html, body { background: ${p.bg}; ${cursor} }
.Surface:hover, .ListRow:hover, .ListItem:hover, .Card:hover, .GridCell:hover { background: ${p.surface}; filter: ${hover}; }
.Chip:hover { background: ${p.chip}; filter: ${hover}; }

.Page { ${pageBackground} background-attachment: fixed; color: ${p.text}; ${font} ${cursor} }
.Sidebar { background: ${p.panel}; border-color: ${p.panelBorder}; color: ${p.text}; }
.Sidebar-title { color: ${p.accent}; ${titleShadow} }
.Header { background: ${p.panel}; border-color: ${p.panelBorder}; color: ${p.text}; }
.BuildChip { background: ${p.chip}; color: ${p.muted}; }

.SearchInput, .Field, .Field--duration { background: ${p.input}; color: ${p.inputText}; border-color: ${p.inputBorder}; }
.SearchInput::placeholder, .Field::placeholder, .Field--duration::placeholder { color: ${p.placeholder}; }
.Field-clear { color: ${p.muted}; }
.Label { color: ${p.muted}; }

.Button { background: ${p.btn}; color: ${p.btnText}; border-color: ${p.btnBorder}; ${btnShadow} }
.Button:hover { background: ${p.btnHover}; }
.Button--primary { background: ${p.primary}; color: ${p.primaryText}; border-color: ${p.primaryBorder}; }
.Button--active { background: ${p.active}; color: ${p.activeText}; }
.Button--danger { background: ${p.error}; color: ${p.errorText}; border-color: ${p.error}; }

.Chip, .GridTag, .Chip--dim { background: ${p.chip}; color: ${p.chipText}; border-color: ${p.chipBorder}; }
.Chip--primary { background: ${p.primary}; color: ${p.primaryText}; border-color: ${p.primaryBorder}; }
.Chip--warn, .Badge--reparse { background: ${p.warn}; color: ${p.warnText}; border-color: ${p.warn}; }
.Chip--scan { background: ${p.scan}; color: ${p.scanText}; border-color: ${p.scan}; }
.Chip--error, .Badge--error { background: ${p.error}; color: ${p.errorText}; border-color: ${p.error}; }
.Chip--heygoogle { background: ${p.heygoogle}; color: ${p.heygoogleText}; }

.GridCell { background: ${p.surface}; border-color: ${p.surfaceBorder}; }
.GridCell-thumb { background: ${p.thumb}; }
.GridCell-title { color: ${p.text}; }
.GridCell-info { color: ${p.muted}; }
.GridCell-progress { background: ${p.progress}; }
.SeriesCount { background: ${p.primary}; color: ${p.primaryText}; }
.CellExpand, .TileAction { background: ${p.chip}; color: ${p.chipText}; border-color: ${p.chipBorder}; }

.Scrollbar { background: ${p.panel}; }
.Scrollbar-thumb { background: ${p.scrollThumb}; }
.Scrollbar-label { color: ${p.accent}; }

.Modal { background: ${p.panel}; color: ${p.text}; border-color: ${p.panelBorder}; box-shadow: ${p.modalShadow}; }
.Modal-backdrop { background: ${p.backdrop}; }
.Modal-title { color: ${p.accent}; ${titleShadow} }

.RearrangeTile { background: ${p.surface}; border-color: ${p.surfaceBorder}; }
.RearrangeTile-stripe { background: ${p.progress}; }
.RearrangeTile-title { color: ${p.text}; }
.DropLine { background: ${p.progress}; }

.PlayerBar { background: ${p.panel}; border-color: ${p.panelBorder}; color: ${p.text}; }
.PlayerBar-seek { background: ${p.progress}; }
.PlayerBar-pill { background: ${p.chip}; color: ${p.chipText}; }
.PlayerBar-name { color: ${p.text}; }

.ListRow, .ListItem { background: ${p.surface}; border-color: ${p.surfaceBorder}; color: ${p.text}; }
.ListPanel { background: ${p.panel}; border-color: ${p.panelBorder}; color: ${p.text}; }
.ListHeader { color: ${p.accent}; ${titleShadow} }
.KeyHint { background: ${p.chip}; color: ${p.chipText}; border-color: ${p.chipBorder}; }

.FaceAvatar { border-color: ${p.avatarBorder}; }

.Toast { background: ${p.panel}; color: ${p.text}; border-color: ${p.panelBorder}; }
.Card { background: ${p.surface}; color: ${p.text}; border-color: ${p.surfaceBorder}; }
.Dot--on { background: ${p.dotOn}; }
.Dot--off { background: ${p.surfaceBorder}; }

.Surface { background: ${p.surface}; border-color: ${p.surfaceBorder}; color: ${p.text}; }
.Muted { color: ${p.muted}; }
.Accent { color: ${p.accent}; ${titleShadow} }
${sceneCss}
${cursorRules}
${modalScroll}
${beam}
${extra}
`;
}

// Neon arrow cursor (data-URI SVG); fill/stroke pick out the theme's accent.
function arrowCursor(fill: string, stroke: string): string {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='26'><path d='M3 2 L3 20 L8 15 L11 23 L14 22 L11 14 L18 14 Z' fill='${fill}' stroke='${stroke}' stroke-width='1.2'/></svg>`;
    return `url("data:image/svg+xml,${svg.replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/ /g, "%20")}") 3 2, auto`;
}

// ── Cyberpunk — near-black, neon cyan + magenta, glow. ───────────────────────
export const CYBERPUNK_CSS = buildTheme({
    bg: "hsl(228, 33%, 3%)",
    panel: "hsl(224, 44%, 5%)", panelBorder: "hsl(190, 53%, 26%)",
    surface: "hsl(220, 38%, 6%)", surfaceBorder: "hsl(190, 51%, 25%)",
    text: "hsl(190, 100%, 92%)", muted: "hsl(188, 46%, 57%)", accent: "hsl(320, 100%, 59%)",
    titleShadow: "0 0 10px hsla(320, 100%, 59%, 0.9), 0 0 22px hsla(320, 100%, 59%, 0.5)",
    input: "hsl(217, 39%, 6%)", inputText: "hsl(182, 100%, 72%)", inputBorder: "hsl(188, 53%, 39%)", placeholder: "hsl(191, 41%, 31%)",
    btn: "hsl(218, 48%, 9%)", btnText: "hsl(182, 100%, 72%)", btnBorder: "hsl(188, 53%, 39%)", btnHover: "hsl(200, 60%, 16%)",
    btnShadow: "0 0 10px hsla(182, 100%, 72%, 0.4), inset 0 0 6px hsla(182, 100%, 72%, 0.15)",
    primary: "hsl(320, 100%, 59%)", primaryText: "hsl(228, 29%, 3%)", primaryBorder: "hsl(319, 100%, 75%)",
    active: "hsl(196, 59%, 17%)", activeText: "hsl(182, 100%, 72%)",
    chip: "hsl(218, 48%, 9%)", chipText: "hsl(182, 100%, 72%)", chipBorder: "hsl(188, 53%, 39%)",
    warn: "hsl(46, 71%, 10%)", warnText: "hsl(51, 100%, 62%)", scan: "hsl(197, 71%, 10%)", scanText: "hsl(182, 100%, 72%)",
    error: "hsl(341, 71%, 10%)", errorText: "hsl(349, 100%, 68%)", heygoogle: "hsl(270, 62%, 10%)", heygoogleText: "hsl(272, 100%, 77%)",
    progress: "hsl(320, 100%, 59%)", scrollThumb: "hsl(188, 53%, 39%)", thumb: "hsl(231, 54%, 3%)",
    dotOn: "hsl(182, 100%, 72%)", avatarBorder: "hsl(320, 100%, 59%)",
    modalShadow: "0 0 40px hsla(320, 100%, 59%, 0.45)", backdrop: "hsla(225, 67%, 2%, 0.85)",
    pattern: "radial-gradient(circle at 50% -10%, hsla(320, 100%, 59%, 0.20), transparent 55%), " +
        "repeating-linear-gradient(0deg, hsla(182, 100%, 72%, 0.05) 0 1px, transparent 1px 44px), " +
        "repeating-linear-gradient(90deg, hsla(182, 100%, 72%, 0.05) 0 1px, transparent 1px 44px)",
    bgImage: neonGrid("hsl(228, 33%, 3%)", "hsl(182, 100%, 72%)", "hsla(320, 100%, 59%, 0.55)"),
    bgOverlay: "hsla(224, 44%, 5%, 0.74)",
    beam: "transparent 55%, hsl(182, 100%, 72%) 78%, hsl(320, 100%, 59%) 100%",
    cursor: arrowCursor("hsl(320, 100%, 59%)", "hsl(182, 100%, 72%)"),
});

// ── Frutiger Aero — bright, glossy, aqua glass. Genuinely light. ─────────────
export const FRUTIGER_AERO_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(201, 100%, 91%) 0%, hsl(201, 100%, 97%) 45%, hsl(0, 0%, 100%) 100%)",
    panel: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(204, 100%, 95%) 100%)", panelBorder: "hsl(200, 70%, 80%)",
    surface: "hsl(0, 0%, 100%)", surfaceBorder: "hsl(202, 75%, 89%)",
    text: "hsl(205, 76%, 20%)", muted: "hsl(203, 33%, 46%)", accent: "hsl(204, 87%, 45%)",
    font: undefined,
    input: "hsl(0, 0%, 100%)", inputText: "hsl(205, 76%, 20%)", inputBorder: "hsl(202, 61%, 77%)", placeholder: "hsl(203, 40%, 69%)",
    btn: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(205, 100%, 92%) 100%)", btnText: "hsl(205, 76%, 20%)",
    btnBorder: "hsl(202, 61%, 77%)", btnHover: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(201, 88%, 87%) 100%)",
    btnShadow: "0 1px 2px hsla(205, 76%, 20%, 0.18), inset 0 1px 0 hsla(0, 0%, 100%, 0.9)",
    primary: "linear-gradient(180deg, hsl(203, 100%, 68%) 0%, hsl(206, 84%, 48%) 100%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(206, 82%, 43%)",
    active: "linear-gradient(180deg, hsl(200, 100%, 89%) 0%, hsl(199, 87%, 76%) 100%)", activeText: "hsl(205, 76%, 20%)",
    chip: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(204, 100%, 95%) 100%)", chipText: "hsl(205, 76%, 20%)", chipBorder: "hsl(200, 70%, 80%)",
    warn: "linear-gradient(180deg, hsl(48, 100%, 88%) 0%, hsl(47, 100%, 74%) 100%)", warnText: "hsl(47, 100%, 21%)",
    scan: "linear-gradient(180deg, hsl(200, 100%, 91%) 0%, hsl(200, 81%, 79%) 100%)", scanText: "hsl(205, 76%, 20%)",
    error: "linear-gradient(180deg, hsl(0, 100%, 92%) 0%, hsl(0, 77%, 78%) 100%)", errorText: "hsl(0, 72%, 28%)",
    heygoogle: "linear-gradient(180deg, hsl(261, 100%, 93%) 0%, hsl(264, 71%, 80%) 100%)", heygoogleText: "hsl(264, 61%, 26%)",
    progress: "linear-gradient(90deg, hsl(203, 100%, 68%), hsl(206, 84%, 48%))", scrollThumb: "linear-gradient(180deg, hsl(200, 81%, 79%), hsl(203, 100%, 68%))",
    thumb: "hsl(205, 79%, 92%)", dotOn: "hsl(140, 53%, 51%)", avatarBorder: "hsl(202, 61%, 77%)",
    modalShadow: "0 10px 36px hsla(205, 76%, 20%, 0.28)", backdrop: "hsla(205, 76%, 20%, 0.28)",
    hoverFilter: "brightness(0.96)",
    pattern: "radial-gradient(circle at 16% 78%, hsla(0, 0%, 100%, 0.85), hsla(0, 0%, 100%, 0) 9%), " +
        "radial-gradient(circle at 82% 30%, hsla(199, 84%, 73%, 0.55), hsla(199, 84%, 73%, 0) 11%), " +
        "radial-gradient(circle at 62% 84%, hsla(0, 0%, 100%, 0.7), hsla(0, 0%, 100%, 0) 6%), " +
        "radial-gradient(circle at 36% 22%, hsla(200, 100%, 81%, 0.45), hsla(200, 100%, 81%, 0) 7%)",
    bgImage: clouds("hsl(204, 82%, 72%)", "hsl(200, 100%, 90%)"),
    bgOverlay: "hsla(206, 100%, 94%, 0.42)",
});

// ── CloudCyber — soft sky/cloud pastels, airy white-blue. ────────────────────
export const CLOUDCYBER_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(206, 100%, 96%) 0%, hsl(207, 100%, 98%) 60%, hsl(0, 0%, 100%) 100%)",
    panel: "hsla(0, 0%, 100%, 0.85)", panelBorder: "hsl(204, 69%, 90%)",
    surface: "hsla(0, 0%, 100%, 0.92)", surfaceBorder: "hsl(206, 68%, 93%)",
    text: "hsl(217, 26%, 31%)", muted: "hsl(213, 26%, 64%)", accent: "hsl(214, 62%, 68%)",
    input: "hsl(0, 0%, 100%)", inputText: "hsl(217, 26%, 31%)", inputBorder: "hsl(209, 52%, 88%)", placeholder: "hsl(213, 31%, 76%)",
    btn: "hsl(0, 0%, 100%)", btnText: "hsl(217, 33%, 44%)", btnBorder: "hsl(210, 59%, 89%)", btnHover: "hsl(212, 100%, 97%)",
    btnShadow: "0 1px 3px hsla(218, 42%, 63%, 0.18)",
    primary: "linear-gradient(180deg, hsl(213, 79%, 81%) 0%, hsl(214, 62%, 68%) 100%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(214, 56%, 64%)",
    active: "hsl(211, 71%, 92%)", activeText: "hsl(217, 26%, 31%)",
    chip: "hsl(212, 76%, 97%)", chipText: "hsl(219, 28%, 49%)", chipBorder: "hsl(211, 60%, 91%)",
    warn: "hsl(46, 92%, 90%)", warnText: "hsl(44, 68%, 32%)", scan: "hsl(205, 78%, 93%)", scanText: "hsl(217, 26%, 31%)",
    error: "hsl(0, 78%, 93%)", errorText: "hsl(0, 47%, 41%)", heygoogle: "hsl(264, 76%, 94%)", heygoogleText: "hsl(262, 37%, 46%)",
    progress: "linear-gradient(90deg, hsl(213, 79%, 81%), hsl(214, 62%, 68%))", scrollThumb: "hsl(210, 63%, 84%)",
    thumb: "hsl(209, 72%, 94%)", dotOn: "hsl(140, 45%, 65%)", avatarBorder: "hsl(213, 79%, 81%)",
    modalShadow: "0 12px 40px hsla(218, 42%, 63%, 0.25)", backdrop: "hsla(218, 32%, 51%, 0.22)",
    hoverFilter: "brightness(0.96)",
    pattern: "radial-gradient(ellipse 40% 28% at 22% 24%, hsla(0, 0%, 100%, 0.9), transparent 70%), " +
        "radial-gradient(ellipse 46% 30% at 78% 68%, hsla(209, 84%, 87%, 0.7), transparent 72%), " +
        "radial-gradient(ellipse 30% 22% at 60% 12%, hsla(0, 0%, 100%, 0.7), transparent 70%)",
    bgImage: clouds("hsl(203, 79%, 81%)", "hsl(206, 100%, 95%)"),
    bgOverlay: "hsla(207, 100%, 96%, 0.46)",
});

// ── Cyber Y2K (Y2K Futurism) — chrome silver, electric blue + hot pink. ──────
export const CYBER_Y2K_CSS = buildTheme({
    bg: "linear-gradient(160deg, hsl(217, 27%, 83%) 0%, hsl(217, 39%, 94%) 40%, hsl(270, 27%, 96%) 100%)",
    panel: "linear-gradient(180deg, hsl(220, 50%, 98%) 0%, hsl(218, 33%, 85%) 100%)", panelBorder: "hsl(218, 21%, 67%)",
    surface: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(218, 36%, 90%) 100%)", surfaceBorder: "hsl(219, 25%, 73%)",
    text: "hsl(220, 36%, 21%)", muted: "hsl(219, 18%, 52%)", accent: "hsl(328, 100%, 62%)",
    titleShadow: "0 1px 0 hsl(0, 0%, 100%)",
    input: "hsl(0, 0%, 100%)", inputText: "hsl(220, 36%, 21%)", inputBorder: "hsl(218, 21%, 67%)", placeholder: "hsl(218, 21%, 67%)",
    btn: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(218, 29%, 83%) 100%)", btnText: "hsl(220, 36%, 21%)",
    btnBorder: "hsl(218, 21%, 63%)", btnHover: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(219, 30%, 78%) 100%)",
    btnShadow: "inset 0 1px 0 hsla(0, 0%, 100%, 0.95), 0 1px 2px hsla(222, 38%, 25%, 0.25)",
    primary: "linear-gradient(180deg, hsl(327, 100%, 74%) 0%, hsl(329, 100%, 56%) 100%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(330, 87%, 45%)",
    active: "linear-gradient(180deg, hsl(209, 100%, 87%) 0%, hsl(209, 87%, 69%) 100%)", activeText: "hsl(212, 73%, 16%)",
    chip: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(218, 40%, 88%) 100%)", chipText: "hsl(220, 30%, 28%)", chipBorder: "hsl(218, 21%, 67%)",
    warn: "linear-gradient(180deg, hsl(50, 100%, 83%) 0%, hsl(46, 100%, 62%) 100%)", warnText: "hsl(47, 100%, 21%)",
    scan: "linear-gradient(180deg, hsl(203, 100%, 88%) 0%, hsl(206, 88%, 67%) 100%)", scanText: "hsl(212, 73%, 16%)",
    error: "linear-gradient(180deg, hsl(341, 100%, 88%) 0%, hsl(343, 100%, 68%) 100%)", errorText: "hsl(341, 78%, 24%)",
    heygoogle: "linear-gradient(180deg, hsl(263, 100%, 91%) 0%, hsl(262, 100%, 77%) 100%)", heygoogleText: "hsl(261, 73%, 23%)",
    progress: "linear-gradient(90deg, hsl(327, 100%, 74%), hsl(329, 100%, 56%))", scrollThumb: "linear-gradient(180deg, hsl(218, 33%, 85%), hsl(218, 21%, 67%))",
    thumb: "hsl(218, 33%, 85%)", dotOn: "hsl(145, 66%, 53%)", avatarBorder: "hsl(328, 100%, 62%)",
    modalShadow: "0 10px 34px hsla(222, 38%, 25%, 0.35)", backdrop: "hsla(222, 38%, 25%, 0.3)",
    hoverFilter: "brightness(0.96)",
    pattern: "radial-gradient(circle at 50% -5%, hsla(328, 100%, 62%, 0.20), transparent 50%), " +
        "repeating-linear-gradient(90deg, hsla(218, 21%, 67%, 0.14) 0 1px, transparent 1px 32px), " +
        "repeating-linear-gradient(0deg, hsla(218, 21%, 67%, 0.10) 0 1px, transparent 1px 32px)",
    bgImage: neonGrid("hsl(218, 33%, 85%)", "hsl(218, 21%, 63%)", "hsla(328, 100%, 62%, 0.45)"),
    bgOverlay: "hsla(220, 50%, 98%, 0.62)",
    cursor: arrowCursor("hsl(328, 100%, 62%)", "hsl(0, 0%, 100%)"),
});

// ── Utopian Scholastic — warm parchment, navy + gold, serif academia. ────────
export const UTOPIAN_SCHOLASTIC_CSS = buildTheme({
    bg: "hsl(43, 56%, 90%)",
    panel: "hsl(43, 54%, 86%)", panelBorder: "hsl(42, 40%, 66%)",
    surface: "hsl(43, 72%, 94%)", surfaceBorder: "hsl(42, 44%, 74%)",
    text: "hsl(38, 35%, 17%)", muted: "hsl(41, 22%, 44%)", accent: "hsl(218, 57%, 27%)",
    font: "Georgia, 'Times New Roman', serif",
    input: "hsl(47, 100%, 98%)", inputText: "hsl(38, 35%, 17%)", inputBorder: "hsl(42, 40%, 66%)", placeholder: "hsl(41, 24%, 56%)",
    btn: "hsl(43, 54%, 86%)", btnText: "hsl(38, 35%, 17%)", btnBorder: "hsl(42, 40%, 66%)", btnHover: "hsl(42, 49%, 81%)",
    btnShadow: "inset 0 1px 0 hsla(0, 0%, 100%, 0.5)",
    primary: "hsl(218, 57%, 27%)", primaryText: "hsl(43, 56%, 90%)", primaryBorder: "hsl(219, 61%, 20%)",
    active: "hsl(43, 44%, 73%)", activeText: "hsl(38, 35%, 17%)",
    chip: "hsl(43, 54%, 86%)", chipText: "hsl(39, 34%, 26%)", chipBorder: "hsl(42, 40%, 66%)",
    warn: "hsl(46, 67%, 73%)", warnText: "hsl(43, 67%, 25%)", scan: "hsl(124, 22%, 85%)", scanText: "hsl(135, 31%, 22%)",
    error: "hsl(18, 52%, 80%)", errorText: "hsl(12, 63%, 29%)", heygoogle: "hsl(275, 28%, 83%)", heygoogleText: "hsl(265, 36%, 26%)",
    progress: "hsl(42, 59%, 45%)", scrollThumb: "hsl(42, 40%, 66%)",
    thumb: "hsl(42, 47%, 83%)", dotOn: "hsl(105, 30%, 42%)", avatarBorder: "hsl(42, 59%, 45%)",
    modalShadow: "0 10px 34px hsla(38, 35%, 17%, 0.3)", backdrop: "hsla(38, 35%, 17%, 0.32)",
    hoverFilter: "brightness(0.96)",
    pattern: "linear-gradient(90deg, hsla(6, 63%, 46%, 0.10) 0 1px, transparent 1px) 64px 0 / 100% 100%, " +
        "repeating-linear-gradient(0deg, transparent 0 31px, hsla(218, 57%, 27%, 0.10) 31px 32px)",
    bgImage: paper("hsl(43, 56%, 90%)", "hsl(42, 40%, 66%)", "hsl(6, 63%, 46%)"),
    bgOverlay: "hsla(43, 54%, 86%, 0.72)",
});

// ── Webcore — early-web: white page, blue links, gray bevels, Times. ─────────
export const WEBCORE_CSS = buildTheme({
    bg: "hsl(0, 0%, 100%)",
    panel: "hsl(40, 12%, 81%)", panelBorder: "hsl(0, 0%, 50%)",
    surface: "hsl(0, 0%, 93%)", surfaceBorder: "hsl(0, 0%, 60%)",
    text: "hsl(0, 0%, 0%)", muted: "hsl(0, 0%, 33%)", accent: "hsl(240, 100%, 40%)",
    font: "'Times New Roman', Times, Georgia, serif",
    input: "hsl(0, 0%, 100%)", inputText: "hsl(0, 0%, 0%)", inputBorder: "hsl(0, 0%, 50%)", placeholder: "hsl(0, 0%, 53%)",
    btn: "hsl(40, 12%, 81%)", btnText: "hsl(0, 0%, 0%)", btnBorder: "hsl(0, 0%, 50%)", btnHover: "hsl(42, 15%, 87%)",
    btnShadow: "inset 1px 1px 0 hsl(0, 0%, 100%), inset -1px -1px 0 hsl(0, 0%, 50%)",
    primary: "hsl(240, 100%, 25%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(240, 100%, 16%)",
    active: "hsl(0, 0%, 75%)", activeText: "hsl(0, 0%, 0%)",
    chip: "hsl(40, 12%, 81%)", chipText: "hsl(0, 0%, 0%)", chipBorder: "hsl(0, 0%, 50%)",
    warn: "hsl(60, 100%, 90%)", warnText: "hsl(47, 100%, 24%)", scan: "hsl(216, 100%, 90%)", scanText: "hsl(240, 100%, 25%)",
    error: "hsl(0, 100%, 90%)", errorText: "hsl(0, 100%, 30%)", heygoogle: "hsl(260, 100%, 91%)", heygoogleText: "hsl(275, 100%, 25%)",
    progress: "hsl(240, 100%, 25%)", scrollThumb: "hsl(0, 0%, 66%)",
    thumb: "hsl(0, 0%, 75%)", dotOn: "hsl(120, 100%, 25%)", avatarBorder: "hsl(240, 100%, 40%)",
    modalShadow: "2px 2px 0 hsl(0, 0%, 50%)", backdrop: "hsla(0, 0%, 0%, 0.4)",
    hoverFilter: "brightness(0.96)",
    pattern: "repeating-linear-gradient(0deg, hsla(240, 100%, 25%, 0.05) 0 1px, transparent 1px 22px), " +
        "repeating-linear-gradient(90deg, hsla(240, 100%, 25%, 0.05) 0 1px, transparent 1px 22px)",
    bgImage: paper("hsl(0, 0%, 100%)", "hsl(0, 0%, 78%)", "hsl(240, 100%, 40%)"),
    bgOverlay: "hsla(40, 12%, 81%, 0.82)",
});

// ── Vaporwave — twilight purple, hot pink + cyan, soft neon. ─────────────────
export const VAPORWAVE_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(267, 60%, 18%) 0%, hsl(282, 45%, 30%) 55%, hsl(317, 100%, 71%) 140%)",
    panel: "hsl(263, 54%, 20%)", panelBorder: "hsl(276, 43%, 44%)",
    surface: "hsl(260, 48%, 24%)", surfaceBorder: "hsl(270, 41%, 42%)",
    text: "hsl(271, 100%, 95%)", muted: "hsl(270, 42%, 72%)", accent: "hsl(317, 100%, 71%)",
    titleShadow: "0 0 8px hsla(317, 100%, 71%, 0.6)",
    input: "hsl(265, 60%, 16%)", inputText: "hsl(181, 100%, 74%)", inputBorder: "hsl(276, 43%, 44%)", placeholder: "hsl(267, 31%, 55%)",
    btn: "hsl(261, 50%, 27%)", btnText: "hsl(181, 100%, 74%)", btnBorder: "hsl(271, 47%, 53%)", btnHover: "hsl(261, 49%, 34%)",
    btnShadow: "0 0 8px hsla(181, 100%, 74%, 0.25)",
    primary: "linear-gradient(90deg, hsl(317, 100%, 71%) 0%, hsl(181, 100%, 74%) 100%)", primaryText: "hsl(265, 60%, 16%)", primaryBorder: "hsl(317, 100%, 71%)",
    active: "hsl(261, 49%, 34%)", activeText: "hsl(181, 100%, 74%)",
    chip: "hsl(261, 50%, 27%)", chipText: "hsl(317, 100%, 84%)", chipBorder: "hsl(271, 47%, 53%)",
    warn: "hsl(47, 70%, 21%)", warnText: "hsl(50, 100%, 71%)", scan: "hsl(197, 64%, 18%)", scanText: "hsl(181, 100%, 74%)",
    error: "hsl(327, 64%, 18%)", errorText: "hsl(341, 100%, 77%)", heygoogle: "hsl(270, 55%, 23%)", heygoogleText: "hsl(272, 100%, 77%)",
    progress: "linear-gradient(90deg, hsl(317, 100%, 71%), hsl(181, 100%, 74%))", scrollThumb: "hsl(276, 43%, 44%)",
    thumb: "hsl(264, 63%, 14%)", dotOn: "hsl(181, 100%, 74%)", avatarBorder: "hsl(317, 100%, 71%)",
    modalShadow: "0 0 40px hsla(317, 100%, 71%, 0.45)", backdrop: "hsla(263, 67%, 9%, 0.8)",
    pattern: "radial-gradient(circle at 50% 82%, hsla(317, 100%, 71%, 0.40), transparent 40%), " +
        "repeating-linear-gradient(0deg, hsla(181, 100%, 74%, 0.06) 0 1px, transparent 1px 42px), " +
        "repeating-linear-gradient(90deg, hsla(181, 100%, 74%, 0.06) 0 1px, transparent 1px 42px)",
    bgImage: sunset("hsl(267, 60%, 18%)", "hsl(282, 45%, 30%)", "hsl(317, 100%, 71%)", "hsl(320, 100%, 77%)"),
    bgOverlay: "hsla(263, 54%, 20%, 0.68)",
    beam: "transparent 55%, hsl(181, 100%, 74%) 78%, hsl(317, 100%, 71%) 100%",
    cursor: arrowCursor("hsl(317, 100%, 71%)", "hsl(181, 100%, 74%)"),
});

// ── Terminal Green — black CRT, phosphor green monospace. ────────────────────
export const TERMINAL_GREEN_CSS = buildTheme({
    bg: "hsl(120, 50%, 2%)",
    panel: "hsl(120, 68%, 4%)", panelBorder: "hsl(120, 49%, 24%)",
    surface: "hsl(120, 67%, 5%)", surfaceBorder: "hsl(120, 48%, 20%)",
    text: "hsl(135, 100%, 60%)", muted: "hsl(136, 66%, 36%)", accent: "hsl(120, 100%, 75%)",
    titleShadow: "0 0 6px hsla(135, 100%, 60%, 0.7)",
    font: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
    input: "hsl(120, 68%, 4%)", inputText: "hsl(135, 100%, 60%)", inputBorder: "hsl(120, 49%, 24%)", placeholder: "hsl(132, 61%, 26%)",
    btn: "hsl(138, 71%, 5%)", btnText: "hsl(135, 100%, 60%)", btnBorder: "hsl(141, 59%, 30%)", btnHover: "hsl(137, 78%, 11%)",
    btnShadow: "0 0 6px hsla(135, 100%, 60%, 0.25)",
    primary: "hsl(135, 100%, 60%)", primaryText: "hsl(129, 78%, 4%)", primaryBorder: "hsl(120, 100%, 75%)",
    active: "hsl(138, 71%, 13%)", activeText: "hsl(120, 100%, 75%)",
    chip: "hsl(138, 71%, 5%)", chipText: "hsl(135, 100%, 60%)", chipBorder: "hsl(141, 59%, 30%)",
    warn: "hsl(60, 79%, 9%)", warnText: "hsl(68, 100%, 62%)", scan: "hsl(154, 79%, 9%)", scanText: "hsl(165, 100%, 60%)",
    error: "hsl(0, 75%, 9%)", errorText: "hsl(0, 100%, 67%)", heygoogle: "hsl(180, 62%, 10%)", heygoogleText: "hsl(165, 100%, 60%)",
    progress: "hsl(135, 100%, 60%)", scrollThumb: "hsl(141, 59%, 30%)",
    thumb: "hsl(120, 67%, 2%)", dotOn: "hsl(135, 100%, 60%)", avatarBorder: "hsl(135, 100%, 60%)",
    modalShadow: "0 0 36px hsla(135, 100%, 60%, 0.4)", backdrop: "hsla(120, 100%, 2%, 0.88)",
    pattern: "radial-gradient(circle at 50% 0%, hsla(135, 100%, 60%, 0.12), transparent 60%), " +
        "repeating-linear-gradient(0deg, hsla(135, 100%, 60%, 0.07) 0 1px, transparent 1px 3px)",
    bgImage: neonGrid("hsl(120, 50%, 2%)", "hsl(135, 100%, 60%)", "hsla(135, 100%, 60%, 0.45)"),
    bgOverlay: "hsla(120, 68%, 4%, 0.74)",
    beam: "transparent 60%, hsl(120, 100%, 75%) 80%, hsl(135, 100%, 60%) 100%",
    cursor: "crosshair",
});

// ── Solarized Dusk — the canonical solarized dark palette. ───────────────────
export const SOLARIZED_DUSK_CSS = buildTheme({
    bg: "hsl(192, 100%, 11%)",
    panel: "hsl(192, 81%, 14%)", panelBorder: "hsl(192, 75%, 20%)",
    surface: "hsl(191, 83%, 14%)", surfaceBorder: "hsl(191, 70%, 22%)",
    text: "hsl(180, 7%, 60%)", muted: "hsl(194, 14%, 40%)", accent: "hsl(205, 69%, 49%)",
    input: "hsl(192, 100%, 11%)", inputText: "hsl(180, 7%, 60%)", inputBorder: "hsl(192, 75%, 20%)", placeholder: "hsl(194, 14%, 40%)",
    btn: "hsl(192, 81%, 14%)", btnText: "hsl(180, 7%, 60%)", btnBorder: "hsl(192, 75%, 20%)", btnHover: "hsl(191, 78%, 18%)",
    primary: "hsl(205, 69%, 49%)", primaryText: "hsl(192, 100%, 11%)", primaryBorder: "hsl(205, 69%, 39%)",
    active: "hsl(191, 80%, 20%)", activeText: "hsl(44, 87%, 94%)",
    chip: "hsl(192, 81%, 14%)", chipText: "hsl(180, 7%, 60%)", chipBorder: "hsl(192, 75%, 20%)",
    warn: "hsl(51, 57%, 15%)", warnText: "hsl(45, 100%, 35%)", scan: "hsl(190, 74%, 15%)", scanText: "hsl(175, 59%, 40%)",
    error: "hsl(0, 57%, 15%)", errorText: "hsl(1, 71%, 52%)", heygoogle: "hsl(267, 45%, 17%)", heygoogleText: "hsl(237, 43%, 60%)",
    progress: "hsl(175, 59%, 40%)", scrollThumb: "hsl(192, 75%, 20%)",
    thumb: "hsl(192, 100%, 8%)", dotOn: "hsl(68, 100%, 30%)", avatarBorder: "hsl(205, 69%, 49%)",
    modalShadow: "0 12px 36px hsla(0, 0%, 0%, 0.5)", backdrop: "hsla(194, 100%, 5%, 0.8)",
    pattern: "radial-gradient(circle at 50% 0%, hsla(205, 69%, 49%, 0.10), transparent 55%), " +
        "repeating-linear-gradient(0deg, hsla(205, 69%, 49%, 0.05) 0 1px, transparent 1px 40px)",
    bgImage: neonGrid("hsl(192, 100%, 11%)", "hsl(205, 69%, 49%)", "hsla(175, 59%, 40%, 0.4)"),
    bgOverlay: "hsla(192, 81%, 14%, 0.72)",
});

// ── Sunset Synth — synthwave dusk, indigo night + orange/pink horizon. ───────
export const SUNSET_SYNTH_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(266, 61%, 11%) 0%, hsl(278, 52%, 21%) 50%, hsl(359, 100%, 68%) 150%)",
    panel: "hsl(266, 57%, 15%)", panelBorder: "hsl(287, 44%, 33%)",
    surface: "hsl(266, 53%, 18%)", surfaceBorder: "hsl(274, 44%, 33%)",
    text: "hsl(30, 100%, 80%)", muted: "hsl(331, 29%, 69%)", accent: "hsl(17, 100%, 68%)",
    titleShadow: "0 0 8px hsla(17, 100%, 68%, 0.6)",
    input: "hsl(262, 57%, 12%)", inputText: "hsl(30, 100%, 83%)", inputBorder: "hsl(287, 44%, 33%)", placeholder: "hsl(320, 19%, 51%)",
    btn: "hsl(265, 52%, 21%)", btnText: "hsl(30, 100%, 83%)", btnBorder: "hsl(279, 42%, 43%)", btnHover: "hsl(265, 50%, 27%)",
    btnShadow: "0 0 8px hsla(17, 100%, 68%, 0.25)",
    primary: "linear-gradient(90deg, hsl(17, 100%, 68%) 0%, hsl(340, 100%, 62%) 100%)", primaryText: "hsl(266, 61%, 11%)", primaryBorder: "hsl(359, 100%, 68%)",
    active: "hsl(269, 49%, 29%)", activeText: "hsl(30, 100%, 83%)",
    chip: "hsl(265, 52%, 21%)", chipText: "hsl(21, 100%, 77%)", chipBorder: "hsl(279, 42%, 43%)",
    warn: "hsl(43, 64%, 18%)", warnText: "hsl(45, 100%, 65%)", scan: "hsl(257, 52%, 21%)", scanText: "hsl(248, 100%, 77%)",
    error: "hsl(327, 64%, 18%)", errorText: "hsl(347, 100%, 71%)", heygoogle: "hsl(259, 54%, 20%)", heygoogleText: "hsl(255, 100%, 80%)",
    progress: "linear-gradient(90deg, hsl(17, 100%, 68%), hsl(340, 100%, 62%))", scrollThumb: "hsl(287, 44%, 33%)",
    thumb: "hsl(262, 60%, 10%)", dotOn: "hsl(32, 100%, 68%)", avatarBorder: "hsl(17, 100%, 68%)",
    modalShadow: "0 0 40px hsla(359, 100%, 68%, 0.42)", backdrop: "hsla(263, 67%, 7%, 0.82)",
    pattern: "radial-gradient(circle at 50% 90%, hsla(17, 100%, 68%, 0.42), transparent 42%), " +
        "repeating-linear-gradient(0deg, hsla(17, 100%, 68%, 0.06) 0 1px, transparent 1px 46px), " +
        "repeating-linear-gradient(90deg, hsla(340, 100%, 62%, 0.05) 0 1px, transparent 1px 46px)",
    bgImage: sunset("hsl(266, 61%, 11%)", "hsl(278, 52%, 21%)", "hsl(359, 100%, 68%)", "hsl(32, 100%, 68%)"),
    bgOverlay: "hsla(266, 57%, 15%, 0.68)",
    beam: "transparent 55%, hsl(17, 100%, 68%) 80%, hsl(340, 100%, 62%) 100%",
    cursor: arrowCursor("hsl(17, 100%, 68%)", "hsl(30, 100%, 83%)"),
});

// ── Paper Ink — clean light paper, black ink, single red accent. ─────────────
export const PAPER_INK_CSS = buildTheme({
    bg: "hsl(45, 29%, 97%)",
    panel: "hsl(45, 24%, 93%)", panelBorder: "hsl(43, 15%, 82%)",
    surface: "hsl(0, 0%, 100%)", surfaceBorder: "hsl(43, 19%, 86%)",
    text: "hsl(60, 4%, 11%)", muted: "hsl(45, 5%, 44%)", accent: "hsl(6, 63%, 46%)",
    input: "hsl(0, 0%, 100%)", inputText: "hsl(60, 4%, 11%)", inputBorder: "hsl(43, 16%, 78%)", placeholder: "hsl(40, 8%, 63%)",
    btn: "hsl(0, 0%, 100%)", btnText: "hsl(60, 4%, 11%)", btnBorder: "hsl(45, 15%, 78%)", btnHover: "hsl(45, 21%, 93%)",
    btnShadow: "0 1px 2px hsla(60, 4%, 11%, 0.08)",
    primary: "hsl(6, 63%, 46%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(6, 65%, 38%)",
    active: "hsl(43, 23%, 88%)", activeText: "hsl(60, 4%, 11%)",
    chip: "hsl(45, 21%, 93%)", chipText: "hsl(60, 4%, 22%)", chipBorder: "hsl(43, 17%, 84%)",
    warn: "hsl(45, 78%, 84%)", warnText: "hsl(44, 77%, 27%)", scan: "hsl(200, 36%, 90%)", scanText: "hsl(199, 50%, 25%)",
    error: "hsl(8, 60%, 88%)", errorText: "hsl(7, 69%, 36%)", heygoogle: "hsl(258, 40%, 90%)", heygoogleText: "hsl(255, 36%, 35%)",
    progress: "hsl(6, 63%, 46%)", scrollThumb: "hsl(43, 16%, 78%)",
    thumb: "hsl(47, 19%, 91%)", dotOn: "hsl(132, 41%, 38%)", avatarBorder: "hsl(6, 63%, 46%)",
    modalShadow: "0 12px 40px hsla(60, 4%, 11%, 0.18)", backdrop: "hsla(60, 4%, 11%, 0.28)",
    hoverFilter: "brightness(0.96)",
    pattern: "radial-gradient(hsla(60, 4%, 11%, 0.07) 1px, transparent 1.6px) 0 0 / 22px 22px",
    bgImage: paper("hsl(45, 29%, 97%)", "hsl(43, 15%, 82%)", "hsl(6, 63%, 46%)"),
    bgOverlay: "hsla(45, 24%, 93%, 0.8)",
});
