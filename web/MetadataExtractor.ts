// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import { Input, ALL_FORMATS, VideoSampleSink, EncodedPacketSink, Source } from "mediabunny/dist/bundles/mediabunny.cjs";
import { ensureMp4vDecoder } from "./player/Mp4vDecoder";

// Bump this constant whenever the extractor's output format changes (different
// thumbnail sizes, new metadata fields, anything that should invalidate the
// per-file cache). The metadata-scan loop skips files whose stored
// metadataVersion already matches this number.
export const METADATA_VERSION = 4;
// Independent version for the keyframe-preview phase — keyframe extraction
// can change without invalidating the thumbnail cache and vice versa.
// Bump when KEYFRAMES_TARGET_W or KEYFRAMES_JPEG_QUALITY changes so existing
// strips get re-extracted at the new size.
export const KEYFRAMES_VERSION = 5;
// Independent version for the face-extraction phase. Bump when anything
// in the extraction pipeline changes that would invalidate stored faces /
// characters / frame thumbs.
export const FACES_VERSION = 3;

// Face-extraction config. 640 matches SCRFD's native input resolution
// (det_10g.onnx wants 640×640 with letterboxing); anything smaller
// throws away pixels SCRFD would have used. The keyframe-preview strip
// uses a separate 600px constant because it has nothing to do with
// detection — that's the displayed thumbnail size.
const FACES_FRAME_TARGET_W = 640;
const FACES_FRAME_JPEG_QUALITY = 0.80;
// Minimum gap between two consecutive frames we keep. Some pathological
// encodings flag every frame as a keyframe (~30/sec or more), and even
// well-behaved files give us a keyframe every 2-3s — running detection
// on every single one wastes GPU time on near-identical shots. 3s gap
// keeps us fast while still catching scene cuts.
const FACES_MIN_INTERVAL_MS = 3000;

// Keyframe preview-strip configuration.
const KEYFRAMES_TARGET_W = 600;
const KEYFRAMES_JPEG_QUALITY = 0.85;
// Sampling interval by movie length — short videos get a denser strip so
// the eventual 4-FPS playback still feels useful.
function keyframeIntervalForDuration(durationSec: number): number {
    if (durationSec < 15 * 60) return 15;
    if (durationSec < 30 * 60) return 30;
    return 60;
}

const THUMB_WIDTHS = [160, 320, 640] as const;
export type ThumbWidth = typeof THUMB_WIDTHS[number];

const JPEG_QUALITY = 0.78;
const SHORT_VIDEO_THRESHOLD_SEC = 30 * 60;

// Everything Mediabunny can tell us about a single track. Per-field optional
// because what's available depends on the container/codec; we keep whatever is
// present and the info modal renders only the set fields. Stored verbatim so a
// future field doesn't need a schema migration — it rides along in `mediaInfo`.
export interface MediaTrackInfo {
    kind: "video" | "audio" | "other";
    // 1-based index among tracks of the same type (video 1, video 2, …).
    number?: number;
    codec?: string;            // homogenized codec name ("avc", "aac", …)
    codecString?: string;      // full WebCodecs codec string ("avc1.640029")
    internalCodecId?: string;  // container-level id ("avc1", Matroska CodecID, …)
    language?: string;         // ISO 639-2/T, omitted when "und"/unknown
    name?: string;             // user-defined track name
    bitrate?: number;          // bits/sec (metadata: average preferred, else peak)
    // Video-only.
    codedWidth?: number;
    codedHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    rotation?: number;         // clockwise degrees (0/90/180/270)
    pixelAspectRatio?: string; // "n:d" — omitted when square (1:1)
    frameRate?: number;        // average packet rate over a 150-packet sample
    hdr?: boolean;
    colorPrimaries?: string;
    colorTransfer?: string;
    colorMatrix?: string;
    colorFullRange?: boolean;
    // Audio-only.
    channels?: number;
    sampleRate?: number;       // Hz
}

export interface MediaInfo {
    format?: string;           // container format name ("MP4", "Matroska", …)
    trackCount?: number;
    tracks: MediaTrackInfo[];
}

export interface ExtractedInfo {
    durationSec?: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    fileModifiedAt?: number;
    // Full per-track detail for every track in the file (video, audio, other).
    // The flat fields above stay for the hot grid path; this is the complete
    // record shown in the info modal.
    mediaInfo?: MediaInfo;
    thumb160?: Uint8Array;
    thumb320?: Uint8Array;
    thumb640?: Uint8Array;
    // The cropped-canvas dimensions the three thumbnails were rendered
    // from. Identifies the *actual* aspect ratio of what's in the JPEG
    // (different from width/height when letterbox bars got trimmed).
    thumbW?: number;
    thumbH?: number;
    metadataExtractionMs: number;
}

