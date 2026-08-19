// Renders a bitmap (VobSub) subtitle cue over the video.
//
// Unlike text cues, a bitmap cue carries its own position: the SPU packet
// specifies a rectangle inside a fixed subtitle plane (720x480 for NTSC DVD,
// 720x576 for PAL). That plane is meant to be stretched onto the whole video
// frame, so the cue lands wherever the authoring tool put it — we must not
// re-center it or lift it above the transport bar the way we do for text.
//
// Alignment trick: the <video>/<canvas> under us fill this region with
// `object-fit: contain`, so their displayed rect depends on the media's aspect
// ratio. Rather than measure that rect, we give our canvas the SAME intrinsic
// aspect ratio as the video and let `object-fit: contain` place it identically.
// The subtitle plane is stretched (non-uniformly, which is correct for DVD)
// into that canvas, so no layout measurement is needed and resizes are free.
//
// Cues are decoded lazily here rather than at extraction time: one full-frame
// cue is ~1.4 MB of RGBA, so a feature film's worth would cost gigabytes. Only
// the cue on screen is ever decoded, and only when it changes.

import * as preact from "preact";
import { css } from "typesafecss";
import { SubtitleCue, SubtitleTrack } from "./subtitles";
import { decodeSpuBitmap } from "./vobsub";

type Props = {
    cue: SubtitleCue;
    bitmap: NonNullable<SubtitleTrack["bitmap"]>;
    // Coded video size, when the engine knows it. Only the ratio matters.
    videoWidth: number | undefined;
    videoHeight: number | undefined;
};

// Cap the backing canvas so a 4K video doesn't allocate a 4K surface to hold
// what is at most a 720-wide bitmap. The plane is upscaled by the browser
// either way; this only sets how much of that upscale we bake in.
const MAX_CANVAS_WIDTH = 1280;

export class SubtitleBitmapOverlay extends preact.Component<Props> {
    private canvas: HTMLCanvasElement | null = null;
    // What's currently painted, so a re-render caused by the clock ticking
    // doesn't re-decode the same cue every frame.
    private paintedCue: SubtitleCue | undefined;
    private paintedSize: string | undefined;

    private draw() {
        const canvas = this.canvas;
        if (!canvas) return;
        const { cue, bitmap, videoWidth, videoHeight } = this.props;
        if (!cue.spu) return;

        // Match the video's aspect ratio so `object-fit: contain` lands us on
        // exactly the video's rect; fall back to the subtitle plane's own shape
        // when the engine hasn't reported a size yet.
        const aspect = videoWidth && videoHeight
            ? videoWidth / videoHeight
            : bitmap.width / bitmap.height;
        const w = Math.min(MAX_CANVAS_WIDTH, Math.max(bitmap.width, videoWidth ?? 0)) || bitmap.width;
        const h = Math.max(1, Math.round(w / aspect));

        const sizeKey = `${w}x${h}`;
        if (this.paintedCue === cue && this.paintedSize === sizeKey) return;
        this.paintedCue = cue;
        this.paintedSize = sizeKey;

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);

        const bmp = decodeSpuBitmap(cue.spu, bitmap.palette);
        if (!bmp) {
            // Silence here would look identical to "no subtitle at this time",
            // which is the hard part of diagnosing a blank overlay.
            console.warn(`[subtitles] cue at ${cue.startMs}ms did not decode `
                + `(${cue.spu.length} byte SPU) — nothing to draw`);
            return;
        }

        // Blit the decoded rect at native size, then scale it into place. We go
        // via a second canvas because putImageData ignores transforms.
        const src = document.createElement("canvas");
        src.width = bmp.width;
        src.height = bmp.height;
        const srcCtx = src.getContext("2d");
        if (!srcCtx) return;
        srcCtx.putImageData(new ImageData(bmp.rgba, bmp.width, bmp.height), 0, 0);

        const sx = w / bitmap.width;
        const sy = h / bitmap.height;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(src, bmp.x * sx, bmp.y * sy, bmp.width * sx, bmp.height * sy);
    }

    componentDidMount() { this.draw(); }
    componentDidUpdate() { this.draw(); }

    render() {
        return <canvas
            ref={c => { this.canvas = c; this.draw(); }}
            className={css.absolute.left(0).top(0).right(0).bottom(0).fillBoth
                .zIndex(15).pointerEvents("none").objectFit("contain")}
        />;
    }
}
