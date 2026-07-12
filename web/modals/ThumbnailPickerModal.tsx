// Pick a custom thumbnail for a video by clicking any keyframe from
// the file's KeyframeBundle. Decodes the chosen JPEG, downscales it
// to 160 / 320 / 640 widths (mirrors what extractMetadataAndThumbs
// produces during the initial scan), and writes the three thumbs +
// the new (width, height) onto the FileRecord. The grid cell picks
// up the change on the next mobx tick.
//
// If keyframes haven't been extracted yet for the file, the modal
// surfaces a "Scan keyframes now" button and renders the live
// extraction heartbeat so the user knows it's working.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { modalCloseBtn, primaryBtn, buttonDown } from "../styles";
import { RS } from "../restyle/classNames";
import { files, thumbnails, keyframes as keyframesDb, extractKeyframesForKey } from "../appState";
import { generateThumbsFromJpeg } from "../scan/thumbnails";
import { decodeKeyframes2, getKeyframes2BlobUrls } from "../scan/keyframes2";
import { playSound } from "../sounds";

const pickerKey = observable.box<string | undefined>(undefined);

export function openThumbnailPicker(key: string) {
    playSound("modalOpen");
    runInAction(() => pickerKey.set(key));
}

export function closeThumbnailPicker() {
    playSound("modalClose");
    runInAction(() => pickerKey.set(undefined));
}

@observer
export class ThumbnailPickerModal extends preact.Component {
    synced = observable({
        // Per-file extraction state. Cleared when modal opens for a
        // different file.
        extracting: false,
        extractStatus: "" as string,
        extractError: undefined as string | undefined,
        applying: false,
        appliedIdx: undefined as number | undefined,
    });

    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && pickerKey.get() !== undefined) {
            e.preventDefault();
            closeThumbnailPicker();
        }
    };

    private runKeyframesNow = async (key: string) => {
        runInAction(() => {
            this.synced.extracting = true;
            this.synced.extractStatus = "starting…";
            this.synced.extractError = undefined;
        });
        try {
            await extractKeyframesForKey(key, info => {
                runInAction(() => { this.synced.extractStatus = info.message; });
            });
        } catch (err) {
            runInAction(() => { this.synced.extractError = (err as Error).message ?? String(err); });
        } finally {
            runInAction(() => { this.synced.extracting = false; });
        }
    };

    private pickKeyframe = async (key: string, idx: number, jpeg: Uint8Array) => {
        if (this.synced.applying) return;
        runInAction(() => {
            this.synced.applying = true;
            this.synced.appliedIdx = idx;
        });
        try {
            const thumbs = await generateThumbsFromJpeg(jpeg);
            await thumbnails.write({ key, ...thumbs, thumbSource: "user" });
        } catch (err) {
            console.warn(`[ThumbnailPicker] could not apply keyframe ${idx}:`, err);
        } finally {
            runInAction(() => { this.synced.applying = false; });
        }
    };

    render() {
        const key = pickerKey.get();
        if (!key) return null;

        const name = files.getSingleFieldSync(key, "name");
        const keyframeBytes = keyframesDb.getSingleFieldSync(key, "keyframes2");
        const keyframeData = decodeKeyframes2(keyframeBytes);
        const hasKeyframes = !!keyframeBytes && !!keyframeData && keyframeData.count > 0;

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeThumbnailPicker(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white").pad(18)
                    .maxWidth("90vw").fillWidth.maxHeight("90vh")
                    .vbox(12).bord(1, "hsl(0, 0%, 22%)") + RS.Modal}
            >
                <div className={css.hbox(12).alignCenter.flexShrink0}>
                    <div className={css.fontSize(15).flexGrow(1).ellipsis + RS.ModalTitle} title={name ?? key}>
                        Pick a thumbnail — {name ?? key}
                    </div>
                    <button
                        onMouseDown={buttonDown(() => closeThumbnailPicker())}
                        className={modalCloseBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>

                {/* Scroll the content area, not the whole modal — so the
                  * pinned header above stays visible while the user
                  * scrolls through a long keyframe grid. */}
                <div className={css.overflowY("auto").flexGrow(1).minHeight(0)}>
                    {hasKeyframes ? <KeyframeGrid
                        keyframes={keyframeBytes!}
                        offsets={keyframeData!.offsets}
                        times={keyframeData!.times}
                        onPick={(idx, jpeg) => this.pickKeyframe(key, idx, jpeg)}
                        appliedIdx={this.synced.appliedIdx}
                        applying={this.synced.applying}
                    /> : <NoKeyframes
                        extracting={this.synced.extracting}
                        extractStatus={this.synced.extractStatus}
                        extractError={this.synced.extractError}
                        onScanNow={() => void this.runKeyframesNow(key)}
                    />}
                </div>
            </div>
        </div>;
    }
}

