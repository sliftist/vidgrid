// SVG-scene background generators for the built-in themes. Each returns a CSS
// `url("data:image/svg+xml,...")` value to drop into a Palette's `bgImage` field;
// buildTheme paints it across the whole page (and, with a translucent tint, the
// sidebar/header) so a theme can carry a real wallpaper, not just a gradient.
//
// SVGs are encoded with encodeURIComponent — the one encoding that round-trips
// fragment refs (`url(#id)` → `url(%23id)`) correctly, so gradients/filters
// referenced by id keep working inside the data-URI.

function dataUri(svg: string): string {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Soft cloudscape: vertical sky gradient with blurred white puffs. Used by the
// light/airy themes (Frutiger Aero, CloudCyber). Cloud puffs are a few
// overlapping blurred ellipses so they read as fluffy rather than as discs.
export function clouds(skyTop: string, skyBottom: string, cloud = "hsl(0, 0%, 100%)"): string {
    const puff = (cx: number, cy: number, rx: number, ry: number, o: number) =>
        `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='${cloud}' opacity='${o}'/>`;
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800' preserveAspectRatio='xMidYMid slice'>`
        + `<defs><linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>`
        + `<stop offset='0' stop-color='${skyTop}'/><stop offset='1' stop-color='${skyBottom}'/></linearGradient>`
        + `<filter id='b' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='26'/></filter></defs>`
        + `<rect width='1200' height='800' fill='url(#sky)'/>`
        + `<g filter='url(#b)'>`
        + puff(220, 180, 170, 70, 0.95) + puff(330, 150, 130, 60, 0.9) + puff(140, 210, 110, 55, 0.85)
        + puff(900, 300, 200, 80, 0.9) + puff(1030, 270, 140, 64, 0.85) + puff(800, 330, 120, 56, 0.8)
        + puff(560, 560, 180, 70, 0.8) + puff(680, 590, 140, 60, 0.75)
        + puff(1080, 620, 150, 64, 0.7) + puff(120, 640, 150, 64, 0.7)
        + `</g></svg>`;
    return dataUri(svg);
}

// Perspective neon grid receding to a horizon glow — the synthwave/cyber floor.
// `line` draws the grid, `glow` the horizon bloom. Horizontal lines bunch toward
// the horizon (perspective) and verticals fan out from the vanishing point.
export function neonGrid(bg: string, line: string, glow: string): string {
    const w = 1200, h = 800, horizon = 300, vpx = w / 2;
    let lines = "";
    // Horizontal lines below the horizon, spacing growing with distance.
    let y = horizon, step = 6;
    while (y < h) {
        lines += `<line x1='0' y1='${y.toFixed(1)}' x2='${w}' y2='${y.toFixed(1)}' stroke='${line}' stroke-width='1.5'/>`;
        y += step; step *= 1.18;
    }
    // Verticals fanning from the vanishing point to the bottom edge.
    for (let i = -14; i <= 14; i++) {
        const bottomX = vpx + i * 90;
        lines += `<line x1='${vpx}' y1='${horizon}' x2='${bottomX.toFixed(1)}' y2='${h}' stroke='${line}' stroke-width='1.5'/>`;
    }
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice'>`
        + `<defs><radialGradient id='g' cx='0.5' cy='${(horizon / h).toFixed(3)}' r='0.6'>`
        + `<stop offset='0' stop-color='${glow}' stop-opacity='0.9'/><stop offset='1' stop-color='${glow}' stop-opacity='0'/></radialGradient></defs>`
        + `<rect width='${w}' height='${h}' fill='${bg}'/>`
        + `<rect width='${w}' height='${horizon}' fill='url(#g)'/>`
        + `<g opacity='0.5'>${lines}</g>`
        + `</svg>`;
    return dataUri(svg);
}

// Banded sunset: a big low sun disc behind horizontal gaps, over a vertical
// color wash. For vaporwave / sunset-synth.
export function sunset(top: string, mid: string, bottom: string, sun: string): string {
    const w = 1200, h = 800;
    let bands = "";
    // Slats across the lower half that "cut" the sun, classic synthwave sun.
    for (let i = 0; i < 8; i++) {
        const by = 430 + i * 16 + i * i * 1.5;
        bands += `<rect x='0' y='${by.toFixed(1)}' width='${w}' height='${(7 + i * 1.5).toFixed(1)}' fill='${bottom}' opacity='0.9'/>`;
    }
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice'>`
        + `<defs><linearGradient id='wash' x1='0' y1='0' x2='0' y2='1'>`
        + `<stop offset='0' stop-color='${top}'/><stop offset='0.55' stop-color='${mid}'/><stop offset='1' stop-color='${bottom}'/></linearGradient>`
        + `<radialGradient id='sun' cx='0.5' cy='0.5' r='0.5'>`
        + `<stop offset='0' stop-color='${sun}'/><stop offset='1' stop-color='${sun}' stop-opacity='0.85'/></radialGradient></defs>`
        + `<rect width='${w}' height='${h}' fill='url(#wash)'/>`
        + `<circle cx='${w / 2}' cy='470' r='230' fill='url(#sun)'/>`
        + bands
        + `</svg>`;
    return dataUri(svg);
}

// Aurora borealis: a deep night-sky gradient with a sprinkled star field and a
// few big, heavily blurred coloured ellipses that read as glowing aurora
// curtains. Used by the Aurora theme. The deterministic PRNG keeps the star
// field stable across rebuilds (no churn in the encoded data-URI).
export function aurora(top: string, bottom: string, c1: string, c2: string, c3: string): string {
    const w = 1200, h = 800;
    let s = 7;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    let stars = "";
    for (let i = 0; i < 90; i++) {
        const x = (rnd() * w).toFixed(0), y = (rnd() * h * 0.72).toFixed(0);
        const r = (rnd() * 1.2 + 0.3).toFixed(1), o = (rnd() * 0.7 + 0.2).toFixed(2);
        stars += `<circle cx='${x}' cy='${y}' r='${r}' fill='hsl(0, 0%, 100%)' opacity='${o}'/>`;
    }
    const curtain = (cx: number, cy: number, rx: number, ry: number, rot: number, fill: string) =>
        `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='${fill}' transform='rotate(${rot} ${cx} ${cy})'/>`;
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice'>`
        + `<defs><linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>`
        + `<stop offset='0' stop-color='${top}'/><stop offset='1' stop-color='${bottom}'/></linearGradient>`
        + `<filter id='ab' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='55'/></filter></defs>`
        + `<rect width='${w}' height='${h}' fill='url(#sky)'/>`
        + `<g>${stars}</g>`
        + `<g filter='url(#ab)' opacity='0.78'>`
        + curtain(300, 240, 360, 90, -18, c1) + curtain(720, 300, 430, 80, -10, c2)
        + curtain(980, 210, 300, 70, -22, c3) + curtain(540, 170, 300, 60, -14, c1)
        + `</g></svg>`;
    return dataUri(svg);
}

// Volcanic ember field: a near-black base with a radial lava bloom rising from
// the bottom edge and a scatter of softly-blurred ember sparks. For the Molten
// Core theme. Same deterministic PRNG so the spark layout is build-stable.
export function embers(base: string, glow: string, ember: string): string {
    const w = 1200, h = 800;
    let s = 13;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    let sparks = "";
    for (let i = 0; i < 70; i++) {
        const x = (rnd() * w).toFixed(0), y = (rnd() * h).toFixed(0);
        const r = (rnd() * 2.4 + 0.6).toFixed(1), o = (rnd() * 0.7 + 0.2).toFixed(2);
        sparks += `<circle cx='${x}' cy='${y}' r='${r}' fill='${ember}' opacity='${o}'/>`;
    }
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice'>`
        + `<defs><radialGradient id='lava' cx='0.5' cy='1' r='0.9'>`
        + `<stop offset='0' stop-color='${glow}' stop-opacity='0.85'/><stop offset='1' stop-color='${glow}' stop-opacity='0'/></radialGradient>`
        + `<filter id='eb' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='1.4'/></filter></defs>`
        + `<rect width='${w}' height='${h}' fill='${base}'/>`
        + `<rect width='${w}' height='${h}' fill='url(#lava)'/>`
        + `<g filter='url(#eb)'>${sparks}</g>`
        + `</svg>`;
    return dataUri(svg);
}

// Faint ruled-paper / dotted-grid scene for the print-like themes (Paper Ink,
// Utopian Scholastic, Webcore). A flat base with subtle ruling so the wallpaper
// is felt, not loud.
export function paper(base: string, rule: string, accent: string): string {
    const w = 1200, h = 800;
    let rules = "";
    for (let y = 40; y < h; y += 34) {
        rules += `<line x1='0' y1='${y}' x2='${w}' y2='${y}' stroke='${rule}' stroke-width='1'/>`;
    }
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice'>`
        + `<rect width='${w}' height='${h}' fill='${base}'/>`
        + `<g opacity='0.5'>${rules}</g>`
        + `<line x1='90' y1='0' x2='90' y2='${h}' stroke='${accent}' stroke-width='1.5' opacity='0.5'/>`
        + `</svg>`;
    return dataUri(svg);
}
