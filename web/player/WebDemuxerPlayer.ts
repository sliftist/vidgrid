// Third playback engine — uses bilibili's `web-demuxer` (FFmpeg-WASM) to demux
// containers Mediabunny can't, then WebCodecs to decode. The library + WASM
// are loaded from a CDN on first use, so they're NOT in the regular bundle —
// this engine is opt-in and niche (AVI etc.).
//
// Status: prototype. Video-only, no audio playback yet, seek + pause are
// best-effort. The point is to compare codec coverage against the other two
// engines, not to be the default.

import { PlayerStatus, PlayerListener } from "./VideoPlayer";
import { MediaFile } from "../appState";

const WEB_DEMUXER_MODULE_URL = "https://esm.sh/web-demuxer@latest";
const WEB_DEMUXER_WASM_URL = "https://cdn.jsdelivr.net/npm/web-demuxer@latest/dist/wasm-files/web-demuxer.wasm";

// Use the Function constructor so the bundler doesn't analyze the dynamic
// import — we want it routed through the runtime, fetching from the URL above
// rather than being rewritten into a chunk request.
const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

let webDemuxerModulePromise: Promise<any> | undefined;
function loadWebDemuxer(): Promise<any> {
    if (!webDemuxerModulePromise) {
        console.log(`[webdemuxer] dynamically loading from ${WEB_DEMUXER_MODULE_URL}`);
        webDemuxerModulePromise = dynImport(WEB_DEMUXER_MODULE_URL);
    }
    return webDemuxerModulePromise;
}

export class WebDemuxerPlayer {
    private listeners = new Set<PlayerListener>();
    private status: PlayerStatus = {
        state: "idle",
        framesDecoded: 0,
        framesRendered: 0,
        framesDropped: 0,
        fps: 0,
        paused: false,
        audioEnabled: false,
        volume: 1,
    };
    private cancelled = false;
    private demuxer: any | undefined;
    private decoder: VideoDecoder | undefined;
    private ctx: CanvasRenderingContext2D | null;
    private startWallClockMs: number | undefined;
    private firstFrameTimestampUs: number | undefined;

    constructor(private canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d");
    }

    subscribe(l: PlayerListener): () => void {
        this.listeners.add(l);
        l(this.status);
        return () => this.listeners.delete(l);
    }

    private update(patch: Partial<PlayerStatus>) {
        this.status = { ...this.status, ...patch };
        for (const l of this.listeners) l(this.status);
    }

    async play(file: MediaFile, startSec: number = 0): Promise<void> {
        this.cancelled = false;
        this.update({
            state: "opening",
            framesDecoded: 0,
            framesRendered: 0,
            framesDropped: 0,
            fps: 0,
            paused: false,
            audioEnabled: false,
            currentTimeMs: 0,
            durationMs: undefined,
            codecString: undefined,
            audioCodec: undefined,
            width: undefined,
            height: undefined,
            error: undefined,
        });

        try {
            const mod = await loadWebDemuxer();
            // The library has shifted shape across versions — accept any of
            // the common export patterns.
            const WebDemuxer = mod.WebDemuxer ?? mod.default?.WebDemuxer ?? mod.default;
            if (!WebDemuxer) throw new Error("web-demuxer module did not expose a WebDemuxer constructor");

            const t0 = performance.now();
            console.log(`[webdemuxer] opening ${file.name} (${(file.size / 1_048_576).toFixed(1)} MB)`);

            this.demuxer = new WebDemuxer({
                wasmFilePath: WEB_DEMUXER_WASM_URL,
            });
            // web-demuxer's `load` only knows about local File/Blob. Backends
            // that don't expose a Blob can't use this engine yet.
            if (!file.blob) {
                throw new Error("web-demuxer engine requires a Blob — switch to mediabunny for this source.");
            }
            await this.demuxer.load(file.blob);

            const mediaInfo = await this.demuxer.getMediaInfo();
            console.log(`[webdemuxer] mediaInfo:`, mediaInfo);
            const videoStreamInfo = mediaInfo.streams?.find((s: any) => s.codec_type_string === "video");
            if (!videoStreamInfo) throw new Error("No video stream found in file");
            console.log(`[webdemuxer] video stream: codec_name=${videoStreamInfo.codec_name} codec_string=${videoStreamInfo.codec_string} ${videoStreamInfo.width}x${videoStreamInfo.height}`);

            let decoderConfig: VideoDecoderConfig | undefined;
            try {
                decoderConfig = await this.demuxer.getDecoderConfig("video");
            } catch (err) {
                console.warn(`[webdemuxer] getDecoderConfig('video') threw — likely the audio analysis pass tripped the demuxer. Falling back to mediaInfo:`, err);
            }
            console.log(`[webdemuxer] decoderConfig:`, decoderConfig);

            if (!decoderConfig || !decoderConfig.codec || decoderConfig.codec === "undf") {
                const codecName = videoStreamInfo.codec_name ?? "(unknown)";
                const codecString = videoStreamInfo.codec_string ?? "(none)";
                throw new Error(
                    `Video codec "${codecName}" (string="${codecString}") isn't mapped to a WebCodecs codec — `
                    + `WebCodecs natively supports avc1/hev1/vp8/vp9/av01 only. AVIs often carry XviD/DivX/MPEG-4 ASP which the browser can't decode without a libav-based polyfill. Try the Mediabunny or Native engine instead.`
                );
            }

            const width = decoderConfig.codedWidth ?? videoStreamInfo?.width;
            const height = decoderConfig.codedHeight ?? videoStreamInfo?.height;
            const durationSec = mediaInfo.duration ?? undefined;

            if (width && height) {
                this.canvas.width = width;
                this.canvas.height = height;
            }

            console.log(`[webdemuxer] opened in ${(performance.now() - t0).toFixed(0)}ms: codec=${decoderConfig.codec} ${width}x${height} duration=${durationSec ?? "?"}s`);

            this.update({
                width,
                height,
                durationMs: durationSec ? durationSec * 1000 : undefined,
                codecString: decoderConfig.codec,
            });

            this.decoder = new VideoDecoder({
                output: f => this.onFrame(f),
                error: e => {
                    console.warn(`[webdemuxer] decoder error:`, e);
                    this.update({ state: "error", error: e.message });
                },
            });
            // Skip the isConfigSupported gate — its true/false answer hides
            // the actual error. Let VideoDecoder.configure() throw, that
            // exception has the real codec/parameter detail.
            this.decoder.configure(decoderConfig);

            this.update({ state: "playing" });
            this.startWallClockMs = performance.now();
            this.firstFrameTimestampUs = undefined;
            void this.pumpPackets(startSec);
        } catch (err) {
            console.warn(`[webdemuxer] open failed:`, err);
            this.update({ state: "error", error: (err as Error).message });
        }
    }

