import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { files, gridSize } from "../appState";
import { goToPlayer } from "../router";
import { primeAudioContext } from "../player/AudioPlayback";
import { cellPadTitle } from "../styles";
import { getNearestKeyframeUrlSync } from "../scan/thumbnails";
import { FaceAvatar } from "../faces/FaceAvatar";
import { SIZES, isPlainLeftClick, buildPlayerHref } from "./gridShared";

// Search-frames result tile — shown when faceSearch + perFrameSearch
// are both active. The thumbnail is the preview keyframe nearest the
// face's timestamp (we no longer keep a per-frame image collection);
// title shows the timestamp + filename. Click jumps to the player at
// (frameTime − 3s) so the moment is visible rather than jumped past.
function fmtTimeMs(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
}

@observer
export class FrameCell extends preact.Component<{
    fileKey: string;
    fileName: string;
    relativePath: string;
    timeMs: number;
    characterKey: string;
    distance: number;
}> {
    private navigate = () => {
        primeAudioContext();
        const seekSec = Math.max(0, this.props.timeMs / 1000 - 3);
        goToPlayer(this.props.fileKey, seekSec);
    };
    private onCellMouseDown = (e: MouseEvent) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        this.navigate();
    };
    private onCellClick = (e: MouseEvent) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
    };

    render() {
        const { fileKey, fileName, timeMs, characterKey, distance } = this.props;
        const s = SIZES[gridSize.get()];
        const fileW = files.getSingleFieldSync(fileKey, "width");
        const fileH = files.getSingleFieldSync(fileKey, "height");
        const aspect = fileW && fileH && fileH > 0 ? fileW / fileH : 16 / 9;
        const slotH = Math.round(s.slotW / aspect);
        const thumbUrl = getNearestKeyframeUrlSync(fileKey, timeMs);
        const seekSec = Math.max(0, timeMs / 1000 - 3);
        return <div className={css.display("flex").alignItems("start").flexShrink(0)}>
            <a
                data-cell-key={`f:${fileKey}#${timeMs}`}
                href={buildPlayerHref(fileKey, { seekSec })}
                onMouseDown={this.onCellMouseDown}
                onClick={this.onCellClick}
                className={
                    css.relative.size(s.slotW, slotH).flexShrink(0)
                    + css.hsl(0, 0, 5).pointer.overflowHidden
                    + css.textDecoration("none").color("inherit").display("block")
                }
                title={`${fmtTimeMs(timeMs)} · ${fileName} · distance ${distance.toFixed(3)}`}
            >
                {thumbUrl && <img
                    src={thumbUrl}
                    className={css.size(s.slotW, slotH).display("block").objectFit("cover")}
                />}
                <div
                    className={
                        cellPadTitle.absolute.left(0).right(0).bottom(0).ellipsis
                        + css.background("black").opacity(0.6).color("white")
                            .fontSize(s.fontSize).lineHeight("1.2")
                    }
                >
                    <span className={css.color("hsl(50, 80%, 70%)")}>{fmtTimeMs(timeMs)}</span> · {fileName}
                </div>
            </a>
            <FaceAvatar
                characterKey={characterKey}
                size={slotH}
                height={slotH}
                title={`Matched face · distance ${distance.toFixed(3)}`}
            />
        </div>;
    }
}