// Walk every track in the input and pull all the per-track detail Mediabunny
// exposes. Each getter is guarded individually so a single unsupported field
// (or a codec Mediabunny can't fully parse) never aborts the whole sweep — we
// keep whatever resolved. frameRate is estimated from a 150-packet prefix so
// it stays cheap even on multi-GB files.
async function collectMediaInfo(input: Input): Promise<MediaInfo | undefined> {
    const set = async <T>(p: Promise<T> | T, assign: (v: NonNullable<T>) => void): Promise<void> => {
        try {
            const v = await p;
            if (v !== null && v !== undefined) assign(v as NonNullable<T>);
        } catch { /* field unsupported for this container/codec — skip it */ }
    };
    try {
        const tracks = await input.getTracks();
        let format: string | undefined;
        try { format = (await input.getFormat()).name; } catch { /* unknown */ }
        const out: MediaTrackInfo[] = [];
        for (const track of tracks) {
            const t: MediaTrackInfo = {
                kind: track.isVideoTrack() ? "video" : track.isAudioTrack() ? "audio" : "other",
                number: track.number,
            };
            await set(track.getCodec(), v => { t.codec = v; });
            await set(track.getCodecParameterString(), v => { t.codecString = v; });
            await set(track.getInternalCodecId(), v => {
                if (typeof v === "string") t.internalCodecId = v;
                else if (typeof v === "number") t.internalCodecId = String(v);
            });
            await set(track.getLanguageCode(), v => { if (v && v !== "und") t.language = v; });
            await set(track.getName(), v => { if (v) t.name = v; });
            await set(track.getAverageBitrate(), v => { if (v > 0) t.bitrate = v; });
            if (t.bitrate === undefined) await set(track.getBitrate(), v => { if (v > 0) t.bitrate = v; });

            if (track.isVideoTrack()) {
                await set(track.getCodedWidth(), v => { t.codedWidth = v; });
                await set(track.getCodedHeight(), v => { t.codedHeight = v; });
                await set(track.getDisplayWidth(), v => { t.displayWidth = v; });
                await set(track.getDisplayHeight(), v => { t.displayHeight = v; });
                await set(track.getRotation(), v => { if (v) t.rotation = v; });
                await set(track.getPixelAspectRatio(), v => {
                    if (v && (v.num !== 1 || v.den !== 1)) {
                        t.pixelAspectRatio = `${v.num}:${v.den}`;
                    }
                });
                await set(track.hasHighDynamicRange(), v => { t.hdr = v; });
                await set(track.getColorSpace(), v => {
                    if (v.primaries) t.colorPrimaries = v.primaries;
                    if (v.transfer) t.colorTransfer = v.transfer;
                    if (v.matrix) t.colorMatrix = v.matrix;
                    if (typeof v.fullRange === "boolean") t.colorFullRange = v.fullRange;
                });
                await set(track.computePacketStats(150), v => {
                    if (v.averagePacketRate > 0) t.frameRate = Math.round(v.averagePacketRate * 1000) / 1000;
                });
            } else if (track.isAudioTrack()) {
                await set(track.getNumberOfChannels(), v => { t.channels = v; });
                await set(track.getSampleRate(), v => { t.sampleRate = v; });
            }
            out.push(t);
        }
        return { format, trackCount: tracks.length, tracks: out };
    } catch (err) {
        console.warn(`collectMediaInfo failed:`, err);
        return undefined;
    }
}

// Single entry point every frame-extraction path (thumbnails, keyframes,
// faces) uses to open a file: demux it, find the primary video track, and
// register whatever custom decoder the codec needs. The browser's WebCodecs
// can't decode MPEG-4 Part 2 (XviD/DivX in AVI), so we register our pure-TS
// decoder here — routing all three through this helper is what gives them AVI
// support consistently, matching live playback (VideoPlayer.ts).
async function openVideoForExtraction(source: Source) {
    const input = new Input({ source, formats: ALL_FORMATS });
    try {
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error("No video track");
        const codec = await videoTrack.getCodec();
        if (codec === "mp4v") await ensureMp4vDecoder();
        return { input, videoTrack, codec };
    } catch (err) {
        try { await input.dispose(); } catch { }
        throw err;
    }
}

