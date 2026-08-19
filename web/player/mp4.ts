// Embedded subtitle extraction from MP4 / MOV containers.
//
// Sibling of ./mkv, for the other container we care about. MP4 is a tree of
// boxes (`[u32 size][u32 type][payload]`), and unlike Matroska it *does* index
// its media: the sample tables under `stbl` give us every subtitle sample's
// timestamp, byte offset and length without walking the file. So the strategy
// differs — read `moov` once (it is small and self-contained), decode the
// tables in memory, then fetch only the sample bytes we actually need.
//
// The only subtitle payload we can render here is VobSub, which MP4 stores in
// a `subp`-handler track whose sample entry is `mp4s`. The 16-colour palette
// lives in that entry's `esds` descriptor as YUV quads (Matroska instead keeps
// the `.idx` text — see ./vobsub for both).
//
// mediabunny is no help for any of this: it only knows `webvtt`, and its
// InputTrack has no subtitle variant at all.

import { SubtitleCue, SubtitleTrack } from "./subtitles";
import { decodeSpuBitmap, parseYuvPalette, spuTiming, VobsubPalette } from "./vobsub";

const u32 = (b: Uint8Array, p: number) =>
    ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
// Sizes and offsets can exceed 2^32 in large files; assemble as float64, which
// is exact to 2^53 and so covers any real file.
const u64 = (b: Uint8Array, p: number) => u32(b, p) * 0x100000000 + u32(b, p + 4);

type Box = { type: string; start: number; dataStart: number; end: number };

// Iterate the child boxes inside [start, end) of `buf`.
function* boxes(buf: Uint8Array, start: number, end: number): Generator<Box> {
    let p = start;
    while (p + 8 <= end) {
        let size = u32(buf, p);
        const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
        let dataStart = p + 8;
        if (size === 1) {
            if (p + 16 > end) return;
            size = u64(buf, p + 8);
            dataStart = p + 16;
        } else if (size === 0) {
            size = end - p;
        }
        if (size < 8 || p + size > end) return;
        yield { type, start: p, dataStart, end: p + size };
        p += size;
    }
}

function findBox(buf: Uint8Array, start: number, end: number, type: string): Box | undefined {
    for (const b of boxes(buf, start, end)) if (b.type === type) return b;
    return undefined;
}

// Descend a path of box types, e.g. ["mdia", "minf", "stbl"].
function descend(buf: Uint8Array, box: Box | undefined, ...path: string[]): Box | undefined {
    let cur = box;
    for (const type of path) {
        if (!cur) return undefined;
        cur = findBox(buf, cur.dataStart, cur.end, type);
    }
    return cur;
}

// mdhd packs the ISO-639-2 language into 15 bits as three 5-bit letters
// biased by 0x60.
function unpackLanguage(v: number): string {
    const a = ((v >> 10) & 0x1f) + 0x60;
    const b = ((v >> 5) & 0x1f) + 0x60;
    const c = (v & 0x1f) + 0x60;
    const s = String.fromCharCode(a, b, c);
    return /^[a-z]{3}$/.test(s) ? s : "und";
}

type SampleTable = {
    times: number[];   // decode time per sample, in media timescale units
    durations: number[];
    offsets: number[]; // absolute file offsets
    sizes: number[];
};

// Rebuild per-sample timing from `stts` (run-length encoded durations).
function readStts(buf: Uint8Array, box: Box): { times: number[]; durations: number[] } {
    const times: number[] = [];
    const durations: number[] = [];
    const count = u32(buf, box.dataStart + 4);
    let p = box.dataStart + 8;
    let t = 0;
    for (let i = 0; i < count && p + 8 <= box.end; i++, p += 8) {
        const n = u32(buf, p);
        const delta = u32(buf, p + 4);
        for (let k = 0; k < n; k++) {
            times.push(t);
            durations.push(delta);
            t += delta;
        }
    }
    return { times, durations };
}

function readStsz(buf: Uint8Array, box: Box): number[] {
    const uniform = u32(buf, box.dataStart + 4);
    const count = u32(buf, box.dataStart + 8);
    if (uniform !== 0) return new Array(count).fill(uniform);
    const sizes: number[] = [];
    let p = box.dataStart + 12;
    for (let i = 0; i < count && p + 4 <= box.end; i++, p += 4) sizes.push(u32(buf, p));
    return sizes;
}

