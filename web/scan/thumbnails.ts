import { cacheWeak } from "socket-function/src/caching";
import { thumbnails, keyframes, FileRecord } from "../appState";
import { decodeKeyframes2, getKeyframes2BlobUrls } from "./keyframes2";
// Pure image helpers moved to a worker-safe module (no appState) so the
// background scan worker can produce thumbnails/avatars too. Re-exported here
// so existing tab call sites keep importing them from ./thumbnails.
export { FACE_AVATAR_SIZE, cropFaceAvatarJpeg, generateThumbsFromJpeg } from "./imageThumbs";

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

// --- Thumbnail source resolution -------------------------------------------
// User-picked thumbnails take priority over every other thumbnail source
// (accurate-position keyframes, last-played heuristics, auto thumbs). Every
// place that shows a thumbnail for a video or series — grid cells, series
// tiles, rearrange tiles, the tab favicon / og:image — resolves which video's
// thumbnail to show through these helpers so that rule holds everywhere.
// Reactive: reads thumbSource via getSingleFieldSync, so callers in reactive
// contexts re-render when a user picks a thumbnail.

export function videoHasUserThumb(fileKey: string): boolean {
    return thumbnails.getSingleFieldSync(fileKey, "thumbSource") === "user";
}

// Which video's thumbnail represents a series: the first video with a
// user-picked thumbnail, else `preferredKey` (e.g. the last-played video),
// else the first video.
export function resolveSeriesThumbKey(
    videos: readonly { key: string }[],
    preferredKey?: string,
): string | undefined {
    for (const v of videos) {
        if (videoHasUserThumb(v.key)) return v.key;
    }
    return preferredKey ?? videos[0]?.key;
}

// Which video's thumbnail represents a single video (tab favicon, og:image):
// itself if it has a user-picked thumbnail, else a user-picked thumbnail from
// its series (when known), else itself.
export function resolveVideoThumbKey(
    selfKey: string,
    seriesVideos?: readonly { key: string }[],
): string {
    if (videoHasUserThumb(selfKey)) return selfKey;
    if (seriesVideos) {
        for (const v of seriesVideos) {
            if (videoHasUserThumb(v.key)) return v.key;
        }
    }
    return selfKey;
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

// Blob URL of the first preview keyframe AT-OR-AFTER the given media time
// (else the last one). The faces modal uses this to thumbnail a matched video
// with the scene right after the person's first appearance, so the thumb
// likely shows them.
export function getKeyframeAtOrAfterUrlSync(fileKey: string, timeMs: number): string | undefined {
    const bytes = keyframes.getSingleFieldSync(fileKey, "keyframes2");
    const decoded = decodeKeyframes2(bytes);
    if (!bytes || !decoded || !decoded.complete || decoded.times.length === 0) return undefined;
    const urls = getKeyframes2BlobUrls(bytes, decoded.offsets);
    const t = timeMs / 1000;
    for (let j = 0; j < decoded.times.length; j++) {
        if (decoded.times[j] >= t) return urls[j];
    }
    return urls[urls.length - 1];
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
