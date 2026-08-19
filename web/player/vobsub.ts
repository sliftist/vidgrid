// VobSub (DVD "sub-picture") decoding.
//
// Unlike every other subtitle format we handle, VobSub carries no text — each
// cue is a run-length-encoded bitmap plus a small program telling the player
// when to show it, where to put it, and which palette entries to use. So there
// is nothing to parse into a string; the only faithful way to display it is to
// decode the bitmap and draw it over the video.
//
// One cue is an SPU (Sub Picture Unit) laid out as:
//
//     u16 total size
//     u16 offset of the first display-control sequence (DCSQ)
//     [RLE pixel data — two interlaced fields]
//     [DCSQ chain]
//
// Each DCSQ is `u16 delay, u16 offset-of-next` followed by commands until an
// 0xFF terminator. The commands set the palette, the alpha, the display
// rectangle and the per-field RLE offsets, and start/stop the display. Delays
// are relative to the packet's own timestamp, in 1/90000s units scaled by 1024.
//
// The palette itself lives outside the SPU, in the container: Matroska keeps
// the `.idx` header text in CodecPrivate (RGB hex), MP4 keeps 16 YUV quads in
// the sample entry's `esds` descriptor. Both are normalised to RGB here.

// A 16-entry palette of 0xRRGGBB values. Colours are referenced indirectly:
// the SPU picks 4 of these 16 per cue.
export type VobsubPalette = Uint32Array;

export type SpuBitmap = {
    // Placement within the subtitle coordinate space (`size:` in the .idx,
    // typically 720x480 or 720x576) — not the video's pixel size.
    x: number;
    y: number;
    width: number;
    height: number;
    rgba: Uint8ClampedArray; // width * height * 4
};

// Display timing, relative to the cue's own timestamp.
export type SpuTiming = { showDelayMs: number; hideDelayMs: number | undefined };

// The DCSQ command set. CHG_COLCON (0x07) is a rare per-line palette override
// we skip: it only refines colours, so ignoring it still yields a correct
// silhouette rather than a decode failure.
const CMD_FORCE_START = 0x00;
const CMD_START = 0x01;
const CMD_STOP = 0x02;
const CMD_SET_COLOR = 0x03;
const CMD_SET_ALPHA = 0x04;
const CMD_SET_AREA = 0x05;
const CMD_SET_OFFSETS = 0x06;
const CMD_CHG_COLCON = 0x07;
const CMD_END = 0xff;

type SpuControl = {
    showDelayMs: number;
    hideDelayMs: number | undefined;
    // Palette indices and alpha for pixel values 3,2,1,0 (index 0 first here).
    colors: number[];
    alpha: number[];
    x1: number; x2: number; y1: number; y2: number;
    topOffset: number;
    botOffset: number;
};

const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];

// Delay units are 1024/90000 s. Rounding to whole ms is well inside the
// precision anyone can perceive on a subtitle.
const delayToMs = (d: number) => Math.round((d * 1024 * 1000) / 90000);

