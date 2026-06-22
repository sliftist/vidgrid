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
}

function buildTheme(p: Palette): string {
    const titleShadow = p.titleShadow ? `text-shadow: ${p.titleShadow};` : "text-shadow: none;";
    const btnShadow = p.btnShadow ? `box-shadow: ${p.btnShadow};` : "box-shadow: none;";
    const font = p.font ? `font-family: ${p.font};` : "";
    const hover = p.hoverFilter || "brightness(1.14)";
    // The base look paints a fixed dark-gray background on :hover (specificity
    // 0,2,0), which beats the theme's non-hover .Surface rule (0,1,0) and repaints
    // light-theme rows near-black under the cursor. Re-assert the themed background
    // at hover specificity and express the feedback as a filter instead.
    return `
html, body { background: ${p.bg}; }
.Surface:hover, .ListRow:hover, .ListItem:hover, .Card:hover, .GridCell:hover { background: ${p.surface}; filter: ${hover}; }
.Chip:hover { background: ${p.chip}; filter: ${hover}; }

.Page { background: ${p.bg}; color: ${p.text}; ${font} }
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
`;
}

// ── Cyberpunk — near-black, neon cyan + magenta, glow. ───────────────────────
export const CYBERPUNK_CSS = buildTheme({
    bg: "#05060a",
    panel: "#070a12", panelBorder: "#16323a",
    surface: "#0a0e16", surfaceBorder: "#173138",
    text: "#d6f8ff", muted: "#4f9aa5", accent: "#ff2fb9",
    titleShadow: "0 0 6px rgba(255,47,185,0.7)",
    input: "#0a0f17", inputText: "#6ef9ff", inputBorder: "#1f5560", placeholder: "#2f6470",
    btn: "#0c1422", btnText: "#6ef9ff", btnBorder: "#1f6f7a", btnHover: "#103040",
    btnShadow: "0 0 6px rgba(110,249,255,0.25)",
    primary: "#ff2fb9", primaryText: "#06070b", primaryBorder: "#ff7fd6",
    active: "#123846", activeText: "#6ef9ff",
    chip: "#0c1422", chipText: "#6ef9ff", chipBorder: "#1f6f7a",
    warn: "#2a2207", warnText: "#ffe23d", scan: "#07202a", scanText: "#6ef9ff",
    error: "#2a0712", errorText: "#ff5d7a", heygoogle: "#1a0a2a", heygoogleText: "#c98bff",
    progress: "#ff2fb9", scrollThumb: "#1f6f7a", thumb: "#03040a",
    dotOn: "#6ef9ff", avatarBorder: "#ff2fb9",
    modalShadow: "0 0 30px rgba(255,47,185,0.3)", backdrop: "rgba(2,4,10,0.85)",
});

// ── Frutiger Aero — bright, glossy, aqua glass. Genuinely light. ─────────────
export const FRUTIGER_AERO_CSS = buildTheme({
    bg: "linear-gradient(180deg, #d2efff 0%, #eef9ff 45%, #ffffff 100%)",
    panel: "linear-gradient(180deg, #ffffff 0%, #e4f4ff 100%)", panelBorder: "#a9d8f0",
    surface: "#ffffff", surfaceBorder: "#cfe9f8",
    text: "#0c3a5a", muted: "#4f7e9c", accent: "#0f86d8",
    font: undefined,
    input: "#ffffff", inputText: "#0c3a5a", inputBorder: "#9fcde8", placeholder: "#8fb6cf",
    btn: "linear-gradient(180deg, #ffffff 0%, #d8efff 100%)", btnText: "#0c3a5a",
    btnBorder: "#9fcde8", btnHover: "linear-gradient(180deg, #ffffff 0%, #c2e7fb 100%)",
    btnShadow: "0 1px 2px rgba(12,58,90,0.18), inset 0 1px 0 rgba(255,255,255,0.9)",
    primary: "linear-gradient(180deg, #5cc0ff 0%, #1488e0 100%)", primaryText: "#ffffff", primaryBorder: "#1378c6",
    active: "linear-gradient(180deg, #c6ecff 0%, #8fd6f7 100%)", activeText: "#0c3a5a",
    chip: "linear-gradient(180deg, #ffffff 0%, #e6f5ff 100%)", chipText: "#0c3a5a", chipBorder: "#a9d8f0",
    warn: "linear-gradient(180deg, #fff3c4 0%, #ffe27a 100%)", warnText: "#6b5400",
    scan: "linear-gradient(180deg, #d3f0ff 0%, #9fd9f5 100%)", scanText: "#0c3a5a",
    error: "linear-gradient(180deg, #ffd5d5 0%, #f29a9a 100%)", errorText: "#7a1414",
    heygoogle: "linear-gradient(180deg, #e6d9ff 0%, #c3a6f0 100%)", heygoogleText: "#3a1a6b",
    progress: "linear-gradient(90deg, #5cc0ff, #1488e0)", scrollThumb: "linear-gradient(180deg, #9fd9f5, #5cc0ff)",
    thumb: "#dceefb", dotOn: "#3ec46b", avatarBorder: "#9fcde8",
    modalShadow: "0 10px 36px rgba(12,58,90,0.28)", backdrop: "rgba(12,58,90,0.28)",
    hoverFilter: "brightness(0.96)",
});

