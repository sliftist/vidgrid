// Drives the browser tab favicon while the player page is mounted.
//
// If the current video has a user-picked thumbnail (thumbSource === "user"),
// the stored JPEG is used directly. Otherwise a small snapshot of the current
// playback frame is captured from the active canvas/video element on an
// interval and used as the favicon — so the tab icon tracks along with the
// video.
//
// The originally-present favicon (whatever `index.html` shipped with) is
// restored on detach.

import { reaction, IReactionDisposer } from "mobx";
import { thumbnails } from "../appState";
import { currentVideo } from "../router";

// How often to resample the current playback frame. Once a minute is enough
// for the tab-icon use case; focus/blur events do an extra refresh on top so
// switching to the tab always shows a current frame.
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
                    this.applyBytes(bytes, "image/jpeg");
                } else if (!bytes) {
                    this.lastUserBytes = undefined;
                }
            },
            { fireImmediately: true },
        );
        this.timer = window.setInterval(() => { void this.tick(); }, REFRESH_MS);
        window.addEventListener("focus", this.onFocusChange);
        window.addEventListener("blur", this.onFocusChange);
        void this.tick();
    }

    detach(): void {
        if (this.timer !== undefined) window.clearInterval(this.timer);
        this.timer = undefined;
        window.removeEventListener("focus", this.onFocusChange);
        window.removeEventListener("blur", this.onFocusChange);
        if (this.reactionDisposer) this.reactionDisposer();
        this.reactionDisposer = undefined;
        if (this.originalHref !== undefined) {
            this.installLink(this.originalHref ?? "", this.originalType ?? "");
        } else {
            this.removeAllIconLinks();
        }
        this.linkEl = undefined;
        this.lastUserBytes = undefined;
    }

    private onFocusChange = (): void => { void this.tick(); };

    private async tick(): Promise<void> {
        if (this.inFlight) return;
        const key = currentVideo.value;
        if (!key) return;
        // A user pick is applied by the reaction; the interval only drives the
        // "live snapshot" case.
        const src = thumbnails.getSingleFieldSync(key, "thumbSource");
        if (src === "user") return;
        this.inFlight = true;
        try {
            await this.captureFromSource();
        } finally {
            this.inFlight = false;
        }
    }

    private async captureFromSource(): Promise<void> {
        const source = this.getSource();
        if (!source) return;
        // createImageBitmap works uniformly across 2D canvas, WebGPU canvas,
        // and <video> and avoids the "read a black frame off a just-presented
        // WebGPU swap chain" hazard of drawImage-on-source.
        let bitmap: ImageBitmap;
        try {
            bitmap = await createImageBitmap(source);
        } catch (err) {
            console.warn("[favicon] createImageBitmap failed:", err);
            return;
        }
        try {
            if (!bitmap.width || !bitmap.height) return;
            const dataUrl = this.bitmapToDataUrl(bitmap);
            if (dataUrl) this.applyDataUrl(dataUrl, "image/png");
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

    // Data URLs, not blob URLs — Chrome in particular will silently render a
    // transparent favicon for a `blob:` href even when the blob is a valid
    // PNG. `data:` URLs are inline and unambiguous, so the browser has no
    // reason to skip them.
    private applyDataUrl(dataUrl: string, mime: string): void {
        this.linkEl = this.installLink(dataUrl, mime);
    }

    private removeAllIconLinks(): void {
        // `rel` on <link> is a token list, so an entry like `rel="shortcut icon"`
        // matches `~="icon"` even though a plain `[rel="icon"]` selector wouldn't
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
