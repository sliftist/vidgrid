// Dynamically load onnxruntime-web from a CDN. The library is large
// (~5 MB including WASM) and is only needed when the user explicitly opens
// the face-test page, so we don't want it in the main bundle. Same shape
// as our web-demuxer loader.

// onnxruntime-web's default entrypoint only includes the WASM backend; the
// WebGPU backend is shipped as a separate ESM. `ort.webgpu.bundle.min.mjs`
// is the pre-bundled, self-contained WebGPU build.
//
// Version pinning matters: 1.20-1.22 lacked WebGPU kernel coverage for ops
// SCRFD uses (AveragePool ceil_mode, recursive-call Transpose). 1.23.x
// fixed SCRFD but regressed ArcFace session creation with a buffer alloc
// error. 1.24.3+ has both working. Pin 1.26.0 — newest known-good for
// the SCRFD + ResNet50-ArcFace pair we ship.
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.webgpu.bundle.min.mjs";

// Function-constructor dance so the bundler doesn't try to analyse the
// import. Same trick we use in WebDemuxerPlayer.
const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

let ortPromise: Promise<any> | undefined;

// Pre-create a WebGPU GPUDevice with the adapter's *maximum* limits and
// hand it to ORT via env.webgpu.device. Default device limits are
// conservative (e.g. 128 MB maxStorageBufferBindingSize), and large models
// like ArcFace ResNet50 have weight buffers that overrun those — session
// creation fails with raw numbers like "Error: 81499536" because JSEP
// can't allocate.
//
// IMPORTANT: only set env.webgpu.device. Do NOT also set env.webgpu.adapter
// — ORT calls adapter.requestDevice internally even when a device is
// already set, and a GPUAdapter can only produce one device. The second
// call throws "adapter is 'consumed'" and ORT drops the WebGPU EP. By
// leaving adapter undefined we let ORT request its own (cheap) adapter for
// metadata purposes and the device we passed is the one actually used.
async function setupWebGPU(mod: any): Promise<void> {
    const gpu = (navigator as any).gpu;
    if (!gpu) {
        console.log(`[ort] navigator.gpu missing — WebGPU disabled`);
        return;
    }
    try {
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) {
            console.warn(`[ort] no WebGPU adapter — WebGPU disabled`);
            return;
        }
        const lims = adapter.limits;
        const requiredLimits: Record<string, number> = {};
        const wanted = [
            "maxBufferSize",
            "maxStorageBufferBindingSize",
            "maxUniformBufferBindingSize",
            "maxComputeWorkgroupStorageSize",
            "maxComputeInvocationsPerWorkgroup",
            "maxComputeWorkgroupSizeX",
            "maxComputeWorkgroupSizeY",
            "maxComputeWorkgroupSizeZ",
            "maxComputeWorkgroupsPerDimension",
        ];
        for (const k of wanted) {
            const v = (lims as any)[k];
            if (typeof v === "number" && Number.isFinite(v)) requiredLimits[k] = v;
        }
        const device = await adapter.requestDevice({ requiredLimits });
        // adapter is now consumed; throw away the reference so ORT can't
        // grab it from env and re-call requestDevice on it.
        device.addEventListener("uncapturederror", (e: any) => {
            console.warn(`[webgpu] uncapturederror:`, e.error?.message ?? e.error ?? e);
        });
        device.lost.then((info: any) => {
            console.warn(`[webgpu] device lost:`, info.reason ?? info);
        }).catch(() => { /* device GC */ });

        mod.env.webgpu.device = device;
        mod.env.webgpu.powerPreference = "high-performance";

        console.log(`[ort] WebGPU device ready — maxBuffer=${(lims.maxBufferSize / (1024 * 1024)).toFixed(0)}MB, maxStorageBinding=${(lims.maxStorageBufferBindingSize / (1024 * 1024)).toFixed(0)}MB`);
    } catch (err) {
        console.warn(`[ort] WebGPU setup failed, will fall back to WASM:`, err);
    }
}

export async function loadOrt(): Promise<any> {
    if (!ortPromise) {
        ortPromise = (async () => {
            console.log(`[ort] loading from ${ORT_URL}`);
            const mod = await dynImport(ORT_URL);
            // Keep the inference on the main thread — saves the cross-origin
            // Worker juggling and works fine for the test page.
            mod.env.wasm.numThreads = 1;
            await setupWebGPU(mod);
            console.log(`[ort] loaded, backends available: ${Object.keys(mod.env).join(",")}`);
            return mod;
        })();
    }
    return ortPromise;
}

// Execution provider option — either a string ("wasm" / "webgpu") or the
// long form with extra knobs (most importantly `preferredLayout` for
// WebGPU, which has to be "NCHW" for some PyTorch-exported models).
export type EP = string | { name: string; preferredLayout?: "NCHW" | "NHWC" };

// Create an InferenceSession from a model buffer. Some models hit WebGPU
// limitations (SCRFD's AveragePool with ceil, ResNet50's NHWC layout
// transform that allocates ~300MB), so the caller picks the EP list and
// shapes per model.
//
// JS-level WebGPU → WASM fallback: JSEP commonly throws raw WASM pointer
// numbers ("Error: 81499536") rather than Error objects, and ORT's
// internal auto-fallback doesn't catch those. We catch at the JS
// boundary instead and retry with WASM-only.
// Optional warmup spec — a dummy input that lets us run one forward pass
// at session-creation time. Catches WebGPU runtime errors (op unsupported,
// recursive-kernel scheduling failures) BEFORE the real pipeline starts
// using the session, so the WASM fallback path can take over.
export interface WarmupSpec {
    inputName: string;
    dims: number[];
    fillValue?: number;
}

export async function createSession(
    modelBytes: ArrayBuffer,
    label: string,
    providers: EP[] = ["wasm"],
    warmup?: WarmupSpec,
): Promise<any> {
    const ort = await loadOrt();
    const t0 = performance.now();
    const descr = providers.map(p => typeof p === "string" ? p : p.name).join(",");
    const usedWebgpu = providers.some(p => (typeof p === "string" ? p : p.name) !== "wasm");

    const tryCreate = async (eps: EP[]): Promise<any> => {
        const s = await ort.InferenceSession.create(modelBytes, {
            executionProviders: eps,
            graphOptimizationLevel: "all",
        });
        if (warmup) {
            const tensor = new ort.Tensor("float32",
                new Float32Array(warmup.dims.reduce((a, b) => a * b, 1)).fill(warmup.fillValue ?? 0),
                warmup.dims);
            await s.run({ [warmup.inputName]: tensor });
        }
        return s;
    };

    try {
        const session = await tryCreate(providers);
        console.log(`[ort] session '${label}' ready in ${(performance.now() - t0).toFixed(0)}ms via [${descr}] (inputs=${session.inputNames.join(",")}, outputs=${session.outputNames.join(",")})`);
        return session;
    } catch (err) {
        if (usedWebgpu) {
            const detail = err instanceof Error ? err.message : String(err);
            console.warn(`[ort] '${label}' failed with [${descr}] (${detail}), retrying [wasm]`);
            const session = await tryCreate(["wasm"]);
            console.log(`[ort] session '${label}' ready in ${(performance.now() - t0).toFixed(0)}ms via [wasm]`);
            return session;
        }
        throw err;
    }
}
