// Embedded subtitle extraction from Matroska (.mkv / .webm) containers.
//
// Matroska is an EBML document: a tree of elements, each `[ID vint][size vint]
// [data]`. There is no subtitle index, so the only way to collect text tracks
// is to walk every Cluster (where the interleaved video / audio / subtitle
// blocks live) and pick out the blocks belonging to a subtitle track. mediabunny
// gives us no subtitle decode path, hence this hand-rolled reader.
//
// The file is read through a *windowed* reader (`ChunkReader`): we never issue
// one tiny range request per element — that would be hundreds of reads on a
// fragmented file. Instead each miss pulls a large sequential window and the
// parser walks forward inside it, so a multi-GB file is traversed in a few
// hundred big reads. Whole top-level elements we don't need (SeekHead, Cues,
// Chapters, Tags, Attachments — fonts can be tens of MB) are skipped by their
// declared size rather than read.

import { SubtitleCue, assEventToText, cleanCueText } from "./subtitles";

// EBML / Matroska element IDs (read with the length-descriptor bits kept).
const ID = {
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimestampScale: 0x2ad7b1,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackType: 0x83,
    CodecID: 0x86,
    Language: 0x22b59c,
    Name: 0x536e,
    Cluster: 0x1f43b675,
    Timestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    BlockDuration: 0x9b,
    Cues: 0x1c53bb6b,
    Chapters: 0x1043a770,
    Tags: 0x1254c367,
    Attachments: 0x1941a469,
} as const;

const TRACK_TYPE_SUBTITLE = 0x11;

// Top-level Segment children. When a Cluster declares "unknown" size (live
// muxers do this), it runs until the next element from this set.
const TOP_LEVEL = new Set<number>([
    ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues,
    ID.Chapters, ID.Tags, ID.Attachments, ID.Segment,
]);

const WINDOW = 1 << 23; // 8 MiB read window.

// Reads the file in large sequential windows. `bytes(pos, len)` returns a view
// of [pos, pos+len); a miss replaces the window with a fresh slice starting at
// `pos`. Callers walking forward stay inside one window until they cross its
// end (or skip past it), keeping the request count proportional to file size /
// WINDOW rather than to the element count.
class ChunkReader {
    private buf = new Uint8Array(0);
    private bufStart = 0;
    constructor(private file: File) {}
    get size(): number { return this.file.size; }

    async bytes(pos: number, len: number): Promise<Uint8Array> {
        if (pos >= this.bufStart && pos + len <= this.bufStart + this.buf.length) {
            const off = pos - this.bufStart;
            return this.buf.subarray(off, off + len);
        }
        const end = Math.min(this.file.size, pos + Math.max(len, WINDOW));
        this.buf = new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
        this.bufStart = pos;
        if (this.buf.length < len) throw new Error("unexpected EOF");
        return this.buf.subarray(0, len);
    }
}

// A vint: the first set bit (scanning from the MSB) marks the byte length; the
// value is the remaining bits across that many bytes. For element IDs the
// marker bit is kept (`keepMarker`); for sizes it is stripped, and an all-ones
// payload denotes "unknown size".
function readVint(buf: Uint8Array, off: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
    const first = buf[off];
    if (first === 0) throw new Error("invalid vint");
    let mask = 0x80, length = 1;
    while (!(first & mask)) { mask >>= 1; length++; }
    let value = keepMarker ? first : (first & (mask - 1));
    let unknownBits = (first & (mask - 1)) === (mask - 1);
    for (let i = 1; i < length; i++) {
        const b = buf[off + i];
        if (b !== 0xff) unknownBits = false;
        value = value * 256 + b;
    }
    return { value, length, unknown: !keepMarker && unknownBits };
}

type Element = { id: number; size: number; dataPos: number; unknown: boolean };

async function readElement(reader: ChunkReader, pos: number): Promise<Element> {
    const head = await reader.bytes(pos, Math.min(12, reader.size - pos));
    const id = readVint(head, 0, true);
    const size = readVint(head, id.length, false);
    return {
        id: id.value,
        size: size.value,
        dataPos: pos + id.length + size.length,
        unknown: size.unknown,
    };
}

function readUint(buf: Uint8Array, off: number, len: number): number {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
    return v;
}

const decoder = new TextDecoder("utf-8");

type SubTrack = { number: number; codec: string; lang: string; name: string };