function readChunkOffsets(buf: Uint8Array, stbl: Box): number[] {
    const stco = findBox(buf, stbl.dataStart, stbl.end, "stco");
    if (stco) {
        const count = u32(buf, stco.dataStart + 4);
        const out: number[] = [];
        let p = stco.dataStart + 8;
        for (let i = 0; i < count && p + 4 <= stco.end; i++, p += 4) out.push(u32(buf, p));
        return out;
    }
    const co64 = findBox(buf, stbl.dataStart, stbl.end, "co64");
    if (co64) {
        const count = u32(buf, co64.dataStart + 4);
        const out: number[] = [];
        let p = co64.dataStart + 8;
        for (let i = 0; i < count && p + 8 <= co64.end; i++, p += 8) out.push(u64(buf, p));
        return out;
    }
    return [];
}

// `stsc` says "from chunk N onwards, each chunk holds K samples". Expanding
// that against the chunk offsets gives every sample's absolute position.
function computeOffsets(buf: Uint8Array, stbl: Box, sizes: number[]): number[] {
    const stsc = findBox(buf, stbl.dataStart, stbl.end, "stsc");
    const chunkOffsets = readChunkOffsets(buf, stbl);
    if (!stsc || chunkOffsets.length === 0) return [];

    const runCount = u32(buf, stsc.dataStart + 4);
    const runs: { firstChunk: number; perChunk: number }[] = [];
    let p = stsc.dataStart + 8;
    for (let i = 0; i < runCount && p + 12 <= stsc.end; i++, p += 12) {
        runs.push({ firstChunk: u32(buf, p), perChunk: u32(buf, p + 4) });
    }
    if (runs.length === 0) return [];

    const offsets: number[] = [];
    let sample = 0;
    for (let r = 0; r < runs.length && sample < sizes.length; r++) {
        const first = runs[r].firstChunk;              // 1-based
        const last = r + 1 < runs.length ? runs[r + 1].firstChunk : chunkOffsets.length + 1;
        for (let chunk = first; chunk < last && sample < sizes.length; chunk++) {
            const base = chunkOffsets[chunk - 1];
            if (base === undefined) break;
            let pos = base;
            for (let k = 0; k < runs[r].perChunk && sample < sizes.length; k++) {
                offsets.push(pos);
                pos += sizes[sample];
                sample++;
            }
        }
    }
    return offsets;
}

// A leading "empty edit" (media_time -1) delays the track; a normal edit's
// media_time trims its head. Both are common in muxer output and both shift
// every timestamp, so ignoring them puts subtitles visibly out of sync.
function readEditShiftMs(buf: Uint8Array, trak: Box, movieTimescale: number, mediaTimescale: number): number {
    const elst = descend(buf, trak, "edts", "elst");
    if (!elst) return 0;
    const version = buf[elst.dataStart];
    const count = u32(buf, elst.dataStart + 4);
    let p = elst.dataStart + 8;
    let shiftMs = 0;
    for (let i = 0; i < count; i++) {
        let segDuration: number, mediaTime: number;
        if (version === 1) {
            if (p + 20 > elst.end) break;
            segDuration = u64(buf, p);
            mediaTime = u64(buf, p + 8);
            // media_time is signed; -1 (all bits set) marks an empty edit.
            if (u32(buf, p + 8) === 0xffffffff && u32(buf, p + 12) === 0xffffffff) mediaTime = -1;
            p += 20;
        } else {
            if (p + 12 > elst.end) break;
            segDuration = u32(buf, p);
            const mt = u32(buf, p + 4);
            mediaTime = mt === 0xffffffff ? -1 : (mt | 0) < 0 ? (mt | 0) : mt;
            p += 12;
        }
        if (mediaTime === -1) {
            shiftMs += (segDuration / movieTimescale) * 1000;
        } else {
            shiftMs -= (mediaTime / mediaTimescale) * 1000;
            break; // only the first real edit shifts the timeline
        }
    }
    return shiftMs;
}

