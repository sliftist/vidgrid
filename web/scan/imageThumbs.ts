// Pure image helpers (createImageBitmap + OffscreenCanvas) with NO appState /
// DOM dependency, so both the tab and the background scan worker can use them.
// scan/thumbnails.ts re-exports these for existing tab call sites.

// Square avatar JPEGs are stored at this edge length (px). Big enough for a
// crisp face strip at 2× DPR, small enough to be a few KB per character.
export const FACE_AVATAR_SIZE = 112;

// Crop a square region centred on the face bbox out of the frame JPEG and
// re-encode it at FACE_AVATAR_SIZE. The bbox is in the frame's own pixel space
// (post letterbox crop).
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
        const b = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.80 });
        return new Uint8Array(await b.arrayBuffer());
    } finally {
        bitmap.close();
    }
}

// One source JPEG → three downscaled JPEGs at 160/320/640 widths.
// Quality 0.85 matches the encoder used during the metadata scan.
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
