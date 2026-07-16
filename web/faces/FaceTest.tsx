// Face-embedding test page (hidden — reach it via ?page=facetest).
// Workflow:
//   1. Paste (Ctrl/Cmd-V) or drag-and-drop one or more images. The FIRST
//      image sets the baseline — we detect faces, pick the highest-confidence
//      one, and embed it.
//   2. Every later image: detect every face, embed each, compute L2 distance
//      to the baseline.
//   3. All faces are re-sorted by distance to the baseline whenever a new
//      image lands. Each row keeps a thumbnail of the ORIGINAL image it came
//      from plus the aligned 112×112 crop, alongside the distance, so you can
//      eyeball the match.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { RS } from "../restyle/classNames";
import {
    extractFaces, l2Distance, FaceEmbeddingResult, PipelineProgress,
} from "../faceEmbed/index";
import { facesFp16 } from "../appState";
import { buttonDown } from "../styles";

interface FaceEntry {
    id: number;
    sourceImageUrl: string;
    alignedDataUrl: string;
    embedding: Float32Array;
    bbox: { x1: number; y1: number; x2: number; y2: number };
    score: number;
    distanceToBaseline: number;
    embedMs: number;
    detectMs: number;
}

let nextId = 0;

async function offscreenToDataUrl(c: OffscreenCanvas): Promise<string> {
    const blob = await c.convertToBlob({ type: "image/png" });
    return URL.createObjectURL(blob);
}

@observer
export class FaceTest extends preact.Component {
    synced = observable({
        baseline: undefined as FaceEntry | undefined,
        others: [] as FaceEntry[],
        status: "Paste (Ctrl/Cmd-V) or drag-and-drop image(s) — the first image sets the baseline.",
        busy: false,
        dragOver: false,
    });

    componentDidMount() {
        window.addEventListener("paste", this.onPaste);
        window.addEventListener("dragover", this.onDragOver);
        window.addEventListener("dragleave", this.onDragLeave);
        window.addEventListener("drop", this.onDrop);
    }
    componentWillUnmount() {
        window.removeEventListener("paste", this.onPaste);
        window.removeEventListener("dragover", this.onDragOver);
        window.removeEventListener("dragleave", this.onDragLeave);
        window.removeEventListener("drop", this.onDrop);
    }