// A subtitle block carries a track-relative payload and (via BlockGroup) an
// optional duration; SimpleBlocks have none, so end times are filled in later.
type RawCue = { startMs: number; durMs: number | undefined; text: string };

function decodePayload(bytes: Uint8Array, codec: string): string {
    const s = decoder.decode(bytes);
    if (codec.includes("ASS") || codec.includes("SSA")) return assEventToText(s);
    return cleanCueText(s);
}

// Parse the block header (track vint + int16 relative timestamp + flags) and,
// if it belongs to our subtitle track and is unlaced, decode its payload.
function readBlock(buf: Uint8Array, dataPos: number, size: number, clusterTs: number, scaleMs: number, track: SubTrack, durMs: number | undefined, out: RawCue[]): void {
    let p = dataPos;
    const trackVint = readVint(buf, p, false);
    p += trackVint.length;
    if (trackVint.value !== track.number) return;
    let rel = (buf[p] << 8) | buf[p + 1];
    if (rel >= 0x8000) rel -= 0x10000;
    const flags = buf[p + 2];
    p += 3;
    // Lacing (flags bits 1–2) packs several frames in one block — never used for
    // subtitles. Skip defensively rather than mis-parse the payload.
    if ((flags & 0x06) !== 0) return;
    const text = decodePayload(buf.subarray(p, dataPos + size), track.codec);
    if (!text) return;
    out.push({ startMs: (clusterTs + rel) * scaleMs, durMs: durMs !== undefined ? durMs * scaleMs : undefined, text });
}

// Read every TrackEntry under Tracks and return the subtitle tracks.
async function parseTracks(reader: ChunkReader, dataPos: number, size: number): Promise<SubTrack[]> {
    const tracks: SubTrack[] = [];
    let pos = dataPos;
    const end = dataPos + size;
    while (pos < end) {
        const el = await readElement(reader, pos);
        if (el.id === ID.TrackEntry) {
            let tp = el.dataPos;
            const tEnd = el.dataPos + el.size;
            let number = -1, type = -1, codec = "", lang = "eng", name = "";
            while (tp < tEnd) {
                const f = await readElement(reader, tp);
                const data = await reader.bytes(f.dataPos, f.size);
                if (f.id === ID.TrackNumber) number = readUint(data, 0, f.size);
                else if (f.id === ID.TrackType) type = readUint(data, 0, f.size);
                else if (f.id === ID.CodecID) codec = decoder.decode(data);
                else if (f.id === ID.Language) lang = decoder.decode(data).trim();
                else if (f.id === ID.Name) name = decoder.decode(data);
                tp = f.dataPos + f.size;
            }
            if (type === TRACK_TYPE_SUBTITLE && number >= 0) tracks.push({ number, codec, lang, name });
        }
        pos = el.dataPos + el.size;
    }
    return tracks;
}

async function parseTimestampScale(reader: ChunkReader, dataPos: number, size: number): Promise<number> {
    let pos = dataPos;
    const end = dataPos + size;
    while (pos < end) {
        const el = await readElement(reader, pos);
        if (el.id === ID.TimestampScale) {
            const data = await reader.bytes(el.dataPos, el.size);
            return readUint(data, 0, el.size);
        }
        pos = el.dataPos + el.size;
    }
    return 1_000_000;
}

// Walk one Cluster's children, collecting subtitle blocks for `track`. Returns
// the position just past the cluster (for unknown-size clusters, the offset of
// the next top-level element).
async function parseCluster(reader: ChunkReader, cl: Element, segEnd: number, scaleMs: number, track: SubTrack, out: RawCue[]): Promise<number> {
    let pos = cl.dataPos;
    const end = cl.unknown ? segEnd : cl.dataPos + cl.size;
    let clusterTs = 0;
    while (pos < end) {
        const el = await readElement(reader, pos);
        if (cl.unknown && TOP_LEVEL.has(el.id)) return pos;
        if (el.id === ID.Timestamp) {
            const data = await reader.bytes(el.dataPos, el.size);
            clusterTs = readUint(data, 0, el.size);
        } else if (el.id === ID.SimpleBlock) {
            const data = await reader.bytes(el.dataPos, el.size);
            readBlock(data, 0, el.size, clusterTs, scaleMs, track, undefined, out);
        } else if (el.id === ID.BlockGroup) {
            await parseBlockGroup(reader, el, clusterTs, scaleMs, track, out);
        }
        pos = el.dataPos + el.size;
    }
    return end;
}

