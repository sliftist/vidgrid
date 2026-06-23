// Reusable CSS-animation builders for the "V2" animated themes. Each returns a
// raw CSS string (keyframes + rules) that a theme drops into Palette.bgAnim (for
// the fixed `.rs-bg` layer stack) or Palette.extra (for border/chrome flair).
//
// Everything animates `transform` / `opacity` / `background-position` only, so
// the work stays on the compositor and a full-screen moving wallpaper costs
// almost nothing. Only one theme's CSS is ever injected at a time, so keyframe
// names can't collide across themes; within a theme, callers pass a unique
// `key` where two instances of the same effect coexist.

// Soft "breathing" border glow for chrome + primary controls — the gentle
// alternative to the racing conic `beam` (which reads as harsh laser lines on
// calmer themes). Pulses box-shadow + border-color in and out instead of racing
// a line around the edge. Grid cells glow only on hover, on a faster cycle so
// they don't march in lockstep with the chrome.
export function gentleGlowBorder(p: {
    glow: string;        // peak outer glow color (hsla)
    glow2?: string;      // optional second, wider glow color (hsla)
    border: string;      // border-color at the peak of the pulse (hsl/hsla)
    durationSec?: number;
}): string {
    const d = p.durationSec ?? 5.5;
    const wide = p.glow2 ? `, 0 0 30px ${p.glow2}` : "";
    return `
@keyframes rs-soft-glow {
    0%, 100% { box-shadow: 0 0 4px ${p.glow}; }
    50% { box-shadow: 0 0 14px ${p.glow}${wide}; border-color: ${p.border}; }
}
.Header, .Modal, .PlayerBar, .Button--primary, .Chip--primary, .SeriesCount {
    animation: rs-soft-glow ${d}s ease-in-out infinite;
}
.Modal { animation-duration: ${(d * 1.3).toFixed(1)}s; }
.GridCell:hover { animation: rs-soft-glow ${(d * 0.55).toFixed(1)}s ease-in-out infinite; }
`;
}