// Pull the 16-entry palette out of the sample entry. `mp4s` wraps an `esds`
// whose DecoderSpecificInfo (tag 0x05) is 64 bytes of YUV quads.
function readPalette(buf: Uint8Array, stbl: Box): VobsubPalette | undefined {
    const stsd = findBox(buf, stbl.dataStart, stbl.end, "stsd");
    if (!stsd) return undefined;
    // version/flags (4) + entry_count (4), then the sample entries.
    const entry = findBox(buf, stsd.dataStart + 8, stsd.end, "mp4s")
        ?? [...boxes(buf, stsd.dataStart + 8, stsd.end)][0];
    if (!entry) return undefined;
    // Sample entry header: 6 reserved bytes + 2 data_reference_index.
    const esds = findBox(buf, entry.dataStart + 8, entry.end, "esds");
    if (!esds) return undefined;

    // Descriptors: [tag][length, optionally with 0x80-continuation bytes][body]
    let p = esds.dataStart + 4; // skip version/flags
    const readLen = () => {
        let len = 0;
        for (let i = 0; i < 4 && p < esds.end; i++) {
            const b = buf[p++];
            len = (len << 7) | (b & 0x7f);
            if (!(b & 0x80)) break;
        }
        return len;
    };
    while (p < esds.end) {
        const tag = buf[p++];
        const len = readLen();
        if (tag === 0x03) {
            // ES_Descriptor: ES_ID(2) + flags(1), then nested descriptors.
            p += 3;
            continue;
        }
        if (tag === 0x04) {
            // DecoderConfigDescriptor: objectType(1) streamType(1) buf(3)
            // maxBitrate(4) avgBitrate(4), then nested descriptors.
            p += 13;
            continue;
        }
        if (tag === 0x05) {
            if (p + len > esds.end) return undefined;
            return parseYuvPalette(buf.subarray(p, p + len));
        }
        p += len;
    }
    return undefined;
}

type SubpTrack = {
    trak: Box;
    stbl: Box;
    lang: string;
    timescale: number;
    // The track's own declared size, when it states one. Usually absent: subp
    // tkhds are almost always 0x0, which is why resolvePlane exists.
    width: number | undefined;
    height: number | undefined;
    palette: VobsubPalette;
    shiftMs: number;
};

// Byte offset of tkhd's 16.16 `width`, or undefined if the box is too short.
// The fields sit at the very end of the box, so getting this wrong reads the
// height as the width and runs off the end for the height -- which is exactly
// what a 4-byte slip did here once already.
//
//   v0: version+flags 4, times 8, id 4, rsv 4, dur 4, rsv 8, layer/alt/vol/rsv 8,
//       matrix 36  => width @80, height @84
//   v1: 8-byte times and duration add 12  => width @92, height @96
function tkhdSizeOffset(moov: Uint8Array, tkhd: Box): number | undefined {
    const base = tkhd.dataStart + (moov[tkhd.dataStart] === 1 ? 92 : 80);
    return base + 8 <= tkhd.end ? base : undefined;
}

// The video track's presentation size, which is the space subtitle cues are
// positioned in. Prefer tkhd (the display size, after any anamorphic scaling);
// fall back to the coded size in the visual sample entry.
function readVideoSize(moov: Uint8Array): { width: number; height: number } | undefined {
    for (const trak of boxes(moov, 0, moov.length)) {
        if (trak.type !== "trak") continue;
        const hdlr = descend(moov, trak, "mdia", "hdlr");
        if (!hdlr) continue;
        const handler = String.fromCharCode(
            moov[hdlr.dataStart + 8], moov[hdlr.dataStart + 9],
            moov[hdlr.dataStart + 10], moov[hdlr.dataStart + 11],
        );
        if (handler !== "vide") continue;

        const tkhd = descend(moov, trak, "tkhd");
        const base = tkhd ? tkhdSizeOffset(moov, tkhd) : undefined;
        if (base !== undefined) {
            const w = Math.round(u32(moov, base) / 65536);
            const h = Math.round(u32(moov, base + 4) / 65536);
            if (w >= 16 && h >= 16) return { width: w, height: h };
        }
        // VisualSampleEntry: 8-byte box header, 6 reserved + 2 data_ref_index,
        // 2 pre_defined + 2 reserved + 12 pre_defined, then u16 width, height.
        const stsd = descend(moov, trak, "mdia", "minf", "stbl", "stsd");
        if (stsd) {
            const entry = [...boxes(moov, stsd.dataStart + 8, stsd.end)][0];
            if (entry && entry.dataStart + 34 <= entry.end) {
                const w = u16(moov, entry.dataStart + 24);
                const h = u16(moov, entry.dataStart + 26);
                if (w >= 16 && h >= 16) return { width: w, height: h };
            }
        }
    }
    return undefined;
}

