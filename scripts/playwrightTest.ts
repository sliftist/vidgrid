import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

// Where the running dev server lives. Started by the parent process; we assume it's up.
const URL = process.env.TEST_URL || "https://video.letterquick.com:6399/";
const FIXTURE_URL = (process.env.TEST_URL || URL) + "test.mkv";
// Hard cap so a stalled decoder can't burn the CI/dev box.
const OVERALL_TIMEOUT_MS = 60_000;
const PLAY_WAIT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return await Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)),
    ]);
}

interface PageStatus {
    state: string;
    framesDecoded: number;
    framesRendered: number;
    codecString?: string;
    error?: string;
    width?: number;
    height?: number;
}

async function main() {
    console.log(`Starting Playwright test against ${URL}`);
    let browser: Browser | undefined;
    let exitCode = 0;
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                "--ignore-certificate-errors",
                "--enable-features=WebGPU,Vulkan,SharedArrayBuffer",
                "--enable-unsafe-webgpu",
                "--use-vulkan=swiftshader",
                "--use-angle=swiftshader",
                "--disable-features=UseChromeOSDirectVideoDecoder",
                "--no-sandbox",
            ],
        });
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        page.on("console", msg => console.log(`[page:${msg.type()}]`, msg.text()));
        page.on("pageerror", err => console.error(`[page-error]`, err.message, err.stack?.split("\n").slice(0, 6).join("\n")));
        await withTimeout(page.goto(URL, { waitUntil: "domcontentloaded" }), 15_000, "page.goto");

        // Quick capability probes — useful even if HEVC ends up unsupported.
        const caps = await page.evaluate(async () => {
            const out: any = {};
            out.hasVideoDecoder = typeof (window as any).VideoDecoder !== "undefined";
            out.hasWebGPU = !!(navigator as any).gpu;
            if (out.hasVideoDecoder) {
                const probes = [
                    "hev1.1.6.L93.B0",
                    "hev1.2.4.L93.90",
                    "hev1.2.4.L120.B0",
                    "vp8",
                    "av01.0.04M.08",
                ];
                out.codecProbes = {};
                for (const c of probes) {
                    try {
                        const r = await (window as any).VideoDecoder.isConfigSupported({ codec: c });
                        out.codecProbes[c] = r.supported;
                    } catch (e) {
                        out.codecProbes[c] = `error: ${(e as Error).message}`;
                    }
                }
            }
            if (out.hasWebGPU) {
                try {
                    const adapter = await (navigator as any).gpu.requestAdapter();
                    out.webgpuAdapter = adapter ? (adapter.info ? `${adapter.info.vendor}/${adapter.info.architecture}` : "unknown") : "no adapter";
                } catch (e) {
                    out.webgpuAdapter = `error: ${(e as Error).message}`;
                }
            }
            return out;
        });
        console.log(`[caps]`, JSON.stringify(caps, null, 2));

        // Wait for the test hook to be available, then kick off playback by
        // fetching the served fixture and feeding it.
        await page.waitForFunction(() => typeof (window as any).__playFile === "function", null, { timeout: 10_000 });

        await page.evaluate(async (fixtureUrl) => {
            const res = await fetch(fixtureUrl);
            if (!res.ok) throw new Error(`fetch fixture failed: ${res.status}`);
            const buf = await res.arrayBuffer();
            const file = new File([buf], "test.mkv", { type: "video/x-matroska" });
            (window as any).__playFile(file).catch((e: any) => console.error("playFile threw:", e));
        }, FIXTURE_URL);

        // Poll the global state until we see progress, an end state, or a timeout.
        const start = Date.now();
        let lastStatus: PageStatus | undefined;
        while (Date.now() - start < PLAY_WAIT_MS) {
            const status = (await page.evaluate(() => {
                const w: any = window;
                // The MobX-backed state object is module-scoped; expose via __status.
                return w.__lastStatus ?? null;
            })) as PageStatus | null;
            if (status) {
                lastStatus = status;
                if (status.state === "error") break;
                if (status.state === "ended") break;
                if (status.framesRendered >= 10) break;
            }
            await new Promise(r => setTimeout(r, 250));
        }

        if (!lastStatus) {
            // Status didn't update — check page DOM directly for a render.
            const visible = await page.evaluate(() => {
                const root = document.querySelector("#app");
                return root ? root.textContent?.slice(0, 200) : null;
            });
            console.log(`[fallback] DOM text snapshot:`, visible);
        } else {
            console.log(`[final-status]`, JSON.stringify(lastStatus));
            if (lastStatus.state === "error") {
                console.error(`[FAIL] player reported error: ${lastStatus.error}`);
                exitCode = 1;
            }
            if (lastStatus.framesRendered < 1 && lastStatus.state !== "error") {
                console.warn(`[WARN] no frames rendered before timeout (state=${lastStatus.state})`);
            }
        }

        // Snapshot the canvas. If WebGPU isn't actually drawing, this will be transparent/black.
        const shotPath = path.resolve(__dirname, "..", "test-fixtures", "playwright-canvas.png");
        const canvas = await page.$("canvas");
        if (canvas) {
            const b64 = await page.evaluate(() => {
                const c = document.querySelector("canvas") as HTMLCanvasElement | null;
                if (!c) return null;
                try {
                    return c.toDataURL("image/png");
                } catch (e) {
                    return `error:${(e as Error).message}`;
                }
            });
            if (b64 && typeof b64 === "string" && b64.startsWith("data:image/png")) {
                const bin = Buffer.from(b64.split(",")[1], "base64");
                fs.writeFileSync(shotPath, bin);
                console.log(`[canvas-snapshot] saved ${shotPath} (${bin.length} bytes)`);
                // Sample the center pixel to verify we got non-blank.
                const sample = await page.evaluate(() => {
                    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
                    if (!c || !c.width) return null;
                    const probe = document.createElement("canvas");
                    probe.width = c.width;
                    probe.height = c.height;
                    const ctx = probe.getContext("2d");
                    if (!ctx) return null;
                    try {
                        ctx.drawImage(c, 0, 0);
                    } catch {
                        return "drawImage failed (likely WebGPU canvas not accessible)";
                    }
                    const d = ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
                    return `center px rgba=${d[0]},${d[1]},${d[2]},${d[3]}`;
                });
                console.log(`[canvas-sample]`, sample);
            } else {
                console.log(`[canvas-snapshot] toDataURL returned`, b64);
            }
        } else {
            console.log(`[canvas-snapshot] no <canvas> element found`);
        }

        // Full-page screenshot for visual sanity check.
        const fullShot = path.resolve(__dirname, "..", "test-fixtures", "playwright-page.png");
        await page.screenshot({ path: fullShot, fullPage: true });
        console.log(`[page-screenshot] saved ${fullShot}`);
    } catch (err) {
        console.error(`[FATAL]`, (err as Error).stack ?? err);
        exitCode = 2;
    } finally {
        if (browser) await browser.close();
    }
    process.exit(exitCode);
}

void withTimeout(main(), OVERALL_TIMEOUT_MS, "main");
