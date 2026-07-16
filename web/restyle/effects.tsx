// Config-driven animated background effects. Unlike the CSS-only `bgAnim`
// layers, these render real DOM/SVG (inline SVG with SMIL, blurred ribbon
// divs) — the kinds of effects that can't be done with a frozen SVG
// background-image. A theme carries a serializable `effects` config (see
// Theme.effects in themes.ts); ThemeStyle renders the matching DOM into the
// `.rs-bg` stack. Keeping the config structured (not a CSS blob) is what lets a
// theme "store more than just styles" and a future editor expose the fields.
//
// Built as HTML strings injected via dangerouslySetInnerHTML so the exact
// SVG/SMIL markup runs verbatim (preact's JSX mangles some SVG filter attribute
// casings and SMIL <animate> tags). Only one theme is active at a time, so fixed
// element ids/class names can't collide across themes.

import * as preact from "preact";

export type ThemeEffect = LiquidEffect | AuroraRibbonsEffect;

// A churning, rippling liquid sheet — the quentinbrooks.com "water-svg" effect,
// recolorable by `hue` (200 = water, ~14 = lava). A tiled pattern of soft
// blurred blobs scrolls upward (the caustics) and is warped by a turbulence
// displacement map that drifts (the ripples), so the surface flows.
export interface LiquidEffect {
    kind: "liquid";
    hue: number;          // base hue: ~200 water, ~14 lava, ~120 acid, ...
    baseLight?: number;   // lightness of the flat base fill, % (default 50)
    scale?: number;       // displacement strength in px (default 80)
    flowSec?: number;     // seconds for the caustic pattern to scroll one tile (default 7)
    rippleSec?: number;   // seconds for the displacement drift to cycle (default 16)
    tileScale?: number;   // pattern zoom — bigger = larger swirls (default 4)
    opacity?: number;     // overall layer opacity (default 0.85)
}

// Aurora curtains — the quentinbrooks.com "warming up" effect scaled to full
// screen: a few heavily-blurred gradient ribbons that slide across at different
// tilts and speeds. `colors` are the ribbon core colors (1–3 used).
export interface AuroraRibbonsEffect {
    kind: "auroraRibbons";
    colors: string[];
    speedSec?: number;    // base slide duration, s (default 16)
    blur?: number;        // ribbon blur radius, px (default 46)
    opacity?: number;     // ribbon opacity (default 0.7)
}

// Caustic blob layout for the liquid pattern. Tuples: [shape, cx, cy, a, b,
// sat, light, opacity, blurred]. Edge blobs are mirrored to the opposite edge
// so the 60×60 tile is seamless under the upward scroll. Lightnesses are
// absolute (highlights); `baseLight` shifts them all so one knob sets the mood.
type Blob = ["c" | "e", number, number, number, number, number, number, number, 0 | 1];
const LIQUID_BLOBS: Blob[] = [
    ["e", 30, 30, 12, 15, 85, 65, 0.7, 1],
    ["c", 20, 20, 6, 0, 95, 75, 0.6, 1],
    ["c", 40, 40, 5, 0, 85, 80, 0.7, 1],
    ["c", 15, 0, 8, 0, 90, 70, 0.6, 1],
    ["c", 15, 60, 8, 0, 90, 70, 0.6, 1],
    ["c", 45, 0, 6, 0, 80, 65, 0.5, 1],
    ["c", 45, 60, 6, 0, 80, 65, 0.5, 1],
    ["c", 0, 15, 7, 0, 75, 60, 0.5, 1],
    ["c", 60, 15, 7, 0, 75, 60, 0.5, 1],
    ["c", 0, 45, 5, 0, 85, 75, 0.6, 1],
    ["c", 60, 45, 5, 0, 85, 75, 0.6, 1],
    ["c", 0, 0, 4, 0, 95, 80, 0.7, 0],
    ["c", 60, 0, 4, 0, 95, 80, 0.7, 0],
    ["c", 0, 60, 4, 0, 95, 80, 0.7, 0],
    ["c", 60, 60, 4, 0, 95, 80, 0.7, 0],
    ["c", 25, 10, 2, 0, 90, 85, 0.8, 0],
    ["c", 35, 50, 2.5, 0, 95, 80, 0.6, 0],
    ["c", 10, 35, 1.5, 0, 85, 75, 0.5, 0],
    ["c", 50, 25, 2, 0, 100, 90, 0.9, 0],
    ["e", 25, 35, 8, 5, 80, 70, 0.4, 1],
    ["e", 35, 25, 6, 8, 75, 65, 0.3, 1],
];

