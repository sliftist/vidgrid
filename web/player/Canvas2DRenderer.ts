// 2D-canvas fallback for environments without WebGPU (e.g. Amazon Silk on a
// Fire TV). A decoded VideoFrame is a CanvasImageSource, so we can paint it
// straight to a 2D context with drawImage — no GPU pipeline needed. Slower
// than the WebGPU path, but works anywhere WebCodecs decoding does.
export class Canvas2DRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | undefined;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    async init(): Promise<void> {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to get 2D canvas context");
        this.ctx = ctx;
    }

    render(frame: VideoFrame): void {
        // Match the backing store to the frame's display size on the first
        // draw; subsequent draws assume the same dimensions.
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }
        // drawImage understands VideoFrame as of recent browsers; the lib DOM
        // types don't list it as a CanvasImageSource yet, hence the cast.
        this.ctx!.drawImage(frame as any, 0, 0, frame.displayWidth, frame.displayHeight);
    }

    destroy(): void {
        // Nothing to release for a 2D context.
    }
}