// A BlockGroup wraps a Block plus its BlockDuration — the only place a cue end
// time is stored. Read the duration first, then the block.
async function parseBlockGroup(reader: ChunkReader, group: Element, clusterTs: number, scaleMs: number, track: SubTrack, out: RawCue[]): Promise<void> {
    let pos = group.dataPos;
    const end = group.dataPos + group.size;
    let block: Element | undefined;
    let durMs: number | undefined;
    while (pos < end) {
        const el = await readElement(reader, pos);
        if (el.id === ID.Block) block = el;
        else if (el.id === ID.BlockDuration) {
            const data = await reader.bytes(el.dataPos, el.size);
            durMs = readUint(data, 0, el.size);
        }
        pos = el.dataPos + el.size;
    }
    if (block) {
        const data = await reader.bytes(block.dataPos, block.size);
        readBlock(data, 0, block.size, clusterTs, scaleMs, track, durMs, out);
    }
}

// Pick the subtitle track best matching the requested language. Exact language
// tag wins; then any track whose tag contains the request; then the first.
function pickTrack(tracks: SubTrack[], lang: string): SubTrack {
    const want = lang.trim().toLowerCase();
    const score = (t: SubTrack) => {
        const l = t.lang.toLowerCase();
        if (want && l === want) return 3;
        if (want && l.includes(want)) return 2;
        return 1;
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

// Embedded blocks store start + optional duration but no end. Sort by start,
// then bound each cue's end by its duration when known, else by the next cue's
// start (capped) so consecutive lines don't overlap. Default to 5s.
function finalizeCues(raw: RawCue[]): SubtitleCue[] {
    raw.sort((a, b) => a.startMs - b.startMs);
    const cues: SubtitleCue[] = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        let endMs: number;
        if (c.durMs !== undefined && c.durMs > 0) {
            endMs = c.startMs + c.durMs;
        } else {
            const next = raw[i + 1]?.startMs ?? c.startMs + 5000;
            endMs = Math.min(next, c.startMs + 15000);
        }
        if (endMs <= c.startMs) endMs = c.startMs + 2000;
        if (c.text) cues.push({ startMs: c.startMs, endMs, text: c.text });
    }
    return cues;
}

export async function extractMkvSubtitles(
    file: File,
    lang: string,
): Promise<{ cues: SubtitleCue[]; label: string } | undefined> {
    const reader = new ChunkReader(file);
    if (reader.size < 4) return undefined;

    const seg = await readElement(reader, 0);
    // First element is the EBML header; the Segment follows it.
    const top = seg.id === ID.Segment ? seg : await readElement(reader, seg.dataPos + seg.size);
    if (top.id !== ID.Segment) return undefined;

    const segEnd = top.unknown ? reader.size : top.dataPos + top.size;
    let scaleMs = 1; // timestampScale (ns) / 1e6 → ms.
    let track: SubTrack | undefined;
    const raw: RawCue[] = [];

    let pos = top.dataPos;
    while (pos < segEnd) {
        const el = await readElement(reader, pos);
        if (el.id === ID.Info) {
            scaleMs = (await parseTimestampScale(reader, el.dataPos, el.size)) / 1_000_000;
        } else if (el.id === ID.Tracks) {
            const subs = await parseTracks(reader, el.dataPos, el.size);
            if (subs.length === 0) return undefined; // no text tracks — don't scan clusters.
            track = pickTrack(subs, lang);
        } else if (el.id === ID.Cluster) {
            if (!track) return undefined; // Clusters before Tracks: malformed for our purposes.
            pos = await parseCluster(reader, el, segEnd, scaleMs, track, raw);
            continue;
        }
        pos = el.dataPos + el.size;
    }

    if (!track) return undefined;
    const cues = finalizeCues(raw);
    if (!cues.length) return undefined;
    const codecShort = track.codec.replace(/^S_TEXT\//, "") || "sub";
    const label = `embedded ${track.lang}${track.name ? ` (${track.name})` : ""} · ${codecShort}`;
    console.log(`[subtitles] ${cues.length} cues from embedded track #${track.number} (${track.codec})`);
    return { cues, label };
}
