// "V2" built-in themes — animated reimaginings of the originals. The originals
// in builtinCss.ts are left untouched; these are additive, separate entries.
//
// Each reuses its V1 colour palette but switches to animated mode: the scene is
// carried by the fixed `.rs-bg` layer stack (see Palette.bgAnim + ThemeStyle.tsx)
// so the wallpaper actually moves, and the chrome panels go slightly translucent
// so the motion reads through and the rest of the UI complements the centerpiece
// background. Border treatment is chosen per theme — the racing `beam` stays
// where it suits the mood (cyber/synth/molten); calmer themes (Aurora, Frutiger)
// swap it for a gentle breathing glow.

import { buildTheme, arrowCursor, type Palette } from "./builtinCss";
import { gentleGlowBorder, orbField, perspectiveGrid, drift, rise } from "./animations";

// ── Cyberpunk V2 — neon tunnel: receding 3D floor + ceiling grids that stream
//    toward you past a drifting magenta/cyan horizon bloom. ──────────────────
const CYBERPUNK_V2_ANIM =
    `.rs-bg-1 { background:
        radial-gradient(ellipse 60% 40% at 50% 50%, hsla(320,100%,59%,0.24), transparent 60%),
        radial-gradient(ellipse 85% 30% at 50% 52%, hsla(182,100%,72%,0.16), transparent 66%); }`
    + drift({ sel: ".rs-bg-1", key: "glow", dx: 0, dy: -16, speedSec: 14, scale: 1.2 })
    + perspectiveGrid({ sel: ".rs-bg-2", key: "floor", color: "hsla(182,100%,72%,0.8)", tile: 56, width: 2, speedSec: 4.5, persp: 700, rot: 62, horizon: 0.52 })
    + perspectiveGrid({ sel: ".rs-bg-3", key: "roof", color: "hsla(320,100%,59%,0.55)", tile: 56, width: 2, speedSec: 5, persp: 700, rot: 62, horizon: 0.48, ceiling: true });

export const CYBERPUNK_V2_CSS = buildTheme({
    bg: "radial-gradient(ellipse 120% 90% at 50% 42%, hsl(228, 36%, 7%) 0%, hsl(228, 38%, 3%) 72%)",
    panel: "hsla(224, 44%, 5%, 0.82)", panelBorder: "hsl(190, 53%, 26%)",
    surface: "hsla(220, 38%, 6%, 0.82)", surfaceBorder: "hsl(190, 51%, 25%)",
    text: "hsl(190, 100%, 92%)", muted: "hsl(188, 46%, 57%)", accent: "hsl(320, 100%, 59%)",
    titleShadow: "0 0 10px hsla(320, 100%, 59%, 0.9), 0 0 22px hsla(320, 100%, 59%, 0.5)",
    input: "hsl(217, 39%, 6%)", inputText: "hsl(182, 100%, 72%)", inputBorder: "hsl(188, 53%, 39%)", placeholder: "hsl(191, 41%, 31%)",
    btn: "hsla(218, 48%, 9%, 0.85)", btnText: "hsl(182, 100%, 72%)", btnBorder: "hsl(188, 53%, 39%)", btnHover: "hsl(200, 60%, 16%)",
    btnShadow: "0 0 10px hsla(182, 100%, 72%, 0.4), inset 0 0 6px hsla(182, 100%, 72%, 0.15)",
    primary: "hsl(320, 100%, 59%)", primaryText: "hsl(228, 29%, 3%)", primaryBorder: "hsl(319, 100%, 75%)",
    active: "hsl(196, 59%, 17%)", activeText: "hsl(182, 100%, 72%)",
    chip: "hsla(218, 48%, 9%, 0.85)", chipText: "hsl(182, 100%, 72%)", chipBorder: "hsl(188, 53%, 39%)",
    warn: "hsl(46, 71%, 10%)", warnText: "hsl(51, 100%, 62%)", scan: "hsl(197, 71%, 10%)", scanText: "hsl(182, 100%, 72%)",
    error: "hsl(341, 71%, 10%)", errorText: "hsl(349, 100%, 68%)", heygoogle: "hsl(270, 62%, 10%)", heygoogleText: "hsl(272, 100%, 77%)",
    progress: "hsl(320, 100%, 59%)", scrollThumb: "hsl(188, 53%, 39%)", thumb: "hsl(231, 54%, 3%)",
    dotOn: "hsl(182, 100%, 72%)", avatarBorder: "hsl(320, 100%, 59%)",
    modalShadow: "0 0 40px hsla(320, 100%, 59%, 0.45)", backdrop: "hsla(225, 67%, 2%, 0.85)",
    beam: "transparent 55%, hsl(182, 100%, 72%) 78%, hsl(320, 100%, 59%) 100%",
    cursor: arrowCursor("hsl(320, 100%, 59%)", "hsl(182, 100%, 72%)"),
    bgAnim: CYBERPUNK_V2_ANIM,
});