// Walk the DCSQ chain and fold every command into a single display state.
// Real-world SPUs occasionally chain several sequences to fade or reposition;
// we take the first "start" as the show time and the first "stop" as the hide
// time, which is what the overwhelming majority of discs actually encode.
function parseControl(data: Uint8Array): SpuControl | undefined {
    if (data.length < 4) return undefined;
    const size = be16(data, 0);
    // Trust the smaller of the declared size and what we actually hold, so a
    // truncated packet degrades instead of reading past the end.
    const end = Math.min(size > 0 ? size : data.length, data.length);
    let pos = be16(data, 2);
    if (pos < 4 || pos >= end) return undefined;

    const ctl: SpuControl = {
        showDelayMs: 0,
        hideDelayMs: undefined,
        colors: [0, 1, 2, 3],
        alpha: [0, 15, 15, 15],
        x1: 0, x2: 0, y1: 0, y2: 0,
        topOffset: -1,
        botOffset: -1,
    };
    let sawStart = false;
    let sawArea = false;
    let guard = 0;

    while (pos + 4 <= end && guard++ < 64) {
        const delay = be16(data, pos);
        const next = be16(data, pos + 2);
        let p = pos + 4;

        while (p < end) {
            const cmd = data[p++];
            if (cmd === CMD_END) break;
            if (cmd === CMD_FORCE_START || cmd === CMD_START) {
                if (!sawStart) {
                    ctl.showDelayMs = delayToMs(delay);
                    sawStart = true;
                }
            } else if (cmd === CMD_STOP) {
                if (ctl.hideDelayMs === undefined) ctl.hideDelayMs = delayToMs(delay);
            } else if (cmd === CMD_SET_COLOR) {
                if (p + 2 > end) break;
                // Two bytes, four nibbles: pixel values 3,2,1,0 in that order.
                ctl.colors = [data[p + 1] & 0x0f, data[p + 1] >> 4, data[p] & 0x0f, data[p] >> 4];
                p += 2;
            } else if (cmd === CMD_SET_ALPHA) {
                if (p + 2 > end) break;
                ctl.alpha = [data[p + 1] & 0x0f, data[p + 1] >> 4, data[p] & 0x0f, data[p] >> 4];
                p += 2;
            } else if (cmd === CMD_SET_AREA) {
                if (p + 6 > end) break;
                ctl.x1 = (data[p] << 4) | (data[p + 1] >> 4);
                ctl.x2 = ((data[p + 1] & 0x0f) << 8) | data[p + 2];
                ctl.y1 = (data[p + 3] << 4) | (data[p + 4] >> 4);
                ctl.y2 = ((data[p + 4] & 0x0f) << 8) | data[p + 5];
                sawArea = true;
                p += 6;
            } else if (cmd === CMD_SET_OFFSETS) {
                if (p + 4 > end) break;
                ctl.topOffset = be16(data, p);
                ctl.botOffset = be16(data, p + 2);
                p += 4;
            } else if (cmd === CMD_CHG_COLCON) {
                if (p + 2 > end) break;
                p += be16(data, p); // length-prefixed, and it includes itself
            } else {
                // Unknown command: the rest of this sequence is unparseable
                // (commands are variable-length, so we can't skip safely).
                break;
            }
        }

        if (next === pos || next < 4 || next >= end) break;
        pos = next;
    }

    if (!sawArea || ctl.topOffset < 0) return undefined;
    if (ctl.x2 < ctl.x1 || ctl.y2 < ctl.y1) return undefined;
    return ctl;
}

// Timing only — skips the (comparatively expensive) RLE pass. Used at
// extraction time so cue times are known without holding a decoded bitmap for
// every cue in the file.
export function spuTiming(data: Uint8Array): SpuTiming | undefined {
    const ctl = parseControl(data);
    if (!ctl) return undefined;
    return { showDelayMs: ctl.showDelayMs, hideDelayMs: ctl.hideDelayMs };
}

// Nibble reader over the RLE region.
class NibbleReader {
    private hi = true;
    constructor(private buf: Uint8Array, private pos: number, private end: number) {}
    next(): number {
        if (this.pos >= this.end) return 0;
        const b = this.buf[this.pos];
        if (this.hi) {
            this.hi = false;
            return b >> 4;
        }
        this.hi = true;
        this.pos++;
        return b & 0x0f;
    }
    // Each scanline's data ends padded to a byte boundary.
    alignByte(): void {
        if (!this.hi) {
            this.hi = true;
            this.pos++;
        }
    }
    done(): boolean {
        return this.pos >= this.end;
    }
}

// One RLE run is 4, 8, 12 or 16 bits: nibbles are accumulated until the value
// clears the threshold for its length. The low 2 bits are the pixel value and
// the rest is the run length; a length of 0 means "to the end of this line".
function decodeField(
    reader: NibbleReader,
    out: Uint8Array,
    width: number,
    height: number,
    startRow: number,
): void {
    for (let row = startRow; row < height; row += 2) {
        let x = 0;
        while (x < width) {
            if (reader.done()) return;
            let v = reader.next();
            if (v < 0x4) {
                v = (v << 4) | reader.next();
                if (v < 0x10) {
                    v = (v << 4) | reader.next();
                    if (v < 0x40) {
                        v = (v << 4) | reader.next();
                    }
                }
            }
            let run = v >> 2;
            const color = v & 0x03;
            if (run === 0 || x + run > width) run = width - x;
            out.fill(color, row * width + x, row * width + x + run);
            x += run;
        }
        reader.alignByte();
    }
}