// Pulls everything we want to know about a file in a single Mediabunny `Input`
// session: codec strings, duration, dimensions, plus a thumbnail at 3 widths
// (160 / 320 / 640) so the grid can pick whichever matches its display size.
//
// Takes a mediabunny `Source` (not a `File`) so the same code runs in both the
// main thread (`BlobSource` over a `File`) and a web worker (`CustomSource`
// over a postMessage-backed reader). Uses OffscreenCanvas + convertToBlob so
// it doesn't touch the DOM and can run in either context.
export async function extractMetadataAndThumbs(
    source: Source,
    fileLastModified: number | undefined,
    label: string,
): Promise<ExtractedInfo> {
    const t0 = performance.now();
    const sinceStart = () => `+${(performance.now() - t0).toFixed(0)}ms`;
    const since = (t: number) => `+${(performance.now() - t).toFixed(0)}ms`;
    console.log(`${label} starting`);

    let tStep = performance.now();
    const { input, videoTrack, codec: videoCodec } = await openVideoForExtraction(source);
    try {
        const audioTrack = await input.getPrimaryAudioTrack();
        console.log(`${label} got primary tracks (${since(tStep)}; ${sinceStart()})`);

        tStep = performance.now();
        const durationSec = await input.computeDuration();
        const width = await videoTrack.getCodedWidth();
        const height = await videoTrack.getCodedHeight();
        const audioCodec = audioTrack ? await audioTrack.getCodec() : undefined;
        console.log(`${label} got metadata (${since(tStep)}): ${durationSec.toFixed(1)}s ${width}×${height} video=${videoCodec} audio=${audioCodec ?? "none"}`);

        // Full per-track detail (codec strings, color space, channels, …) for
        // the info modal. Non-fatal — a failure here leaves mediaInfo undefined
        // and we still return the flat fields the grid needs.
        const mediaInfo = await collectMediaInfo(input);

        const primaryTs = durationSec < SHORT_VIDEO_THRESHOLD_SEC
            ? durationSec / 2
            : durationSec * 0.2;
        console.log(`${label} target thumbnail at ${primaryTs.toFixed(2)}s (${durationSec < SHORT_VIDEO_THRESHOLD_SEC ? "midpoint, <30min" : "20%, ≥30min"})`);

        // Fallback chain — some demuxers refuse to seek to specific
        // offsets (truncated MOOV, partial index, encoded-only frames
        // before the requested time). Try a few earlier-and-earlier
        // positions before giving up; landing on *any* keyframe gives
        // us a usable thumbnail.
        tStep = performance.now();
        const sink = new VideoSampleSink(videoTrack);
        const packetSink = new EncodedPacketSink(videoTrack);
        const candidates = [primaryTs, durationSec * 0.1, durationSec * 0.05, 1, 0]
            .filter(t => t >= 0 && (durationSec === 0 || t <= durationSec))
            .filter((t, i, arr) => arr.indexOf(t) === i);
        let sample: Awaited<ReturnType<typeof sink.getSample>> | undefined;
        let actualTs = 0;
        for (const t of candidates) {
            // Snap to the keyframe at-or-before `t` and decode only that
            // keyframe, instead of asking for the exact frame at `t`.
            // getSample(t) for an arbitrary (non-keyframe) timestamp makes the
            // decoder walk forward from the prior keyframe to `t`; on a format
            // with a weak/absent seek index — AVI especially — that degrades to
            // decoding the whole file up to `t`. A thumbnail only needs a
            // representative frame, so any nearby keyframe is fine. Mirrors the
            // keyframe-preview path (getKeyPacket → getSample(packet.timestamp)).
            const keyPacket = await packetSink.getKeyPacket(t).catch(() => undefined);
            const seekTs = keyPacket ? keyPacket.timestamp : t;
            const s = await sink.getSample(seekTs);
            if (s) {
                sample = s;
                actualTs = s.timestamp;
                if (t !== primaryTs) {
                    console.log(`${label} primary thumbnail timestamp ${primaryTs.toFixed(2)}s missed, fell back to ${t.toFixed(2)}s`);
                }
                break;
            }
        }
        if (!sample) throw new Error(`No video sample within ${candidates.length} candidate timestamps`);
        console.log(`${label} decoded keyframe (${since(tStep)}; ${sinceStart()}): landed at ${actualTs.toFixed(2)}s`);

        tStep = performance.now();
        const frame = sample.toVideoFrame();
        const fullCanvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        const fullCtx = fullCanvas.getContext("2d");
        if (!fullCtx) throw new Error("Could not get 2d context");
        fullCtx.drawImage(frame, 0, 0);
        frame.close();
        sample.close();
        const crop = detectLetterboxRect(fullCanvas);
        const croppedCanvas = cropCanvas(fullCanvas, crop);
        if (croppedCanvas !== fullCanvas) {
            console.log(`${label} trimmed letterbox: ${fullCanvas.width}×${fullCanvas.height} → ${crop.w}×${crop.h} (offset ${crop.x},${crop.y})`);
        }
        console.log(`${label} drew ${croppedCanvas.width}×${croppedCanvas.height} canvas (${since(tStep)})`);

        tStep = performance.now();
        const thumbs = await Promise.all(
            THUMB_WIDTHS.map(async w => {
                const start = performance.now();
                const bytes = await resizeAndEncode(croppedCanvas, w);
                console.log(`${label} thumb${w} (${since(start)}): ${(bytes.byteLength / 1024).toFixed(1)} KB`);
                return bytes;
            }),
        );
        const [thumb160, thumb320, thumb640] = thumbs;
        console.log(`${label} all thumbnails encoded (${since(tStep)}; ${sinceStart()})`);

        const totalMs = Math.round(performance.now() - t0);
        console.log(`${label} done in ${totalMs}ms`);
        return {
            durationSec,
            width: width ?? undefined,
            height: height ?? undefined,
            videoCodec: videoCodec ?? undefined,
            audioCodec: audioCodec ?? undefined,
            fileModifiedAt: fileLastModified,
            mediaInfo,
            thumb160,
            thumb320,
            thumb640,
            thumbW: croppedCanvas.width,
            thumbH: croppedCanvas.height,
            metadataExtractionMs: totalMs,
        };
    } catch (err) {
        console.warn(`${label} failed after ${sinceStart()}:`, err);
        throw err;
    } finally {
        try { await input.dispose(); } catch { }
    }
}