// ── Frutiger Aero V2 — light & glossy, with slow-floating bokeh, gently rising
//    aqua bubbles and a drifting light sweep. Gentle breathing border, no beam. ─
const FRUTIGER_AERO_V2_ANIM =
    `.rs-bg-1 { background: ${orbField({ seed: 11, count: 10, color: "hsla(0,0%,100%,0.55)", minR: 8, maxR: 20, softEdge: 0.1 })}; }`
    + drift({ sel: ".rs-bg-1", key: "bokeh", dx: 26, dy: -34, speedSec: 28, scale: 1.3 })
    + `.rs-bg-2 { background: ${orbField({ seed: 5, count: 9, color: "hsla(195,90%,75%,0.4)", minR: 4, maxR: 11 })}; }`
    + rise({ sel: ".rs-bg-2", key: "bub", distance: 220, speedSec: 22, scale: 1.3, fade: true })
    + `.rs-bg-3 { background: linear-gradient(115deg, transparent 32%, hsla(0,0%,100%,0.28) 50%, transparent 68%); }`
    + drift({ sel: ".rs-bg-3", key: "sweep", dx: -130, dy: 0, speedSec: 19, scale: 1.7 });

export const FRUTIGER_AERO_V2_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(201, 100%, 91%) 0%, hsl(201, 100%, 97%) 45%, hsl(0, 0%, 100%) 100%)",
    panel: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.9) 0%, hsla(204, 100%, 95%, 0.86) 100%)", panelBorder: "hsl(200, 70%, 80%)",
    surface: "hsla(0, 0%, 100%, 0.9)", surfaceBorder: "hsl(202, 75%, 89%)",
    text: "hsl(205, 76%, 20%)", muted: "hsl(203, 33%, 46%)", accent: "hsl(204, 87%, 45%)",
    input: "hsl(0, 0%, 100%)", inputText: "hsl(205, 76%, 20%)", inputBorder: "hsl(202, 61%, 77%)", placeholder: "hsl(203, 40%, 69%)",
    btn: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(205, 100%, 92%) 100%)", btnText: "hsl(205, 76%, 20%)",
    btnBorder: "hsl(202, 61%, 77%)", btnHover: "linear-gradient(180deg, hsl(0, 0%, 100%) 0%, hsl(201, 88%, 87%) 100%)",
    btnShadow: "0 1px 2px hsla(205, 76%, 20%, 0.18), inset 0 1px 0 hsla(0, 0%, 100%, 0.9)",
    primary: "linear-gradient(180deg, hsl(203, 100%, 68%) 0%, hsl(206, 84%, 48%) 100%)", primaryText: "hsl(0, 0%, 100%)", primaryBorder: "hsl(206, 82%, 43%)",
    active: "linear-gradient(180deg, hsl(200, 100%, 89%) 0%, hsl(199, 87%, 76%) 100%)", activeText: "hsl(205, 76%, 20%)",
    chip: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.92) 0%, hsla(204, 100%, 95%, 0.9) 100%)", chipText: "hsl(205, 76%, 20%)", chipBorder: "hsl(200, 70%, 80%)",
    warn: "linear-gradient(180deg, hsl(48, 100%, 88%) 0%, hsl(47, 100%, 74%) 100%)", warnText: "hsl(47, 100%, 21%)",
    scan: "linear-gradient(180deg, hsl(200, 100%, 91%) 0%, hsl(200, 81%, 79%) 100%)", scanText: "hsl(205, 76%, 20%)",
    error: "linear-gradient(180deg, hsl(0, 100%, 92%) 0%, hsl(0, 77%, 78%) 100%)", errorText: "hsl(0, 72%, 28%)",
    heygoogle: "linear-gradient(180deg, hsl(261, 100%, 93%) 0%, hsl(264, 71%, 80%) 100%)", heygoogleText: "hsl(264, 61%, 26%)",
    progress: "linear-gradient(90deg, hsl(203, 100%, 68%), hsl(206, 84%, 48%))", scrollThumb: "linear-gradient(180deg, hsl(200, 81%, 79%), hsl(203, 100%, 68%))",
    thumb: "hsl(205, 79%, 92%)", dotOn: "hsl(140, 53%, 51%)", avatarBorder: "hsl(202, 61%, 77%)",
    modalShadow: "0 10px 36px hsla(205, 76%, 20%, 0.28)", backdrop: "hsla(205, 76%, 20%, 0.28)",
    hoverFilter: "brightness(0.96)",
    bgAnim: FRUTIGER_AERO_V2_ANIM,
    extra: gentleGlowBorder({ glow: "hsla(199, 90%, 60%, 0.5)", glow2: "hsla(199, 100%, 75%, 0.35)", border: "hsl(199, 90%, 70%)", durationSec: 6 }),
});

