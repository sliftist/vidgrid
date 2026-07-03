// Faces modal — a dedicated, larger view of the characters detected in one
// file (the same set the info modal shows). Each face card carries two
// inline expanders: the videos across the whole library that contain that
// person, and every timestamp the face appears in this file. Expanded
// content is injected straight into the surrounding hbox-wrap flow, so it
// wraps onto its own lines right after the card instead of opening a
// panel elsewhere.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { cacheWeak } from "socket-function/src/caching";
import { modalCloseBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { files, characters, faceFrames } from "../appState";
import {
    getCharacterKeysForFileSync, getClosestCharactersByFileSync,
    setFaceSearch, SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import { pickThumbForDisplay, formatDurationHM } from "../scan/thumbnails";
import { goToSearch, goToPlayer } from "../router";
import { playSound } from "../sounds";

const facesModalKey = observable.box<string | undefined>(undefined);
// Which expander is open per character key. Reset on every open so the
// modal always starts collapsed.
const expandedVideos = observable.set<string>();
const expandedTimes = observable.set<string>();

export function openFacesModal(key: string) {
    playSound("modalOpen");
    runInAction(() => {
        expandedVideos.clear();
        expandedTimes.clear();
        facesModalKey.set(key);
    });
}

export function closeFacesModal() {
    playSound("modalClose");
    runInAction(() => facesModalKey.set(undefined));
}

// Library-wide person search, cached so it runs once per face per data
// version instead of on every render. Outer key is the centroid column
// object (its reference changes when character data changes, invalidating
// the inner cache); inner key is the face's centroid embedding. The result
// is every file whose closest character is within the same-character
// threshold, nearest first.
const matchedFilesCache = cacheWeak((_col: object) =>
    cacheWeak((centroid: Float32Array) => {
        const byFile = getClosestCharactersByFileSync(centroid);
        const out: { fileKey: string; distance: number }[] = [];
        for (const [fileKey, m] of byFile) {
            if (m.distance <= SAME_CHARACTER_THRESHOLD) out.push({ fileKey, distance: m.distance });
        }
        out.sort((a, b) => a.distance - b.distance);
        return out;
    })
);

const expanderBtn = css.fontSize(11).pad2(6, 2).pointer.hsl(0, 0, 16)
    .color("hsl(0, 0%, 78%)").bord(1, "hsl(0, 0%, 26%)")
    .hslhover(0, 0, 22) + RS.Button;
const expanderBtnActive = css.fontSize(11).pad2(6, 2).pointer.hsl(50, 40, 30)
    .color("hsl(50, 90%, 85%)").bord(1, "hsl(50, 50%, 40%)") + RS.Button;

@observer
export class FacesModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && facesModalKey.get() !== undefined) {
            e.preventDefault();
            closeFacesModal();
        }
    };

    render() {
        const key = facesModalKey.get();
        if (!key) return null;

        const name = files.getSingleFieldSync(key, "name");
        const charKeys = getCharacterKeysForFileSync(key);
        const centroidCol = characters.getColumnSync("centroid");
        const matchesFor = centroidCol ? matchedFilesCache(centroidCol as object) : undefined;

        // Face card + (optionally) its expanded content, all emitted as
        // siblings into one wrap flow.
        const items: preact.ComponentChildren[] = [];
        for (const { key: ck, characterIdx } of charKeys) {
            const memberCount = characters.getSingleFieldSync(ck, "memberCount") ?? 0;
            const centroid = characters.getSingleFieldSync(ck, "centroid");
            const matches = centroid && matchesFor ? matchesFor(centroid) : undefined;
            const videosOpen = expandedVideos.has(ck);
            const timesOpen = expandedTimes.has(ck);

            items.push(<div key={ck} className={css.vbox(6).alignCenter.pad2(8, 8)
                .hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
                <FaceAvatar
                    characterKey={ck}
                    size={112}
                    title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"} · click to search by this face`}
                    onClick={async () => {
                        const emb = await characters.getSingleField(ck, "bestFaceEmbedding");
                        if (!emb) return;
                        setFaceSearch(emb);
                        closeFacesModal();
                        goToSearch();
                    }}
                />
                <button
                    className={videosOpen ? expanderBtnActive : expanderBtn}
                    onMouseDown={() => runInAction(() => {
                        if (videosOpen) expandedVideos.delete(ck); else expandedVideos.add(ck);
                    })}
                    title="Videos across the library that contain this person — click to expand inline"
                >
                    {matches ? `${matches.length} video${matches.length === 1 ? "" : "s"}` : "searching…"} {videosOpen ? "▾" : "▸"}
                </button>
                <button
                    className={timesOpen ? expanderBtnActive : expanderBtn}
                    onMouseDown={() => runInAction(() => {
                        if (timesOpen) expandedTimes.delete(ck); else expandedTimes.add(ck);
                    })}
                    title="Every timestamp this face appears in this video — click a time to play from 3s before it"
                >
                    {memberCount} time{memberCount === 1 ? "" : "s"} {timesOpen ? "▾" : "▸"}
                </button>
            </div>);

            if (videosOpen && matches) {
                for (const m of matches) {
                    const thumbUrl = pickThumbForDisplay(m.fileKey, 160);
                    const vidName = files.getSingleFieldSync(m.fileKey, "name") ?? m.fileKey;
                    items.push(<div
                        key={`${ck}|v|${m.fileKey}`}
                        className={css.vbox(4).width(160).pointer}
                        title={`${vidName} · distance ${m.distance.toFixed(2)} · click to play`}
                        onMouseDown={() => { closeFacesModal(); goToPlayer(m.fileKey); }}
                    >
                        <div className={css.size(160, 90).flexShrink(0)
                            .backgroundSize("cover").backgroundPosition("center")
                            .hsl(0, 0, 16).bord(1, "hsl(0, 0%, 24%)")
                            + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css)} />
                        <div className={css.fontSize(11).color("hsl(0, 0%, 80%)").maxWidth(160).ellipsis}>
                            {vidName}
                        </div>
                    </div>);
                }
            }

            if (timesOpen) {
                const frameTimes = faceFrames.getSingleFieldSync(ck, "frameTimes");
                const times = frameTimes ? Array.from(frameTimes).sort((a, b) => a - b) : [];
                for (let i = 0; i < times.length; i++) {
                    const sec = times[i] / 1000;
                    items.push(<button
                        key={`${ck}|t|${i}`}
                        className={expanderBtn + css.alignSelf("center")}
                        title={`Face at ${formatDurationHM(sec)} — play from 3s before`}
                        onMouseDown={() => { closeFacesModal(); goToPlayer(key, Math.max(0, sec - 3)); }}
                    >
                        {formatDurationHM(sec)}
                    </button>);
                }
                if (times.length === 0) {
                    items.push(<div key={`${ck}|t|none`} className={css.fontSize(11)
                        .color("hsl(0, 0%, 55%)").alignSelf("center") + RS.Muted}>
                        {frameTimes ? "no recorded timestamps" : "loading timestamps…"}
                    </div>);
                }
            }
        }

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeFacesModal(); }}
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
                <div className={css.pad2(18, 22).flexGrow(1).minHeight(0).overflowAuto.vbox(12).fillWidth}>
                    <div className={css.hbox(12).alignCenter}>
                        <div className={css.fontSize(15).flexGrow(1).ellipsis + RS.ModalTitle} title={name ?? key}>
                            Faces — {name ?? key}
                        </div>
                        <button
                            onMouseDown={() => closeFacesModal()}
                            className={modalCloseBtn}
                            title="Close (Esc)"
                        >
                            ✕
                        </button>
                    </div>
                    {charKeys.length === 0 && <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                        No characters detected in this file (or face extraction hasn't run yet).
                    </div>}
                    <div className={css.hbox(10).wrap.alignItems("center")}>
                        {items}
                    </div>
                </div>
            </div>
        </div>;
    }
}