// Deterministic PRNG so generated layouts (orbs/stars) stay stable across
// rebuilds — no churn in the emitted CSS string.
function prng(seed: number): () => number {
    let s = seed % 233280 || 1;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// A scatter of soft radial blobs as a single background-image value (comma-list
// of radial-gradients). Used as a layer's wallpaper that the theme then drifts
// via transform. `color` is the blob core (hsla); blobs fade to transparent by
// their individual radius (a % of the element box).
export function orbField(p: {
    seed: number; count: number; color: string;
    minR: number; maxR: number;   // blob radius as % of box
    softEdge?: number;            // 0..1 fraction of radius that's solid before fade
}): string {
    const rnd = prng(p.seed);
    const soft = p.softEdge ?? 0.15;
    const orbs: string[] = [];
    for (let i = 0; i < p.count; i++) {
        const x = (rnd() * 100).toFixed(1);
        const y = (rnd() * 100).toFixed(1);
        const r = (p.minR + rnd() * (p.maxR - p.minR));
        const inner = (r * soft).toFixed(2);
        orbs.push(`radial-gradient(circle at ${x}% ${y}%, ${p.color} 0, ${p.color} ${inner}%, transparent ${r.toFixed(2)}%)`);
    }
    return orbs.join(", ");
}

// A pseudo-3D grid floor that scrolls toward the camera. The grid lives on a
// `::before` plane anchored at the near edge (screen bottom for a floor) and
// tilted away with rotateX; the *layer* carries `perspective` +
// `perspective-origin` so the vanishing point sits at the horizon line (not at
// the rotation pivot — that's the trap with the `perspective()` transform
// function, which pins the vanishing point to transform-origin and collapses the
// whole plane into a sliver at the near edge). With the vanishing point placed
// independently, the floor fills from the near edge up to `horizon` and the grid
// lines stream forward by animating background-position. Pass `ceiling: true` for
// a mirrored roof plane anchored at the top. The layer is masked in screen space
// so the lines dissolve into the horizon rather than cutting off hard.
export function perspectiveGrid(p: {
    sel: string;          // layer selector, e.g. ".rs-bg-2"
    key: string;          // unique keyframe suffix within the theme
    color: string;        // grid line color (hsla)
    tile?: number;        // grid cell size in px
    width?: number;       // grid line thickness in px
    feather?: number;     // soft anti-alias ramp on each line edge, px
    blur?: number;        // screen-space low-pass to kill minification shimmer, px
    speedSec?: number;    // time for one tile to scroll forward
    persp?: number;       // perspective depth (smaller = steeper recession)
    rot?: number;         // floor tilt in degrees (toward 90 = flatter floor)
    horizon?: number;     // 0..1 viewport fraction where the horizon sits
    ceiling?: boolean;    // anchor at the top as a roof plane instead
}): string {
    const tile = p.tile ?? 48;
    const w = p.width ?? 2;
    const speed = p.speedSec ?? 4;
    const persp = p.persp ?? 700;
    const rot = p.rot ?? 62;
    const horizon = p.horizon ?? 0.5;
    // Two-part shimmer fix. The grid is one rasterized texture the GPU minifies
    // (no mipmaps) as perspective compresses the far field, so dense lines alias
    // and flash. (1) Feather each line edge with a sub-pixel transparent→color
    // ramp; lines are centered in their band so both edges ramp evenly and the
    // pattern still repeats every `tile`px (keeping translateY(tile) seamless).
    // Feathering alone only half-helps because it lives in texture space and gets
    // minified along with the lines. (2) The real catch is the `filter: blur` on
    // the layer below: the transform is on `::before`, the layer itself is
    // untransformed, so a blur there low-passes the already-composited, already-
    // minified result in SCREEN space — exactly where the aliasing shows up.
    const f = p.feather ?? 0.75;
    const c = tile / 2;
    const half = w / 2;
    const a = (c - half - f).toFixed(2);
    const b = (c - half).toFixed(2);
    const d = (c + half).toFixed(2);
    const e = (c + half + f).toFixed(2);
    const stops = `transparent 0, transparent ${a}px, ${p.color} ${b}px, ${p.color} ${d}px, transparent ${e}px, transparent ${tile}px`;
    const grid = `repeating-linear-gradient(0deg, ${stops}), `
        + `repeating-linear-gradient(90deg, ${stops})`;
    const ceiling = !!p.ceiling;
    const hp = (horizon * 100).toFixed(1) + "%";
    // Vanishing point = the horizon line. For a floor it's `horizon` down from the
    // top; for a ceiling it's `horizon` up from the bottom.
    const poY = ceiling ? `${((1 - horizon) * 100).toFixed(1)}%` : hp;
    const anchor = ceiling ? "top: 0; bottom: auto;" : "bottom: 0; top: auto;";
    const tOrigin = ceiling ? "50% 0%" : "50% 100%";
    const rotate = ceiling ? `rotateX(-${rot}deg)` : `rotateX(${rot}deg)`;
    // Scroll the *whole plane* by exactly one tile via transform (GPU-composited),
    // not background-position. background-position scrolling resamples the
    // hard-edged repeating-gradient every frame, so under perspective compression
    // each line rounds between 1 and 2 device pixels and visibly flashes. A
    // transform translate moves the already-rasterized plane, so line thickness is
    // stable; translating by exactly `tile` makes the loop seamless (the grid
    // repeats every `tile`px, so the end frame is pixel-identical to the start).
    // The plane is anchored at the near edge and rotated; translating *before* the
    // rotation (in the plane's own Y) streams the lines forward toward the camera.
    const slide = ceiling ? `translateY(-${tile}px)` : `translateY(${tile}px)`;
    const solidTo = (horizon * 70).toFixed(1) + "%";
    const fade = ceiling
        ? `linear-gradient(to bottom, hsl(0,0%,0%) 0%, hsl(0,0%,0%) ${solidTo}, transparent ${hp})`
        : `linear-gradient(to top, hsl(0,0%,0%) 0%, hsl(0,0%,0%) ${solidTo}, transparent ${hp})`;
    return `
@keyframes rs-grid-${p.key} {
    from { transform: ${rotate} translateZ(0); }
    to { transform: ${rotate} ${slide} translateZ(0); }
}
${p.sel} {
    perspective: ${persp}px;
    perspective-origin: 50% ${poY};
    -webkit-mask: ${fade}; mask: ${fade};
    filter: blur(${(p.blur ?? 0.7).toFixed(2)}px);
}
${p.sel}::before {
    content: ""; position: absolute; left: -50%; right: -50%; ${anchor}
    height: 150%;
    background-image: ${grid};
    transform-origin: ${tOrigin};
    transform: ${rotate};
    animation: rs-grid-${p.key} ${speed}s linear infinite;
    will-change: transform;
    backface-visibility: hidden;
}
`;
}

// Slow continuous drift of a layer (translate + optional gentle vertical bob),
// for parallax skies / floating bokeh. `dx`/`dy` are the travel in px; the layer
// is over-sized via scale so the wrap is never visible at the edges.
export function drift(p: {
    sel: string; key: string;
    dx: number; dy: number; speedSec: number;
    scale?: number; ease?: string;
}): string {
    const sc = p.scale ?? 1.3;
    const ease = p.ease ?? "ease-in-out";
    return `
@keyframes rs-drift-${p.key} {
    0% { transform: scale(${sc}) translate(0, 0); }
    50% { transform: scale(${sc}) translate(${p.dx}px, ${p.dy}px); }
    100% { transform: scale(${sc}) translate(0, 0); }
}
${p.sel} { animation: rs-drift-${p.key} ${p.speedSec}s ${ease} infinite; will-change: transform; }
`;
}

// Particles streaming *toward the viewer*: the layer starts small and high
// (near the horizon), grows as it sweeps down and diagonally off the bottom of
// the screen, then fades. Scaling up = getting closer; the downward+diagonal
// travel sells "we're moving forward over the ground". Run several instances
// (e.g. on a layer plus its ::before/::after) with different `dx`, scales, and
// speeds so each group takes its own course and the field reads as 3D depth.
export function approach(p: {
    sel: string; key: string;
    dx: number;           // horizontal drift across the loop (px)
    dy?: number;          // downward travel across the loop (px)
    fromScale?: number;
    toScale?: number;
    speedSec: number;
    delaySec?: number;
    origin?: string;      // transform-origin (where the field zooms from)
}): string {
    const from = p.fromScale ?? 0.5;
    const to = p.toScale ?? 1.9;
    const dy = p.dy ?? 260;
    const delay = p.delaySec ? `animation-delay: ${p.delaySec}s;` : "";
    const origin = p.origin ?? "50% 28%";
    return `
@keyframes rs-approach-${p.key} {
    0% { transform: translate(0, 0) scale(${from}); opacity: 0; }
    14% { opacity: 1; }
    78% { opacity: 1; }
    100% { transform: translate(${p.dx}px, ${dy}px) scale(${to}); opacity: 0; }
}
${p.sel} { transform-origin: ${origin}; animation: rs-approach-${p.key} ${p.speedSec}s linear infinite; ${delay} will-change: transform, opacity; }
`;
}

// Rising-and-fading bubbles/embers: the layer streams straight up, looping
// seamlessly, while its blobs pulse opacity. Pair two offset instances (half a
// period apart) for an unbroken flow.
export function rise(p: {
    sel: string; key: string;
    distance: number;     // px travelled upward per loop
    speedSec: number;
    scale?: number;
    delaySec?: number;
    fade?: boolean;
}): string {
    const sc = p.scale ?? 1.4;
    const delay = p.delaySec ? `animation-delay: ${p.delaySec}s;` : "";
    const fadeKf = p.fade ? "opacity: 0.15;" : "";
    return `
@keyframes rs-rise-${p.key} {
    0% { transform: scale(${sc}) translateY(0); opacity: 0.0; }
    15% { opacity: 1; }
    85% { opacity: 1; }
    100% { transform: scale(${sc}) translateY(-${p.distance}px); ${fadeKf} opacity: 0; }
}
${p.sel} { animation: rs-rise-${p.key} ${p.speedSec}s linear infinite; ${delay} will-change: transform, opacity; }
`;
}