// ── Vaporwave V2 — twilight dream: a slowly pulsing sun behind a streaming
//    synthwave grid, with cyan haze orbs drifting overhead. ───────────────────
const VAPORWAVE_V2_ANIM =
    `.rs-bg-1 { background: radial-gradient(circle at 50% 80%, hsla(317,100%,71%,0.5), hsla(317,100%,71%,0.12) 22%, transparent 46%); }`
    + drift({ sel: ".rs-bg-1", key: "sun", dx: 0, dy: -12, speedSec: 11, scale: 1.1 })
    + perspectiveGrid({ sel: ".rs-bg-2", key: "floor", color: "hsla(181,100%,74%,0.7)", tile: 60, width: 2, speedSec: 4.5, persp: 700, rot: 62, horizon: 0.5 })
    + `.rs-bg-3 { background: ${orbField({ seed: 9, count: 7, color: "hsla(181,100%,74%,0.22)", minR: 5, maxR: 13 })}; }`
    + drift({ sel: ".rs-bg-3", key: "haze", dx: 34, dy: -26, speedSec: 26, scale: 1.3 });

export const VAPORWAVE_V2_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(267, 60%, 16%) 0%, hsl(282, 45%, 26%) 55%, hsl(317, 70%, 40%) 130%)",
    panel: "hsla(263, 54%, 20%, 0.82)", panelBorder: "hsl(276, 43%, 44%)",
    surface: "hsla(260, 48%, 24%, 0.82)", surfaceBorder: "hsl(270, 41%, 42%)",
    text: "hsl(271, 100%, 95%)", muted: "hsl(270, 42%, 72%)", accent: "hsl(317, 100%, 71%)",
    titleShadow: "0 0 8px hsla(317, 100%, 71%, 0.6)",
    input: "hsl(265, 60%, 16%)", inputText: "hsl(181, 100%, 74%)", inputBorder: "hsl(276, 43%, 44%)", placeholder: "hsl(267, 31%, 55%)",
    btn: "hsla(261, 50%, 27%, 0.85)", btnText: "hsl(181, 100%, 74%)", btnBorder: "hsl(271, 47%, 53%)", btnHover: "hsl(261, 49%, 34%)",
    btnShadow: "0 0 8px hsla(181, 100%, 74%, 0.25)",
    primary: "linear-gradient(90deg, hsl(317, 100%, 71%) 0%, hsl(181, 100%, 74%) 100%)", primaryText: "hsl(265, 60%, 16%)", primaryBorder: "hsl(317, 100%, 71%)",
    active: "hsl(261, 49%, 34%)", activeText: "hsl(181, 100%, 74%)",
    chip: "hsla(261, 50%, 27%, 0.85)", chipText: "hsl(317, 100%, 84%)", chipBorder: "hsl(271, 47%, 53%)",
    warn: "hsl(47, 70%, 21%)", warnText: "hsl(50, 100%, 71%)", scan: "hsl(197, 64%, 18%)", scanText: "hsl(181, 100%, 74%)",
    error: "hsl(327, 64%, 18%)", errorText: "hsl(341, 100%, 77%)", heygoogle: "hsl(270, 55%, 23%)", heygoogleText: "hsl(272, 100%, 77%)",
    progress: "linear-gradient(90deg, hsl(317, 100%, 71%), hsl(181, 100%, 74%))", scrollThumb: "hsl(276, 43%, 44%)",
    thumb: "hsl(264, 63%, 14%)", dotOn: "hsl(181, 100%, 74%)", avatarBorder: "hsl(317, 100%, 71%)",
    modalShadow: "0 0 40px hsla(317, 100%, 71%, 0.45)", backdrop: "hsla(263, 67%, 9%, 0.8)",
    beam: "transparent 55%, hsl(181, 100%, 74%) 78%, hsl(317, 100%, 71%) 100%",
    cursor: arrowCursor("hsl(317, 100%, 71%)", "hsl(181, 100%, 74%)"),
    bgAnim: VAPORWAVE_V2_ANIM,
});

