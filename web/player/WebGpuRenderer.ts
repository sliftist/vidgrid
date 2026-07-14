// Renders VideoFrames to a canvas via WebGPU.
//
//  - SDR frames use `importExternalTexture` (zero copy) + a fullscreen quad.
//  - HDR frames (PQ/HLG) can NOT use `importExternalTexture`: Chrome silently
//    pre-converts the external texture from PQ BT.2020 to a washed-out SDR sRGB
//    approximation, so a shader sampling it never sees the real PQ signal and
//    the tone-map runs on already-mangled data (this was the "too pink" bug).
//    Instead we read the raw decoded YUV back with `VideoFrame.copyTo()` and do
//    the whole HDR->SDR transform ourselves on the true samples: 10-bit limited
//    BT.2020 YCbCr -> R'G'B' -> PQ EOTF -> BT.2020->709 matrix -> gamut clip ->
//    exposure scale -> ratio-preserving (maxrgb) Hable tone-map -> sRGB encode.
//    Verified against `ffmpeg tonemap=hable` (mean abs err ~5/255) in a real
//    headless WebGPU browser. The `exposure` knob is a linear-light multiplier,
//    so it changes brightness without shifting hue.

import { DEFAULT_HDR_EXPOSURE } from "../appState";

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

// HDR->SDR transform on the RAW decoded YUV (see file header). Y at binding 0,
// Cb at 1, Cr at 2 — all r16uint 10-bit-code textures (Y full res, chroma 4:2:0
// half res). params = (exposure, codeScale, 0, 0); codeScale maps a raw sample
// to a 10-bit code value (1.0 for I420P10 low-bit data, 1/64 for P010 high-bit).
const SHADER_YUV_HDR = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
    );
    var out: VsOut;
    out.pos = vec4<f32>(positions[vi], 0.0, 1.0);
    out.uv = positions[vi] * 0.5 + 0.5;
    return out;
}

@group(0) @binding(0) var yT: texture_2d<u32>;
@group(0) @binding(1) var cbT: texture_2d<u32>;
@group(0) @binding(2) var crT: texture_2d<u32>;
@group(0) @binding(3) var<uniform> params: vec4<f32>;   // exposure, codeScale, _, _

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

// Hable filmic tonemap (filmicworlds.com), scalar. Applied to a single signal
// (the max RGB component) and used to scale the whole pixel, so hue/saturation
// are preserved — this is ffmpeg/VLC's maxrgb approach.
const HA = 0.15; const HB = 0.50; const HC = 0.10;
const HD = 0.20; const HE = 0.02; const HF = 0.30;
const PEAK = 200.0;
fn hable1(x: f32) -> f32 {
    return ((x * (HA * x + HC * HB) + HD * HE) / (x * (HA * x + HB) + HD * HF)) - HE / HF;
}

// Linear -> sRGB OETF (display encoding). The canvas is sRGB, so we encode here.
fn srgb_oetf(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c < vec3<f32>(0.0031308));
}

fn loadC(t: texture_2d<u32>, ix: i32, iy: i32) -> f32 {
    let dim = vec2<i32>(textureDimensions(t));
    let c = clamp(vec2<i32>(ix, iy), vec2<i32>(0), dim - vec2<i32>(1));
    return f32(textureLoad(t, c, 0).x);
}