export interface KeyframeBundle {
    data: Uint8Array;
    // Byte offsets into `data`. Length = number of frames + 1; the last
    // entry is data.byteLength (sentinel for slicing the final frame).
    offsets: number[];
    // Media-time of each frame in seconds. Length = number of frames.
    times: number[];
    intervalSec: number;
    keyframesExtractionMs: number;
}

// Sample one keyframe every `keyframeIntervalForDuration(duration)` seconds,
// decode each, downscale to KEYFRAMES_TARGET_W width, JPEG-encode at
// KEYFRAMES_JPEG_QUALITY, and pack the result into one contiguous buffer.
export async function extractKeyframes(
    source: Source,
    label: string,
    onProgress?: (i: number, totalEstimate: number, timeMsCurrent: number, durationMs: number) => void,
): Promise<KeyframeBundle> {
    const t0 = performance.now();
    console.log(`${label} starting keyframe-preview extraction`);
    const { input, videoTrack: track } = await openVideoForExtraction(source);
    try {
        const duration = await track.computeDuration();
        const intervalSec = keyframeIntervalForDuration(duration);
        console.log(`${label} duration=${duration.toFixed(1)}s → interval=${intervalSec}s`);

        const packetSink = new EncodedPacketSink(track);
        const sampleSink = new VideoSampleSink(track);
        const frames: { time: number; jpeg: Uint8Array }[] = [];
        const seen = new Set<number>();

        // Rough estimate so the progress consumer has something to chart
        // against. Real count varies (gaps between keyframes, dedup).
        const totalEstimate = Math.max(1, Math.ceil(duration / intervalSec));
        let iter = 0;
        for (let t = 0; t < duration; t += intervalSec) {
            iter++;
            const packet = await packetSink.getKeyPacket(t);
            if (!packet) continue;
            if (seen.has(packet.timestamp)) continue;
            seen.add(packet.timestamp);
            const sample = await sampleSink.getSample(packet.timestamp);
            if (!sample) continue;
            try {
                const frame = sample.toVideoFrame();
                try {
                    const jpeg = await encodeFrameAsJpeg(frame, KEYFRAMES_TARGET_W);
                    frames.push({ time: packet.timestamp, jpeg });
                    onProgress?.(iter, totalEstimate, Math.round((packet.timestamp ?? t) * 1000), Math.round(duration * 1000));
                } finally {
                    frame.close();
                }
            } finally {
                sample.close();
            }
        }

        // Pack all JPEGs end-to-end with a per-frame offset index.
        const totalBytes = frames.reduce((s, f) => s + f.jpeg.byteLength, 0);
        const data = new Uint8Array(totalBytes);
        const offsets: number[] = [];
        const times: number[] = [];
        let pos = 0;
        for (const f of frames) {
            offsets.push(pos);
            times.push(f.time);
            data.set(f.jpeg, pos);
            pos += f.jpeg.byteLength;
        }
        offsets.push(pos);
        const keyframesExtractionMs = Math.round(performance.now() - t0);
        console.log(`${label} packed ${frames.length} keyframes, ${(totalBytes / 1024).toFixed(1)} KB total, in ${keyframesExtractionMs}ms`);
        return { data, offsets, times, intervalSec, keyframesExtractionMs };
    } finally {
        try { await input.dispose(); } catch { }
    }
}