// ── CloudCyber — soft sky/cloud pastels, airy white-blue. ────────────────────
export const CLOUDCYBER_CSS = buildTheme({
    bg: "linear-gradient(180deg, #eaf6ff 0%, #f6fbff 60%, #ffffff 100%)",
    panel: "rgba(255,255,255,0.85)", panelBorder: "#d4e9f7",
    surface: "rgba(255,255,255,0.92)", surfaceBorder: "#e0eef9",
    text: "#3a4a63", muted: "#8aa0bb", accent: "#7aa7e0",
    input: "#ffffff", inputText: "#3a4a63", inputBorder: "#cfe0f0", placeholder: "#aebfd4",
    btn: "#ffffff", btnText: "#4a6694", btnBorder: "#d4e4f4", btnHover: "#eef6ff",
    btnShadow: "0 1px 3px rgba(120,150,200,0.18)",
    primary: "linear-gradient(180deg, #aaccf5 0%, #7aa7e0 100%)", primaryText: "#ffffff", primaryBorder: "#6f9bd6",
    active: "#dceaf9", activeText: "#3a4a63",
    chip: "#f0f6fd", chipText: "#5a73a0", chipBorder: "#dbe8f6",
    warn: "#fdf2cf", warnText: "#8a6d1a", scan: "#deeffb", scanText: "#3a4a63",
    error: "#fbdede", errorText: "#9a3838", heygoogle: "#ece2fb", heygoogleText: "#6a4aa0",
    progress: "linear-gradient(90deg, #aaccf5, #7aa7e0)", scrollThumb: "#bcd6f0",
    thumb: "#e6f1fb", dotOn: "#7fcf9a", avatarBorder: "#aaccf5",
    modalShadow: "0 12px 40px rgba(120,150,200,0.25)", backdrop: "rgba(90,120,170,0.22)",
    hoverFilter: "brightness(0.96)",
});

