// Microbenchmark / probe: drives onnxruntime-web's WebGPU backend in a
// headed Chromium so we can see exactly where ArcFace's session-create
// trips. The Python facegrabs server has no such issue, so the failure has
// to be in how ORT-web allocates GPU buffers for the ResNet50 weights.
//
// Approach:
//   1. Spin up a tiny static HTTP server that fetches ONNX weights from
//      the existing /face-models/ endpoint and serves an HTML harness.
//   2. Launch Chromium with WebGPU enabled.
//   3. The harness loads ORT-web with a pre-created WebGPU device and
//      reports back per-step results (adapter limits, device acquired,
//      session create attempt, full error text if any).
//   4. Try ArcFace under several configurations to figure out which
//      one ORT accepts.

import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as fs from "fs";
import { chromium } from "playwright";

const MODELS_DIR = "/root/face-models";
const PORT = 9777;
const ORT_VERSION = "1.22.0";
const ORT_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.bundle.min.mjs`;

function httpsGet(url: string, redirectsLeft = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                const next = new URL(res.headers.location, url).toString();
                httpsGet(next, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
            const chunks: Buffer[] = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ort webgpu probe</title></head>
<body><pre id="log"></pre><script type="module">
const log = (...a) => {
    const line = a.map(x => typeof x === "string" ? x : JSON.stringify(x, (k, v) => v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v, 2)).join(" ");
    console.log("[harness]", line);
    document.getElementById("log").textContent += line + "\\n";
};
const errToObj = err => {
    if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
    if (typeof err === "object" && err) return err;
    return { value: String(err), typeof: typeof err };
};
window.__results = [];
const finish = (key, ok, info) => { window.__results.push({ key, ok, info }); log("RESULT", key, ok, info); };

async function tryLoad(label, modelUrl, sessionOpts) {
    const t0 = performance.now();
    try {
        const resp = await fetch(modelUrl);
        const buf = await resp.arrayBuffer();
        log(label, "fetched", buf.byteLength, "B");
        const sess = await ort.InferenceSession.create(buf, sessionOpts);
        const createMs = performance.now() - t0;
        finish(label, true, { createMs, inputs: sess.inputNames, outputs: sess.outputNames });
        return sess;
    } catch (err) {
        finish(label, false, errToObj(err));
        return undefined;
    }
}

try {
    // Function-constructor dance so the bundler never analyses this import
    // (see CLAUDE.md): the module is served raw at runtime, not bundled.
    const dynImport = new Function("u", "return import(u)");
    const ort = await dynImport("/ort.webgpu.bundle.min.mjs");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@__ORT_VERSION__/dist/";
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "warning";
    ort.env.webgpu.powerPreference = "high-performance";
    window.ort = ort; // for poking around in the playwright console
    log("ort loaded", { version: ort.env?.versions });

    if (!navigator.gpu) { finish("adapter", false, "no navigator.gpu"); throw new Error("no gpu"); }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) { finish("adapter", false, "requestAdapter returned null"); throw new Error("no adapter"); }
    const lims = {};
    for (const k of [
        "maxBufferSize", "maxStorageBufferBindingSize", "maxUniformBufferBindingSize",
        "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup",
        "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
        "maxComputeWorkgroupsPerDimension",
    ]) lims[k] = adapter.limits[k];
    finish("adapter-limits", true, lims);

    // Tier 1: WASM baseline. Both models must work here — if any of these
    // fail then it's not a WebGPU issue, it's something more fundamental.
    await tryLoad("det_10g-wasm", "/face-models/det_10g.onnx", { executionProviders: ["wasm"] });
    const recWasm = await tryLoad("w600k_r50-wasm", "/face-models/w600k_r50.onnx", { executionProviders: ["wasm"] });
    if (recWasm) {
        try {
            const t0 = performance.now();
            const input = new ort.Tensor("float32", new Float32Array(3 * 112 * 112), [1, 3, 112, 112]);
            const out = await recWasm.run({ [recWasm.inputNames[0]]: input });
            finish("w600k_r50-wasm-run", true, { runMs: performance.now() - t0, outShape: out[recWasm.outputNames[0]].dims });
        } catch (err) { finish("w600k_r50-wasm-run", false, errToObj(err)); }
    }

    // Tier 2: small model on WebGPU. det_10g is only 16 MB; if THIS fails
    // with the same kind of raw-number error then the cap-and-buffer
    // hypothesis is wrong and it's an ops-coverage issue (we already know
    // det_10g uses AveragePool with ceil that WebGPU doesn't implement, so
    // we expect a runtime not a session-create failure).
    await tryLoad("det_10g-webgpu", "/face-models/det_10g.onnx", { executionProviders: ["webgpu"] });

    // Tier 3: the big one, the actual problem. ArcFace on WebGPU.
    await tryLoad("w600k_r50-webgpu", "/face-models/w600k_r50.onnx", { executionProviders: ["webgpu"] });

    // Tier 4: same model various sessionOption knobs.
    await tryLoad("w600k_r50-webgpu-no-opt", "/face-models/w600k_r50.onnx", {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "disabled",
    });
    await tryLoad("w600k_r50-webgpu-no-mempat", "/face-models/w600k_r50.onnx", {
        executionProviders: ["webgpu"],
        enableMemPattern: false,
    });
    await tryLoad("w600k_r50-webgpu-nhwc", "/face-models/w600k_r50.onnx", {
        executionProviders: [{ name: "webgpu", preferredLayout: "NHWC" }],
    });
    await tryLoad("w600k_r50-webgpu-nchw", "/face-models/w600k_r50.onnx", {
        executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
    });
    await tryLoad("w600k_r50-webgpu-no-arena", "/face-models/w600k_r50.onnx", {
        executionProviders: ["webgpu"],
        enableCpuMemArena: false,
    });
    await tryLoad("w600k_r50-webgpu-everything-off", "/face-models/w600k_r50.onnx", {
        executionProviders: [{ name: "webgpu", preferredLayout: "NHWC" }],
        graphOptimizationLevel: "disabled",
        enableMemPattern: false,
        enableCpuMemArena: false,
    });

    // Tier 5: SCRFD detection on WebGPU. The AveragePool/ceil error was
    // at inference time, not session creation. Test different layouts to
    // see which one (if any) actually completes a full forward pass.
    async function tryRunSCRFD(label, opts) {
        const t0 = performance.now();
        try {
            const resp = await fetch("/face-models/det_10g.onnx");
            const buf = await resp.arrayBuffer();
            const sess = await ort.InferenceSession.create(buf, opts);
            const createMs = performance.now() - t0;
            const tRun = performance.now();
            const input = new ort.Tensor("float32", new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
            const out = await sess.run({ [sess.inputNames[0]]: input });
            const runMs = performance.now() - tRun;
            const outShapes = {};
            for (const [k, v] of Object.entries(out)) outShapes[k] = v.dims;
            finish(label, true, { createMs, runMs, outShapes });
        } catch (err) { finish(label, false, errToObj(err)); }
    }

    await tryRunSCRFD("det_10g-webgpu-default-run",
        { executionProviders: ["webgpu"] });
    await tryRunSCRFD("det_10g-webgpu-nchw-run",
        { executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }] });
    await tryRunSCRFD("det_10g-webgpu-nhwc-run",
        { executionProviders: [{ name: "webgpu", preferredLayout: "NHWC" }] });
    await tryRunSCRFD("det_10g-wasm-run",
        { executionProviders: ["wasm"] });

    // Tier 6: the actual user scenario — does SCRFD's WebGPU failure
    // corrupt the device for ArcFace's subsequent run?
    try {
        const recBuf = await (await fetch("/face-models/w600k_r50.onnx")).arrayBuffer();
        const recSess = await ort.InferenceSession.create(recBuf, {
            executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
        });
        log("arcface created on webgpu");
        // Try a successful embed first.
        const embedTry = async (tag) => {
            const t0 = performance.now();
            const inp = new ort.Tensor("float32", new Float32Array(3 * 112 * 112), [1, 3, 112, 112]);
            const out = await recSess.run({ [recSess.inputNames[0]]: inp });
            return { tag, runMs: performance.now() - t0, outShape: out[recSess.outputNames[0]].dims };
        };
        finish("pipeline-arcface-pre", true, await embedTry("pre"));

        const detBuf = await (await fetch("/face-models/det_10g.onnx")).arrayBuffer();
        const detSess = await ort.InferenceSession.create(detBuf, {
            executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
        });
        try {
            const inp = new ort.Tensor("float32", new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
            await detSess.run({ [detSess.inputNames[0]]: inp });
            finish("pipeline-scrfd-run", true, "no error (huh)");
        } catch (err) {
            finish("pipeline-scrfd-run", false, errToObj(err));
        }
        // Now retry ArcFace — does the SCRFD failure poison the device?
        try {
            finish("pipeline-arcface-post-scrfd-fail", true, await embedTry("post"));
        } catch (err) {
            finish("pipeline-arcface-post-scrfd-fail", false, errToObj(err));
        }
    } catch (err) {
        finish("pipeline-test", false, errToObj(err));
    }
} catch (e) { log("FATAL", errToObj(e)); }
window.__done = true;
</script></body></html>
`;

