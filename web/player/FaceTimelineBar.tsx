// The face-timeline overlay drawn on top of the player trackbar. Reads the
// file's merged faces and the URL-backed config (gap fill + row count), packs
// every face into overlapping rows (see faceTimeline.ts), and renders the top
// rows as coloured bars. Bars are click-through to the trackbar underneath
// (they never stopPropagation) so scrubbing still works; hovering a bar reveals
// whose face it is via a floating avatar.

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { getMergedFacesSync } from "../faces/faceScenes";
import { getFaceTimelineSync, TimelineGroup } from "../faces/faceTimeline";
import { faceTimelineGapSec, faceTimelineRows } from "../router";
import { FaceAvatar } from "../faces/FaceAvatar";

// Number of timeline rows that will actually be drawn for this file given the
// current config — min of the configured row count and the rows available.
// PlayerOverlay uses the same value to size the trackbar, so the rows fill it.
export function shownTimelineRowCount(fileKey: string, durationSec: number): number {
    if (!(durationSec > 0)) return 0;
    const merged = getMergedFacesSync(fileKey);
    const gapMs = Math.max(0, faceTimelineGapSec.value ?? 15) * 1000;
    const timeline = getFaceTimelineSync(merged, gapMs);
    const want = Math.max(1, Math.floor(faceTimelineRows.value ?? 4));
    return Math.min(want, timeline.rows.length);
}

@observer
export class FaceTimelineBar extends preact.Component<
    { fileKey: string; durationSec: number },
    { hover?: { group: TimelineGroup; leftPct: number } }
> {
    render() {
        const { fileKey, durationSec } = this.props;
        if (!(durationSec > 0)) return null;
        const merged = getMergedFacesSync(fileKey);
        const gapMs = Math.max(0, faceTimelineGapSec.value ?? 15) * 1000;
        const timeline = getFaceTimelineSync(merged, gapMs);
        const want = Math.max(1, Math.floor(faceTimelineRows.value ?? 4));
        const rows = timeline.rows.slice(0, want);
        if (rows.length === 0) return null;

        const durMs = durationSec * 1000;
        const rowPct = 100 / rows.length;
        const hover = this.state.hover;

        return <div className={css.absolute.top(0).left(0).right(0).bottom(0)}>
            {rows.map((row, ri) => row.groups.map(g =>
                g.segments.map((seg, si) => {
                    const l = Math.max(0, Math.min(100, (seg.startMs / durMs) * 100));
                    const r = Math.max(0, Math.min(100, (seg.endMs / durMs) * 100));
                    const w = Math.max(0.4, r - l); // keep lone appearances visible
                    return <div
                        key={`${g.groupId}-${si}`}
                        className={css.absolute.borderRadius(2).pointer}
                        style={{
                            left: `${l}%`,
                            width: `${w}%`,
                            top: `${ri * rowPct}%`,
                            height: `${rowPct}%`,
                            background: `hsla(${g.hue}, 70%, 55%, 0.72)`,
                            outline: "1px solid hsla(0, 0%, 0%, 0.35)",
                        }}
                        onMouseEnter={() => this.setState({ hover: { group: g, leftPct: l } })}
                        onMouseLeave={() => { if (this.state.hover?.group === g) this.setState({ hover: undefined }); }}
                    />;
                }),
            ))}
            {hover && <div
                className={css.absolute.zIndex(30).pointerEvents("none")}
                style={{ left: `${hover.leftPct}%`, bottom: "calc(100% + 6px)" }}
            >
                <FaceAvatar characterKey={hover.group.repCharKey} size={56} highlighted />
            </div>}
        </div>;
    }
}
