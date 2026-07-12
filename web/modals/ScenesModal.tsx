// Scenes modal — face-defined scenes for one file. Each scene is thumbnailed
// with its middle keyframe and shows its time range plus the faces in it.
// Clicking a face toggles it in the scene selection (URL-backed): the player
// then highlights those scenes on the trackbar and plays only them, skipping
// the gaps. If keyframes / faces haven't been extracted yet, a Calculate
// button runs the same on-demand extraction the faces modal uses.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { modalCloseBtn, controlSurfaceAccent, buttonDown } from "../styles";
import { sceneGapSec } from "../router";
import { RS } from "../restyle/classNames";
import {
    files, keyframes,
    extractMetadataForKey, extractKeyframesForKey,
} from "../appState";
import { extractFacesForKey } from "../faces/faceExtraction";
import { KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { getCharacterKeysForFileSync } from "../faces/faceSearch";
import {
    getScenesForFileSync, selectedGroupsForFile, getSelectedFaceKeys,
    toggleGroupSelection, clearSelectedFaces, facesLoadingSync, DEFAULT_SCENE_GAP_SEC,
    MergedFaces, MergedGroup, Scene,
} from "../faces/faceScenes";
import { FaceAvatar } from "../faces/FaceAvatar";
import { getNearestKeyframeUrlSync } from "../scan/thumbnails";
import { playSound } from "../sounds";

const scenesModalKey = observable.box<string | undefined>(undefined);

export function openScenesModal(key: string) {
    playSound("modalOpen");
    runInAction(() => scenesModalKey.set(key));
}

export function closeScenesModal() {
    playSound("modalClose");
    runInAction(() => scenesModalKey.set(undefined));
}

// On-demand extraction (mirrors the faces modal): run only the phases the file
// is missing — metadata (for duration), the keyframe strip (scene thumbnails),
// then faces. Keyed by file so it survives closing/reopening mid-run.
type ExtractState = { running: boolean; status: string };
const extractState = observable.map<string, ExtractState>();

async function calculateScenes(key: string): Promise<void> {
    if (extractState.get(key)?.running) return;
    const setStatus = (status: string) => runInAction(() => extractState.set(key, { running: true, status }));
    setStatus("starting…");
    try {
        if (await files.getSingleField(key, "durationSec") === undefined) {
            setStatus("metadata…");
            await extractMetadataForKey(key);
        }
        if (await keyframes.getSingleField(key, "keyframesVersion") !== KEYFRAMES_VERSION) {
            setStatus("keyframes…");
            await extractKeyframesForKey(key, info => setStatus(`keyframes: ${info.message}`));
        }
        setStatus("faces…");
        await extractFacesForKey(key, info => setStatus(`faces: ${info.message}`));
        const recordedError = await files.getSingleField(key, "facesError");
        if (recordedError) {
            runInAction(() => extractState.set(key, { running: false, status: `failed: ${recordedError}` }));
            return;
        }
        runInAction(() => extractState.delete(key));
    } catch (err) {
        console.warn(`[scenes-modal] extraction failed for ${key}:`, err);
        runInAction(() => extractState.set(key, { running: false, status: `failed: ${(err as Error).message}` }));
    }
}

function fmtClock(ms: number): string {
    let sec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// One scene tile: middle-keyframe thumbnail, time range, and its face avatars
// (toggle selection on click).
function SceneTile(props: { fileKey: string; scene: Scene; merged: MergedFaces; selectedGroups: Set<number> }) {
    const { fileKey, scene, merged, selectedGroups } = props;
    const midMs = (scene.start + scene.end) / 2;
    const thumbUrl = getNearestKeyframeUrlSync(fileKey, midMs);
    const groups: MergedGroup[] = [];
    for (const gid of scene.groups) {
        const g = merged.groups[gid];
        if (g) groups.push(g);
    }
    groups.sort((a, b) => b.memberCount - a.memberCount);
    return <div className={css.vbox(6).width(220).pad2(8, 8).hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
        <div className={css.size(204, 115).flexShrink(0).bord(1, "hsl(0, 0%, 24%)").position("relative")
            .backgroundSize("cover").backgroundPosition("center")
            + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css.hsl(0, 0, 16))}>
            <div className={css.absolute.bottom(0).left(0).right(0).pad2(6, 2)
                .hsla(0, 0, 0, 0.6).color("white").fontSize(11).textAlign("center")}>
                {fmtClock(scene.start)} – {fmtClock(scene.end)}
            </div>
        </div>
        <div className={css.hbox(4, 4).wrap.alignCenter}>
            {groups.map(g => {
                const on = selectedGroups.has(g.groupId);
                return <FaceAvatar
                    key={g.groupId}
                    characterKey={g.repCharKey}
                    size={48}
                    highlighted={on}
                    onClick={() => { playSound("toggle"); toggleGroupSelection(merged, g); }}
                    title={on ? "Selected — click to remove from scene selection" : "Click to select this person's scenes"}
                />;
            })}
            {groups.length === 0 && <span className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>no faces</span>}
        </div>
    </div>;
}

@observer
export class ScenesModal extends preact.Component {
    componentDidMount() { document.addEventListener("keydown", this.onKeyDown); }
    componentWillUnmount() { document.removeEventListener("keydown", this.onKeyDown); }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && scenesModalKey.get() !== undefined) {
            e.preventDefault();
            closeScenesModal();
        }
    };

    render() {
        const key = scenesModalKey.get();
        if (!key) return null;

        const name = files.getSingleFieldSync(key, "name");
        const durationSec = files.getSingleFieldSync(key, "durationSec") ?? 0;
        const durationMs = durationSec * 1000;
        const charKeys = getCharacterKeysForFileSync(key);
        // "Loading" here means the character list or any per-character field
        // (embedding / member count / frame times) is still being fetched — so
        // an empty `scenes` is provisional, not "no faces". extractFacesForKey
        // triggers the loads; facesLoadingSync reports when they've landed.
        const facesLoading = facesLoadingSync(key);
        const facesRan = files.getSingleFieldSync(key, "facesVersion") === FACES_VERSION;
        const extract = extractState.get(key);

        const { merged, scenes } = getScenesForFileSync(key, durationMs);
        const selection = getSelectedFaceKeys();
        const selectedGroups = selectedGroupsForFile(merged, selection);

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeScenesModal(); } }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(1080).fillWidth.maxHeight("85vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={css.pad2(16, 22).hbox(12).alignItems("center").fillWidth.flexShrink(0)
                    .borderBottom("1px solid hsl(0, 0%, 18%)")}>
                    <div className={css.fontSize(15).flexGrow(1).minWidth(0).overflowWrap("break-word") + RS.ModalTitle}
                        title={name ?? key}>
                        Scenes — {name ?? key}
                    </div>
                    <div className={css.hbox(6).alignCenter.flexShrink(0)}
                        title="Longest gap (seconds) between two of a scene's faces before it's split into a new scene">
                        <span className={css.fontSize(12).color("hsl(0, 0%, 60%)").whiteSpace("nowrap") + RS.Muted}>Scene gap</span>
                        <input
                            type="number"
                            min={1}
                            value={sceneGapSec.value}
                            onInput={(e: Event) => {
                                const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
                                runInAction(() => { sceneGapSec.value = Number.isFinite(v) && v > 0 ? v : DEFAULT_SCENE_GAP_SEC; });
                            }}
                            className={css.width(66).pad2(8, 5).fontSize(13).fontFamily("inherit")
                                .hsl(0, 0, 8).color("white").bord(1, "hsl(0, 0%, 25%)").borderRadius(4) + RS.Surface}
                        />
                        <span className={css.fontSize(12).color("hsl(0, 0%, 60%)") + RS.Muted}>s</span>
                    </div>
                    {selection.length > 0 && <button
                        onMouseDown={buttonDown(() => { playSound("toggle"); clearSelectedFaces(); })}
                        className={css.fontSize(12).pad2(10, 5).pointer.hsl(0, 0, 16)
                            .color("hsl(0, 0%, 82%)").bord(1, "hsl(0, 0%, 30%)").hslhover(0, 0, 22) + RS.Button}
                        title="Clear the scene selection (play the whole video again)"
                    >
                        Clear selection ({selection.length})
                    </button>}
                    <button
                        onMouseDown={buttonDown(() => closeScenesModal())}
                        className={modalCloseBtn + css.flexShrink(0)}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.pad2(14, 22).flexGrow(1).minHeight(0).overflowY("auto").overflowX("hidden").vbox(12).fillWidth}>
                    {scenes.length === 0 && (
                        facesLoading ? (
                            <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>Loading…</div>
                        ) : extract?.running ? (
                            <div className={css.fontSize(13).color("hsl(48, 85%, 70%)")}>Calculating — {extract.status}</div>
                        ) : (
                            <div className={css.vbox(10).alignItems("flex-start")}>
                                <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                                    {extract ? extract.status
                                        : charKeys.length > 0 ? "No scenes could be built from this video's faces."
                                        : facesRan ? "No faces were found in this video."
                                        : "Scenes haven't been calculated for this video yet."}
                                </div>
                                <button
                                    onMouseDown={buttonDown(() => void calculateScenes(key))}
                                    className={controlSurfaceAccent + css.pad2(12, 6).fontSize(13).pointer + RS.ButtonPrimary}
                                    title="Extract keyframes + faces for this video and build scenes"
                                >
                                    {facesRan || extract ? "Recalculate scenes" : "Calculate scenes"}
                                </button>
                            </div>
                        )
                    )}
                    {scenes.length > 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 60%)") + RS.Muted}>
                        {scenes.length} scene{scenes.length === 1 ? "" : "s"} · click a face to play only that person's scenes
                    </div>}
                    <div className={css.hbox(10, 10).wrap.alignItems("flex-start")}>
                        {scenes.map((s, i) => <SceneTile
                            key={i}
                            fileKey={key}
                            scene={s}
                            merged={merged}
                            selectedGroups={selectedGroups}
                        />)}
                    </div>
                </div>
            </div>
        </div>;
    }
}
