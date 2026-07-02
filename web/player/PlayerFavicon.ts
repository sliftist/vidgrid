// Drives the browser tab favicon while the player page is mounted.
//
// If the current video has a user-picked thumbnail (thumbSource === "user"),
// the stored JPEG is used directly. Otherwise a small snapshot of the current
// playback frame is captured from the active canvas/video element and used
// as the favicon — refreshed on a slow interval and on focus/blur, plus a
// public refresh() the player calls whenever playback state or paused
// changes (play, pause, ended, engine swap) so the icon tracks meaningful
// transitions immediately.
//
// The originally-present favicon (whatever `index.html` shipped with) is
// restored on detach.

import { reaction, IReactionDisposer } from "mobx";
import { thumbnails } from "../appState";
import { currentVideo } from "../router";

// Slow background refresh — enough to feel live-ish over long playback, low
// enough to be free. Focus/blur + play/pause refresh() calls do the real
// work of keeping the icon current at meaningful moments.
const REFRESH_MS = 60_000;
// Rendered size of the generated favicon (px). 64 is crisp on 2× DPR title
// bars and small enough that the PNG payload is tiny.
const FAVICON_SIZE = 64;

type SourceGetter = () => HTMLCanvasElement | HTMLVideoElement | null | undefined;

export class PlayerFavicon {
    private linkEl: HTMLLinkElement | undefined;
    // What the favicon href was before we touched it. undefined = there was no
    // <link rel="icon"> in the document at attach time; we drop our injected
    // node on detach in that case instead of leaving a stale href behind.
    private originalHref: string | null | undefined;
    private originalType: string | null | undefined;
    private timer: number | undefined;
    private reactionDisposer: IReactionDisposer | undefined;
    private inFlight = false;
    // Tracks the bytes reference of the last user-picked thumbnail we applied,
    // so we don't rebuild the data URL when nothing changed.
    private lastUserBytes: Uint8Array | undefined;
    private readonly getSource: SourceGetter;

    constructor(getSource: SourceGetter) {
        this.getSource = getSource;
    }

    attach(): void {
        const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (existing) {
            this.originalHref = existing.getAttribute("href");
            this.originalType = existing.getAttribute("type");
        } else {
            this.originalHref = undefined;
            this.originalType = undefined;
        }
        console.log(`[favicon] attach (originalHref=${this.originalHref ?? "<none>"})`);
        this.reactionDisposer = reaction(
            () => {
                const key = currentVideo.value;
                if (!key) return undefined;
                const src = thumbnails.getSingleFieldSync(key, "thumbSource");
                if (src !== "user") return undefined;
                return thumbnails.getSingleFieldSync(key, "thumb320")
                    ?? thumbnails.getSingleFieldSync(key, "thumb160")
                    ?? thumbnails.getSingleFieldSync(key, "thumb640");
            },
            bytes => {
                if (bytes && bytes !== this.lastUserBytes) {
                    this.lastUserBytes = bytes;
                    console.log(`[favicon] applying user-picked thumbnail (${bytes.byteLength}B)`);
                    this.applyBytes(bytes, "image/jpeg");
                } else if (!bytes) {
                    this.lastUserBytes = undefined;
                }
            },
            { fireImmediately: true },
        );
        this.timer = window.setInterval(() => this.refresh("interval"), REFRESH_MS);
        window.addEventListener("focus", this.onFocus);
        window.addEventListener("blur", this.onBlur);
        this.refresh("attach");
    }

    detach(): void {
        if (this.timer !== undefined) window.clearInterval(this.timer);
        this.timer = undefined;
        window.removeEventListener("focus", this.onFocus);
        window.removeEventListener("blur", this.onBlur);
        if (this.reactionDisposer) this.reactionDisposer();
        this.reactionDisposer = undefined;
        console.log(`[favicon] detach — restoring originalHref=${this.originalHref ?? "<none>"}`);
        if (this.originalHref !== undefined) {
            this.installLink(this.originalHref ?? "", this.originalType ?? "");
        } else {
            this.removeAllIconLinks();
        }
        this.linkEl = undefined;
        this.lastUserBytes = undefined;
    }

    // Public trigger for the player to fire on state transitions.
    refresh(reason: string): void {
        void this.tick(reason);
    }

    private onFocus = (): void => this.refresh("focus");
    private onBlur = (): void => this.refresh("blur");

