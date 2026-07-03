// Faces modal — a dedicated, larger view of the characters detected in one
// file (the same set the info modal shows). Just the faces up front —
// nothing is precomputed. Clicking a face kicks off the library-wide search
// for that person (time-sliced, with live % progress on the card) and
// expands the matched video tiles inline (injected into the surrounding
// hbox-wrap flow). Each tile is thumbnailed with the keyframe right after
// the person's first appearance in it (so it likely shows them), plays on
// click, and shows how many times the face appears there, expandable into
// the individual timestamps.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { modalCloseBtn } from "../styles";
import { RS } from "../restyle/classNames";
import { files, characters, faceFrames, characterKey } from "../appState";
import {
    getCharacterKeysForFileSync, getClosestCharactersByFileAsync,
    setFaceSearch, SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import { pickThumbForDisplay, getKeyframeAtOrAfterUrlSync, formatDurationHM } from "../scan/thumbnails";
import { goToSearch, goToPlayer } from "../router";
import { playSound } from "../sounds";

const facesModalKey = observable.box<string | undefined>(undefined);
// Which face's video list is open (by character key), and which video's
// timestamp list is open (by `${characterKey}|${fileKey}`). Reset on every
// open so the modal always starts collapsed.
const expandedVideos = observable.set<string>();
const expandedTimes = observable.set<string>();

// Library-wide person search results, per character key. Nothing is
// precomputed — a character's search runs the first time its face is
// clicked, with live progress in matchProgress until it lands.
type FaceMatch = { fileKey: string; distance: number; characterIdx: number; memberCount: number };
const matchResults = observable.map<string, FaceMatch[]>();
const matchProgress = observable.map<string, { done: number; total: number }>();
// Guards double-starting a search when the face is clicked again before the
// first progress callback fires.
const inFlight = new Set<string>();
// Bumping the session cancels any in-flight search — it polls at every yield.
let searchSession = 0;

export function openFacesModal(key: string) {
    playSound("modalOpen");
    searchSession++;
    inFlight.clear();
    runInAction(() => {
        expandedVideos.clear();
        expandedTimes.clear();
        matchResults.clear();
        matchProgress.clear();
        facesModalKey.set(key);
    });
}

export function closeFacesModal() {
    playSound("modalClose");
    searchSession++;
    inFlight.clear();
    runInAction(() => facesModalKey.set(undefined));
}

// Score ONE character against the whole library. Time-sliced (yields a
// frame whenever it has blocked >0.2s), reports % progress at every yield,
// and stops as soon as the modal closes or reopens.
async function runCharacterSearch(ck: string): Promise<void> {
    if (inFlight.has(ck) || matchResults.has(ck)) return;
    inFlight.add(ck);
    const session = searchSession;
    const cancelled = () => session !== searchSession;
    try {
        const centroid = await characters.getSingleField(ck, "centroid");
        if (cancelled()) return;
        if (!centroid) {
            runInAction(() => matchResults.set(ck, []));
            return;
        }
        const byFile = await getClosestCharactersByFileAsync(centroid, {
            shouldCancel: cancelled,
            onProgress: (done, total) => runInAction(() => matchProgress.set(ck, { done, total })),
        });
        if (!byFile || cancelled()) return;
        const matches: FaceMatch[] = [];
        for (const [fk, m] of byFile) {
            if (m.distance <= SAME_CHARACTER_THRESHOLD) {
                matches.push({ fileKey: fk, distance: m.distance, characterIdx: m.characterIdx, memberCount: m.memberCount });
            }
        }
        matches.sort((a, b) => a.distance - b.distance);
        runInAction(() => matchResults.set(ck, matches));
    } catch (err) {
        console.warn(`[faces-modal] match search failed:`, err);
    } finally {
        inFlight.delete(ck);
        runInAction(() => matchProgress.delete(ck));
    }
}

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
        // Stop any in-flight match search — nothing left to show it to.
        searchSession++;
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

        // Face card + (optionally) its expanded video tiles, all emitted as
        // siblings into one wrap flow. A video's timestamp list is a
        // full-width row, so it breaks onto its own line right below.
        const items: preact.ComponentChildren[] = [];
        for (const { key: ck, characterIdx } of charKeys) {
            const memberCount = characters.getSingleFieldSync(ck, "memberCount") ?? 0;
            const matches = matchResults.get(ck);
            const progress = matchProgress.get(ck);
            const videosOpen = expandedVideos.has(ck);
            // Opening a face starts its (one-time) library search on demand.
            const toggleVideos = () => {
                runInAction(() => {
                    if (videosOpen) expandedVideos.delete(ck); else expandedVideos.add(ck);
                });
                if (!videosOpen) void runCharacterSearch(ck);
            };

            items.push(<div key={ck} className={css.vbox(6).alignCenter.pad2(8, 8)
                .hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
                <FaceAvatar
                    characterKey={ck}
                    size={112}
                    title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"} · click to show the videos this person is in`}
                    onClick={toggleVideos}
                />
                <button
                    className={videosOpen ? expanderBtnActive : expanderBtn}
                    onMouseDown={toggleVideos}
                    title="Videos across the library that contain this person — click to expand inline"
                >
                    {matches ? `${matches.length} video${matches.length === 1 ? "" : "s"}`
                        : progress ? `searching… ${Math.floor(progress.done / Math.max(1, progress.total) * 100)}%`
                        : videosOpen ? "searching…" : "videos"} {videosOpen ? "▾" : "▸"}
                </button>
                <button
                    className={expanderBtn}
                    onMouseDown={async () => {
                        const emb = await characters.getSingleField(ck, "bestFaceEmbedding");
                        if (!emb) return;
                        setFaceSearch(emb);
                        closeFacesModal();
                        goToSearch();
                    }}
                    title="Search the whole library by this face"
                >
                    search
                </button>
            </div>);

            if (videosOpen && matches) {
                for (const m of matches) {
                    const vidName = files.getSingleFieldSync(m.fileKey, "name") ?? m.fileKey;
                    // This person's character in the MATCHED video — its frame
                    // times drive both the thumbnail choice and the expander.
                    const matchedCk = characterKey(m.fileKey, m.characterIdx);
                    const frameTimes = faceFrames.getSingleFieldSync(matchedCk, "frameTimes");
                    const times = frameTimes ? Array.from(frameTimes).sort((a, b) => a - b) : [];
                    // Thumbnail = the keyframe right after the person's first
                    // appearance, so it hopefully shows them / their scene.
                    const thumbUrl = (times.length > 0 ? getKeyframeAtOrAfterUrlSync(m.fileKey, times[0]) : undefined)
                        ?? pickThumbForDisplay(m.fileKey, 160);
                    const timesKey = `${ck}|${m.fileKey}`;
                    const timesOpen = expandedTimes.has(timesKey);
                    items.push(<div key={`${ck}|v|${m.fileKey}`} className={css.vbox(4).width(160)}>
                        <div
                            className={css.size(160, 90).flexShrink(0).pointer
                                .backgroundSize("cover").backgroundPosition("center")
                                .hsl(0, 0, 16).bord(1, "hsl(0, 0%, 24%)")
                                + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css)}
                            title={`${vidName} · distance ${m.distance.toFixed(2)} · click to play`}
                            onMouseDown={() => { closeFacesModal(); goToPlayer(m.fileKey); }}
                        />
                        <div className={css.fontSize(11).color("hsl(0, 0%, 80%)").maxWidth(160).ellipsis} title={vidName}>
                            {vidName}
                        </div>
                        <button
                            className={(timesOpen ? expanderBtnActive : expanderBtn) + css.alignSelf("flex-start")}
                            onMouseDown={() => runInAction(() => {
                                if (timesOpen) expandedTimes.delete(timesKey); else expandedTimes.add(timesKey);
                            })}
                            title="Every timestamp this person appears at in this video — click a time to play from 3s before it"
                        >
                            {m.memberCount} time{m.memberCount === 1 ? "" : "s"} {timesOpen ? "▾" : "▸"}
                        </button>
                    </div>);

                    if (timesOpen) {
                        items.push(<div key={`${ck}|t|${m.fileKey}`}
                            className={css.fillWidth.hbox(4).wrap.alignCenter.pad2(4, 2)}>
                            <span className={css.fontSize(11).color("hsl(0, 0%, 55%)").maxWidth(240).ellipsis + RS.Muted}
                                title={vidName}>
                                {vidName}:
                            </span>
                            {times.map((tms, i) => {
                                const sec = tms / 1000;
                                return <button
                                    key={i}
                                    className={expanderBtn}
                                    title={`Face at ${formatDurationHM(sec)} — play from 3s before`}
                                    onMouseDown={() => { closeFacesModal(); goToPlayer(m.fileKey, Math.max(0, sec - 3)); }}
                                >
                                    {formatDurationHM(sec)}
                                </button>;
                            })}
                            {times.length === 0 && <span className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>
                                {frameTimes ? "no recorded timestamps" : "loading timestamps…"}
                            </span>}
                        </div>);
                    }
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
