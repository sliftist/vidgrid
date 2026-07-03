// Drives the browser tab presentation while the player page is mounted —
// both the tab favicon (<link rel="icon">) and the Open Graph image
// (<meta property="og:image">, used for share previews of the currently-open
// video).
//
// Sourced entirely from stored thumbnails (the `thumbnails` DB). Live-frame
// capture was tried and abandoned: WebGPU swap-chain reads outside a
// compositor window return solid black, and mirroring frames to a 2D canvas
// costs a GPU→CPU read per capture. Stored thumbs always exist and are
// consistent.
//
// Which video's thumbnail to show is decided by resolveVideoThumbKey — the
// shared user-thumbs-beat-everything resolver used by all thumbnail surfaces.

import { reaction, IReactionDisposer } from "mobx";
import { thumbnails, files, seriesMinVideos } from "../appState";
import { currentVideo } from "../router";
import { getSeries, locateInSeries } from "../search/series";
import { resolveVideoThumbKey } from "../scan/thumbnails";

type ThumbField = "thumb160" | "thumb320" | "thumb640";

export class PlayerFavicon {
    private originalFaviconHref: string | null | undefined;
    private originalFaviconType: string | null | undefined;
    private originalOgContent: string | null | undefined;
    private disposers: IReactionDisposer[] = [];

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

        // Favicons render tiny, prefer the smallest stored width; og:image is
        // a share preview, prefer the largest (~360p).
        this.disposers.push(reaction(
            () => this.resolveBytes(["thumb160", "thumb320", "thumb640"]),
            bytes => this.applyFavicon(bytes),
            { fireImmediately: true },
        ));
        this.disposers.push(reaction(
            () => this.resolveBytes(["thumb640", "thumb320", "thumb160"]),
            bytes => this.applyOg(bytes),
            { fireImmediately: true },
        ));
    }

    detach(): void {
        for (const d of this.disposers) d();
        this.disposers = [];
        this.restoreFavicon();
        this.restoreOg();
    }

    // Which video's thumbnail represents the current playback. Runs inside
    // mobx reactions, so getSingleFieldSync / getColumnSync are safe and
    // re-fire on change.
    private resolveThumbKey(): string | undefined {
        const key = currentVideo.value;
        if (!key) return undefined;
        return resolveVideoThumbKey(key, this.currentSeriesVideos(key));
    }

    private currentSeriesVideos(key: string): { key: string }[] | undefined {
        const nameCol = files.getColumnSync("name");
        const pathCol = files.getColumnSync("relativePath");
        if (!nameCol || !pathCol) return undefined;
        const pathByKey = new Map<string, string>();
        for (const { key: k, value } of pathCol) pathByKey.set(k, value);
        const recs: { key: string; name: string; relativePath: string }[] = [];
        for (const { key: k, value: n } of nameCol) {
            const rp = pathByKey.get(k);
            if (rp) recs.push({ key: k, name: n, relativePath: rp });
        }
        const located = locateInSeries(getSeries(recs, seriesMinVideos.get()), key);
        return located?.group.videos;
    }

    private resolveBytes(preferOrder: ThumbField[]): Uint8Array | undefined {
        const key = this.resolveThumbKey();
        if (!key) return undefined;
        for (const w of preferOrder) {
            const bytes = thumbnails.getSingleFieldSync(key, w);
            if (bytes) return bytes;
        }
        return undefined;
    }

    private applyFavicon(bytes: Uint8Array | undefined): void {
        if (!bytes) {
            this.restoreFavicon();
            return;
        }
        console.log(`[favicon] applying thumbnail favicon (${bytes.byteLength}B)`);
        this.installLink(this.bytesToDataUrl(bytes, "image/jpeg"), "image/jpeg");
    }

    private applyOg(bytes: Uint8Array | undefined): void {
        if (!bytes) {
            this.restoreOg();
            return;
        }
        console.log(`[favicon] applying thumbnail og:image (${bytes.byteLength}B)`);
        this.installMeta(this.bytesToDataUrl(bytes, "image/jpeg"));
    }

    private restoreFavicon(): void {
        if (this.originalFaviconHref !== undefined) {
            this.installLink(this.originalFaviconHref ?? "", this.originalFaviconType ?? "");
        } else {
            this.removeAllIconLinks();
        }
    }

    private restoreOg(): void {
        if (this.originalOgContent !== undefined) {
            this.installMeta(this.originalOgContent ?? "");
        } else {
            this.removeAllOgMetas();
        }
    }

    // Chunked base64 encode — `String.fromCharCode.apply(null, bigArray)`
    // can hit the argument-count limit for anything above tens of KB.
    // Data URLs, not blob URLs — Chrome silently renders a transparent
    // favicon for a `blob:` href even when the blob is a valid image.
    private bytesToDataUrl(bytes: Uint8Array, mime: string): string {
        const CHUNK = 0x8000;
        let bin = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
        }
        return `data:${mime};base64,${btoa(bin)}`;
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
    // href. Mutating the existing node's `.href` doesn't reliably invalidate
    // the cached favicon in Chrome/Firefox — replacing the node does.
    private installLink(href: string, mime: string): void {
        this.removeAllIconLinks();
        const link = document.createElement("link");
        link.setAttribute("rel", "icon");
        if (mime) link.setAttribute("type", mime);
        if (href) link.setAttribute("href", href);
        document.head.appendChild(link);
    }

    private installMeta(content: string): void {
        this.removeAllOgMetas();
        const meta = document.createElement("meta");
        meta.setAttribute("property", "og:image");
        if (content) meta.setAttribute("content", content);
        document.head.appendChild(meta);
    }
}
