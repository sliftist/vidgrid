// Theme-coverage auditor. Loads the app under a given theme and reports every
// sizeable element whose computed background / text color is "wrong" for the
// theme's intent, plus the class list on it — so missed restyle hooks are
// named instead of guessed. Usage:
//   node scripts/auditTheme.mjs <theme> [light|dark] [surface]
// e.g. node scripts/auditTheme.mjs frutiger-aero light grid

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "build-web");

const theme = process.argv[2] || "frutiger-aero";
const intent = process.argv[3] || "light";
const surface = process.argv[4] || "grid";
const SURFACE_PARAMS = {
    grid: { view: "movies" },
    settings: { view: "movies", modal: "settings" },
    restyling: { view: "movies", modal: "restyling" },
    list: { view: "list" },
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".wasm": "application/wasm" };
function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
            const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
            fs.readFile(filePath, (err, data) => {
                if (err) { fs.readFile(path.join(ROOT, "index.html"), (e2, idx) => { res.writeHead(e2 ? 404 : 200, { "Content-Type": "text/html" }); res.end(idx || ""); }); return; }
                res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
                res.end(data);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

async function main() {
    const server = await startServer();
    const port = server.address().port;
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
        const grant = async () => "granted";
        const proto = window.FileSystemHandle && window.FileSystemHandle.prototype;
        if (proto) { proto.requestPermission = grant; proto.queryPermission = grant; }
        window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    });
    const page = await ctx.newPage();
    const qs = new URLSearchParams({ demo: "1", theme, ...SURFACE_PARAMS[surface] });
    await page.goto(`http://127.0.0.1:${port}/?${qs}`, { waitUntil: "domcontentloaded" });
    const pick = page.getByText("Pick Data Directory", { exact: true });
    if (await pick.isVisible().catch(() => false)) await pick.click().catch(() => {});
    await page.waitForSelector(".GridCell, .ListRow, .Modal", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    const report = await page.evaluate((intent) => {
        function lum(c) {
            const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
            if (!m) return undefined;
            const [r, g, b] = [+m[1], +m[2], +m[3]];
            return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        }
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 16) continue;
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            const bgImg = cs.backgroundImage;
            const opaque = bg && bg !== "rgba(0, 0, 0, 0)" && !bg.startsWith("rgba(0, 0, 0, 0");
            const l = lum(bg);
            // For a light theme, flag large opaque DARK backgrounds (with no
            // image) — those are surfaces the theme failed to lighten.
            const bad = intent === "light"
                ? (opaque && bgImg === "none" && l !== undefined && l < 0.35 && r.width * r.height > 6000)
                : (opaque && bgImg === "none" && l !== undefined && l > 0.7 && r.width * r.height > 6000);
            if (!bad) continue;
            const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
            const rs = String(cls).split(/\s+/).filter(c => /^[A-Z]/.test(c));
            const sig = el.tagName + "|" + rs.join(",") + "|" + Math.round(l * 100);
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push({ tag: el.tagName.toLowerCase(), rs: rs.join(" ") || "(no RS hook)", bg, area: Math.round(r.width) + "x" + Math.round(r.height), text: (el.textContent || "").trim().slice(0, 30) });
        }
        return out;
    }, intent);

    console.log(`\n=== ${theme} / ${surface} (intent ${intent}) — ${report.length} flagged ===`);
    for (const r of report) console.log(`${r.rs.padEnd(28)} <${r.tag}> ${r.bg} ${r.area} "${r.text}"`);

    await browser.close();
    server.close();
}
main().catch(e => { console.error(e); process.exit(1); });