// Decode an SPU into RGBA pixels ready for putImageData / createImageBitmap.
// Returns undefined when the packet is malformed or the cue is fully
// transparent (a real occurrence — discs use empty SPUs to clear the screen).
export function decodeSpuBitmap(data: Uint8Array, palette: VobsubPalette): SpuBitmap | undefined {
    const ctl = parseControl(data);
    if (!ctl) return undefined;

    const width = ctl.x2 - ctl.x1 + 1;
    const height = ctl.y2 - ctl.y1 + 1;
    // Guard against absurd rectangles from a corrupt packet.
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return undefined;

    const size = be16(data, 0);
    const end = Math.min(size > 0 ? size : data.length, data.length);
    const idx = new Uint8Array(width * height);

    decodeField(new NibbleReader(data, ctl.topOffset, end), idx, width, height, 0);
    decodeField(new NibbleReader(data, ctl.botOffset, end), idx, width, height, 1);

    // Resolve the 4 active pixel values to RGBA up front, then expand.
    const lut = new Uint32Array(4);
    let anyVisible = false;
    for (let i = 0; i < 4; i++) {
        const a = ctl.alpha[i];
        if (a > 0) anyVisible = true;
        const rgb = palette[ctl.colors[i] & 0x0f] ?? 0;
        // Alpha is 0..15; 15 is fully opaque.
        const alpha8 = a === 0 ? 0 : (a << 4) | a;
        lut[i] = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff) | (alpha8 << 24);
    }
    if (!anyVisible) return undefined;

    const rgba = new Uint8ClampedArray(width * height * 4);
    const view = new Uint32Array(rgba.buffer);
    for (let i = 0; i < idx.length; i++) view[i] = lut[idx[i]];

    return { x: ctl.x1, y: ctl.y1, width, height, rgba };
}

// ---------------------------------------------------------------------------
// Palette sources
// ---------------------------------------------------------------------------

// Matroska stores the `.idx` header text verbatim in CodecPrivate. We want the
// `palette:` line (16 comma-separated RGB hex triples) and, when present, the
// `size:` line giving the subtitle coordinate space.
export function parseIdxHeader(text: string): {
    palette: VobsubPalette;
    width: number | undefined;
    height: number | undefined;
} {
    const palette = defaultPalette();
    let width: number | undefined;
    let height: number | undefined;

    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("palette:")) {
            const parts = t.slice(8).split(",").map(s => s.trim());
            for (let i = 0; i < Math.min(16, parts.length); i++) {
                const v = parseInt(parts[i], 16);
                if (!Number.isNaN(v)) palette[i] = v & 0xffffff;
            }
        } else if (t.startsWith("size:")) {
            const m = t.slice(5).trim().match(/^(\d+)\s*x\s*(\d+)$/i);
            if (m) {
                width = parseInt(m[1], 10);
                height = parseInt(m[2], 10);
            }
        }
    }
    return { palette, width, height };
}

// MP4 stores 16 four-byte entries in the sample entry's DecoderSpecificInfo,
// as (unused, Y, Cb, Cr) rather than RGB.
export function parseYuvPalette(bytes: Uint8Array): VobsubPalette {
    const palette = defaultPalette();
    const n = Math.min(16, Math.floor(bytes.length / 4));
    for (let i = 0; i < n; i++) {
        palette[i] = yuvToRgb(bytes[i * 4 + 1], bytes[i * 4 + 2], bytes[i * 4 + 3]);
    }
    return palette;
}

// BT.601 studio-swing conversion — the colour space DVD sub-pictures are
// authored in.
function yuvToRgb(y: number, cb: number, cr: number): number {
    const yy = 1.164 * (y - 16);
    const u = cb - 128;
    const v = cr - 128;
    const r = clamp8(yy + 1.596 * v);
    const g = clamp8(yy - 0.813 * v - 0.391 * u);
    const b = clamp8(yy + 2.018 * u);
    return (r << 16) | (g << 8) | b;
}

const clamp8 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

// Fallback when a file gives us no palette at all: greyscale ramp, with the
// conventional "0 = background, 1 = outline, 2 = fill" reading still legible.
function defaultPalette(): VobsubPalette {
    const p = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
        const v = Math.round((i / 15) * 255);
        p[i] = (v << 16) | (v << 8) | v;
    }
    p[0] = 0x000000;
    p[1] = 0x000000;
    p[2] = 0xffffff;
    p[3] = 0x808080;
    return p;
}