// Bilinear-sample a 4:2:0 chroma plane at luma pixel (px,py). Chroma is sited at
// half resolution; the luma pixel center maps to chroma coord px*0.5 - 0.5.
fn sampleChroma(t: texture_2d<u32>, px: f32, py: f32) -> f32 {
    let fx = px * 0.5 - 0.5;
    let fy = py * 0.5 - 0.5;
    let x0 = i32(floor(fx));
    let y0 = i32(floor(fy));
    let tx = fx - floor(fx);
    let ty = fy - floor(fy);
    let a = loadC(t, x0,     y0);
    let b = loadC(t, x0 + 1, y0);
    let c = loadC(t, x0,     y0 + 1);
    let d = loadC(t, x0 + 1, y0 + 1);
    return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let exposure = params.x;
    let codeScale = params.y;
    let px = in.pos.x;
    let py = in.pos.y;

    let Y  = f32(textureLoad(yT, vec2<i32>(i32(px), i32(py)), 0).x) * codeScale;
    let Cb = sampleChroma(cbT, px, py) * codeScale;
    let Cr = sampleChroma(crT, px, py) * codeScale;

    // 10-bit limited-range normalize (Y: 64..940, chroma: 512 +/- 448).
    let yn = (Y - 64.0) / 876.0;
    let cb = (Cb - 512.0) / 896.0;
    let cr = (Cr - 512.0) / 896.0;

    // BT.2020 non-constant-luminance YCbCr -> R'G'B' (still PQ-encoded).
    var L = vec3<f32>(
        yn + 1.4746 * cr,
        yn - 0.16455 * cb - 0.57135 * cr,
        yn + 1.8814 * cb,
    );

    L = pq_eotf(L);                             // -> linear BT.2020 (1.0=10000 nits)

    // BT.2020 -> BT.709 primaries (linear; may go negative).
    L = vec3<f32>(
        1.6604910 * L.x - 0.5876411 * L.y - 0.0728499 * L.z,
       -0.1245505 * L.x + 1.1328999 * L.y - 0.0083494 * L.z,
       -0.0181508 * L.x - 0.1005789 * L.y + 1.1187297 * L.z,
    );

    // Gamut clip (709 can't hold the reddest BT.2020 colors -> negatives), then
    // scale by exposure — a plain linear-light multiplier, so raising it
    // brightens the image without shifting hue.
    L = max(L, vec3<f32>(0.0)) * exposure;

    // Ratio-preserving tone map: curve the max component, scale RGB to match, so
    // colors don't shift as brightness changes — only level and highlight rolloff.
    let sig = max(L.x, max(L.y, L.z));
    let scaled = clamp(hable1(sig) / hable1(PEAK), 0.0, 1.0) / max(sig, 1e-6);
    let outc = clamp(L * scaled, vec3<f32>(0.0), vec3<f32>(1.0));
    let disp = srgb_oetf(outc);
    return vec4<f32>(disp, 1.0);
}`;

export class WebGpuRenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipelineExternal!: GPURenderPipeline;
    private pipelineYuvHdr!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private format!: GPUTextureFormat;
    private paramsBuffer!: GPUBuffer;

    // HDR YUV plane textures (Y full res, Cb/Cr 4:2:0 half res), reused across
    // frames and rebuilt when the coded size changes. Plus a scratch readback
    // buffer for copyTo and (for semi-planar P010) de-interleaved chroma scratch.
    private yTex: GPUTexture | undefined;
    private cbTex: GPUTexture | undefined;
    private crTex: GPUTexture | undefined;
    private yuvW = 0;
    private yuvH = 0;
    private copyBuf: Uint8Array | undefined;
    private cbScratch: Uint16Array | undefined;
    private crScratch: Uint16Array | undefined;

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

    // Live exposure (LS) knob for the HDR tone-map. Repaints the last frame so
    // the change shows immediately even while paused.
    setExposure(ls: number): void {
        this.exposure = ls;
        if (this.paramsBuffer) {
            this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([ls]));
        }
        // Repaint the last frame so a paused preview updates live. The frame may
        // already be closed by the render loop; if so, the copyTo rejects and we
        // ignore it — the next painted frame picks up the new exposure anyway.
        if (this.lastFrame) {
            void this.drawHdr(this.lastFrame).catch(() => { /* frame closed */ });
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
        this.pipelineYuvHdr = this.makePipeline(SHADER_YUV_HDR);
        this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        // vec4: (exposure, codeScale, _, _). codeScale is set per-frame from the
        // decoded pixel format; exposure lives in .x and updates live.
        this.paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.exposure, 1, 0, 0]));
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
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }
        if (this.isHdrFrame(frame)) {
            await this.drawHdr(frame);
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

    // Ensure Y/Cb/Cr textures exist at the current coded size (r16uint; Y full
    // res, chroma half res for 4:2:0).
    private ensureYuvTextures(w: number, h: number): void {
        if (this.yTex && this.yuvW === w && this.yuvH === h) return;
        this.yTex?.destroy();
        this.cbTex?.destroy();
        this.crTex?.destroy();
        const cw = w >> 1, ch = h >> 1;
        const mk = (tw: number, th: number) => this.device.createTexture({
            size: [tw, th], format: "r16uint",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.yTex = mk(w, h);
        this.cbTex = mk(cw, ch);
        this.crTex = mk(cw, ch);
        this.yuvW = w;
        this.yuvH = h;
    }

    // Read the raw decoded YUV back and run the HDR->SDR tone-map on the true PQ
    // samples (importExternalTexture pre-converts HDR, so it can't be used here).
    // Handles planar 10-bit (I420P10-style, 3 planes, data in the low bits) and
    // semi-planar P010 (2 planes, 10-bit data in the high bits of each u16).
    private async drawHdr(frame: VideoFrame): Promise<void> {
        const w = frame.codedWidth, h = frame.codedHeight;
        const size = frame.allocationSize();
        if (!this.copyBuf || this.copyBuf.byteLength < size) this.copyBuf = new Uint8Array(size);
        const buf = this.copyBuf;
        const layout = await frame.copyTo(buf.subarray(0, size));
        this.lastFrame = frame;

        this.ensureYuvTextures(w, h);
        const cw = w >> 1, ch = h >> 1;
        const u16 = new Uint16Array(buf.buffer, 0, size >> 1);

        let codeScale = 1.0;
        if (layout.length >= 3) {
            // Planar: Y, Cb, Cr each their own plane; 10-bit data in low bits.
            this.uploadPlane(this.yTex!, buf, layout[0].offset, layout[0].stride, w, h);
            this.uploadPlane(this.cbTex!, buf, layout[1].offset, layout[1].stride, cw, ch);
            this.uploadPlane(this.crTex!, buf, layout[2].offset, layout[2].stride, cw, ch);
        } else {
            // Semi-planar P010: plane 0 = Y, plane 1 = interleaved CbCr; 10-bit in
            // the high bits of each 16-bit sample, so scale back down by 1/64.
            codeScale = 1.0 / 64.0;
            this.uploadPlane(this.yTex!, buf, layout[0].offset, layout[0].stride, w, h);
            const n = cw * ch;
            if (!this.cbScratch || this.cbScratch.length < n) {
                this.cbScratch = new Uint16Array(n);
                this.crScratch = new Uint16Array(n);
            }
            const cb = this.cbScratch, cr = this.crScratch!;
            const base = layout[1].offset >> 1, stride = layout[1].stride >> 1;
            for (let y = 0; y < ch; y++) {
                let s = base + y * stride;
                let d = y * cw;
                for (let x = 0; x < cw; x++) {
                    cb[d] = u16[s];
                    cr[d] = u16[s + 1];
                    s += 2; d += 1;
                }
            }
            this.device.queue.writeTexture({ texture: this.cbTex! }, cb, { bytesPerRow: cw * 2, rowsPerImage: ch }, [cw, ch]);
            this.device.queue.writeTexture({ texture: this.crTex! }, cr, { bytesPerRow: cw * 2, rowsPerImage: ch }, [cw, ch]);
        }

        if (!this.loggedHdr) {
            this.loggedHdr = true;
            console.log(`[hdr] YUV tone-map active (LS=${this.exposure}) transfer=${frame.colorSpace?.transfer} format=${frame.format} planes=${layout.length} codeScale=${codeScale}`);
        }
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.exposure, codeScale, 0, 0]));

        const group = this.device.createBindGroup({
            layout: this.pipelineYuvHdr.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.yTex!.createView() },
                { binding: 1, resource: this.cbTex!.createView() },
                { binding: 2, resource: this.crTex!.createView() },
                { binding: 3, resource: { buffer: this.paramsBuffer } },
            ],
        });
        this.encodeAndSubmit(this.pipelineYuvHdr, group);
    }

    // Upload one 16-bit plane straight from the copyTo buffer (no repack — the
    // source row stride goes in via bytesPerRow).
    private uploadPlane(tex: GPUTexture, buf: Uint8Array, offset: number, stride: number, w: number, h: number): void {
        this.device.queue.writeTexture(
            { texture: tex },
            buf,
            { offset, bytesPerRow: stride, rowsPerImage: h },
            [w, h],
        );
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
        this.yTex?.destroy();
        this.cbTex?.destroy();
        this.crTex?.destroy();
        this.yTex = this.cbTex = this.crTex = undefined;
        if (this.device) this.device.destroy();
    }
}
