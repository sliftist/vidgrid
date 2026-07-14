// Renders VideoFrames to a canvas via WebGPU.
//
//  - SDR frames: the fast path — `importExternalTexture` keeps the decoded
//    frame GPU-resident (zero copy) and a fullscreen quad samples it.
//  - HDR frames (PQ/HLG, e.g. HDR10): run a cheap approximate tone map on the
//    external texture's (over-bright) output — sRGB→linear, exposure, ACES
//    rolloff, →sRGB. Full speed, no readback, works for hardware-decoded HDR
//    (whose pixels Chrome won't expose). It can't recover highlights already
//    clipped to white by the browser's conversion, but pulls the washed-out
//    midtones back toward natural.

import { hdrBlack, hdrWhite, hdrGamma } from "../appState";

const VS = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
    );
    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0),
    );
    var out: VsOut;
    out.pos = vec4<f32>(positions[vi], 0.0, 1.0);
    out.uv = uvs[vi];
    return out;
}`;

// SDR fast path: sample the decoded frame directly as an external texture.
const SHADER_EXTERNAL = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(tex, samp, in.uv);
}`;

// Approximate HDR path: a "levels" stretch on the external texture's output.
// Used for ALL HDR frames (the raw planes aren't available for hardware-decoded
// HDR, and Chrome already gives us an SDR-ish sRGB surface — usually dark and
// low-contrast). Rather than a fixed tone curve, we let the user pull the range
// back by hand: normalize between a black and white point, then apply gamma —
//   out = clamp((s - black) / (white - black), 0, 1) ^ (1/gamma)
// The three params are baked in; the renderer rebuilds the pipeline when any of
// them change (see render()).
interface HdrLevels { black: number; white: number; gamma: number; }
function readHdrLevels(): HdrLevels {
    return { black: hdrBlack.get(), white: hdrWhite.get(), gamma: hdrGamma.get() };
}
function levelsKey(l: HdrLevels): string {
    return `${l.black}|${l.white}|${l.gamma}`;
}
function makeHdrShader(l: HdrLevels): string {
    const black = l.black;
    // Guard against a zero/negative range (white <= black) blowing up.
    const invRange = 1 / Math.max(l.white - l.black, 1e-4);
    const invGamma = 1 / Math.max(l.gamma, 1e-4);
    return VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
const BLACK: f32 = ${black.toFixed(5)};
const INV_RANGE: f32 = ${invRange.toFixed(5)};
const INV_GAMMA: f32 = ${invGamma.toFixed(5)};
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let s = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;
    let n = clamp((s - vec3<f32>(BLACK)) * INV_RANGE, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(pow(n, vec3<f32>(INV_GAMMA)), 1.0);
}`;
}

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipelineExternalHdr!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;

    // Fired when the GPUDevice is lost for a reason other than our own
    // destroy() — a driver reset / the GPU being wedged by another app. Once
    // lost, every submit on the device silently no-ops (frames "render" but
    // nothing paints), so the owner must rebuild with a fresh device.
    onDeviceLost: ((message: string) => void) | undefined;

    private hdrHint = false;
    private loggedHdr = false;
    // A clone of the most recently rendered frame, kept alive so redraw() can
    // repaint it (settings changed while paused). Closed on replace / destroy.
    private lastFrame: VideoFrame | undefined;
    // Levels baked into pipelineExternalHdr; rebuilt when any setting changes.
    private hdrLevelsBuilt = "";

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    static async isSupported(): Promise<boolean> {
        if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return !!adapter;
        } catch {
            return false;
        }
    }

    // Tell the renderer the stream is HDR (from Mediabunny's track info) so it
    // tone-maps even if a frame's colorSpace metadata is missing.
    setHdrHint(hdr: boolean): void {
        this.hdrHint = hdr;
    }

    async init(): Promise<void> {
        if (!navigator.gpu) throw new Error("WebGPU not available");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No WebGPU adapter");
        this.device = await adapter.requestDevice();
        void this.device.lost.then(info => {
            if (info.reason === "destroyed") return; // our own destroy()
            console.warn(`[render] WebGPU device lost (${info.reason}): ${info.message}`);
            this.onDeviceLost?.(info.message);
        });
        const ctx = this.canvas.getContext("webgpu");
        if (!ctx) throw new Error("Failed to get webgpu canvas context");
        this.context = ctx;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
        this.pipelineExternal = this.makePipeline(SHADER_EXTERNAL);
        const levels = readHdrLevels();
        this.hdrLevelsBuilt = levelsKey(levels);
        this.pipelineExternalHdr = this.makePipeline(makeHdrShader(levels));
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    }

    private makePipeline(code: string): GPURenderPipeline {
        const module = this.device.createShaderModule({ code });
        return this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs_main" },
            fragment: { module, entryPoint: "fs_main", targets: [{ format: this.format }] },
            primitive: { topology: "triangle-list" },
        });
    }

    private isHdrFrame(frame: VideoFrame): boolean {
        if (this.hdrHint) return true;
        const tr = frame.colorSpace?.transfer as string | undefined;
        return tr === "pq" || tr === "hlg";
    }

    async render(frame: VideoFrame): Promise<void> {
        this.paint(frame);
        // Retain a clone of the most recent frame so we can repaint it on demand
        // — e.g. when the user drags the HDR-exposure slider while paused and no
        // new frames are being decoded. The caller closes its own `frame` after
        // render() returns, so we hold our own reference.
        if (this.lastFrame) { try { this.lastFrame.close(); } catch { /* already closed */ } }
        try { this.lastFrame = frame.clone(); } catch { this.lastFrame = undefined; }
    }

    // Repaint the last frame with the current settings. Used while paused so a
    // change to the HDR tone-map exposure is visible immediately. No-op before
    // the first frame has been rendered.
    redraw(): void {
        if (!this.device || !this.lastFrame) return;
        this.paint(this.lastFrame);
    }

    private paint(frame: VideoFrame): void {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        const hdr = this.isHdrFrame(frame);
        if (hdr) {
            // Live-update the levels stretch when the user changes any HDR knob.
            const levels = readHdrLevels();
            const key = levelsKey(levels);
            if (key !== this.hdrLevelsBuilt) {
                this.hdrLevelsBuilt = key;
                this.pipelineExternalHdr = this.makePipeline(makeHdrShader(levels));
            }
            if (!this.loggedHdr) {
                this.loggedHdr = true;
                const cs = frame.colorSpace;
                console.log(`[render] HDR frame: format=${frame.format} primaries=${cs?.primaries} transfer=${cs?.transfer} matrix=${cs?.matrix} fullRange=${cs?.fullRange} → levels stretch (black ${levels.black}, white ${levels.white}, gamma ${levels.gamma})`);
            }
        }
        const draw = this.bindGroupForExternal(frame, hdr ? this.pipelineExternalHdr : this.pipelineExternal);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(0, draw.group);
        pass.draw(6, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    private bindGroupForExternal(frame: VideoFrame, pipeline: GPURenderPipeline) {
        const external = this.device.importExternalTexture({ source: frame });
        return {
            pipeline,
            group: this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: external },
                ],
            }),
        };
    }

    destroy(): void {
        if (this.lastFrame) { try { this.lastFrame.close(); } catch { /* already closed */ } this.lastFrame = undefined; }
        if (this.device) this.device.destroy();
    }
}