// ── Cyber Y2K (Y2K Futurism) — chrome silver, electric blue + hot pink. ──────
export const CYBER_Y2K_CSS = buildTheme({
    bg: "linear-gradient(160deg, #c9d2e0 0%, #e8edf5 40%, #f4f1f7 100%)",
    panel: "linear-gradient(180deg, #f6f8fc 0%, #cdd6e6 100%)", panelBorder: "#9aa7bd",
    surface: "linear-gradient(180deg, #ffffff 0%, #dbe2ee 100%)", surfaceBorder: "#aab6cc",
    text: "#23304a", muted: "#6f7e9a", accent: "#ff3ea5",
    titleShadow: "0 1px 0 #ffffff",
    input: "#ffffff", inputText: "#23304a", inputBorder: "#9aa7bd", placeholder: "#9aa7bd",
    btn: "linear-gradient(180deg, #ffffff 0%, #c7d0e0 100%)", btnText: "#23304a",
    btnBorder: "#8d9bb4", btnHover: "linear-gradient(180deg, #ffffff 0%, #b6c2d8 100%)",
    btnShadow: "inset 0 1px 0 rgba(255,255,255,0.95), 0 1px 2px rgba(40,55,90,0.25)",
    primary: "linear-gradient(180deg, #ff7ac4 0%, #ff1e93 100%)", primaryText: "#ffffff", primaryBorder: "#d80f74",
    active: "linear-gradient(180deg, #bfe0ff 0%, #6db4f5 100%)", activeText: "#0b2747",
    chip: "linear-gradient(180deg, #ffffff 0%, #d3dcec 100%)", chipText: "#33415e", chipBorder: "#9aa7bd",
    warn: "linear-gradient(180deg, #fff0a8 0%, #ffd23d 100%)", warnText: "#6b5400",
    scan: "linear-gradient(180deg, #c4e8ff 0%, #5fb4f5 100%)", scanText: "#0b2747",
    error: "linear-gradient(180deg, #ffc0d4 0%, #ff5d8a 100%)", errorText: "#6b0d2a",
    heygoogle: "linear-gradient(180deg, #e3d2ff 0%, #b388ff 100%)", heygoogleText: "#2e1065",
    progress: "linear-gradient(90deg, #ff7ac4, #ff1e93)", scrollThumb: "linear-gradient(180deg, #cdd6e6, #9aa7bd)",
    thumb: "#cdd6e6", dotOn: "#37d67a", avatarBorder: "#ff3ea5",
    modalShadow: "0 10px 34px rgba(40,55,90,0.35)", backdrop: "rgba(40,55,90,0.3)",
    hoverFilter: "brightness(0.96)",
});

// ── Utopian Scholastic — warm parchment, navy + gold, serif academia. ────────
export const UTOPIAN_SCHOLASTIC_CSS = buildTheme({
    bg: "#f4ecd8",
    panel: "#efe4c9", panelBorder: "#cbb787",
    surface: "#fbf5e6", surfaceBorder: "#dac9a0",
    text: "#3a2f1c", muted: "#8a7a58", accent: "#1d3a6b",
    font: "Georgia, 'Times New Roman', serif",
    input: "#fffdf6", inputText: "#3a2f1c", inputBorder: "#cbb787", placeholder: "#a99873",
    btn: "#efe4c9", btnText: "#3a2f1c", btnBorder: "#cbb787", btnHover: "#e6d8b6",
    btnShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
    primary: "#1d3a6b", primaryText: "#f4ecd8", primaryBorder: "#142a52",
    active: "#d8c79b", activeText: "#3a2f1c",
    chip: "#efe4c9", chipText: "#5a4a2c", chipBorder: "#cbb787",
    warn: "#e8d28a", warnText: "#6b5215", scan: "#cfe0d0", scanText: "#274a30",
    error: "#e6c0b0", errorText: "#7a2f1c", heygoogle: "#d6c8e0", heygoogleText: "#3e2a5a",
    progress: "#b8902f", scrollThumb: "#cbb787",
    thumb: "#e8dcc0", dotOn: "#5a8a4a", avatarBorder: "#b8902f",
    modalShadow: "0 10px 34px rgba(58,47,28,0.3)", backdrop: "rgba(58,47,28,0.32)",
    hoverFilter: "brightness(0.96)",
});

// ── Webcore — early-web: white page, blue links, gray bevels, Times. ─────────
export const WEBCORE_CSS = buildTheme({
    bg: "#ffffff",
    panel: "#d4d0c8", panelBorder: "#808080",
    surface: "#ececec", surfaceBorder: "#9a9a9a",
    text: "#000000", muted: "#555555", accent: "#0000cc",
    font: "'Times New Roman', Times, Georgia, serif",
    input: "#ffffff", inputText: "#000000", inputBorder: "#7f7f7f", placeholder: "#888888",
    btn: "#d4d0c8", btnText: "#000000", btnBorder: "#808080", btnHover: "#e2dfd8",
    btnShadow: "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #808080",
    primary: "#000080", primaryText: "#ffffff", primaryBorder: "#000050",
    active: "#c0c0c0", activeText: "#000000",
    chip: "#d4d0c8", chipText: "#000000", chipBorder: "#808080",
    warn: "#ffffcc", warnText: "#7a6000", scan: "#cce0ff", scanText: "#000080",
    error: "#ffcccc", errorText: "#990000", heygoogle: "#e0d0ff", heygoogleText: "#4b0082",
    progress: "#000080", scrollThumb: "#a8a8a8",
    thumb: "#c0c0c0", dotOn: "#008000", avatarBorder: "#0000cc",
    modalShadow: "2px 2px 0 #808080", backdrop: "rgba(0,0,0,0.4)",
    hoverFilter: "brightness(0.96)",
});

