// Renders VideoFrames to a canvas via WebGPU.
//
//  - SDR frames use `importExternalTexture` (zero copy) + a fullscreen quad.
//  - HDR frames (PQ/HLG) also use `importExternalTexture`, but Chrome converts
//    the external HDR texture to a fixed, roughly-linear 709/sRGB signal before
//    the shader samples it (it is NOT raw PQ, and it carries values outside
//    [0,1]). That conversion is a constant global function — identical for every
//    frame and every file — so we correct it with a single fixed color curve
//    (LUT) fitted offline against `ffmpeg tonemap=hable` / VLC output:
//        disp = clamp((1.6 * max(ext, 0)^3.2 - 0.01) * k, 0, 1)   (per channel)
//    Fit error ~4.6/255 mean abs vs the reference. `k` is a post-curve linear
//    gain (the exposure knob); k = 1 is neutral, so raising it brightens the
//    image without shifting hue. This works on hardware-decoded (opaque) frames,
//    which is the whole point — no software decode / raw YUV readback needed.

import { DEFAULT_HDR_EXPOSURE } from "../appState";

// The UI exposure value that maps to neutral gain k = 1.0.
const EXPOSURE_UNITY = 100;

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

const SHADER_EXTERNAL = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(tex, samp, in.uv);
}`;

// HDR path: correct Chrome's fixed external-texture HDR conversion with the
// fitted global curve, then apply the post-curve exposure gain k (params.x).
const SHADER_EXTERNAL_HDR = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> params: vec4<f32>;   // k (gain), _, _, _
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let src = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;
    let base = 1.6 * pow(max(src, vec3<f32>(0.0)), vec3<f32>(3.2)) - 0.01;
    let disp = clamp(base * params.x, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(disp, 1.0);
}`;

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipelineHdr!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;
    private paramsBuffer!: GPUBuffer;

    // Fired when the GPUDevice is lost for a reason other than our own
    // destroy() — a driver reset / the GPU being wedged by another app. Once
    // lost, every submit on the device silently no-ops (frames "render" but
    // nothing paints), so the owner must rebuild with a fresh device.
    onDeviceLost: ((message: string) => void) | undefined;

    private hdrHint = false;
    private exposure = DEFAULT_HDR_EXPOSURE;
    private lastFrame: VideoFrame | undefined;
    private loggedHdr = false;

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

    // Tell the renderer the stream is HDR (from Mediabunny's track info).
    setHdrHint(hdr: boolean): void {
        this.hdrHint = hdr;
    }

    // Map the UI exposure value to the post-curve gain k used by the shader.
    private exposureGain(): number {
        return this.exposure / EXPOSURE_UNITY;
    }

    // Live exposure knob for the HDR curve. Repaints the last frame so the
    // change shows immediately even while paused.
    setExposure(ls: number): void {
        this.exposure = ls;
        if (this.paramsBuffer) {
            this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.exposureGain(), 0, 0, 0]));
        }
        if (this.lastFrame) {
            try {
                this.drawHdr(this.lastFrame);
            } catch { /* frame already closed by the render loop */ }
        }
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
        this.pipelineHdr = this.makePipeline(SHADER_EXTERNAL_HDR);
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        // vec4: (k, _, _, _). k is the post-curve exposure gain and updates live.
        this.paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.exposureGain(), 0, 0, 0]));
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

    render(frame: VideoFrame): void {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }
        if (this.isHdrFrame(frame)) {
            this.drawHdr(frame);
        } else {
            this.drawExternal(frame);
        }
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
        this.encodeAndSubmit(this.pipelineExternal, group);
    }

    // Sample the (Chrome-converted) external HDR texture and apply the fitted
    // global curve + exposure gain. Works on opaque hardware-decoded frames.
    private drawHdr(frame: VideoFrame): void {
        this.lastFrame = frame;
        if (!this.loggedHdr) {
            this.loggedHdr = true;
            console.log(`[hdr] external-texture LUT active (LS=${this.exposure}, k=${this.exposureGain().toFixed(3)}) transfer=${frame.colorSpace?.transfer}`);
        }
        const external = this.device.importExternalTexture({ source: frame });
        const group = this.device.createBindGroup({
            layout: this.pipelineHdr.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: external },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
            ],
        });
        this.encodeAndSubmit(this.pipelineHdr, group);
    }

    private encodeAndSubmit(pipeline: GPURenderPipeline, group: GPUBindGroup): void {
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
        this.lastFrame = undefined;
        if (this.device) this.device.destroy();
    }
}
