// GPU-side preprocessing for SCRFD. Instead of the CPU round-trip
// (drawImage → getImageData readback → JS normalize loop → re-upload as a
// fat fp32 tensor), we copy the frame straight into a GPU texture and run a
// WGSL compute shader that does the letterbox-resize + RGB normalize,
// writing the NCHW float32 input directly into a GPUBuffer that ORT consumes
// as a `gpu-buffer` tensor. The frame never leaves the GPU.
//
// Supports batching: write() places image `batchIndex` into its slice of the
// shared output buffer, so a [batch,3,S,S] tensor can be assembled with one
// buffer and one inference call.
//
// Everything here is best-effort: ScrfdDetector calls this inside a try and
// permanently falls back to CPU preprocessing if any step throws (e.g. a
// browser without copyExternalImageToTexture, or a device mismatch).

export interface LetterboxMeta {
    scale: number; padX: number; padY: number; srcW: number; srcH: number; newW: number; newH: number;
}

const WGSL = `
struct Params { S: u32, newW: u32, newH: u32, outBase: u32 };
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
@group(0) @binding(2) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let S = params.S;
  if (gid.x >= S || gid.y >= S) { return; }
  let plane = S * S;
  let outIdx = params.outBase + gid.y * S + gid.x;
  var r = 0.0; var g = 0.0; var b = 0.0;
  if (gid.x < params.newW && gid.y < params.newH) {
    let u = (f32(gid.x) + 0.5) / f32(params.newW);
    let v = (f32(gid.y) + 0.5) / f32(params.newH);
    let c = textureSampleLevel(srcTex, srcSamp, vec2<f32>(u, v), 0.0);
    r = c.r * 255.0; g = c.g * 255.0; b = c.b * 255.0;
  }
  outBuf[outIdx] = (r - 127.5) / 128.0;
  outBuf[plane + outIdx] = (g - 127.5) / 128.0;
  outBuf[2u * plane + outIdx] = (b - 127.5) / 128.0;
}`;

type ImgSource = HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | HTMLVideoElement | ImageBitmap;

function sourceDims(src: ImgSource): { w: number; h: number } {
    const w = (src as any).width || (src as any).videoWidth || (src as any).naturalWidth;
    const h = (src as any).height || (src as any).videoHeight || (src as any).naturalHeight;
    return { w, h };
}

export class GpuPreprocessor {
    private size: number;
    private device: GPUDevice;
    private sampler: GPUSampler;
    private pipeline: GPUComputePipeline;
    private paramBuf: GPUBuffer;
    private srcTex?: GPUTexture; private texW = 0; private texH = 0;
    private outBuf?: GPUBuffer; private outCapImgs = 0;
    private bind?: GPUBindGroup;
    private readonly wg: number;

    constructor(device: GPUDevice, size: number) {
        this.device = device;
        this.size = size;
        this.wg = Math.ceil(size / 8);
        this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
        const module = device.createShaderModule({ code: WGSL });
        this.pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
        this.paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }

    private ensureTex(w: number, h: number) {
        if (this.srcTex && this.texW === w && this.texH === h) return;
        this.srcTex?.destroy();
        this.srcTex = this.device.createTexture({
            size: [w, h], format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.texW = w; this.texH = h;
        this.bind = undefined; // texture view changed
    }

    private ensureOut(batch: number) {
        if (this.outBuf && this.outCapImgs >= batch) return;
        this.outBuf?.destroy();
        this.outBuf = this.device.createBuffer({
            size: batch * 3 * this.size * this.size * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this.outCapImgs = batch;
        this.bind = undefined; // buffer changed
    }

    private ensureBind() {
        if (this.bind) return;
        this.bind = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.srcTex!.createView() },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.outBuf! } },
                { binding: 3, resource: { buffer: this.paramBuf } },
            ],
        });
    }

    // Allocate the output buffer for `batch` images. Call once before a
    // sequence of write() calls.
    begin(batch: number) { this.ensureOut(batch); }

    // Preprocess `source` into slice `batchIndex` of the output buffer.
    // Returns the letterbox metadata needed to map model coords back.
    write(source: ImgSource, batchIndex: number): LetterboxMeta {
        const S = this.size;
        const { w: srcW, h: srcH } = sourceDims(source);
        const scale = Math.min(S / srcW, S / srcH);
        const newW = Math.round(srcW * scale), newH = Math.round(srcH * scale);

        this.ensureTex(srcW, srcH);
        this.ensureBind();
        const plane = S * S;
        this.device.queue.writeBuffer(this.paramBuf, 0, new Uint32Array([S, newW, newH, batchIndex * 3 * plane]));
        this.device.queue.copyExternalImageToTexture({ source: source as any }, { texture: this.srcTex! }, [srcW, srcH]);
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind!); pass.dispatchWorkgroups(this.wg, this.wg); pass.end();
        this.device.queue.submit([enc.finish()]);

        return { scale, padX: 0, padY: 0, srcW, srcH, newW, newH };
    }

    // Wrap the output buffer as an ORT tensor of shape [batch,3,S,S].
    tensor(ort: any, batch: number): any {
        return ort.Tensor.fromGpuBuffer(this.outBuf!, { dataType: "float32", dims: [batch, 3, this.size, this.size] });
    }
}