    private async tick(reason: string): Promise<void> {
        if (this.inFlight) {
            console.log(`[favicon] tick(${reason}) — skip: another snapshot in flight`);
            return;
        }
        const key = currentVideo.value;
        if (!key) {
            console.log(`[favicon] tick(${reason}) — skip: no current video`);
            return;
        }
        const src = thumbnails.getSingleFieldSync(key, "thumbSource");
        if (src === "user") {
            console.log(`[favicon] tick(${reason}) — skip: user-picked thumbnail in use`);
            return;
        }
        this.inFlight = true;
        try {
            await this.captureFromSource(reason);
        } finally {
            this.inFlight = false;
        }
    }

    private async captureFromSource(reason: string): Promise<void> {
        const source = this.getSource();
        if (!source) {
            console.log(`[favicon] capture(${reason}) — skip: no source element yet`);
            return;
        }
        const kind = source instanceof HTMLCanvasElement ? "canvas" : "video";
        const sw = source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
        const sh = source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
        if (!sw || !sh) {
            console.log(`[favicon] capture(${reason}) — skip: source ${kind} has no dimensions (${sw}×${sh})`);
            return;
        }
        // createImageBitmap works uniformly across 2D canvas, WebGPU canvas,
        // and <video> and avoids the "read a black frame off a just-presented
        // WebGPU swap chain" hazard of drawImage-on-source.
        let bitmap: ImageBitmap;
        try {
            bitmap = await createImageBitmap(source);
        } catch (err) {
            console.warn(`[favicon] capture(${reason}) — createImageBitmap threw:`, err);
            return;
        }
        try {
            if (!bitmap.width || !bitmap.height) {
                console.log(`[favicon] capture(${reason}) — skip: bitmap has no dimensions`);
                return;
            }
            const dataUrl = this.bitmapToDataUrl(bitmap);
            if (!dataUrl) {
                console.log(`[favicon] capture(${reason}) — skip: toDataURL returned empty`);
                return;
            }
            this.applyDataUrl(dataUrl, "image/png");
            console.log(`[favicon] capture(${reason}) — applied ${kind} snapshot ${bitmap.width}×${bitmap.height} → ${dataUrl.length}B data URL`);
        } finally {
            bitmap.close();
        }
    }

    private bitmapToDataUrl(bitmap: ImageBitmap): string | undefined {
        const dst = document.createElement("canvas");
        dst.width = FAVICON_SIZE;
        dst.height = FAVICON_SIZE;
        const ctx = dst.getContext("2d");
        if (!ctx) return undefined;
        // Center-crop to a square before scaling — a 16:9 frame squashed
        // straight into a 64×64 favicon would be unreadable.
        const side = Math.min(bitmap.width, bitmap.height);
        const cx = (bitmap.width - side) / 2;
        const cy = (bitmap.height - side) / 2;
        ctx.drawImage(bitmap, cx, cy, side, side, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
        return dst.toDataURL("image/png");
    }

    private applyBytes(bytes: Uint8Array, mime: string): void {
        // Chunked base64 encode — `String.fromCharCode.apply(null, bigArray)`
        // can hit the argument-count limit for anything above tens of KB.
        const CHUNK = 0x8000;
        let bin = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
        }
        this.applyDataUrl(`data:${mime};base64,${btoa(bin)}`, mime);
    }

    // Data URLs, not blob URLs — Chrome will silently render a transparent
    // favicon for a `blob:` href even when the blob is a valid PNG. `data:`
    // URLs are inline and unambiguous, so the browser has no reason to skip
    // them.
    private applyDataUrl(dataUrl: string, mime: string): void {
        this.linkEl = this.installLink(dataUrl, mime);
    }

    private removeAllIconLinks(): void {
        // `rel` on <link> is a token list, so `rel="shortcut icon"` matches
        // `~="icon"` even though a plain `[rel="icon"]` selector wouldn't
        // catch it.
        const nodes = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
        for (const el of Array.from(nodes)) el.remove();
    }

    // Swap the <link rel="icon"> element for a fresh node carrying the new
    // href. Simply mutating the existing node's `.href` doesn't reliably
    // invalidate the cached favicon in Chrome/Firefox — replacing the node
    // does, and it's cheap.
    private installLink(href: string, mime: string): HTMLLinkElement {
        this.removeAllIconLinks();
        const link = document.createElement("link");
        link.setAttribute("rel", "icon");
        if (mime) link.setAttribute("type", mime);
        if (href) link.setAttribute("href", href);
        document.head.appendChild(link);
        return link;
    }
}
