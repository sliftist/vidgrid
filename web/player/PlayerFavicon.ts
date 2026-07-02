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
// for the tab-icon use case (the user asked for this cadence explicitly);
// focus/blur events do an extra refresh on top so switching to the tab
// always shows a current frame.
const REFRESH_MS = 60_000;
// Rendered size of the generated favicon (px). 64 is crisp on 2× DPR title
// bars and small enough that the PNG payload is tiny.
const FAVICON_SIZE = 64;

type SourceGetter = () => HTMLCanvasElement | HTMLVideoElement | null | undefined;

export class PlayerFavicon {
    private linkEl: HTMLLinkElement | undefined;
    // What the favicon href was before we touched it. undefined = there was no
    // <link rel="icon"> in the document at attach time; we remove any element
    // we created on detach instead of leaving a stale href behind.
    private originalHref: string | null | undefined;
    private currentBlobUrl: string | undefined;
    private timer: number | undefined;
    private reactionDisposer: IReactionDisposer | undefined;
    private inFlight = false;
    // Tracks the bytes reference of the last user-picked thumbnail we applied,
    // so we don't rebuild the blob URL when nothing changed.
    private lastUserBytes: Uint8Array | undefined;
    private readonly getSource: SourceGetter;

    constructor(getSource: SourceGetter) {
        this.getSource = getSource;
    }

    attach(): void {
        const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (existing) {
            this.originalHref = existing.getAttribute("href");
        } else {
            this.originalHref = undefined;
        }
        // Always work on our own <link>. Swapping the element (via
        // reinstallLink()) on each update is what makes some browsers pick up
        // the favicon change — they cache by node identity, not by href.
        this.linkEl = this.installLink(this.originalHref ?? "");
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
        // If the page shipped with a favicon, restore it on the current node so
        // the user sees the shipped icon again. If it didn't, drop the node.
        if (this.linkEl) {
            if (this.originalHref !== undefined && this.originalHref !== null) {
                this.linkEl.setAttribute("href", this.originalHref);
            } else {
                this.linkEl.remove();
            }
        }
        this.linkEl = undefined;
        this.revokeCurrentBlobUrl();
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
        // Snapshot the current pixels via createImageBitmap. This works
        // uniformly across 2D canvas, WebGPU canvas, and <video> elements and
        // avoids the "drawImage from a just-presented WebGPU swap chain paints
        // a black frame" foot-gun.
        let bitmap: ImageBitmap;
        try {
            bitmap = await createImageBitmap(source);
        } catch (err) {
            console.warn("[favicon] createImageBitmap failed:", err);
            return;
        }
        try {
            if (!bitmap.width || !bitmap.height) return;
            const dst = document.createElement("canvas");
            dst.width = FAVICON_SIZE;
            dst.height = FAVICON_SIZE;
            const ctx = dst.getContext("2d");
            if (!ctx) return;
            // Center-crop to a square before scaling — a 16:9 frame squashed
            // straight into a 64×64 favicon would be unreadable.
            const side = Math.min(bitmap.width, bitmap.height);
            const cx = (bitmap.width - side) / 2;
            const cy = (bitmap.height - side) / 2;
            ctx.drawImage(bitmap, cx, cy, side, side, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
            const blob = await new Promise<Blob | null>(resolve => dst.toBlob(resolve, "image/png"));
            if (!blob) return;
            this.applyUrl(URL.createObjectURL(blob));
        } finally {
            bitmap.close();
        }
    }

    private applyBytes(bytes: Uint8Array, type: string): void {
        this.applyUrl(URL.createObjectURL(new Blob([bytes], { type })));
    }

    // Swap the <link rel="icon"> element for a fresh one carrying the new
    // href. Just setting `.href` on the existing node doesn't reliably
    // invalidate the cached favicon in Chrome/Firefox — replacing the node
    // does, and it's cheap.
    private installLink(href: string): HTMLLinkElement {
        // Drop any element we (or a prior page) put here so we don't leave a
        // stack of <link rel="icon"> nodes behind.
        for (const el of Array.from(document.querySelectorAll('link[rel="icon"]'))) {
            el.remove();
        }
        const link = document.createElement("link");
        link.rel = "icon";
        if (href) link.setAttribute("href", href);
        document.head.appendChild(link);
        return link;
    }

    private applyUrl(url: string): void {
        // Even if detach() ran between the snapshot and here, throw the URL
        // away rather than leaking the blob.
        if (!this.linkEl || !document.head.contains(this.linkEl)) {
            URL.revokeObjectURL(url);
            return;
        }
        this.linkEl = this.installLink(url);
        this.revokeCurrentBlobUrl();
        this.currentBlobUrl = url;
    }

    private revokeCurrentBlobUrl(): void {
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = undefined;
        }
    }
}