// ── Molten Core V2 — a churning lava glow drifts along the bottom while embers
//    rise in two overlapping streams. Warm racing border kept. ────────────────
const MOLTEN_CORE_V2_ANIM =
    `.rs-bg-1 { background: radial-gradient(ellipse 95% 55% at 50% 112%, hsla(18,100%,50%,0.55), hsla(22,100%,55%,0.18) 45%, transparent 72%); }`
    + drift({ sel: ".rs-bg-1", key: "lava", dx: 64, dy: 0, speedSec: 13, scale: 1.3 })
    + `.rs-bg-2 { background: ${orbField({ seed: 7, count: 7, color: "hsla(28,100%,58%,0.55)", minR: 3, maxR: 9 })}; }`
    + rise({ sel: ".rs-bg-2", key: "e1", distance: 540, speedSec: 9, scale: 1.3, fade: true })
    + `.rs-bg-3 { background: ${orbField({ seed: 23, count: 10, color: "hsla(36,100%,62%,0.45)", minR: 2, maxR: 6 })}; }`
    + rise({ sel: ".rs-bg-3", key: "e2", distance: 580, speedSec: 11, scale: 1.4, delaySec: 4, fade: true });

export const MOLTEN_CORE_V2_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(20, 18%, 5%) 0%, hsl(16, 30%, 8%) 55%, hsl(18, 70%, 14%) 130%)",
    panel: "hsla(18, 22%, 8%, 0.82)", panelBorder: "hsl(22, 60%, 32%)",
    surface: "hsla(17, 24%, 10%, 0.82)", surfaceBorder: "hsl(20, 55%, 30%)",
    text: "hsl(30, 62%, 88%)", muted: "hsl(25, 36%, 60%)", accent: "hsl(22, 100%, 58%)",
    titleShadow: "0 0 10px hsla(22, 100%, 58%, 0.8), 0 0 24px hsla(8, 100%, 55%, 0.5)",
    input: "hsl(18, 26%, 7%)", inputText: "hsl(30, 90%, 73%)", inputBorder: "hsl(22, 55%, 34%)", placeholder: "hsl(24, 25%, 42%)",
    btn: "hsla(18, 26%, 11%, 0.85)", btnText: "hsl(30, 90%, 75%)", btnBorder: "hsl(22, 55%, 36%)", btnHover: "hsl(18, 50%, 18%)",
    btnShadow: "0 0 10px hsla(22, 100%, 58%, 0.3), inset 0 0 6px hsla(22, 100%, 58%, 0.14)",
    primary: "linear-gradient(90deg, hsl(30, 100%, 55%) 0%, hsl(8, 100%, 52%) 100%)", primaryText: "hsl(20, 30%, 6%)", primaryBorder: "hsl(22, 100%, 58%)",
    active: "hsl(18, 55%, 18%)", activeText: "hsl(30, 90%, 75%)",
    chip: "hsla(18, 26%, 11%, 0.85)", chipText: "hsl(30, 85%, 71%)", chipBorder: "hsl(22, 55%, 36%)",
    warn: "hsl(45, 70%, 12%)", warnText: "hsl(45, 100%, 62%)", scan: "hsl(30, 72%, 12%)", scanText: "hsl(36, 100%, 63%)",
    error: "hsl(0, 70%, 14%)", errorText: "hsl(2, 100%, 67%)", heygoogle: "hsl(330, 46%, 16%)", heygoogleText: "hsl(330, 100%, 77%)",
    progress: "linear-gradient(90deg, hsl(30, 100%, 55%), hsl(8, 100%, 52%))", scrollThumb: "hsl(22, 55%, 36%)",
    thumb: "hsl(18, 30%, 4%)", dotOn: "hsl(30, 100%, 55%)", avatarBorder: "hsl(22, 100%, 58%)",
    modalShadow: "0 0 40px hsla(15, 100%, 50%, 0.45)", backdrop: "hsla(18, 50%, 3%, 0.86)",
    beam: "transparent 55%, hsl(30, 100%, 58%) 78%, hsl(8, 100%, 55%) 100%",
    cursor: arrowCursor("hsl(22, 100%, 58%)", "hsl(30, 90%, 75%)"),
    bgAnim: MOLTEN_CORE_V2_ANIM,
});