// One decoded frame, ready for face detection. JPEG encoding is deferred
// to the caller — they get to skip it on frames where no faces are
// detected, which is the dominant cost saver for long movies with sparse
// face presence.
export interface ExtractedRawFrame {
    timeMs: number;
    canvas: OffscreenCanvas;
    width: number;
    height: number;
    // Total media duration in ms — same value on every yielded frame
    // (it's known at iteration start). Lets the consumer compute %
    // progress + ETA without separately demuxing the file.
    durationMs: number;
}

// Re-encode an already-cropped frame as JPEG. Caller responsible for
// deciding whether the frame is worth keeping.
export async function encodeFrameJpeg(canvas: OffscreenCanvas): Promise<Uint8Array> {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: FACES_FRAME_JPEG_QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
}

// Iterate every keyframe in `source`, deduplicated to at most one per
// FACES_MIN_INTERVAL_MS. Each yielded frame is decoded, letterbox-cropped,
// and scaled to FACES_FRAME_TARGET_W width. The canvas is yielded raw —
// caller does face detection on it directly, then encodes JPEG via
// encodeFrameJpeg only if it's worth keeping.
export async function* iterateFacesFrames(source: Source, label: string): AsyncGenerator<ExtractedRawFrame> {
    const { input, videoTrack: track } = await openVideoForExtraction(source);
    try {
        const durationMs = Math.round((await track.computeDuration()) * 1000);
        const packetSink = new EncodedPacketSink(track);
        const sampleSink = new VideoSampleSink(track);
        let sharedCrop: Rect | undefined;
        let lastEmittedMs = -FACES_MIN_INTERVAL_MS;
        let packet = await packetSink.getFirstKeyPacket();
        let emitted = 0;
        while (packet) {
            const timeMs = Math.round(packet.timestamp * 1000);
            if (timeMs - lastEmittedMs < FACES_MIN_INTERVAL_MS) {
                packet = await packetSink.getNextKeyPacket(packet);
                continue;
            }
            const sample = await sampleSink.getSample(packet.timestamp);
            if (!sample) { packet = await packetSink.getNextKeyPacket(packet); continue; }
            try {
                const frame = sample.toVideoFrame();
                try {
                    // Draw at native resolution once so we can run crop
                    // detection on the first keyframe.
                    const nativeCanvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
                    const nctx = nativeCanvas.getContext("2d");
                    if (!nctx) throw new Error("Could not get 2d context");
                    nctx.drawImage(frame, 0, 0);
                    if (!sharedCrop) sharedCrop = detectLetterboxRect(nativeCanvas);
                    const cropped = cropCanvas(nativeCanvas, sharedCrop);

                    const ratio = cropped.width > 0 ? cropped.height / cropped.width : 9 / 16;
                    const w = Math.min(FACES_FRAME_TARGET_W, cropped.width || FACES_FRAME_TARGET_W);
                    const h = Math.max(1, Math.round(w * ratio));
                    const outCanvas = new OffscreenCanvas(w, h);
                    const octx = outCanvas.getContext("2d");
                    if (!octx) throw new Error("Could not get 2d context");
                    octx.imageSmoothingEnabled = true;
                    octx.imageSmoothingQuality = "high";
                    octx.drawImage(cropped, 0, 0, w, h);
                    lastEmittedMs = timeMs;
                    emitted++;
                    yield { timeMs, canvas: outCanvas, width: w, height: h, durationMs };
                } finally {
                    frame.close();
                }
            } finally {
                sample.close();
            }
            packet = await packetSink.getNextKeyPacket(packet);
        }
        console.log(`${label} face-frames: emitted ${emitted}`);
    } finally {
        try { await input.dispose(); } catch { }
    }
}

