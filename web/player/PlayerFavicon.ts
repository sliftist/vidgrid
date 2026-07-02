// Drives the browser tab presentation while the player page is mounted —
// both the tab favicon (<link rel="icon">) and the Open Graph image
// (<meta property="og:image">, used for share previews of the currently-open
// video).
//
// If the current video has a user-picked thumbnail (thumbSource === "user"),
// the stored JPEGs are used directly (thumb160 for the favicon, thumb640 for
// og:image). Otherwise a snapshot of the current playback frame is captured
// from the active canvas/video element — refreshed on a slow interval, on
// focus/blur, and on any player state / paused transition the page pipes in
// via refresh().
//
// The originally-present favicon / og:image (whatever `index.html` shipped
// with) is restored on detach.

import { observable, runInAction, reaction, IReactionDisposer } from "mobx";
import { thumbnails } from "../appState";
import { currentVideo } from "../router";

// Slow background refresh — enough to feel live-ish over long playback, low
// enough to be free. Focus/blur + play/pause refresh() calls do the real
// work of keeping the images current at meaningful moments.
const REFRESH_MS = 60_000;
// Rendered size of the generated favicon (px). 64 is crisp on 2× DPR title
// bars and small enough that the PNG payload is tiny.
const FAVICON_SIZE = 64;
// Longest side of the generated og:image (px). 640 gives a 640×360 result
// for a 16:9 frame — i.e. 360p — which is plenty for a share preview and
// keeps the base64 data URL comfortably under 100KB at JPEG q=0.85.
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
    // What was there before we touched it. undefined = there was no matching
    // node at attach time; we drop any node we injected on detach in that
    // case instead of leaving a stale value behind.
    private originalFaviconHref: string | null | undefined;
    private originalFaviconType: string | null | undefined;
    private originalOgContent: string | null | undefined;
    private timer: number | undefined;
    private reactionDisposers: IReactionDisposer[] = [];
    private inFlight = false;
    private readonly getSource: SourceGetter;

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

        // Two separate reactions so favicon and og:image each track a stable
        // bytes reference — a change to only one column won't spuriously
        // trigger the other's re-encode.
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
        runInAction(() => {
            this.currentFaviconUrl.set(undefined);
            this.currentOgUrl.set(undefined);
        });
    }

    // Public trigger for the player to fire on state transitions.
    refresh(reason: string): void {
        void this.tick(reason);
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
            const favUrl = this.bitmapToFaviconDataUrl(bitmap);
            if (favUrl) {
                this.applyFaviconDataUrl(favUrl, "image/png");
                console.log(`[favicon] capture(${reason}) — applied ${kind} favicon ${bitmap.width}×${bitmap.height} → ${favUrl.length}B`);
            }
            const ogUrl = this.bitmapToOgDataUrl(bitmap);
            if (ogUrl) {
                this.applyOgDataUrl(ogUrl);
                console.log(`[favicon] capture(${reason}) — applied ${kind} og:image → ${ogUrl.length}B`);
            }
        } finally {
            bitmap.close();
        }
    }

    private bitmapToFaviconDataUrl(bitmap: ImageBitmap): string | undefined {
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

    private bitmapToOgDataUrl(bitmap: ImageBitmap): string | undefined {
        // Preserve aspect; cap the longest side at OG_MAX_SIDE.
        const maxSide = Math.max(bitmap.width, bitmap.height);
        const scale = maxSide > OG_MAX_SIDE ? OG_MAX_SIDE / maxSide : 1;
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const dst = document.createElement("canvas");
        dst.width = w;
        dst.height = h;
        const ctx = dst.getContext("2d");
        if (!ctx) return undefined;
        ctx.drawImage(bitmap, 0, 0, w, h);
        return dst.toDataURL("image/jpeg", 0.85);
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
        // `rel` on <link> is a token list, so `rel="shortcut icon"` matches
        // `~="icon"` even though a plain `[rel="icon"]` selector wouldn't
        // catch it.
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