    private async pumpPackets(startSec: number) {
        if (!this.demuxer || !this.decoder) return;
        try {
            // `read('video', startSec)` returns a ReadableStream of
            // EncodedVideoChunk objects directly — no need to wrap.
            const stream: ReadableStream<EncodedVideoChunk> = this.demuxer.read("video", startSec);
            const reader = stream.getReader();
            while (!this.cancelled) {
                const { done, value } = await reader.read();
                if (done) break;
                if (this.status.paused) {
                    // Cooperative pause — wait briefly and re-check. We've
                    // already pulled this chunk, so push it through the
                    // decoder before pausing so we don't drop it.
                    this.decoder.decode(value);
                    while (this.status.paused && !this.cancelled) {
                        await new Promise(r => setTimeout(r, 50));
                    }
                    continue;
                }
                this.decoder.decode(value);
                if (this.firstFrameTimestampUs === undefined) {
                    this.firstFrameTimestampUs = value.timestamp;
                }
                this.update({ framesDecoded: this.status.framesDecoded + 1 });
            }
        } catch (err) {
            console.warn(`[webdemuxer] packet read failed:`, err);
            this.update({ state: "error", error: (err as Error).message });
        }
    }

    private onFrame(frame: VideoFrame) {
        if (!this.ctx || this.cancelled) {
            frame.close();
            return;
        }
        const w = this.canvas.width;
        const h = this.canvas.height;
        // ctx.drawImage understands VideoFrame as of recent Chrome.
        this.ctx.drawImage(frame as any, 0, 0, w, h);
        const framesRendered = this.status.framesRendered + 1;
        const currentTimeMs = frame.timestamp / 1000; // microseconds → ms
        frame.close();
        this.update({
            framesRendered,
            currentTimeMs,
        });
    }

    stop(): void {
        this.cancelled = true;
        try { this.decoder?.close(); } catch { }
        this.decoder = undefined;
        try { this.demuxer?.destroy?.() ?? this.demuxer?.close?.(); } catch { }
        this.demuxer = undefined;
        this.update({ state: "idle" });
    }

    togglePause(): void {
        // Cooperative pause — pumpPackets loop checks this on each iteration.
        this.update({ paused: !this.status.paused });
    }

    seek(_sec: number): void {
        // TODO: implement via demuxer.seek(sec) once we've confirmed the
        // exact API surface. For now log so the user knows it's a no-op.
        console.warn(`[webdemuxer] seek not yet implemented; restart playback to seek`);
    }

    setVolume(v: number): void {
        // No audio path yet — keep the value in status so the UI displays
        // it consistently.
        this.update({ volume: Math.max(0, Math.min(1, v)) });
    }

    getCurrentTimeSec(): number {
        return (this.status.currentTimeMs ?? 0) / 1000;
    }
}

