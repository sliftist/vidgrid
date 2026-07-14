// Renders VideoFrames to a canvas via WebGPU.
//
//  - SDR frames: the fast path — `importExternalTexture` keeps the decoded
//    frame GPU-resident (zero copy) and a fullscreen quad samples it.
//  - HDR frames (PQ/HLG, e.g. HDR10): copy the (already SDR-ish, usually dark)
//    frame into an owned rgba16float texture and run a user-tunable levels
//    stretch (black/white/gamma) on it. The copy lets us repaint the same frame
//    while paused when the knobs change (redraw), without holding a VideoFrame
//    — hardware-decoded HDR frames don't survive retention/re-import reliably.
//    It can't recover highlights already clipped to white by the browser's
//    conversion, but pulls the washed-out midtones back toward natural.

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
@group(0) @binding(1) var tex: texture_2d<f32>;
const BLACK: f32 = ${black.toFixed(5)};
const INV_RANGE: f32 = ${invRange.toFixed(5)};
const INV_GAMMA: f32 = ${invGamma.toFixed(5)};
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let s = textureSample(tex, samp, in.uv).rgb;
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
    // The most recently rendered HDR frame, copied into an owned rgba16float
    // texture so redraw() can re-run the levels shader on it while paused (no
    // dependency on a retained/cloned VideoFrame, which proved unreliable for
    // hardware-decoded HDR). Destroyed/resized on the next HDR frame + destroy().
    private hdrTex: GPUTexture | undefined;
    private hdrTexW = 0;
    private hdrTexH = 0;
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
        this.resizeCanvas(frame);
        if (this.isHdrFrame(frame)) {
            // Copy the (already SDR-ish) frame into an owned texture and run the
            // levels shader on it. The copy lets redraw() repaint while paused
            // without holding onto the VideoFrame (the caller closes it).
            this.uploadHdr(frame);
            this.drawHdr();
        } else {
            // SDR fast path: sample the decoded frame directly, zero copy. No
            // adjustable levels here, so no paused-repaint dependency to keep.
            this.drawExternal(frame);
        }
    }

    // Repaint the last HDR frame with the current levels. Used while paused so a
    // change to the HDR knobs is visible immediately. No-op before the first HDR
    // frame (nothing to repaint) or on SDR (no adjustable levels). Paints
    // synchronously — the render loop presents the same way (a bare submit, no
    // rAF), so there's no need to defer, and doing so only risks a throttled or
    // never-firing rAF swallowing the update.
    redraw(): void {
        if (!this.device || !this.hdrTex) return;
        this.drawHdr();
    }

    private resizeCanvas(frame: VideoFrame): void {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }
    }

    // Copy the frame into the owned rgba16float texture, (re)allocating it if the
    // dimensions changed. Keeps enough of the frame around to repaint on demand.
    private uploadHdr(frame: VideoFrame): void {
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        if (!this.hdrTex || this.hdrTexW !== w || this.hdrTexH !== h) {
            this.hdrTex?.destroy();
            this.hdrTex = this.device.createTexture({
                size: [w, h],
                format: "rgba16float",
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.hdrTexW = w;
            this.hdrTexH = h;
        }
        this.device.queue.copyExternalImageToTexture({ source: frame }, { texture: this.hdrTex }, [w, h]);
        if (!this.loggedHdr) {
            this.loggedHdr = true;
            const cs = frame.colorSpace;
            const l = readHdrLevels();
            console.log(`[render] HDR frame: format=${frame.format} primaries=${cs?.primaries} transfer=${cs?.transfer} matrix=${cs?.matrix} fullRange=${cs?.fullRange} → levels stretch (black ${l.black}, white ${l.white}, gamma ${l.gamma})`);
        }
    }

    // Run the levels shader on the owned HDR texture, rebuilding the pipeline if
    // any knob changed. Safe to call repeatedly (redraw) with no frame in hand.
    private drawHdr(): void {
        if (!this.hdrTex) return;
        const levels = readHdrLevels();
        const key = levelsKey(levels);
        if (key !== this.hdrLevelsBuilt) {
            this.hdrLevelsBuilt = key;
            this.pipelineExternalHdr = this.makePipeline(makeHdrShader(levels));
        }
        const group = this.device.createBindGroup({
            layout: this.pipelineExternalHdr.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: this.hdrTex.createView() },
            ],
        });
        this.drawPass(this.pipelineExternalHdr, group);
    }

    private drawExternal(frame: VideoFrame): void {
        const external = this.device.importExternalTexture({ source: frame });
        const group = this.device.createBindGroup({
            layout: this.pipelineExternal.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: external },
            ],
        });
        this.drawPass(this.pipelineExternal, group);
    }

    private drawPass(pipeline: GPURenderPipeline, group: GPUBindGroup): void {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(6, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    destroy(): void {
        if (this.hdrTex) { this.hdrTex.destroy(); this.hdrTex = undefined; }
        if (this.device) this.device.destroy();
    }
}
