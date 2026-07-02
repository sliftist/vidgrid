// Drives the browser tab presentation while the player page is mounted —
// both the tab favicon (<link rel="icon">) and the Open Graph image
// (<meta property="og:image">, used for share previews of the currently-open
// video).
//
// If the current video has a user-picked thumbnail (thumbSource === "user"),
// the stored JPEGs are used directly (thumb160 for the favicon, thumb640 for
// og:image).
//
// Otherwise the icon tracks the live playback frame. We can't read the
// WebGPU swap chain reliably outside a compositor window — createImageBitmap
// / toDataURL routinely return a solid-color result even while the video is
// visibly playing. So refresh() wraps each capture in a requestAnimationFrame
// (the browser guarantees the source pixels are readable during that window)
// and mirrors the current source into a persistent 2D canvas before reading.
//
// Capture is strictly on-demand — a slow 20s interval, focus/blur, and the
// play/pause/state transitions the page pipes in via refresh(). No
// continuous background sampling: reading a WebGPU canvas costs a GPU→CPU
// texture read, and doing it every frame would slow decode.

import { observable, runInAction, reaction, IReactionDisposer } from "mobx";
import { thumbnails } from "../appState";
import { currentVideo } from "../router";

// Slow background resample of the icon. Focus/blur + play/pause refresh()
// calls do the real work of keeping the images current at meaningful moments;
// this catches long-idle drift.
const REFRESH_MS = 20_000;
// Rendered size of the generated favicon (px). 64 is crisp on 2× DPR title
// bars and small enough that the PNG payload is tiny.
const FAVICON_SIZE = 64;
// Longest side of the shadow / og:image (px). 640 gives 640×360 for a 16:9
// frame — 360p — plenty for a share preview and keeps the base64 data URL
// comfortably under 100KB at JPEG q=0.85.
const OG_MAX_SIDE = 640;

type SourceGetter = () => HTMLCanvasElement | HTMLVideoElement | null | undefined;

export class PlayerFavicon {
    // Latest data URLs we've fed the browser — exposed so the page can render
    // small debug previews and visually distinguish "snapshot pipeline is
    // broken" from "browser rejected the image."
    readonly currentFaviconUrl = observable.box<string | undefined>(undefined);
    readonly currentOgUrl = observable.box<string | undefined>(undefined);

    private linkEl: HTMLLinkElement | undefined;
    private metaEl: HTMLMetaElement | undefined;
    private originalFaviconHref: string | null | undefined;
    private originalFaviconType: string | null | undefined;
    private originalOgContent: string | null | undefined;
    private timer: number | undefined;
    private reactionDisposers: IReactionDisposer[] = [];
    private readonly getSource: SourceGetter;

    // Persistent 2D shadow — populated on demand from inside a RAF window.
    // Kept ≤ OG_MAX_SIDE on its longest side; aspect ratio matches the source.
    private readonly shadow = document.createElement("canvas");
    private readonly shadowCtx = this.shadow.getContext("2d", { willReadFrequently: false });
    private shadowHasContent = false;
    // Debounce refresh() so a burst of state transitions collapses into one
    // RAF-scheduled capture instead of a stack of them.
    private pendingRefreshReason: string | undefined;

    constructor(getSource: SourceGetter) {
        this.getSource = getSource;
    }

    attach(): void {
        const existingLink = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
        if (existingLink) {
            this.originalFaviconHref = existingLink.getAttribute("href");
            this.originalFaviconType = existingLink.getAttribute("type");
        }
        const existingMeta = document.querySelector<HTMLMetaElement>('meta[property="og:image"]');
        if (existingMeta) {
            this.originalOgContent = existingMeta.getAttribute("content");
        }
        console.log(`[favicon] attach (originalFavicon=${this.originalFaviconHref ?? "<none>"}, originalOg=${this.originalOgContent ?? "<none>"})`);

        this.reactionDisposers.push(reaction(
            () => this.readUserBytes(["thumb160", "thumb320", "thumb640"]),
            bytes => {
                if (!bytes) return;
                console.log(`[favicon] applying user-picked thumbnail to favicon (${bytes.byteLength}B)`);
                this.applyBytesAsFavicon(bytes, "image/jpeg");
            },
            { fireImmediately: true },
        ));
        this.reactionDisposers.push(reaction(
            () => this.readUserBytes(["thumb640", "thumb320", "thumb160"]),
            bytes => {
                if (!bytes) return;
                console.log(`[favicon] applying user-picked thumbnail to og:image (${bytes.byteLength}B)`);
                this.applyBytesAsOg(bytes, "image/jpeg");
            },
            { fireImmediately: true },
        ));

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
        this.pendingRefreshReason = undefined;
        for (const d of this.reactionDisposers) d();
        this.reactionDisposers = [];
        console.log(`[favicon] detach — restoring favicon=${this.originalFaviconHref ?? "<none>"}, og=${this.originalOgContent ?? "<none>"}`);
        if (this.originalFaviconHref !== undefined) {
            this.installLink(this.originalFaviconHref ?? "", this.originalFaviconType ?? "");
        } else {
            this.removeAllIconLinks();
        }
        if (this.originalOgContent !== undefined) {
            this.installMeta(this.originalOgContent ?? "");
        } else {
            this.removeAllOgMetas();
        }
        this.linkEl = undefined;
        this.metaEl = undefined;
        this.shadowHasContent = false;
        runInAction(() => {
            this.currentFaviconUrl.set(undefined);
            this.currentOgUrl.set(undefined);
        });
    }