function liquidHtml(e: LiquidEffect): string {
    const hue = e.hue;
    const delta = (e.baseLight ?? 50) - 55;
    const scale = e.scale ?? 80;
    const flow = e.flowSec ?? 7;
    const ripple = e.rippleSec ?? 16;
    const ts = e.tileScale ?? 4;
    const op = e.opacity ?? 0.85;
    const L = (l: number) => Math.max(2, Math.min(98, l + delta));
    const base = `hsl(${hue}, 70%, ${L(55)}%)`;
    // No viewBox: the <svg> is sized 100%×100% of the screen, so one user unit is
    // one screen pixel and the turbulence/displacement rasterize at the real
    // device resolution (and re-rasterize on resize). A fixed viewBox would scale
    // that canvas up to the screen — which is the magnification that made it
    // blocky. Everything below is therefore authored in screen pixels.
    const k = ts / 4;                 // tileScale 4 == the reference pixel sizing
    const cell = Math.round(320 * k); // caustic tile edge, px
    const ck = cell / 60;             // map the 60-unit blob layout onto `cell`
    const bl = (8 * k).toFixed(2);    // blob blur, px
    const n = (v: number) => +(v * ck).toFixed(2);
    const blobs = LIQUID_BLOBS.map(([shape, cx, cy, a, b, sat, light, o, blur]) => {
        const fill = `hsl(${hue}, ${sat}%, ${L(light)}%)`;
        const f = blur ? ` filter="url(#rsLiqBlur)"` : "";
        return shape === "c"
            ? `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(a)}" fill="${fill}" opacity="${o}"${f}/>`
            : `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(a)}" ry="${n(b)}" fill="${fill}" opacity="${o}"${f}/>`;
    }).join("");
    // Exactly-looping ripples. A single stitched turbulence tile (period `dtile`)
    // is repeated with feTile so the displacement field is strictly periodic;
    // offsetting it by one whole tile lands on an identical image, so the loop has
    // no jump. The filter region (relative to the screen-filling rect) is padded
    // by more than `dtile` on every side so the offset never drags an uncovered
    // edge into view — bare feTurbulence + feOffset reveals empty space mid-loop
    // ("runs out of space before it wraps").
    const dtile = 384;
    return `<style>
.rs-liquid { position: absolute; inset: 0; overflow: hidden; opacity: ${op}; }
.rs-liquid svg { width: 100%; height: 100%; display: block; }
</style>
<div class="rs-liquid"><svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
<defs>
<filter id="rsLiqBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${bl}"/></filter>
<filter id="rsLiqDisp" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
<feTurbulence type="turbulence" baseFrequency="0.009 0.012" numOctaves="2" seed="6" stitchTiles="stitch" result="noise" x="0" y="0" width="${dtile}" height="${dtile}"/>
<feTile in="noise" result="tiled"/>
<feOffset in="tiled" result="moved" dy="0"><animate attributeName="dy" values="0;-${dtile}" dur="${ripple}s" repeatCount="indefinite"/></feOffset>
<feDisplacementMap in="SourceGraphic" in2="moved" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<pattern id="rsLiqPat" x="0" y="0" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">
<rect width="${cell}" height="${cell}" fill="${base}"/>
${blobs}
<animate attributeName="y" values="0;${cell}" dur="${flow}s" repeatCount="indefinite"/>
</pattern>
</defs>
<rect x="-25%" y="-25%" width="150%" height="150%" fill="url(#rsLiqPat)" filter="url(#rsLiqDisp)"/>
</svg></div>`;
}

function auroraRibbonsHtml(e: AuroraRibbonsEffect): string {
    const c = e.colors.length ? e.colors : ["hsla(150,82%,58%,0.7)"];
    const dur = e.speedSec ?? 16;
    const blur = e.blur ?? 46;
    const op = e.opacity ?? 0.7;
    const ribbon = (i: number, top: number, rot: number, mult: number, rev: boolean) => {
        const col = c[i % c.length];
        return `.rs-aurora-r${i} { top: ${top}%; --r: ${rot}deg;`
            + ` background: linear-gradient(90deg, transparent 0%, ${col} 45%, ${col} 55%, transparent 100%);`
            + ` animation: rsAuroraSlide ${(dur * mult).toFixed(1)}s linear infinite${rev ? " reverse" : ""}; }`;
    };
    return `<style>
@keyframes rsAuroraSlide {
  0% { transform: translateX(-75%) rotate(var(--r)); }
  100% { transform: translateX(175%) rotate(var(--r)); }
}
.rs-aurora { position: absolute; inset: 0; overflow: hidden; }
.rs-aurora-ribbon { position: absolute; left: 0; width: 72%; height: 36%; filter: blur(${blur}px); opacity: ${op}; will-change: transform; }
${ribbon(1, 6, -10, 1, false)}
${ribbon(2, 34, 12, 1.45, false)}
${ribbon(3, 56, 18, 1.15, true)}
</style>
<div class="rs-aurora">
<div class="rs-aurora-ribbon rs-aurora-r1"></div>
<div class="rs-aurora-ribbon rs-aurora-r2"></div>
<div class="rs-aurora-ribbon rs-aurora-r3"></div>
</div>`;
}

function effectHtml(e: ThemeEffect): string {
    switch (e.kind) {
        case "liquid": return liquidHtml(e);
        case "auroraRibbons": return auroraRibbonsHtml(e);
    }
}

// Rendered by ThemeStyle into the `.rs-bg` stack. `.rs-fx` is display:contents
// so each effect's own absolutely-positioned wrapper fills `.rs-bg` directly.
export function renderEffects(effects: ThemeEffect[] | undefined): preact.VNode | null {
    if (!effects || effects.length === 0) return null;
    const html = `<style>.rs-fx { display: contents; }</style>` + effects.map(effectHtml).join("");
    return <div className="rs-fx" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}
