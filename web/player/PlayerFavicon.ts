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

// How often to resample the current playback frame. Cheap enough (one small
// drawImage + toBlob) that a 2s cadence keeps the icon feeling live without
// tripping over itself under a busy decode.
const REFRESH_MS = 2000;
// Rendered size of the generated favicon (px). 64 is crisp on 2× DPR title
// bars and small enough that the JPEG/PNG payload is tiny.
const FAVICON_SIZE = 64;

type SourceGetter = () => HTMLCanvasElement | HTMLVideoElement | null | undefined;

export class PlayerFavicon {
    private linkEl: HTMLLinkElement | undefined;
    // What the favicon href was before we touched it. null = there was no
    // <link rel="icon"> in the document, so we should remove our injected one
    // on detach rather than leave a stale href behind.
    private originalHref: string | null = null;
    private ownedLink = false;
    private currentBlobUrl: string | undefined;
    private timer: number | undefined;
    private reactionDisposer: IReactionDisposer | undefined;
    private inFlight = false;
    // Tracks the bytes reference of the last user-picked thumbnail we applied,
    // so we don't rebuild the blob URL on every interval tick when nothing
    // changed.
    private lastUserBytes: Uint8Array | undefined;
    private readonly getSource: SourceGetter;

    constructor(getSource: SourceGetter) {
        this.getSource = getSource;
    }

    attach(): void {
        const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (existing) {
            this.linkEl = existing;
            this.originalHref = existing.getAttribute("href");
            this.ownedLink = false;
        } else {
            const link = document.createElement("link");
            link.rel = "icon";
            document.head.appendChild(link);
            this.linkEl = link;
            this.originalHref = null;
            this.ownedLink = true;
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
        void this.tick();
    }

    detach(): void {
        if (this.timer !== undefined) window.clearInterval(this.timer);
        this.timer = undefined;
        if (this.reactionDisposer) this.reactionDisposer();
        this.reactionDisposer = undefined;
        if (this.linkEl) {
            if (this.ownedLink) {
                this.linkEl.remove();
            } else if (this.originalHref !== null) {
                this.linkEl.setAttribute("href", this.originalHref);
            } else {
                this.linkEl.removeAttribute("href");
            }
        }
        this.linkEl = undefined;
        this.revokeCurrentBlobUrl();
        this.lastUserBytes = undefined;
    }

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
        let sw = 0;
        let sh = 0;
        if (source instanceof HTMLCanvasElement) {
            sw = source.width;
            sh = source.height;
        } else {
            sw = source.videoWidth;
            sh = source.videoHeight;
        }
        if (!sw || !sh) return;

        const dst = document.createElement("canvas");
        dst.width = FAVICON_SIZE;
        dst.height = FAVICON_SIZE;
        const ctx = dst.getContext("2d");
        if (!ctx) return;
        // Center-crop the frame to a square before scaling — a wide 16:9 frame
        // squashed straight into a 64×64 favicon would be unreadable.
        const side = Math.min(sw, sh);
        const cx = (sw - side) / 2;
        const cy = (sh - side) / 2;
        try {
            ctx.drawImage(source, cx, cy, side, side, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
        } catch (err) {
            // WebGPU/tainted-canvas edge cases — skip this tick, next one will retry.
            console.warn("[favicon] snapshot failed:", err);
            return;
        }
        const blob = await new Promise<Blob | null>(resolve => dst.toBlob(resolve, "image/png"));
        if (!blob) return;
        this.applyUrl(URL.createObjectURL(blob));
    }

    private applyBytes(bytes: Uint8Array, type: string): void {
        this.applyUrl(URL.createObjectURL(new Blob([bytes], { type })));
    }

    private applyUrl(url: string): void {
        if (!this.linkEl) {
            URL.revokeObjectURL(url);
            return;
        }
        this.linkEl.setAttribute("href", url);
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
