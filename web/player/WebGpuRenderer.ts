// Renders VideoFrames to a canvas via WebGPU.
//
//  - SDR frames: the fast path — `importExternalTexture` keeps the decoded
//    frame GPU-resident (zero copy) and a fullscreen quad samples it.
//  - HDR frames (PQ, e.g. HDR10) need tone mapping. When the decoder gives us
//    readable 10-bit planes (I420P10 — i.e. software-decoded), we pull Y/U/V
//    with VideoFrame.copyTo(), upload them, and do the whole HDR→SDR chain on
//    the GPU in one pass: BT.2020 YCbCr→R'G'B', PQ EOTF, BT.2020→Rec.709 gamut,
//    ACES tone map, sRGB. Hardware-decoded frames are opaque GPU surfaces
//    (format == null, no high-bit-depth readback in Chrome) so we can't reach
//    their pixels — those fall back to the fast external path.

// Tone-map exposure: linear luminance is normalized so 1.0 == 10000 nits, so a
// 100-nit pixel is 0.01. Multiplying by this maps the HDR reference white into
// the ACES curve's usable range. Up = brighter SDR result, down = darker.
const HDR_EXPOSURE = 150.0;

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

// HDR path: tone-map 10-bit BT.2020/PQ planes to SDR sRGB in-shader.
const SHADER_HDR = VS + /* wgsl */ `
@group(0) @binding(0) var texY: texture_2d<u32>;
@group(0) @binding(1) var texU: texture_2d<u32>;
@group(0) @binding(2) var texV: texture_2d<u32>;
struct Params { coded: vec2<u32>, fullRange: u32, exposure: f32 };
@group(0) @binding(3) var<uniform> u: Params;

// SMPTE ST 2084 (PQ) EOTF: encoded [0,1] -> linear, 1.0 == 10000 nits.
fn pqEotf(e: f32) -> f32 {
    let m1 = 0.1593017578125; let m2 = 78.84375;
    let c1 = 0.8359375; let c2 = 18.8515625; let c3 = 18.6875;
    let ep = pow(max(e, 0.0), 1.0 / m2);
    return pow(max(ep - c1, 0.0) / (c2 - c3 * ep), 1.0 / m1);
}
// ACES filmic tone curve (Narkowicz approximation).
fn aces(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn srgbOetf(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let cw = i32(u.coded.x); let ch = i32(u.coded.y);
    let xy = vec2<i32>(clamp(i32(in.uv.x * f32(cw)), 0, cw - 1), clamp(i32(in.uv.y * f32(ch)), 0, ch - 1));
    let cxy = xy / 2;
    let Y = f32(textureLoad(texY, xy, 0).r);
    let U = f32(textureLoad(texU, cxy, 0).r);
    let V = f32(textureLoad(texV, cxy, 0).r);
    var yf: f32; var cb: f32; var cr: f32;
    if (u.fullRange == 1u) {
        yf = Y / 1023.0; cb = U / 1023.0 - 0.5; cr = V / 1023.0 - 0.5;
    } else {
        yf = (Y - 64.0) / 876.0; cb = (U - 512.0) / 896.0; cr = (V - 512.0) / 896.0;
    }
    let rp = yf + 1.4746 * cr;
    let gp = yf - 0.16455 * cb - 0.57135 * cr;
    let bp = yf + 1.8814 * cb;
    var lin = vec3<f32>(pqEotf(rp), pqEotf(gp), pqEotf(bp));
    lin = vec3<f32>(
        dot(vec3<f32>( 1.66049, -0.58764, -0.07286), lin),
        dot(vec3<f32>(-0.12455,  1.13290, -0.00836), lin),
        dot(vec3<f32>(-0.01825, -0.10058,  1.11873), lin),
    );
    lin = max(lin, vec3<f32>(0.0));
    return vec4<f32>(srgbOetf(aces(lin * u.exposure)), 1.0);
}`;

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipelineHdr!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;

    private hdrHint = false;
    private loggedHdr = false;

    // HDR shader-path resources (lazy).
    private texY: GPUTexture | undefined;
    private texU: GPUTexture | undefined;
    private texV: GPUTexture | undefined;
    private hdrTexW = 0;
    private hdrTexH = 0;
    private hdrParams!: GPUBuffer;
    private copyBuf: Uint8Array | undefined;

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
        const ctx = this.canvas.getContext("webgpu");
        if (!ctx) throw new Error("Failed to get webgpu canvas context");
        this.context = ctx;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
        const mk = (code: string) => {
            const module = this.device.createShaderModule({ code });
            return this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{ format: this.format }] },
                primitive: { topology: "triangle-list" },
            });
        };
        this.pipelineExternal = mk(SHADER_EXTERNAL);
        this.pipelineHdr = mk(SHADER_HDR);
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        this.hdrParams = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }

    private isHdrFrame(frame: VideoFrame): boolean {
        if (this.hdrHint) return true;
        const tr = frame.colorSpace?.transfer as string | undefined;
        return tr === "pq" || tr === "hlg";
    }

    async render(frame: VideoFrame): Promise<void> {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        let draw: { pipeline: GPURenderPipeline; group: GPUBindGroup } | undefined;
        if (this.isHdrFrame(frame)) {
            const readable = (frame.format as string) === "I420P10";
            if (!this.loggedHdr) {
                this.loggedHdr = true;
                console.log(`[render] HDR frame: format=${frame.format} transfer=${frame.colorSpace?.transfer} → ${readable ? "GPU tone-map" : "no readable planes (hardware-decoded); fast path, highlights clipped"}`);
            }
            if (readable) {
                try {
                    draw = await this.bindGroupForHdrShader(frame);
                } catch (err) {
                    console.warn(`[render] HDR shader path failed:`, err);
                }
            }
        }
        if (!draw) draw = this.bindGroupForSdr(frame);

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

    private bindGroupForSdr(frame: VideoFrame) {
        const external = this.device.importExternalTexture({ source: frame });
        return {
            pipeline: this.pipelineExternal,
            group: this.device.createBindGroup({
                layout: this.pipelineExternal.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: external },
                ],
            }),
        };
    }

    // Fast HDR path: upload the decoded 10-bit Y/U/V planes and tone-map them.
    private async bindGroupForHdrShader(frame: VideoFrame) {
        const cw = frame.codedWidth, ch = frame.codedHeight;
        const cw2 = Math.ceil(cw / 2), ch2 = Math.ceil(ch / 2);
        if (this.hdrTexW !== cw || this.hdrTexH !== ch) {
            this.texY?.destroy(); this.texU?.destroy(); this.texV?.destroy();
            const mkTex = (w: number, h: number) => this.device.createTexture({
                size: [w, h], format: "r16uint",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.texY = mkTex(cw, ch);
            this.texU = mkTex(cw2, ch2);
            this.texV = mkTex(cw2, ch2);
            this.hdrTexW = cw; this.hdrTexH = ch;
        }

        const size = frame.allocationSize();
        if (!this.copyBuf || this.copyBuf.byteLength < size) this.copyBuf = new Uint8Array(size);
        const layout = await frame.copyTo(this.copyBuf);  // [Y, U, V] plane layouts

        const writePlane = (tex: GPUTexture, planeIdx: number, w: number, h: number) => {
            const { offset, stride } = layout[planeIdx];
            this.device.queue.writeTexture(
                { texture: tex },
                this.copyBuf!,
                { offset, bytesPerRow: stride, rowsPerImage: h },
                { width: w, height: h },
            );
        };
        writePlane(this.texY!, 0, cw, ch);
        writePlane(this.texU!, 1, cw2, ch2);
        writePlane(this.texV!, 2, cw2, ch2);

        const fullRange = frame.colorSpace?.fullRange ? 1 : 0;
        const params = new ArrayBuffer(16);
        new Uint32Array(params, 0, 3).set([cw, ch, fullRange]);
        new Float32Array(params, 12, 1)[0] = HDR_EXPOSURE;
        this.device.queue.writeBuffer(this.hdrParams, 0, params);

        return {
            pipeline: this.pipelineHdr,
            group: this.device.createBindGroup({
                layout: this.pipelineHdr.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.texY!.createView() },
                    { binding: 1, resource: this.texU!.createView() },
                    { binding: 2, resource: this.texV!.createView() },
                    { binding: 3, resource: { buffer: this.hdrParams } },
                ],
            }),
        };
    }

    destroy(): void {
        this.texY?.destroy(); this.texU?.destroy(); this.texV?.destroy();
        if (this.device) this.device.destroy();
    }
}
