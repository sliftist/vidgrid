// Scan-report bundle: per-folder stats from the last file walk, packed
// into ONE binary buffer so the whole report loads as a single record
// read + one linear decode pass (no per-folder rows to join).
//
// Layout (little-endian):
//   u32 magic "VGSR", u32 version,
//   u32 folderCount, then per folder:
//     u32 pathByteLen, utf8 path bytes,
//     f32 timeMs, u32 fileCount, u32 videoCount
//
// Paths are relative to the scan root ("" = the root itself). Only
// direct (non-recursive) counts are stored — the tree view aggregates
// descendants at display time.

export interface FolderScanStat {
    // Relative to the scan root; "" is the root folder itself.
    path: string;
    // Time spent enumerating this folder's own entries.
    timeMs: number;
    // Files iterated directly in this folder (any extension).
    fileCount: number;
    // Videos found directly in this folder.
    videoCount: number;
}

const MAGIC = 0x56475352; // "VGSR"
const VERSION = 1;

export function encodeScanReport(folders: FolderScanStat[]): Uint8Array {
    const enc = new TextEncoder();
    const pathBytes = folders.map(f => enc.encode(f.path));
    let size = 12;
    for (const p of pathBytes) size += 4 + p.byteLength + 12;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let o = 0;
    view.setUint32(o, MAGIC, true); o += 4;
    view.setUint32(o, VERSION, true); o += 4;
    view.setUint32(o, folders.length, true); o += 4;
    for (let i = 0; i < folders.length; i++) {
        const p = pathBytes[i];
        view.setUint32(o, p.byteLength, true); o += 4;
        bytes.set(p, o); o += p.byteLength;
        view.setFloat32(o, folders[i].timeMs, true); o += 4;
        view.setUint32(o, folders[i].fileCount, true); o += 4;
        view.setUint32(o, folders[i].videoCount, true); o += 4;
    }
    return bytes;
}

export function decodeScanReport(bytes: Uint8Array | undefined): FolderScanStat[] | undefined {
    if (!bytes || bytes.byteLength < 12) return undefined;
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dec = new TextDecoder();
        let o = 0;
        if (view.getUint32(o, true) !== MAGIC) return undefined; o += 4;
        if (view.getUint32(o, true) !== VERSION) return undefined; o += 4;
        const count = view.getUint32(o, true); o += 4;
        const out: FolderScanStat[] = [];
        for (let i = 0; i < count; i++) {
            const pathLen = view.getUint32(o, true); o += 4;
            const path = dec.decode(bytes.subarray(o, o + pathLen)); o += pathLen;
            const timeMs = view.getFloat32(o, true); o += 4;
            const fileCount = view.getUint32(o, true); o += 4;
            const videoCount = view.getUint32(o, true); o += 4;
            out.push({ path, timeMs, fileCount, videoCount });
        }
        return out;
    } catch {
        return undefined;
    }
}
