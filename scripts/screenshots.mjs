// Theme / UI screenshot harness. Serves the built web app, then drives a
// headless chromium through every (theme × surface) combination using the
// URL params the app now understands (?demo=1 seeds a synthetic library,
// ?theme= overrides the active theme, ?modal= opens a modal, ?view= picks
// the grid mode). Output lands in scripts/screenshots/.
//
//   yarn build-web && node scripts/screenshots.mjs [theme1 theme2 ...]
//
// With no args it shoots every theme below; pass ids to shoot a subset.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "build-web");
const OUT = path.resolve(__dirname, "screenshots");

const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".mkv": "video/x-matroska", ".mp4": "video/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".wasm": "application/wasm", ".map": "application/json",
};

function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
            let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
            if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    // SPA fallback to index.html for unknown paths.
                    fs.readFile(path.join(ROOT, "index.html"), (e2, idx) => {
                        if (e2) { res.writeHead(404); res.end(); return; }
                        res.writeHead(200, { "Content-Type": "text/html" });
                        res.end(idx);
                    });
                    return;
                }
                res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
                res.end(data);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

const THEMES = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["default", "cyberpunk", "cyberpunk-v2", "frutiger-aero", "frutiger-aero-v2",
       "cloudcyber", "cyber-y2k", "utopian-scholastic", "webcore",
       "vaporwave", "vaporwave-v2", "terminal-green", "solarized-dusk",
       "sunset-synth", "aurora", "aurora-v2", "molten-core", "molten-core-v2",
       "paper-ink"];

// surface label → query params (besides demo + theme)
const SURFACES = [
    { name: "grid", params: { view: "movies" } },
    { name: "series", params: { view: "series" } },
    { name: "list", params: { view: "list" } },
    { name: "settings", params: { view: "movies", modal: "settings" } },
    { name: "restyling", params: { view: "movies", modal: "restyling" } },
];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await startServer();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/`;

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // The app's storage layer (BulkDatabase2 → getDirectoryHandle) wants a real
    // directory handle. Headless chromium has no file picker, so route it at
    // the origin-private file system: stub showDirectoryPicker to hand back the
    // OPFS root, and grant FS permissions unconditionally (OPFS handles, and
    // handles re-read from IndexedDB, lack the permission methods the app calls).
    await ctx.addInitScript(() => {
        const grant = async () => "granted";
        const proto = window.FileSystemHandle && window.FileSystemHandle.prototype;
        if (proto) { proto.requestPermission = grant; proto.queryPermission = grant; }
        window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    });
    const page = await ctx.newPage();
    page.on("pageerror", e => console.error("[pageerror]", e.message));

    for (const theme of THEMES) {
        for (const surface of SURFACES) {
            const qs = new URLSearchParams({ demo: "1", theme, ...surface.params });
            const url = `${base}?${qs}`;
            await page.goto(url, { waitUntil: "domcontentloaded" });
            // First load has no saved storage pointer, so the app shows its
            // directory prompt; accept it (writes the OPFS pointer for reuse).
            const pick = page.getByText("Pick Data Directory", { exact: true });
            if (await pick.isVisible().catch(() => false)) await pick.click().catch(() => {});
            // Grid renders once the demo seed lands; wait for a cell.
            await page.waitForSelector(".GridCell, .ListRow", { timeout: 15000 }).catch(() => {});
            if (surface.params.modal) {
                await page.waitForSelector(".Modal", { timeout: 8000 }).catch(() => {});
            }
            await page.waitForTimeout(700);
            const file = path.join(OUT, `${theme}__${surface.name}.png`);
            await page.screenshot({ path: file });
            console.log("shot", path.basename(file));
        }
    }

    await browser.close();
    server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