// Pick the coordinate space the cue rectangles live in.
//
// Nothing in an MP4 states it: the subp tkhd is almost always 0x0, and there is
// no `.idx` header the way there is in Matroska. So we infer it from where the
// cues actually land. Subs are bottom-anchored, so the vertical extent alone
// separates the cases: a DVD-raster sub bottoms out under 480/576, while one
// re-authored against a 1080p frame sits near y=1000 and would be drawn far
// off-screen if we assumed the DVD raster. Conversely, a genuine DVD sub muxed
// beside HD video must NOT be stretched to the video size, or it shrinks into
// the top-left corner. Smallest candidate that contains every cue wins.
function resolvePlane(
    declared: { width: number | undefined; height: number | undefined },
    videoSize: { width: number; height: number } | undefined,
    extent: { right: number; bottom: number },
): { width: number; height: number; why: string } {
    const fits = (w: number, h: number) => extent.right <= w && extent.bottom <= h;

    if (declared.width && declared.height) {
        // An explicit statement wins even if the cues overflow it -- but then
        // widen, since drawing off-screen is never what the author meant.
        return {
            width: Math.max(declared.width, extent.right),
            height: Math.max(declared.height, extent.bottom),
            why: fits(declared.width, declared.height) ? "track tkhd" : "track tkhd, widened to fit cues",
        };
    }
    if (fits(720, 480)) return { width: 720, height: 480, why: "NTSC DVD raster" };
    if (fits(720, 576)) return { width: 720, height: 576, why: "PAL DVD raster" };
    if (videoSize && fits(videoSize.width, videoSize.height)) {
        return { width: videoSize.width, height: videoSize.height, why: "video track size" };
    }
    return {
        width: Math.max(videoSize?.width ?? 0, extent.right),
        height: Math.max(videoSize?.height ?? 0, extent.bottom),
        why: "cue extents",
    };
}

function collectSubpTracks(moov: Uint8Array, movieTimescale: number): SubpTrack[] {
    const out: SubpTrack[] = [];
    for (const trak of boxes(moov, 0, moov.length)) {
        if (trak.type !== "trak") continue;
        const hdlr = descend(moov, trak, "mdia", "hdlr");
        if (!hdlr) continue;
        const handler = String.fromCharCode(
            moov[hdlr.dataStart + 8], moov[hdlr.dataStart + 9],
            moov[hdlr.dataStart + 10], moov[hdlr.dataStart + 11],
        );
        // `subp` is the DVD sub-picture handler. `sbtl`/`text` are the text
        // subtitle handlers (tx3g), which don't carry a VobSub payload.
        if (handler !== "subp") continue;

        const stbl = descend(moov, trak, "mdia", "minf", "stbl");
        const mdhd = descend(moov, trak, "mdia", "mdhd");
        if (!stbl || !mdhd) continue;

        const version = moov[mdhd.dataStart];
        const timescale = version === 1 ? u32(moov, mdhd.dataStart + 20) : u32(moov, mdhd.dataStart + 12);
        const langRaw = version === 1 ? u16(moov, mdhd.dataStart + 36) : u16(moov, mdhd.dataStart + 20);
        if (!timescale) continue;

        const palette = readPalette(moov, stbl);
        if (!palette) continue;

        // Only recorded here; the plane it feeds is decided by resolvePlane once
        // the cues are read, since this is 0x0 more often than not.
        const tkhd = descend(moov, trak, "tkhd");
        let width: number | undefined;
        let height: number | undefined;
        const base = tkhd ? tkhdSizeOffset(moov, tkhd) : undefined;
        if (base !== undefined) {
            const w = u32(moov, base) / 65536;
            const h = u32(moov, base + 4) / 65536;
            if (w >= 16 && h >= 16) { width = Math.round(w); height = Math.round(h); }
        }

        out.push({
            trak, stbl,
            lang: unpackLanguage(langRaw),
            timescale, width, height, palette,
            shiftMs: readEditShiftMs(moov, trak, movieTimescale, timescale),
        });
    }
    return out;
}

