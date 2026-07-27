// The face-timeline overlay drawn on top of the player trackbar. Reads the
// file's merged faces and the URL-backed config (gap fill + row count), packs
// every face into overlapping rows (see faceTimeline.ts), and renders the top
// rows as coloured bars. Bars are click-through to the trackbar underneath
// for scrubbing (left-click); MIDDLE-click on a bar toggles that person in the
// scene selection so scene-only playback and highlights include them. A tiny
// dot on each bar marks every exact time the detector actually placed a face
// (the bar itself is the gap-bridged span between those dots).

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { getMergedFacesSync, getSelectedFaceKeys, selectedGroupsForFile, toggleSelectedFaceKey } from "../faces/faceScenes";
import { getFaceTimelineSync, TimelineGroup } from "../faces/faceTimeline";
import { faceTimelineGapSec, faceTimelineRows } from "../router";
import { FaceAvatar } from "../faces/FaceAvatar";
import { playSound } from "../sounds";

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

        // Selected face groups on this file — drives the blue "selected" outline
        // on their bars, matching the SceneFaceBar avatar highlight.
        const selectedGroups = selectedGroupsForFile(merged, getSelectedFaceKeys());

        const durMs = durationSec * 1000;
        const rowPct = 100 / rows.length;
        const hover = this.state.hover;

        return <div className={css.absolute.top(0).left(0).right(0).bottom(0)}>
            {rows.map((row, ri) => row.groups.map(g => {
                const isSelected = selectedGroups.has(g.groupId);
                const bars = g.segments.map((seg, si) => {
                    const l = Math.max(0, Math.min(100, (seg.startMs / durMs) * 100));
                    const r = Math.max(0, Math.min(100, (seg.endMs / durMs) * 100));
                    const w = Math.max(0.4, r - l); // keep lone appearances visible
                    return <div
                        key={`${g.groupId}-${si}`}
                        className={css.absolute.pointer}
                        style={{
                            left: `${l}%`,
                            width: `${w}%`,
                            top: `${ri * rowPct}%`,
                            height: `${rowPct}%`,
                            background: `hsla(${g.hue}, 70%, 55%, 0.72)`,
                            outline: isSelected
                                ? "2px solid hsl(210, 100%, 62%)"
                                : "1px solid hsla(0, 0%, 0%, 0.35)",
                            outlineOffset: isSelected ? "-2px" : "-1px",
                            zIndex: isSelected ? 2 : 1,
                        }}
                        title={isSelected
                            ? "Middle-click to remove this person from the scene selection"
                            : "Middle-click to add this person to the scene selection"}
                        onMouseEnter={() => this.setState({ hover: { group: g, leftPct: l } })}
                        onMouseLeave={() => { if (this.state.hover?.group === g) this.setState({ hover: undefined }); }}
                        onMouseDown={e => {
                            // Middle-click toggles this person in the scene selection.
                            // Left-click intentionally bubbles so the trackbar seeks.
                            if (e.button === 1) {
                                e.preventDefault();
                                e.stopPropagation();
                                playSound("toggle");
                                toggleSelectedFaceKey(g.repCharKey);
                            }
                        }}
                    />;
                });
                // Per-appearance dots — one tiny mark at every exact detection
                // time for this group, centered vertically in the row so you
                // can see where the detector actually placed faces vs the
                // gap-filled span the bar shows.
                const dots = g.times.map((t, ti) => {
                    const x = (t / durMs) * 100;
                    if (x < 0 || x > 100) return null;
                    return <div
                        key={`d-${g.groupId}-${ti}`}
                        className={css.absolute.pointerEvents("none")}
                        style={{
                            left: `${x}%`,
                            top: `calc(${ri * rowPct + rowPct / 2}% - 2px)`,
                            width: "4px",
                            height: "4px",
                            marginLeft: "-2px",
                            background: `hsl(${g.hue}, 90%, 15%)`,
                            zIndex: 2,
                        }}
                    />;
                });
                return <preact.Fragment key={`g-${g.groupId}`}>{bars}{dots}</preact.Fragment>;
            }))}
            {hover && <div
                className={css.absolute.zIndex(100).pointerEvents("none")
                    .hsl(0, 0, 8).pad(3).bord(1, "hsl(0, 0%, 30%)")}
                style={{ left: `${hover.leftPct}%`, bottom: "calc(100% + 6px)" }}
            >
                <FaceAvatar characterKey={hover.group.repCharKey} size={56} highlighted />
            </div>}
        </div>;
    }
}