// ── Vaporwave — twilight purple, hot pink + cyan, soft neon. ─────────────────
export const VAPORWAVE_CSS = buildTheme({
    bg: "linear-gradient(180deg, #2a1248 0%, #5a2a6e 55%, #ff6ad5 140%)",
    panel: "#2d1850", panelBorder: "#7a3fa0",
    surface: "#34205c", surfaceBorder: "#6a3f96",
    text: "#f3e6ff", muted: "#b89ad6", accent: "#ff6ad5",
    titleShadow: "0 0 8px rgba(255,106,213,0.6)",
    input: "#241040", inputText: "#7afcff", inputBorder: "#7a3fa0", placeholder: "#8a6ab0",
    btn: "#3a2266", btnText: "#7afcff", btnBorder: "#8a4fc0", btnHover: "#4a2c80",
    btnShadow: "0 0 8px rgba(122,252,255,0.25)",
    primary: "linear-gradient(90deg, #ff6ad5 0%, #7afcff 100%)", primaryText: "#241040", primaryBorder: "#ff6ad5",
    active: "#4a2c80", activeText: "#7afcff",
    chip: "#3a2266", chipText: "#ffaee8", chipBorder: "#8a4fc0",
    warn: "#5a4a10", warnText: "#ffe66d", scan: "#103a4a", scanText: "#7afcff",
    error: "#4a1030", errorText: "#ff8ab0", heygoogle: "#3a1a5a", heygoogleText: "#c98bff",
    progress: "linear-gradient(90deg, #ff6ad5, #7afcff)", scrollThumb: "#7a3fa0",
    thumb: "#1f0d3a", dotOn: "#7afcff", avatarBorder: "#ff6ad5",
    modalShadow: "0 0 34px rgba(255,106,213,0.35)", backdrop: "rgba(20,8,40,0.8)",
});

// ── Terminal Green — black CRT, phosphor green monospace. ────────────────────
export const TERMINAL_GREEN_CSS = buildTheme({
    bg: "#020602",
    panel: "#031003", panelBorder: "#1f5a1f",
    surface: "#041404", surfaceBorder: "#1a4a1a",
    text: "#33ff66", muted: "#1f9a3f", accent: "#7dff7d",
    titleShadow: "0 0 6px rgba(51,255,102,0.7)",
    font: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
    input: "#031003", inputText: "#33ff66", inputBorder: "#1f5a1f", placeholder: "#1a6a2a",
    btn: "#04180a", btnText: "#33ff66", btnBorder: "#1f7a3f", btnHover: "#063012",
    btnShadow: "0 0 6px rgba(51,255,102,0.25)",
    primary: "#33ff66", primaryText: "#021004", primaryBorder: "#7dff7d",
    active: "#0a3a18", activeText: "#7dff7d",
    chip: "#04180a", chipText: "#33ff66", chipBorder: "#1f7a3f",
    warn: "#2a2a05", warnText: "#e6ff3d", scan: "#052a1a", scanText: "#33ffcc",
    error: "#2a0606", errorText: "#ff5555", heygoogle: "#0a2a2a", heygoogleText: "#33ffcc",
    progress: "#33ff66", scrollThumb: "#1f7a3f",
    thumb: "#020a02", dotOn: "#33ff66", avatarBorder: "#33ff66",
    modalShadow: "0 0 30px rgba(51,255,102,0.3)", backdrop: "rgba(0,8,0,0.88)",
});

