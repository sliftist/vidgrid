// Renders VideoFrames to a canvas via WebGPU. SDR frames go the fast path:
// `importExternalTexture` keeps the decoded frame GPU-resident (zero CPU copy)
// and a fullscreen quad samples it.
//
// HDR frames (PQ / HLG, e.g. HDR10) need tone mapping to look right on an SDR
// canvas. WebGPU's external-texture path does NOT tone-map — it color-converts
// to sRGB and clips anything above SDR white, which blows out the highlights.
// So for HDR we first paint the frame to a 2D canvas (browsers tone-map HDR→
// SDR on `drawImage`), then upload that SDR result with copyExternalImageTo
// Texture and sample it as a regular 2D texture. SDR playback is unchanged.

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

// HDR path: sample the tone-mapped SDR copy we staged via a 2D canvas.
const SHADER_2D = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv);
}`;

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipeline2d!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;

    // HDR (tone-mapping) path resources, created lazily on the first HDR frame.
    private hdrHint = false;
    private stagingCanvas: OffscreenCanvas | undefined;
    private stagingCtx: OffscreenCanvasRenderingContext2D | undefined;
    private sdrTex: GPUTexture | undefined;
    private sdrTexW = 0;
    private sdrTexH = 0;

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

    // Tell the renderer the stream is HDR so it tone-maps every frame, even if
    // an individual VideoFrame's colorSpace metadata is missing. Set by the
    // player from Mediabunny's track info (hasHighDynamicRange()).
    setHdrHint(hdr: boolean): void {
        this.hdrHint = hdr;
    }

    async init(): Promise<void> {
        if (!navigator.gpu) throw new Error("WebGPU not available");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No WebGPU adapter");
        this.device = await adapter.requestDevice();
        const ctx = this.canvas.getContext("webgpu");
        if (!ctx) throw new Error("Failed to get webgpu canvas context");
        this.context = ctx;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "opaque",
        });
        const mkPipeline = (code: string) => {
            const module = this.device.createShaderModule({ code });
            return this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{ format: this.format }] },
                primitive: { topology: "triangle-list" },
            });
        };
        this.pipelineExternal = mkPipeline(SHADER_EXTERNAL);
        this.pipeline2d = mkPipeline(SHADER_2D);
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    }

    private isHdrFrame(frame: VideoFrame): boolean {
        if (this.hdrHint) return true;
        // Cast: some lib.dom versions type VideoTransferCharacteristics without
        // the HDR members (pq/hlg) even though WebCodecs reports them.
        const tr = frame.colorSpace?.transfer as string | undefined;
        return tr === "pq" || tr === "hlg";
    }

    render(frame: VideoFrame): void {
        // Resize canvas backing store to match frame's display size on the first
        // draw; subsequent draws assume the same dimensions.
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        const drawCall = this.isHdrFrame(frame)
            ? this.bindGroupForHdr(frame)
            : this.bindGroupForSdr(frame);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(drawCall.pipeline);
        pass.setBindGroup(0, drawCall.group);
        pass.draw(6, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    private bindGroupForSdr(frame: VideoFrame): { pipeline: GPURenderPipeline; group: GPUBindGroup } {
        const external = this.device.importExternalTexture({ source: frame });
        const group = this.device.createBindGroup({
            layout: this.pipelineExternal.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: external },
            ],
        });
        return { pipeline: this.pipelineExternal, group };
    }

    private bindGroupForHdr(frame: VideoFrame): { pipeline: GPURenderPipeline; group: GPUBindGroup } {
        const w = frame.displayWidth, h = frame.displayHeight;
        if (!this.stagingCanvas || this.sdrTexW !== w || this.sdrTexH !== h) {
            this.stagingCanvas = new OffscreenCanvas(w, h);
            this.stagingCtx = this.stagingCanvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D;
            this.sdrTex?.destroy();
            this.sdrTex = this.device.createTexture({
                size: [w, h], format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.sdrTexW = w; this.sdrTexH = h;
        }
        // Browsers tone-map HDR (PQ/HLG) → SDR sRGB when an HDR VideoFrame is
        // drawn to a 2D canvas. Upload that SDR result to a sampled texture.
        this.stagingCtx!.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
        this.device.queue.copyExternalImageToTexture(
            { source: this.stagingCanvas! },
            { texture: this.sdrTex! },
            [w, h],
        );
        const group = this.device.createBindGroup({
            layout: this.pipeline2d.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: this.sdrTex!.createView() },
            ],
        });
        return { pipeline: this.pipeline2d, group };
    }

    destroy(): void {
        this.sdrTex?.destroy();
        if (this.device) this.device.destroy();
    }
}
