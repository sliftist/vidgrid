import { cacheWeak } from "socket-function/src/caching";
import { thumbnails, keyframes, FileRecord } from "../appState";
import { decodeKeyframes2, getKeyframes2BlobUrls } from "./keyframes2";

// Square avatar JPEGs are stored at this edge length (px). Big enough for a
// crisp face strip at 2× DPR, small enough to be a few KB per character.
export const FACE_AVATAR_SIZE = 112;

// Crop a square region centred on the face bbox out of the frame JPEG and
// re-encode it at FACE_AVATAR_SIZE. The bbox is in the frame's own pixel
// space (post letterbox crop). Stored once per character so avatars don't
// need a per-frame image collection to crop from at render time.
export async function cropFaceAvatarJpeg(
    frameJpeg: Uint8Array,
    bbox: { x1: number; y1: number; x2: number; y2: number },
): Promise<Uint8Array> {
    const blob = new Blob([frameJpeg], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    try {
        const w = bbox.x2 - bbox.x1;
        const h = bbox.y2 - bbox.y1;
        const side = Math.min(Math.max(w, h, 1), bitmap.width, bitmap.height);
        const cx = (bbox.x1 + bbox.x2) / 2;
        const cy = (bbox.y1 + bbox.y2) / 2;
        const sx = Math.max(0, Math.min(cx - side / 2, bitmap.width - side));
        const sy = Math.max(0, Math.min(cy - side / 2, bitmap.height - side));
        const dim = Math.max(1, Math.min(FACE_AVATAR_SIZE, Math.round(side)));
        const canvas = new OffscreenCanvas(dim, dim);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get 2d context");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, dim, dim);
        const b = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
        return new Uint8Array(await b.arrayBuffer());
    } finally {
        bitmap.close();
    }
}

// One source JPEG → three downscaled JPEGs at 160/320/640 widths.
// Quality 0.85 matches the encoder used during the metadata scan.
// Shared by the thumbnail picker (user-chosen keyframe) and the
// face-extraction thumbnail (most-common character's largest face).
export async function generateThumbsFromJpeg(jpegBytes: Uint8Array): Promise<{
    thumb160: Uint8Array;
    thumb320: Uint8Array;
    thumb640: Uint8Array;
    thumbW: number;
    thumbH: number;
}> {
    const blob = new Blob([jpegBytes], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    try {
        const aspect = bitmap.width > 0 ? bitmap.height / bitmap.width : 9 / 16;
        const widths = [160, 320, 640] as const;
        const out: Record<string, Uint8Array> = {};
        for (const w of widths) {
            const h = Math.max(1, Math.round(w * aspect));
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Could not get 2d context");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, w, h);
            const b = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            out[`thumb${w}`] = new Uint8Array(await b.arrayBuffer());
        }
        return {
            thumb160: out["thumb160"],
            thumb320: out["thumb320"],
            thumb640: out["thumb640"],
            thumbW: bitmap.width,
            thumbH: bitmap.height,
        };
    } finally {
        bitmap.close();
    }
}

export type ThumbWidth = 160 | 320 | 640;
const THUMB_WIDTHS: ThumbWidth[] = [160, 320, 640];

function thumbColumn(width: ThumbWidth): "thumb160" | "thumb320" | "thumb640" {
    if (width === 160) return "thumb160";
    if (width === 320) return "thumb320";
    return "thumb640";
}

// One blob URL per unique bytes object — keyed by the bytes value returned
// from the BulkDatabase. The DB hands out a stable reference for a given
// column value and a new reference when that column is updated, so identical
// bytes → same URL and new bytes → new URL automatically.
//
// The browser's blob URL table pins the underlying blob until you call
// URL.revokeObjectURL — JS GC alone won't free it. So when the bytes object
// gets collected (column was overwritten, no more references), revoke the
// stale URL too.
const urlRevoke = new FinalizationRegistry<string>(url => URL.revokeObjectURL(url));
const blobUrlForBytes = cacheWeak((bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    urlRevoke.register(bytes, url);
    return url;
});

// Pick the smallest stored thumbnail at or above what the grid needs at the
// current DPR. Falls back across stored sizes so a cell with only one width
// available still renders.
export function pickThumbForDisplay(fileKey: string, displayWidth: number): string | undefined {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const needed = displayWidth * dpr;
    let preferred: ThumbWidth;
    if (needed <= 200) preferred = 160;
    else if (needed <= 400) preferred = 320;
    else preferred = 640;
    // Try preferred first, then larger, then smaller — slightly better quality
    // beats slightly smaller storage in most cases.
    const tryOrder: ThumbWidth[] = [preferred];
    for (const w of THUMB_WIDTHS) if (w > preferred) tryOrder.push(w);
    for (const w of THUMB_WIDTHS) if (w < preferred) tryOrder.push(w);
    for (const w of tryOrder) {
        const bytes = thumbnails.getSingleFieldSync(fileKey, thumbColumn(w));
        if (bytes) return blobUrlForBytes(bytes);
    }
    return undefined;
}

export function hasAnyThumbnail(fileKey: string): boolean {
    for (const w of THUMB_WIDTHS) {
        if (thumbnails.getSingleFieldSync(fileKey, thumbColumn(w))) return true;
    }
    return false;
}

// Blob URL of the preview keyframe nearest (at-or-before, else first) the
// given media time. Used by the per-frame face search to show a frame image
// without a dedicated per-frame collection — the scrub keyframes already on
// disk are close enough. Returns undefined when this file has no strip.
export function getNearestKeyframeUrlSync(fileKey: string, timeMs: number): string | undefined {
    const bytes = keyframes.getSingleFieldSync(fileKey, "keyframes2");
    const decoded = decodeKeyframes2(bytes);
    if (!bytes || !decoded || !decoded.complete) return undefined;
    const urls = getKeyframes2BlobUrls(bytes, decoded.offsets);
    let i = findKeyframeAtOrBefore(decoded.times, timeMs / 1000);
    if (i < 0) i = 0;
    return urls[i];
}

// Index of the latest keyframe at-or-before `timeSec`. Returns -1 if no
// frame qualifies (e.g. timeSec is before the first keyframe).
export function findKeyframeAtOrBefore(times: readonly number[], timeSec: number): number {
    let i = -1;
    for (let j = 0; j < times.length; j++) {
        if (times[j] <= timeSec) i = j;
        else break;
    }
    return i;
}

// Formats a duration in seconds as "1h30m" / "45m" / "0m" — the user asked
// specifically for h+m granularity.
export function formatDurationHM(sec: number | undefined): string {
    if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
    return `${m}m`;
}

// Build the full hover tooltip text for a file — used by both the grid cell
// title attr and the player overlay info line.
export function buildFileInfoText(record: Partial<FileRecord> & { key: string }): string {
    const lines: string[] = [];
    if (record.relativePath) lines.push(record.relativePath);
    const dims: string[] = [];
    if (record.size !== undefined) dims.push(`${formatBytes(record.size)}`);
    if (record.durationSec !== undefined) dims.push(formatDurationHM(record.durationSec));
    if (record.width && record.height) dims.push(`${record.width}×${record.height}`);
    if (dims.length) lines.push(dims.join(" · "));
    const codecs: string[] = [];
    if (record.videoCodec) codecs.push(`video ${record.videoCodec}`);
    if (record.audioCodec) codecs.push(`audio ${record.audioCodec}`);
    if (codecs.length) lines.push(codecs.join(" · "));
    // Added + modified on one line so the consumer sees them together; either
    // is independently optional.
    const dateBits: string[] = [];
    if (record.addedAt) dateBits.push(`added: ${new Date(record.addedAt).toLocaleString()}`);
    if (record.fileModifiedAt) dateBits.push(`modified: ${new Date(record.fileModifiedAt).toLocaleString()}`);
    if (dateBits.length) lines.push(dateBits.join(" · "));
    if (record.metadataExtractionMs !== undefined) lines.push(`extracted in ${record.metadataExtractionMs}ms`);
    return lines.join("\n");
}

// Lightweight bytes formatter — the user asked for "{formatNumber(size)}B" so
// we run socket-function/formatNumber against the byte count.
import { formatNumber } from "socket-function/src/formatting/format";
export function formatBytes(size: number | undefined): string {
    if (size === undefined || !Number.isFinite(size) || size < 0) return "";
    return `${formatNumber(size)}B`;
}