// ── Solarized Dusk — the canonical solarized dark palette. ───────────────────
export const SOLARIZED_DUSK_CSS = buildTheme({
    bg: "#002b36",
    panel: "#073642", panelBorder: "#0d4a59",
    surface: "#063540", surfaceBorder: "#11515f",
    text: "#93a1a1", muted: "#586e75", accent: "#268bd2",
    input: "#002b36", inputText: "#93a1a1", inputBorder: "#0d4a59", placeholder: "#586e75",
    btn: "#073642", btnText: "#93a1a1", btnBorder: "#0d4a59", btnHover: "#0a4350",
    primary: "#268bd2", primaryText: "#002b36", primaryBorder: "#1f6fa8",
    active: "#0a4d5c", activeText: "#fdf6e3",
    chip: "#073642", chipText: "#93a1a1", chipBorder: "#0d4a59",
    warn: "#3a3410", warnText: "#b58900", scan: "#0a3a44", scanText: "#2aa198",
    error: "#3a1010", errorText: "#dc322f", heygoogle: "#2a1840", heygoogleText: "#6c71c4",
    progress: "#2aa198", scrollThumb: "#0d4a59",
    thumb: "#001f27", dotOn: "#859900", avatarBorder: "#268bd2",
    modalShadow: "0 12px 36px rgba(0,0,0,0.5)", backdrop: "rgba(0,20,26,0.8)",
});

// ── Sunset Synth — synthwave dusk, indigo night + orange/pink horizon. ───────
export const SUNSET_SYNTH_CSS = buildTheme({
    bg: "linear-gradient(180deg, #1a0b2e 0%, #3d1a52 50%, #ff5e62 150%)",
    panel: "#22103a", panelBorder: "#6a2f7a",
    surface: "#2a1545", surfaceBorder: "#5a2f7a",
    text: "#ffe7d6", muted: "#c89ab0", accent: "#ff8a5c",
    titleShadow: "0 0 8px rgba(255,138,92,0.6)",
    input: "#1a0d30", inputText: "#ffd2a6", inputBorder: "#6a2f7a", placeholder: "#9a6a8a",
    btn: "#311a52", btnText: "#ffd2a6", btnBorder: "#7a3f9a", btnHover: "#3e2266",
    btnShadow: "0 0 8px rgba(255,138,92,0.25)",
    primary: "linear-gradient(90deg, #ff8a5c 0%, #ff3e7f 100%)", primaryText: "#1a0b2e", primaryBorder: "#ff5e62",
    active: "#4a2670", activeText: "#ffd2a6",
    chip: "#311a52", chipText: "#ffb38a", chipBorder: "#7a3f9a",
    warn: "#4a3a10", warnText: "#ffd24d", scan: "#2a1a52", scanText: "#9a8aff",
    error: "#4a1030", errorText: "#ff6a8a", heygoogle: "#2a1850", heygoogleText: "#b39aff",
    progress: "linear-gradient(90deg, #ff8a5c, #ff3e7f)", scrollThumb: "#6a2f7a",
    thumb: "#150a28", dotOn: "#ffb35c", avatarBorder: "#ff8a5c",
    modalShadow: "0 0 34px rgba(255,94,98,0.3)", backdrop: "rgba(15,6,30,0.82)",
});

// ── Paper Ink — clean light paper, black ink, single red accent. ─────────────
export const PAPER_INK_CSS = buildTheme({
    bg: "#faf9f6",
    panel: "#f2f0ea", panelBorder: "#d8d4ca",
    surface: "#ffffff", surfaceBorder: "#e2ded4",
    text: "#1c1c1a", muted: "#76736a", accent: "#c0392b",
    input: "#ffffff", inputText: "#1c1c1a", inputBorder: "#cfcabd", placeholder: "#a8a399",
    btn: "#ffffff", btnText: "#1c1c1a", btnBorder: "#d0ccc0", btnHover: "#f0eee8",
    btnShadow: "0 1px 2px rgba(28,28,26,0.08)",
    primary: "#c0392b", primaryText: "#ffffff", primaryBorder: "#a02e22",
    active: "#e8e4da", activeText: "#1c1c1a",
    chip: "#f0eee8", chipText: "#3a3a36", chipBorder: "#dcd8ce",
    warn: "#f6e6b8", warnText: "#7a5e10", scan: "#dde9ef", scanText: "#1f4a5e",
    error: "#f3d4cf", errorText: "#9a2a1c", heygoogle: "#e2dcf0", heygoogleText: "#4a3a7a",
    progress: "#c0392b", scrollThumb: "#cfcabd",
    thumb: "#eceae3", dotOn: "#3a8a4a", avatarBorder: "#c0392b",
    modalShadow: "0 12px 40px rgba(28,28,26,0.18)", backdrop: "rgba(28,28,26,0.28)",
    hoverFilter: "brightness(0.96)",
});
