// MPEG-4 Part 2 (XviD/DivX/MPEG-4 ASP) isn't decodable by the browser's
// WebCodecs, so we decode it with a pure-TypeScript port of ffmpeg's mpeg4
// decoder (see ./mp4v). No WASM, no async loader.
import { CustomVideoDecoder, EncodedPacket, VideoSample, registerDecoder } from "mediabunny/dist/bundles/mediabunny.cjs";
import { Mpeg4Decoder } from "./mp4v/Mpeg4Decoder";

class Mp4vDecoder extends CustomVideoDecoder {
    private dec = new Mpeg4Decoder();
    private frameDur = 1 / 30;
    // The decoder emits frames in DISPLAY order while AVI packets arrive in
    // DECODE order; we hand each output frame the next-smallest pending packet
    // timestamp, giving correct presentation times (incl. B-frames) and seeks.
    private pendingTs: number[] = [];

    static supports(codec: string): boolean {
        return codec === "mp4v";
    }

    async init(): Promise<void> {
        this.dec = new Mpeg4Decoder();
    }

    async decode(packet: EncodedPacket): Promise<void> {
        if (packet.duration) this.frameDur = packet.duration;
        const ts = packet.timestamp;
        let lo = 0, hi = this.pendingTs.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (this.pendingTs[m]! < ts) lo = m + 1; else hi = m; }
        this.pendingTs.splice(lo, 0, ts);
        for (const f of this.dec.decode(packet.data)) this.emit(f.data);
    }

    async flush(): Promise<void> {
        for (const f of this.dec.flush()) this.emit(f.data);
        this.pendingTs.length = 0;
    }

    async close(): Promise<void> { }

    private emit(data: Uint8Array): void {
        const ts = this.pendingTs.length ? this.pendingTs.shift()! : 0;
        const sample = new VideoSample(data, {
            format: "I420",
            codedWidth: this.dec.displayWidth,
            codedHeight: this.dec.displayHeight,
            timestamp: ts,
            duration: this.frameDur,
        });
        this.onSample(sample);
    }
}

let registered = false;

// Register the mp4v decoder with mediabunny. Call before opening an AVI's video
// track (mirrors ensureAc3Decoder).
export async function ensureMp4vDecoder(): Promise<void> {
    if (!registered) {
        registerDecoder(Mp4vDecoder as any);
        registered = true;
    }
    console.log("[video] mp4v (MPEG-4 Part 2) decoder registered (pure TS)");
}