let ortBundle: Buffer | undefined;

const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HARNESS_HTML.replace(/__ORT_VERSION__/g, ORT_VERSION));
        return;
    }
    if (url === "/ort.webgpu.bundle.min.mjs") {
        if (!ortBundle) { res.writeHead(503); res.end("ort bundle not loaded yet"); return; }
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(ortBundle);
        return;
    }
    if (url.startsWith("/face-models/")) {
        const name = url.slice("/face-models/".length);
        if (name.includes("..") || name.includes("/")) { res.writeHead(400); res.end(); return; }
        const filePath = path.join(MODELS_DIR, name);
        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
        const stat = fs.statSync(filePath);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(stat.size) });
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    res.writeHead(404); res.end();
});

async function main() {
    console.log(`[probe] fetching ${ORT_BUNDLE_URL}...`);
    ortBundle = await httpsGet(ORT_BUNDLE_URL);
    // Patch the harness's wasmPaths placeholder before serving.
    // (cheap inline templating instead of importing a templating lib)
    console.log(`[probe] ort bundle: ${(ortBundle.byteLength / 1024).toFixed(0)} KB`);
    server.listen(PORT);
    await new Promise(r => server.on("listening", r));
    console.log(`[probe] http://localhost:${PORT}/ serving harness + /face-models/ + /ort.webgpu.bundle.min.mjs`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--enable-unsafe-webgpu",
            "--enable-features=Vulkan",
            "--use-vulkan=swiftshader",
            "--no-sandbox",
        ],
    });
    const context = await browser.newContext();
    const pageObj = await context.newPage();
    pageObj.on("console", msg => {
        const t = msg.type();
        if (t === "warning" || t === "error") console.log(`[browser ${t}]`, msg.text());
    });
    pageObj.on("pageerror", err => console.log(`[pageerror]`, err.message));

    await pageObj.goto(`http://localhost:${PORT}/`);
    await pageObj.waitForFunction("window.__done === true", undefined, { timeout: 180_000 });
    const results = await pageObj.evaluate("window.__results");
    console.log("\n────── RESULTS ──────");
    console.log(JSON.stringify(results, null, 2));

    await browser.close();
    server.close();
    process.exit(0);
}

main().catch(err => { console.error("probe failed:", err); process.exit(1); });
