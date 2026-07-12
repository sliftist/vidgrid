// Player transport rows for the scene selector:
//   1. the currently-selected faces (click one to drop it), and
//   2. the faces in the scene at the current time (click to add / remove).
// Both read the URL-backed selection reactively, so they stay in sync with the
// scenes modal, the trackbar highlights, and scene-only playback.

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { RS } from "../restyle/classNames";
import { FaceAvatar } from "../faces/FaceAvatar";
import { playSound } from "../sounds";
import {
    getScenesForFileSync, currentScene, selectedGroupsForFile,
    getSelectedFaceKeys, toggleSelectedFaceKey, toggleGroupSelection, clearSelectedFaces,
    MergedGroup,
} from "../faces/faceScenes";
import { openScenesModal } from "../modals/ScenesModal";

function badge(text: string, on: boolean): preact.ComponentChildren {
    return <div className={css.absolute.top(-4).right(-4).size(16, 16).borderRadius(8)
        .display("flex").alignItems("center").justifyContent("center").fontSize(12).lineHeight("1")
        .pointerEvents("none").color(on ? "hsl(0, 0%, 10%)" : "white")
        .hsl(on ? 50 : 210, on ? 90 : 70, on ? 55 : 45).bord(1, "hsl(0, 0%, 15%)")}>
        {text}
    </div>;
}

@observer
export class SceneFaceBar extends preact.Component<{
    fileKey: string;
    currentTimeMs: number;
    durationMs: number;
}> {
    render() {
        const { fileKey, currentTimeMs, durationMs } = this.props;
        const { merged, scenes } = getScenesForFileSync(fileKey, durationMs);
        const selection = getSelectedFaceKeys();
        if (merged.groups.length === 0 && selection.length === 0) return null;

        const selectedGroups = selectedGroupsForFile(merged, selection);
        const scene = currentScene(scenes, currentTimeMs);
        const sceneGroups: MergedGroup[] = [];
        if (scene) {
            for (const gid of scene.groups) {
                const g = merged.groups[gid];
                if (g) sceneGroups.push(g);
            }
            sceneGroups.sort((a, b) => b.memberCount - a.memberCount);
        }

        const label = (text: string) => <span className={css.fontSize(11).color("hsl(0, 0%, 65%)").whiteSpace("nowrap") + RS.Muted}>{text}</span>;

        return <div className={css.vbox(4).pad2(10, 0).fillWidth}>
            {selection.length > 0 && <div className={css.hbox(6, 4).wrap.alignCenter}>
                {label("Playing faces:")}
                {selection.map(ck => <div key={ck} className={css.position("relative")}>
                    <FaceAvatar
                        characterKey={ck}
                        size={40}
                        highlighted
                        onClick={() => { playSound("toggle"); toggleSelectedFaceKey(ck); }}
                        title="Remove this face from the selection"
                    />
                    {badge("✕", false)}
                </div>)}
                <button
                    onMouseDown={() => { playSound("toggle"); clearSelectedFaces(); }}
                    className={css.fontSize(11).pad2(8, 3).pointer.hsl(0, 0, 16).color("hsl(0, 0%, 82%)")
                        .bord(1, "hsl(0, 0%, 30%)").hslhover(0, 0, 22) + RS.Button}
                    title="Clear the scene selection and play the whole video"
                >
                    Clear
                </button>
            </div>}
            {sceneGroups.length > 0 && <div className={css.hbox(6, 4).wrap.alignCenter}>
                {label("In this scene:")}
                {sceneGroups.map(g => {
                    const on = selectedGroups.has(g.groupId);
                    return <div key={g.groupId} className={css.position("relative")}>
                        <FaceAvatar
                            characterKey={g.repCharKey}
                            size={40}
                            highlighted={on}
                            onClick={() => { playSound("toggle"); toggleGroupSelection(merged, g); }}
                            title={on ? "Remove this person from the selection" : "Add this person — play only their scenes"}
                        />
                        {badge(on ? "−" : "+", on)}
                    </div>;
                })}
                <button
                    onMouseDown={() => openScenesModal(fileKey)}
                    className={css.fontSize(11).pad2(8, 3).pointer.hsl(0, 0, 16).color("hsl(0, 0%, 82%)")
                        .bord(1, "hsl(0, 0%, 30%)").hslhover(0, 0, 22) + RS.Button}
                    title="Open the scene selector"
                >
                    All scenes…
                </button>
            </div>}
        </div>;
    }
}
