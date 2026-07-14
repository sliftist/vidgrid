// Renders VideoFrames to a canvas via WebGPU.
//
//  - `importExternalTexture` keeps the decoded frame GPU-resident (zero copy)
//    and a fullscreen quad samples it.
//  - HDR frames (PQ/HLG) run through an extra fragment shader that ports VLC
//    3.0's HDR->SDR pixel transform: PQ EOTF -> BT.2020->709 matrix ->
//    desaturate-to-gamut -> Hable filmic tonemap (per channel, scaled by the
//    `exposure`/LS knob) -> gamma 2.2. SDR frames keep the plain path.

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

// VLC 3.0 HDR->SDR transform, ported per-pixel. Input is treated as
// PQ-encoded BT.2020 R'G'B' in [0,1]; output is display-gamma sRGB/BT.709.
const SHADER_EXTERNAL_HDR = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> exposure: f32;   // LS (luminance scale)

// PQ / SMPTE ST.2084 EOTF: coded value -> linear (1.0 == 10000 nits).
const M1 = 0.1593017578125;   // 2610/16384
const M2 = 78.84375;          // 2523/4096*128
const C1 = 0.8359375;         // 3424/4096
const C2 = 18.8515625;        // 2413/4096*32
const C3 = 18.6875;           // 2392/4096*32
fn pq_eotf(v: vec3<f32>) -> vec3<f32> {
    let vv = max(v, vec3<f32>(0.0));
    let vp = pow(vv, vec3<f32>(1.0 / M2));
    return pow(max(vp - C1, vec3<f32>(0.0)) / (C2 - C3 * vp), vec3<f32>(1.0 / M1));
}

// Hable filmic tonemap (filmicworlds.com), per channel.
const HA = 0.15; const HB = 0.50; const HC = 0.10;
const HD = 0.20; const HE = 0.02; const HF = 0.30;
fn hable1(x: f32) -> f32 {
    return ((x * (HA * x + HC * HB) + HD * HE) / (x * (HA * x + HB) + HD * HF)) - HE / HF;
}
fn hable3(x: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(hable1(x.x), hable1(x.y), hable1(x.z));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let src = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;

    var L = pq_eotf(src);                       // -> linear BT.2020

    // BT.2020 -> BT.709 primaries (linear; may go negative).
    L = vec3<f32>(
        1.6604910 * L.x - 0.5876411 * L.y - 0.0728499 * L.z,
       -0.1245505 * L.x + 1.1328999 * L.y - 0.0083494 * L.z,
       -0.0181508 * L.x - 0.1005789 * L.y + 1.1187297 * L.z,
    );

    // Desaturate-to-gamut: pull toward luma instead of hard-clipping negatives.
    let Y = 0.2126 * L.x + 0.7152 * L.y + 0.0722 * L.z;
    let mn = min(L.x, min(L.y, L.z));
    if (mn < 0.0 && Y > 1e-6) {
        L = vec3<f32>(Y) + (L - vec3<f32>(Y)) * min(Y / (Y - mn), 1.0);
    }
    L = max(L, vec3<f32>(0.0));

    let hdiv = hable1(11.2);                     // Hable white point W=11.2
    let outc = clamp(hable3(L * exposure) / hdiv, vec3<f32>(0.0), vec3<f32>(1.0));
    let disp = pow(outc, vec3<f32>(1.0 / 2.2));  // display gamma
    return vec4<f32>(disp, 1.0);
}`;

export const DEFAULT_HDR_EXPOSURE = 80;

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipelineExternalHdr!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;
    private exposureBuffer!: GPUBuffer;

    // Fired when the GPUDevice is lost for a reason other than our own
    // destroy() — a driver reset / the GPU being wedged by another app. Once
    // lost, every submit on the device silently no-ops (frames "render" but
    // nothing paints), so the owner must rebuild with a fresh device.
    onDeviceLost: ((message: string) => void) | undefined;

    private hdrHint = false;
    private exposure = DEFAULT_HDR_EXPOSURE;
    private lastFrame: VideoFrame | undefined;

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

    // Live exposure (LS) knob for the HDR tone-map. Repaints the last frame so
    // the change shows immediately even while paused.
    setExposure(ls: number): void {
        this.exposure = ls;
        if (this.exposureBuffer) {
            this.device.queue.writeBuffer(this.exposureBuffer, 0, new Float32Array([ls]));
        }
        // Repaint the last frame so a paused preview updates live. The frame
        // may already be closed by the render loop; if so, ignore — the next
        // painted frame picks up the new exposure anyway.
        if (this.lastFrame) {
            try { this.drawHdr(this.lastFrame); } catch { /* frame closed */ }
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
        this.pipelineExternalHdr = this.makePipeline(SHADER_EXTERNAL_HDR);
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        this.exposureBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.exposureBuffer, 0, new Float32Array([this.exposure]));
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

    private drawHdr(frame: VideoFrame): void {
        this.lastFrame = frame;
        const external = this.device.importExternalTexture({ source: frame });
        const group = this.device.createBindGroup({
            layout: this.pipelineExternalHdr.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: external },
                { binding: 2, resource: { buffer: this.exposureBuffer } },
            ],
        });
        this.encodeAndSubmit(this.pipelineExternalHdr, group);
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