function pickTrack(tracks: SubpTrack[], lang: string): SubpTrack {
    const want = lang.trim().toLowerCase();
    const score = (t: SubpTrack) => {
        const l = t.lang.toLowerCase();
        if (want && l === want) return 3;
        if (want && l.includes(want)) return 2;
        return 1;
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

// Read the sample bytes. Samples are fetched in offset order through a sliding
// window so a track with thousands of cues costs a handful of large reads
// rather than one request per cue.
async function readSamples(
    file: File,
    offsets: number[],
    sizes: number[],
): Promise<(Uint8Array | undefined)[]> {
    const order = offsets.map((_, i) => i).sort((a, b) => offsets[a] - offsets[b]);
    const out: (Uint8Array | undefined)[] = new Array(offsets.length);
    const WINDOW = 1 << 22; // 4 MiB

    let winStart = 0;
    let win = new Uint8Array(0);
    for (const i of order) {
        const start = offsets[i];
        const size = sizes[i];
        if (size <= 0 || start < 0 || start + size > file.size) continue;
        if (start < winStart || start + size > winStart + win.length) {
            const end = Math.min(file.size, start + Math.max(size, WINDOW));
            win = new Uint8Array(await file.slice(start, end).arrayBuffer());
            winStart = start;
        }
        const off = start - winStart;
        out[i] = new Uint8Array(win.subarray(off, off + size));
    }
    return out;
}

export async function extractMp4Subtitles(
    file: File,
    lang: string,
): Promise<SubtitleTrack | undefined> {
    if (file.size < 16) return undefined;

    // Find `moov` among the top-level boxes. It may sit after `mdat` (the
    // default for non-faststart output), so we walk headers rather than assume.
    let moovBuf: Uint8Array | undefined;
    let pos = 0;
    while (pos + 8 <= file.size) {
        const head = new Uint8Array(await file.slice(pos, Math.min(pos + 16, file.size)).arrayBuffer());
        if (head.length < 8) break;
        let size = u32(head, 0);
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        let hdr = 8;
        if (size === 1) {
            if (head.length < 16) break;
            size = u64(head, 8);
            hdr = 16;
        } else if (size === 0) {
            size = file.size - pos;
        }
        if (size < 8 || pos + size > file.size) break;
        if (type === "moov") {
            moovBuf = new Uint8Array(await file.slice(pos + hdr, pos + size).arrayBuffer());
            break;
        }
        pos += size;
    }
    if (!moovBuf) return undefined;

    const mvhd = findBox(moovBuf, 0, moovBuf.length, "mvhd");
    const movieTimescale = mvhd
        ? (moovBuf[mvhd.dataStart] === 1 ? u32(moovBuf, mvhd.dataStart + 20) : u32(moovBuf, mvhd.dataStart + 12))
        : 1000;

    const videoSize = readVideoSize(moovBuf);
    const tracks = collectSubpTracks(moovBuf, movieTimescale || 1000);
    if (tracks.length === 0) return undefined;
    const track = pickTrack(tracks, lang);

    const stts = findBox(moovBuf, track.stbl.dataStart, track.stbl.end, "stts");
    const stsz = findBox(moovBuf, track.stbl.dataStart, track.stbl.end, "stsz");
    if (!stts || !stsz) return undefined;

    const { times, durations } = readStts(moovBuf, stts);
    const sizes = readStsz(moovBuf, stsz);
    const offsets = computeOffsets(moovBuf, track.stbl, sizes);
    const count = Math.min(times.length, sizes.length, offsets.length);
    if (count === 0) return undefined;

    const payloads = await readSamples(file, offsets.slice(0, count), sizes.slice(0, count));

    const toMs = (t: number) => (t / track.timescale) * 1000 + track.shiftMs;
    const cues: SubtitleCue[] = [];
    // Samples we throw away, by reason. Dropping silently makes a partly-wrong
    // parse look like a sparse subtitle track, so we report the tally.
    let unread = 0, empty = 0, unparsed = 0;
    // Furthest any cue reaches, used below to check the plane we assumed.
    let maxRight = 0, maxBottom = 0;
    for (let i = 0; i < count; i++) {
        const spu = payloads[i];
        if (!spu) { unread++; continue; }
        // A 4-byte sample is an empty "clear the screen" packet, which some
        // muxers emit between cues; there is nothing to show.
        if (spu.length <= 4) { empty++; continue; }
        const timing = spuTiming(spu);
        if (!timing) { unparsed++; continue; }
        maxRight = Math.max(maxRight, timing.right);
        maxBottom = Math.max(maxBottom, timing.bottom);

        const startMs = toMs(times[i]) + timing.showDelayMs;
        let endMs: number;
        if (timing.hideDelayMs !== undefined) {
            endMs = toMs(times[i]) + timing.hideDelayMs;
        } else if (durations[i] > 0) {
            endMs = toMs(times[i] + durations[i]);
        } else {
            endMs = startMs + 3000;
        }
        if (endMs <= startMs) endMs = startMs + 2000;
        cues.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: "", spu });
    }
    if (!cues.length) return undefined;

    cues.sort((a, b) => a.startMs - b.startMs);

    const plane = resolvePlane(track, videoSize, { right: maxRight, bottom: maxBottom });

    const label = `embedded ${track.lang} · VobSub`;
    // Log the span too: cues that exist but never line up with playback time
    // look exactly like cues that fail to draw, and this separates the two.
    const span = `${(cues[0].startMs / 1000).toFixed(1)}s..${(cues[cues.length - 1].endMs / 1000).toFixed(1)}s`;
    console.log(`[subtitles] ${cues.length} VobSub cues from MP4 subp track `
        + `(plane ${plane.width}x${plane.height} via ${plane.why}, video ${videoSize?.width ?? "?"}x${videoSize?.height ?? "?"}, `
        + `cues reach ${maxRight}x${maxBottom}, ${span}, lang ${track.lang})`);
    console.log(`[subtitles] subp tracks: ${tracks.map(t => t.lang).join(", ")} `
        + `— wanted "${lang}", chose "${track.lang}"`);
    console.log(`[subtitles] ${count} samples -> ${cues.length} cues `
        + `(dropped: ${unread} unread, ${empty} empty, ${unparsed} unparsed), `
        + `timescale ${track.timescale}, editShift ${Math.round(track.shiftMs)}ms`);
    console.log(`[subtitles] palette: ${[...track.palette].map(v => v.toString(16).padStart(6, "0")).join(" ")}`);
    // Probe the first cue so a blank overlay is diagnosable from the load log
    // alone, without having to catch a cue on screen. One decode is ~1ms.
    const probe = decodeSpuBitmap(cues[0].spu!, track.palette);
    if (probe) {
        let opaque = 0;
        const seen = new Set<number>();
        for (let i = 0; i < probe.rgba.length; i += 4) {
            if (probe.rgba[i + 3] > 0) {
                opaque++;
                seen.add((probe.rgba[i] << 16) | (probe.rgba[i + 1] << 8) | probe.rgba[i + 2]);
            }
        }
        const pct = (opaque / (probe.width * probe.height)) * 100;
        console.log(`[subtitles] probe cue 0: ${probe.width}x${probe.height}@${probe.x},${probe.y} `
            + `ink ${pct.toFixed(2)}%, visible colours `
            + `${[...seen].map(v => v.toString(16).padStart(6, "0")).join(" ")}`);
    } else {
        console.warn("[subtitles] probe cue 0 FAILED to decode");
    }
    return {
        cues,
        label,
        bitmap: { palette: track.palette, width: plane.width, height: plane.height },
    };
}