async function encodeFrameAsJpeg(
    frame: VideoFrame,
    targetWidth: number,
): Promise<Uint8Array> {
    // Draw the frame at native size and detect its letterbox bars
    // independently — a video that legitimately changes aspect ratio gets
    // cropped correctly at every keyframe.
    const nativeCanvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const nativeCtx = nativeCanvas.getContext("2d");
    if (!nativeCtx) throw new Error("Could not get 2d context");
    nativeCtx.drawImage(frame, 0, 0);
    const effectiveCrop = detectLetterboxRect(nativeCanvas);
    const source = cropCanvas(nativeCanvas, effectiveCrop);

    const ratio = source.width > 0 ? source.height / source.width : 9 / 16;
    const w = Math.min(targetWidth, source.width || targetWidth);
    const h = Math.max(1, Math.round(w * ratio));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: KEYFRAMES_JPEG_QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
}

// ────────────────────────────────────────────────────────────────────────
// Letterbox detection — top/bottom black bars only. Pillarboxing is rare
// and detecting it tends to also chew into legitimate dark scenes at the
// edges. Just remove the bars; don't touch the actual content.

interface Rect { x: number; y: number; w: number; h: number; }

// A pixel is "dark" if every channel is at or below this. ~20 catches
// JPEG-noisy "black" without false positives on dark scenes.
const DARK_MAX_CHANNEL = 20;
// A row counts as a bar if at most this fraction of pixels are non-dark.
// Lets a couple of stray bright pixels (e.g. credits leaking in) survive
// without aborting the detection.
const NON_DARK_TOLERANCE = 0.02;
// Skip detection on tiny canvases — not worth the IO.
const MIN_DIM_FOR_DETECTION = 64;
// Reject a letterbox crop that would keep less than this fraction of the frame
// height — guards against a bad first frame (fade/title) producing a sliver crop.
const KEYFRAMES_MIN_KEEP_FRACTION = 0.5;

function detectLetterboxRect(canvas: OffscreenCanvas): Rect {
    const W = canvas.width;
    const H = canvas.height;
    const full = { x: 0, y: 0, w: W, h: H };
    if (W < MIN_DIM_FOR_DETECTION || H < MIN_DIM_FOR_DETECTION) return full;
    const ctx = canvas.getContext("2d");
    if (!ctx) return full;
    const data = ctx.getImageData(0, 0, W, H).data;

    const rowIsBar = (y: number): boolean => {
        const start = y * W * 4;
        let nonDark = 0;
        for (let x = 0; x < W; x++) {
            const i = start + x * 4;
            if (data[i] > DARK_MAX_CHANNEL || data[i + 1] > DARK_MAX_CHANNEL || data[i + 2] > DARK_MAX_CHANNEL) nonDark++;
        }
        return nonDark / W < NON_DARK_TOLERANCE;
    };

    let top = 0;
    while (top < H && rowIsBar(top)) top++;
    let bottom = H;
    while (bottom > top && rowIsBar(bottom - 1)) bottom--;

    if (top === 0 && bottom === H) return full;
    // Reject a pathological crop. The crop is locked from the first sampled
    // frame, often a fade-in / title / mostly-black frame whose only bright
    // rows are a thin band — that produces a sliver strip applied to the whole
    // video. A real letterbox keeps well over half the height (2.39:1 in 16:9
    // keeps ~75%), so if we'd keep less than half, treat detection as bad.
    if (bottom - top < H * KEYFRAMES_MIN_KEEP_FRACTION) return full;
    return { x: 0, y: top, w: W, h: bottom - top };
}

// Crops `source` to `rect` in a fresh OffscreenCanvas. If rect equals the
// full source we just return source itself (no copy).
function cropCanvas(source: OffscreenCanvas, rect: Rect): OffscreenCanvas {
    if (rect.x === 0 && rect.y === 0 && rect.w === source.width && rect.h === source.height) return source;
    const out = new OffscreenCanvas(rect.w, rect.h);
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return out;
}

async function resizeAndEncode(source: OffscreenCanvas, targetWidth: number): Promise<Uint8Array> {
    const ratio = source.width > 0 ? source.height / source.width : 9 / 16;
    const w = Math.min(targetWidth, source.width || targetWidth);
    const h = Math.max(1, Math.round(w * ratio));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
}
