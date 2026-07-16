// keyframes2: one self-describing binary blob per video. The header carries
// the frame count, sample interval, per-frame media times and per-frame byte
// offsets; the concatenated JPEG payload follows. Bundling the index into the
// same value the JPEGs live in means the two can never land out of sync the
// way two separate DB columns could (one column from an old write, the other
// from a new one) — and a single contiguous read is faster than two.
//
// Layout (little-endian):
//   u32        frameCount (n)
//   f64        intervalSec
//   n × f64    times (media-time seconds, one per frame)
//   (n+1) × u32 offsets into the data section (offsets[0]=0, offsets[n]=dataLen)
//   ...          JPEG payload (the "data section")

const HEADER_FIXED = 4 + 8; // frameCount + intervalSec

function headerBytes(frameCount: number): number {
    return HEADER_FIXED + frameCount * 8 + (frameCount + 1) * 4;
}

export function encodeKeyframes2(parts: {
    data: Uint8Array;
    // Offsets into `data`; length frameCount + 1, last entry = data.byteLength.
    offsets: readonly number[];
    // Media-time of each frame in seconds; length frameCount.
    times: readonly number[];
    intervalSec: number;
}): Uint8Array {
    const n = parts.times.length;
    const dataStart = headerBytes(n);
    const out = new Uint8Array(dataStart + parts.data.byteLength);
    const view = new DataView(out.buffer);
    let p = 0;
    view.setUint32(p, n, true); p += 4;
    view.setFloat64(p, parts.intervalSec, true); p += 8;
    for (let i = 0; i < n; i++) { view.setFloat64(p, parts.times[i], true); p += 8; }
    for (let i = 0; i <= n; i++) { view.setUint32(p, parts.offsets[i] ?? 0, true); p += 4; }
    out.set(parts.data, dataStart);
    return out;
}

export interface DecodedKeyframes2 {
    count: number;
    intervalSec: number;
    times: number[];
    // Absolute byte offsets into the keyframes2 buffer (the data-section start
    // is already folded in), so frame i is bytes[offsets[i] .. offsets[i+1]).
    // Length = count + 1.
    offsets: number[];
    // True when every byte the offset table claims is actually present. A
    // write interrupted mid-flush leaves the buffer short of the final offset,
    // so the trailing frame(s) would decode to garbage — callers suppress the
    // preview when this is false.
    complete: boolean;
}

export function decodeKeyframes2(bytes: Uint8Array | undefined): DecodedKeyframes2 | undefined {
    if (!bytes || bytes.byteLength < HEADER_FIXED) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = view.getUint32(0, true);
    if (n <= 0) return undefined;
    const dataStart = headerBytes(n);
    if (bytes.byteLength < dataStart) return undefined;
    const intervalSec = view.getFloat64(4, true);
    const times: number[] = [];
    let p = HEADER_FIXED;
    for (let i = 0; i < n; i++) { times.push(view.getFloat64(p, true)); p += 8; }
    const offsets: number[] = [];
    for (let i = 0; i <= n; i++) { offsets.push(dataStart + view.getUint32(p, true)); p += 4; }
    const complete = bytes.byteLength >= offsets[n];
    return { count: n, intervalSec, times, offsets, complete };
}

// One blob URL per frame, cached by the bytes object so a column rewrite (new
// bytes reference) naturally invalidates the strip and the FinalizationRegistry
// revokes the stale URLs once the old bytes are GC'd. `offsets` are the
// absolute offsets from decodeKeyframes2.
const keyframe2UrlsByBytes = new WeakMap<Uint8Array, string[]>();
const keyframe2Revoke = new FinalizationRegistry<string[]>(urls => {
    for (const u of urls) URL.revokeObjectURL(u);
});

export function getKeyframes2BlobUrls(bytes: Uint8Array, offsets: readonly number[]): string[] {
    let urls = keyframe2UrlsByBytes.get(bytes);
    if (urls) return urls;
    const built: string[] = [];
    for (let i = 0; i + 1 < offsets.length; i++) {
        const slice = bytes.subarray(offsets[i], offsets[i + 1]);
        built.push(URL.createObjectURL(new Blob([slice], { type: "image/jpeg" })));
    }
    keyframe2UrlsByBytes.set(bytes, built);
    keyframe2Revoke.register(bytes, built);
    return built;
}