@observer
class NoKeyframes extends preact.Component<{
    extracting: boolean;
    extractStatus: string;
    extractError: string | undefined;
    onScanNow: () => void;
}> {
    render() {
        const { extracting, extractStatus, extractError, onScanNow } = this.props;
        return <div className={css.vbox(10).pad(20).center}>
            <div className={css.fontSize(13).color("hsl(0, 0%, 70%)") + RS.Muted}>
                Keyframes haven't been extracted for this video yet. Run the keyframe scan to populate them, then pick a thumbnail from the grid.
            </div>
            {!extracting && <button
                onMouseDown={buttonDown(onScanNow)}
                className={primaryBtn}
            >
                Scan keyframes now
            </button>}
            {extracting && <div className={css.vbox(6).alignCenter}>
                <div className={css.fontSize(12).color("hsl(220, 60%, 75%)") + RS.Accent}>
                    Extracting keyframes…
                </div>
                <div className={css.fontSize(11).color("hsl(0, 0%, 65%)").ellipsis.maxWidth(420) + RS.Muted}
                    title={extractStatus}>
                    {extractStatus || "decoding…"}
                </div>
            </div>}
            {extractError && <div className={css.fontSize(11).color("hsl(0, 70%, 70%)") + RS.Accent}>
                {extractError}
            </div>}
        </div>;
    }
}

class KeyframeGrid extends preact.Component<{
    keyframes: Uint8Array;
    offsets: readonly number[];
    times: readonly number[];
    onPick: (idx: number, jpeg: Uint8Array) => void;
    appliedIdx: number | undefined;
    applying: boolean;
}> {
    render() {
        const { keyframes, offsets, times, onPick, appliedIdx, applying } = this.props;
        const urls = getKeyframes2BlobUrls(keyframes, offsets);
        return <div className={css.hbox(6, 2).wrap}>
            {urls.map((url, idx) => {
                const isPicked = appliedIdx === idx;
                // Hover cue is a brightness filter, NOT a background-colour
                // change — typesafecss's hslhover sets the `background`
                // shorthand, which clobbers backgroundImage and hides the
                // thumbnail entirely on hover.
                const cellCls = css.relative.size(200, 112).pointer
                    .filter("brightness(1.15)", "hover")
                    .backgroundSize("cover").backgroundPosition("center")
                    .backgroundImage(`url("${url}")`)
                    + (isPicked
                        ? css.bord(2, "hsl(140, 60%, 55%)")
                        : css.bord(1, "hsl(0, 0%, 22%)"))
                    + (applying && !isPicked ? css.opacity(0.5) : css);
                return <div
                    key={url}
                    onMouseDown={(e: MouseEvent) => {
                        e.preventDefault();
                        const slice = keyframes.subarray(offsets[idx], offsets[idx + 1]);
                        onPick(idx, new Uint8Array(slice));
                    }}
                    title={`Frame at ${formatT(times[idx])} — click to use as thumbnail`}
                    className={cellCls}
                >
                    <div className={css.absolute.bottom(4).left(4).pad2(5, 1)
                        .fontSize(10).color("white").pointerEvents("none")
                        .background("hsla(0, 0%, 0%, 0.65)") + RS.Surface}>
                        {formatT(times[idx])}
                    </div>
                </div>;
            })}
        </div>;
    }
}

function formatT(seconds: number | undefined): string {
    if (seconds === undefined) return "?";
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}