    private onPaste = async (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind !== "file") continue;
            const f = items[i].getAsFile();
            if (f && f.type.startsWith("image/")) files.push(f);
        }
        if (files.length === 0) return;
        e.preventDefault();
        await this.processFiles(files);
    };

    private onDragOver = (e: DragEvent) => {
        e.preventDefault();
        if (!this.synced.dragOver) runInAction(() => { this.synced.dragOver = true; });
    };
    private onDragLeave = (e: DragEvent) => {
        // Only clear when the cursor actually leaves the window.
        if (e.relatedTarget === null) runInAction(() => { this.synced.dragOver = false; });
    };
    private onDrop = async (e: DragEvent) => {
        e.preventDefault();
        runInAction(() => { this.synced.dragOver = false; });
        const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith("image/"));
        if (files.length === 0) return;
        await this.processFiles(files);
    };

    private setStatus(s: string) {
        runInAction(() => { this.synced.status = s; });
        console.log(`[facetest] ${s}`);
    }

    // Process a batch of dropped/pasted images sequentially (the pipeline is a
    // single shared session, so there's no point running them concurrently).
    private async processFiles(files: File[]) {
        if (this.synced.busy) {
            this.setStatus("Busy — wait for the current image(s) to finish.");
            return;
        }
        runInAction(() => { this.synced.busy = true; });
        try {
            for (let i = 0; i < files.length; i++) {
                if (files.length > 1) this.setStatus(`Image ${i + 1} / ${files.length}...`);
                await this.processOne(files[i]);
            }
        } finally {
            runInAction(() => { this.synced.busy = false; });
        }
    }

    private async processOne(file: File) {
        try {
            this.setStatus("Decoding image...");
            const img = await loadImageFromFile(file);
            const sourceUrl = URL.createObjectURL(file);
            const onProgress = (p: PipelineProgress) => {
                if (p.stage === "model-det" && p.total) {
                    this.setStatus(`Downloading detector model: ${formatMb(p.received ?? 0)} / ${formatMb(p.total)}`);
                } else if (p.stage === "model-rec" && p.total) {
                    this.setStatus(`Downloading recognition model: ${formatMb(p.received ?? 0)} / ${formatMb(p.total)}`);
                } else if (p.stage === "detect") {
                    this.setStatus("Detecting faces...");
                } else if (p.stage === "embed") {
                    this.setStatus(`Embedding ${p.detail} face(s)...`);
                }
            };
            const t0 = performance.now();
            const faces = await extractFaces(img, onProgress, { fp16: facesFp16.get() });
            this.setStatus(`Found ${faces.length} face${faces.length === 1 ? "" : "s"} in ${(performance.now() - t0).toFixed(0)}ms`);

            if (faces.length === 0) return;

            if (!this.synced.baseline) {
                // First image → baseline is its highest-confidence face. Any
                // additional faces in that same image become compared entries.
                const sorted = faces.slice().sort((a, b) => b.score - a.score);
                const baselineEntry = await toEntry(sorted[0], sourceUrl, 0);
                const rest: FaceEntry[] = [];
                for (let i = 1; i < sorted.length; i++) {
                    rest.push(await toEntry(sorted[i], sourceUrl, l2Distance(baselineEntry.embedding, sorted[i].embedding)));
                }
                runInAction(() => {
                    this.synced.baseline = baselineEntry;
                    if (rest.length) this.synced.others = [...this.synced.others, ...rest]
                        .sort((a, b) => a.distanceToBaseline - b.distanceToBaseline);
                });
            } else {
                const baseline = this.synced.baseline;
                const newEntries: FaceEntry[] = [];
                for (const f of faces) {
                    const dist = l2Distance(baseline.embedding, f.embedding);
                    newEntries.push(await toEntry(f, sourceUrl, dist));
                }
                runInAction(() => {
                    this.synced.others = [...this.synced.others, ...newEntries]
                        .sort((a, b) => a.distanceToBaseline - b.distanceToBaseline);
                });
            }
        } catch (err) {
            console.warn(`[facetest] failed:`, err);
            this.setStatus(`Error: ${(err as Error).message ?? String(err)}`);
        }
    }

    private reset = () => {
        runInAction(() => {
            this.synced.baseline = undefined;
            this.synced.others = [];
            this.synced.status = "Cleared. Paste or drag an image to set a new baseline.";
        });
    };

    render() {
        const baseline = this.synced.baseline;
        return <div className={css.minHeight("100vh").hsl(0, 0, 9).color("white").pad2(16, 24).vbox(16)
            + (this.synced.dragOver ? css.boxShadow("inset 0 0 0 3px hsl(140,70%,45%)") : "")}>
            <div className={css.hbox(12).alignCenter}>
                <div className={css.fontSize(18).flexGrow(1)}>Face embedding test</div>
                {baseline ? <button onMouseDown={buttonDown()} onClick={this.reset}
                    className={css.pad2(6, 12).hsl(0, 0, 16).color("white").bord(1, "hsl(0,0,28)").pointer.fontSize(12) + RS.Button}>
                    Reset baseline
                </button> : null}
            </div>
            <div className={css.fontSize(12).hsl(0, 0, 70) + RS.Muted}>
                {this.synced.dragOver ? "Drop to add image(s)..." : this.synced.status}
                {facesFp16.get() ? "  ·  fp16: on" : ""}
            </div>
            {baseline ? <div className={css.vbox(6)}>
                <div className={css.fontSize(13)}>Baseline</div>
                <FaceCard entry={baseline} />
            </div> : null}
            {this.synced.others.length > 0 && <div className={css.vbox(6)}>
                <div className={css.fontSize(13)}>Faces sorted by distance to baseline ({this.synced.others.length})</div>
                <div className={css.display("flex").flexWrap("wrap").columnGap(8).rowGap(8)}>
                    {this.synced.others.map(e => <FaceCard key={e.id} entry={e} />)}
                </div>
            </div>}
        </div>;
    }
}

function FaceCard(props: { entry: FaceEntry }) {
    const e = props.entry;
    return <div className={css.vbox(4).pad2(6, 8).hsl(0, 0, 14).color("white").width(132) + RS.Card}>
        <div className={css.fontSize(10).hsl(0, 0, 55) + RS.Muted}>source</div>
        <img src={e.sourceImageUrl} style={{ width: 116, height: 78, objectFit: "contain", background: "#000", display: "block" }} />
        <div className={css.fontSize(10).hsl(0, 0, 55) + RS.Muted}>aligned face</div>
        <img src={e.alignedDataUrl} style={{ width: 112, height: 112, display: "block" }} />
        <div className={css.fontSize(11)}>dist: <b>{e.distanceToBaseline.toFixed(4)}</b></div>
        <div className={css.fontSize(11).hsl(0, 0, 75) + RS.Muted}>score: {e.score.toFixed(3)}</div>
        <div className={css.fontSize(11).hsl(0, 0, 55) + RS.Muted}
            title="ArcFace embedding time (align + inference), amortized per face">
            embed: {e.embedMs.toFixed(1)}ms · detect: {e.detectMs.toFixed(1)}ms
        </div>
    </div>;
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = e => reject(new Error(`Image load failed: ${(e as ErrorEvent).message ?? "unknown"}`));
        img.src = URL.createObjectURL(file);
    });
}

async function toEntry(f: FaceEmbeddingResult, sourceUrl: string, dist: number): Promise<FaceEntry> {
    return {
        id: ++nextId,
        sourceImageUrl: sourceUrl,
        alignedDataUrl: await offscreenToDataUrl(f.alignedCrop),
        embedding: f.embedding,
        bbox: f.bbox,
        score: f.score,
        distanceToBaseline: dist,
        embedMs: f.embedMs,
        detectMs: f.detectMs,
    };
}

function formatMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
