// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
// Must be the same mediabunny instance the rest of the app uses so the
// registered custom decoder is visible to the sinks.
import { CustomVideoDecoder, EncodedPacket, VideoSample, registerDecoder } from "mediabunny/dist/bundles/mediabunny.cjs";

// MPEG-4 Part 2 (XviD/DivX/MPEG-4 ASP) isn't decodable by the browser's
// WebCodecs, so we decode it with a custom-built libav.js WASM variant ("xvid",
// which bundles ffmpeg's mpeg4/h263/msmpeg4 decoders). The dispatcher script
// sets a global `LibAV`; we load it once, lazily, like the AC-3 loader.

declare global {
    interface Window { LibAV?: any }
}

const LIBAV_LOADER = "./assets/libav-6.8.8.0-xvid.js";
// Computed lazily (in the browser) — must not touch `location` at module load,
// since the build-time bundler requires this module under Node.
function libavBase(): string {
    return new URL("./assets", location.href).href.replace(/\/$/, "");
}

// AV_PIX_FMT_* (libav) -> mediabunny VideoSamplePixelFormat. mpeg4 decodes to
// YUV420P (0); a couple of near neighbours map to the same I420 family.
const AV_PIX: Record<number, "I420"> = { 0: "I420", 12: "I420" /* YUVJ420P */ };

// libav hands back planes with padded strides/offsets (e.g. U starting 160
// bytes past the end of Y). VideoSample.copyTo honours the per-plane layout, but
// VideoSample.toVideoFrame (the canvas render path) drops it and assumes a
// tightly-packed I420, reading chroma from the wrong offsets -> garbled colour.
// So repack into a contiguous default-layout I420 here and pass no layout.
function packI420(f: any): Uint8Array {
    const w = f.width, h = f.height;
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const out = new Uint8Array(w * h + 2 * cw * ch);
    const planes: [number, number][] = [[w, h], [cw, ch], [cw, ch]];
    let o = 0;
    for (let p = 0; p < 3; p++) {
        const [pw, ph] = planes[p]!;
        const { offset, stride } = f.layout[p];
        for (let y = 0; y < ph; y++) {
            out.set(f.data.subarray(offset + y * stride, offset + y * stride + pw), o);
            o += pw;
        }
    }
    return out;
}

let libavLoad: Promise<any> | undefined;
function loadLibAV(): Promise<any> {
    if (!libavLoad) {
        libavLoad = (async () => {
            if (window.LibAV) return window.LibAV;
            // libav's loader sniffs `typeof process` to decide Node-vs-browser.
            // vidgrid's bundle defines a global `process`, which makes libav
            // (wrongly) take its Node path and `require()` the wasm via the
            // bundler shim. Fetch the loader text and run it as a synchronous
            // inline script with `process` briefly hidden, so it captures
            // browser mode and loads the wasm in a Worker instead.
            const code = await (await fetch(LIBAV_LOADER)).text();
            const saved = (globalThis as any).process;
            const s = document.createElement("script");
            s.textContent = code;
            try {
                (globalThis as any).process = undefined;
                document.head.appendChild(s); // inline script runs synchronously here
            } finally {
                (globalThis as any).process = saved;
            }
            if (!window.LibAV) throw new Error("libav loader did not set window.LibAV");
            return window.LibAV;
        })();
    }
    return libavLoad;
}

class Mp4vDecoder extends CustomVideoDecoder {
    private libav: any;
    private ctx = 0;
    private pkt = 0;
    private frame = 0;
    private frameDur = 1 / 30;
    // libav emits frames in DISPLAY order while AVI packets arrive in DECODE
    // order; we hand each output frame the next-smallest pending packet
    // timestamp, giving correct presentation times (incl. B-frames) and seeks.
    private pendingTs: number[] = [];
    private seq = 0;

    static supports(codec: string): boolean {
        return codec === "mp4v";
    }

    async init(): Promise<void> {
        const LibAV = await loadLibAV();
        this.libav = await LibAV.LibAV({ base: libavBase(), variant: "xvid" });
        const r = await this.libav.ff_init_decoder("mpeg4", { time_base: [1, 1] });
        this.ctx = r[1]; this.pkt = r[2]; this.frame = r[3];
    }

    async decode(packet: EncodedPacket): Promise<void> {
        if (packet.duration) this.frameDur = packet.duration;
        const ts = packet.timestamp;
        let lo = 0, hi = this.pendingTs.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (this.pendingTs[m]! < ts) lo = m + 1; else hi = m; }
        this.pendingTs.splice(lo, 0, ts);
        const frames = await this.libav.ff_decode_multi(this.ctx, this.pkt, this.frame,
            [{ data: packet.data, pts: this.seq, dts: this.seq, ptshi: 0, dtshi: 0, time_base_num: 1, time_base_den: 1 }],
            { copyoutFrame: "video" });
        this.seq++;
        for (const f of frames) this.emit(f);
    }

    async flush(): Promise<void> {
        const frames = await this.libav.ff_decode_multi(this.ctx, this.pkt, this.frame, [], { fin: true, copyoutFrame: "video" });
        for (const f of frames) this.emit(f);
        this.pendingTs.length = 0;
    }

    async close(): Promise<void> {
        try { await this.libav?.ff_free_decoder(this.ctx, this.pkt, this.frame); } catch { }
        try { this.libav?.terminate?.(); } catch { }
    }

    private emit(f: any): void {
        const ts = this.pendingTs.length ? this.pendingTs.shift()! : 0;
        const sample = new VideoSample(packI420(f), {
            format: AV_PIX[f.format] ?? "I420",
            codedWidth: f.width,
            codedHeight: f.height,
            timestamp: ts,
            duration: this.frameDur,
        });
        this.onSample(sample);
    }
}

let registered = false;

// Register the mp4v decoder with mediabunny and warm up libav. Call before
// opening an AVI's video track (mirrors ensureAc3Decoder).
export async function ensureMp4vDecoder(): Promise<void> {
    if (!registered) {
        registerDecoder(Mp4vDecoder as any);
        registered = true;
    }
    await loadLibAV();
    console.log("[video] mp4v (MPEG-4 Part 2) decoder registered (libav xvid)");
}