    // Public trigger for the player to fire on state transitions. Debounced
    // and dispatched via requestAnimationFrame so the mirror runs inside the
    // browser's compositor window (the only reliable moment to read a
    // WebGPU canvas).
    refresh(reason: string): void {
        if (this.pendingRefreshReason !== undefined) {
            // Keep the latest reason for the log — the pending RAF still fires.
            this.pendingRefreshReason = reason;
            return;
        }
        this.pendingRefreshReason = reason;
        requestAnimationFrame(() => {
            const r = this.pendingRefreshReason ?? reason;
            this.pendingRefreshReason = undefined;
            this.tickInRaf(r);
        });
    }

    private onFocus = (): void => this.refresh("focus");
    private onBlur = (): void => this.refresh("blur");

    private readUserBytes(preferOrder: ("thumb160" | "thumb320" | "thumb640")[]): Uint8Array | undefined {
        const key = currentVideo.value;
        if (!key) return undefined;
        const src = thumbnails.getSingleFieldSync(key, "thumbSource");
        if (src !== "user") return undefined;
        for (const w of preferOrder) {
            const bytes = thumbnails.getSingleFieldSync(key, w);
            if (bytes) return bytes;
        }
        return undefined;
    }

    // Copy the current source into the shadow at ≤ OG_MAX_SIDE. Returns true
    // if the shadow was updated. Called synchronously — must NEVER await, so
    // the read/write stays inside the RAF window.
    private mirror(): boolean {
        const source = this.getSource();
        if (!source || !this.shadowCtx) return false;
        const sw = source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
        const sh = source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
        if (!sw || !sh) return false;
        const scale = Math.min(1, OG_MAX_SIDE / Math.max(sw, sh));
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));
        if (this.shadow.width !== dw || this.shadow.height !== dh) {
            this.shadow.width = dw;
            this.shadow.height = dh;
        }
        try {
            this.shadowCtx.drawImage(source, 0, 0, dw, dh);
            this.shadowHasContent = true;
            return true;
        } catch (err) {
            console.warn("[favicon] mirror drawImage failed:", err);
            return false;
        }
    }

    // Fires inside the RAF window scheduled by refresh(). Mirror + capture
    // both run here synchronously — no awaits — so the WebGPU read stays in
    // the guaranteed-valid slice of the frame.
    private tickInRaf(reason: string): void {
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
        const gotFresh = this.mirror();
        // If this refresh couldn't get a fresh frame (paused with no live
        // render pass this tick, source empty, canvas tainted, …) but a
        // prior refresh did, we still update from the last-good shadow.
        // If we have nothing at all, skip and the next event will retry.
        if (!gotFresh && !this.shadowHasContent) {
            console.log(`[favicon] tick(${reason}) — skip: no frame available yet`);
            return;
        }
        this.captureFromShadow(reason, gotFresh);
    }

    private captureFromShadow(reason: string, fresh: boolean): void {
        const shadow = this.shadow;
        if (!shadow.width || !shadow.height) return;
        const staleTag = fresh ? "" : " (stale)";

        // Favicon: 64×64 square center-crop from shadow.
        const favCanvas = document.createElement("canvas");
        favCanvas.width = FAVICON_SIZE;
        favCanvas.height = FAVICON_SIZE;
        const favCtx = favCanvas.getContext("2d");
        if (favCtx) {
            const side = Math.min(shadow.width, shadow.height);
            const cx = (shadow.width - side) / 2;
            const cy = (shadow.height - side) / 2;
            favCtx.drawImage(shadow, cx, cy, side, side, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
            const favUrl = favCanvas.toDataURL("image/png");
            this.applyFaviconDataUrl(favUrl, "image/png");
            console.log(`[favicon] capture(${reason})${staleTag} — favicon from ${shadow.width}×${shadow.height} shadow → ${favUrl.length}B`);
        }

        // og:image: the shadow already IS the right size, just JPEG-encode.
        const ogUrl = shadow.toDataURL("image/jpeg", 0.85);
        this.applyOgDataUrl(ogUrl);
        console.log(`[favicon] capture(${reason})${staleTag} — og:image from ${shadow.width}×${shadow.height} shadow → ${ogUrl.length}B`);
    }

    private applyBytesAsFavicon(bytes: Uint8Array, mime: string): void {
        this.applyFaviconDataUrl(this.bytesToDataUrl(bytes, mime), mime);
    }

    private applyBytesAsOg(bytes: Uint8Array, mime: string): void {
        this.applyOgDataUrl(this.bytesToDataUrl(bytes, mime));
    }

    // Chunked base64 encode — `String.fromCharCode.apply(null, bigArray)`
    // can hit the argument-count limit for anything above tens of KB.
    private bytesToDataUrl(bytes: Uint8Array, mime: string): string {
        const CHUNK = 0x8000;
        let bin = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
        }
        return `data:${mime};base64,${btoa(bin)}`;
    }

    // Data URLs, not blob URLs — Chrome will silently render a transparent
    // favicon for a `blob:` href even when the blob is a valid PNG. `data:`
    // URLs are inline and unambiguous, so the browser has no reason to skip
    // them.
    private applyFaviconDataUrl(dataUrl: string, mime: string): void {
        this.linkEl = this.installLink(dataUrl, mime);
        runInAction(() => this.currentFaviconUrl.set(dataUrl));
    }

    private applyOgDataUrl(dataUrl: string): void {
        this.metaEl = this.installMeta(dataUrl);
        runInAction(() => this.currentOgUrl.set(dataUrl));
    }

    private removeAllIconLinks(): void {
        const nodes = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
        for (const el of Array.from(nodes)) el.remove();
    }

    private removeAllOgMetas(): void {
        const nodes = document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"]');
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

    private installMeta(content: string): HTMLMetaElement {
        this.removeAllOgMetas();
        const meta = document.createElement("meta");
        meta.setAttribute("property", "og:image");
        if (content) meta.setAttribute("content", content);
        document.head.appendChild(meta);
        return meta;
    }
}