// ── Aurora V2 — the night sky floats: two curtain layers drift at different
//    speeds (parallax) over a near-still star field. Gentle breathing border
//    replaces the harsh racing laser of the original. ─────────────────────────
const AURORA_V2_ANIM =
    `.rs-bg-1 { background: ${orbField({ seed: 3, count: 60, color: "hsla(0,0%,100%,0.85)", minR: 0.15, maxR: 0.5, softEdge: 0.4 })}; }`
    + drift({ sel: ".rs-bg-1", key: "stars", dx: -14, dy: 8, speedSec: 64, scale: 1.15 })
    + `.rs-bg-2 { background:
        radial-gradient(ellipse 55% 34% at 28% 26%, hsla(150,82%,55%,0.42), transparent 70%),
        radial-gradient(ellipse 45% 28% at 70% 32%, hsla(170,78%,55%,0.34), transparent 72%),
        radial-gradient(ellipse 40% 26% at 52% 20%, hsla(150,82%,58%,0.3), transparent 70%); }`
    + drift({ sel: ".rs-bg-2", key: "cur1", dx: 52, dy: 16, speedSec: 34, scale: 1.3 })
    + `.rs-bg-3 { background:
        radial-gradient(ellipse 50% 32% at 80% 24%, hsla(278,74%,64%,0.38), transparent 72%),
        radial-gradient(ellipse 42% 26% at 35% 30%, hsla(265,72%,62%,0.3), transparent 72%); }`
    + drift({ sel: ".rs-bg-3", key: "cur2", dx: -72, dy: -10, speedSec: 21, scale: 1.35 });

export const AURORA_V2_CSS = buildTheme({
    bg: "linear-gradient(180deg, hsl(230, 45%, 6%) 0%, hsl(215, 48%, 9%) 55%, hsl(200, 44%, 12%) 100%)",
    panel: "hsla(228, 40%, 9%, 0.82)", panelBorder: "hsl(162, 42%, 30%)",
    surface: "hsla(226, 38%, 11%, 0.82)", surfaceBorder: "hsl(165, 36%, 28%)",
    text: "hsl(158, 60%, 88%)", muted: "hsl(176, 26%, 60%)", accent: "hsl(150, 80%, 62%)",
    titleShadow: "0 0 10px hsla(150, 80%, 62%, 0.7), 0 0 22px hsla(278, 72%, 65%, 0.4)",
    input: "hsl(228, 42%, 8%)", inputText: "hsl(155, 80%, 76%)", inputBorder: "hsl(162, 42%, 34%)", placeholder: "hsl(176, 20%, 45%)",
    btn: "hsla(225, 38%, 12%, 0.85)", btnText: "hsl(155, 80%, 78%)", btnBorder: "hsl(165, 40%, 34%)", btnHover: "hsl(190, 46%, 18%)",
    btnShadow: "0 0 10px hsla(150, 80%, 62%, 0.25), inset 0 0 6px hsla(150, 80%, 62%, 0.12)",
    primary: "linear-gradient(90deg, hsl(150, 80%, 55%) 0%, hsl(278, 75%, 65%) 100%)", primaryText: "hsl(230, 45%, 7%)", primaryBorder: "hsl(150, 80%, 62%)",
    active: "hsl(190, 46%, 18%)", activeText: "hsl(155, 80%, 78%)",
    chip: "hsla(225, 38%, 12%, 0.85)", chipText: "hsl(155, 72%, 72%)", chipBorder: "hsl(165, 40%, 34%)",
    warn: "hsl(45, 60%, 12%)", warnText: "hsl(48, 100%, 65%)", scan: "hsl(190, 56%, 12%)", scanText: "hsl(180, 82%, 66%)",
    error: "hsl(345, 56%, 14%)", errorText: "hsl(350, 100%, 73%)", heygoogle: "hsl(278, 50%, 16%)", heygoogleText: "hsl(280, 92%, 82%)",
    progress: "linear-gradient(90deg, hsl(150, 80%, 55%), hsl(278, 75%, 65%))", scrollThumb: "hsl(165, 40%, 34%)",
    thumb: "hsl(230, 50%, 5%)", dotOn: "hsl(150, 80%, 55%)", avatarBorder: "hsl(150, 80%, 62%)",
    modalShadow: "0 0 40px hsla(150, 80%, 55%, 0.4)", backdrop: "hsla(230, 55%, 4%, 0.85)",
    cursor: arrowCursor("hsl(150, 80%, 62%)", "hsl(278, 72%, 78%)"),
    bgAnim: AURORA_V2_ANIM,
    extra: gentleGlowBorder({ glow: "hsla(150, 80%, 55%, 0.45)", glow2: "hsla(278, 72%, 62%, 0.3)", border: "hsl(150, 70%, 55%)", durationSec: 6.5 }),
});
