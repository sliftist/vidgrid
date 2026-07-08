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
import { modalCloseBtn, controlSurfaceAccent } from "../styles";
import { RS } from "../restyle/classNames";
import {
    files, characters, faceFrames, keyframes, characterKey, seriesMinVideos,
    extractMetadataForKey, extractKeyframesForKey,
} from "../appState";
import { extractFacesForKey } from "../faces/faceExtraction";
import { KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { getSeries, SeriesVideo } from "../search/series";
import {
    getCharacterKeysForFileSync, getClosestCharactersByFileAsync,
    SAME_CHARACTER_THRESHOLD,
} from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import { pickThumbForDisplay, getKeyframeAtOrAfterUrlSync, formatDurationHM } from "../scan/thumbnails";
import { goToPlayer } from "../router";
import { buildPlayerHref } from "../search/gridShared";
import { playSound } from "../sounds";

const facesModalKey = observable.box<string | undefined>(undefined);
// Which face's video list is open (by character key), which series group is
// open (by `${characterKey}|s|${parentPath}`), and which video's timestamp
// list is open (by `${characterKey}|${fileKey}`). Reset on every open so the
// modal always starts collapsed.
const expandedVideos = observable.set<string>();
const expandedSeries = observable.set<string>();
const expandedTimes = observable.set<string>();
// Character keys for which the user asked to show ALL matches (past the
// default MAX_SHOWN cap). Reset on every open.
const expandedAll = observable.set<string>();

// How many matched videos to show per character before the "show all"
// control — beyond this the wall of thumbnails bogs the modal down.
const MAX_SHOWN = 100;

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
        expandedSeries.clear();
        expandedTimes.clear();
        expandedAll.clear();
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
        const emb = await characters.getSingleField(ck, "bestFaceEmbedding");
        if (cancelled()) return;
        if (!emb) {
            runInAction(() => matchResults.set(ck, []));
            return;
        }
        const byFile = await getClosestCharactersByFileAsync(emb, {
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
        // Order by most appearances first (how many times the person shows up
        // in each video), closest distance breaking ties. All matches are
        // within SAME_CHARACTER_THRESHOLD, so they're all confident hits — the
        // interesting ranking is "who appears the most", not raw distance.
        matches.sort((a, b) => b.memberCount - a.memberCount || a.distance - b.distance);
        // Keep the full list — the render caps display at MAX_SHOWN and offers
        // a "show all" control so the total is always visible.
        runInAction(() => matchResults.set(ck, matches));
    } catch (err) {
        console.warn(`[faces-modal] match search failed:`, err);
    } finally {
        inFlight.delete(ck);
        runInAction(() => matchProgress.delete(ck));
    }
}

// On-demand per-file extraction ("Extract faces now" button). Runs only the
// phases the file is missing: metadata (needed for the duration-based face
// thumbnail rules), the keyframe strip (this modal's video-tile thumbnails),
// then faces — surfacing each phase's heartbeat as the status line. Keyed by
// file so the state survives closing/reopening the modal mid-extraction.
type ExtractState = { running: boolean; status: string };
const extractState = observable.map<string, ExtractState>();

async function extractFacesNow(key: string): Promise<void> {
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
        // extractFacesForKey records failures in facesError rather than
        // throwing — surface it here so the button row explains itself.
        const recordedError = await files.getSingleField(key, "facesError");
        if (recordedError) {
            runInAction(() => extractState.set(key, { running: false, status: `failed: ${recordedError}` }));
            return;
        }
        runInAction(() => extractState.delete(key));
    } catch (err) {
        console.warn(`[faces-modal] extraction failed for ${key}:`, err);
        runInAction(() => extractState.set(key, { running: false, status: `failed: ${(err as Error).message}` }));
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
        // getCharacterKeysForFileSync returns [] BOTH while the characters
        // collection is still loading and when the file genuinely has no
        // characters — tell them apart so we don't claim "no faces" during load.
        const charsLoading = !characters.isColumnLoadedSync("characterIdx");
        const facesRan = files.getSingleFieldSync(key, "facesVersion") === FACES_VERSION;
        const extract = extractState.get(key);

        // Library series detection (same rules as the grid), computed lazily
        // once per render — only needed when a face's matches are showing.
        // File keys ARE relativePaths, so a match's series folder is just its
        // key's parent directory.
        let seriesParents: Set<string> | undefined;
        const getSeriesParents = (): Set<string> => {
            if (seriesParents) return seriesParents;
            const nameCol = files.getColumnSync("name");
            const seriesInput: SeriesVideo[] = [];
            if (nameCol) {
                for (const { key: fk, value } of nameCol) {
                    seriesInput.push({ key: fk, name: (value as string) ?? fk, relativePath: fk });
                }
            }
            seriesParents = new Set(getSeries(seriesInput, seriesMinVideos.get()).keys());
            return seriesParents;
        };

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

            // The whole card is ONE button (avatar included) so it's obvious
            // that clicking anywhere on it expands the person's videos.
            items.push(<button
                key={ck}
                onMouseDown={toggleVideos}
                title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"} · click to show the videos this person is in`}
                className={css.vbox(6).alignItems("center").pad2(8, 8).pointer
                    + (videosOpen
                        ? css.hsl(50, 30, 16).bord(1, "hsl(50, 50%, 40%)")
                        : css.hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)").hslhover(0, 0, 17))
                    + RS.Button}
            >
                <FaceAvatar characterKey={ck} size={112} />
                <div className={css.fontSize(11).color(videosOpen ? "hsl(50, 90%, 85%)" : "hsl(0, 0%, 78%)")}>
                    {matches ? `${matches.length} video${matches.length === 1 ? "" : "s"}`
                        : progress ? `searching… ${Math.floor(progress.done / Math.max(1, progress.total) * 100)}%`
                        : videosOpen ? "searching…" : "videos"} {videosOpen ? "▾" : "▸"}
                </div>
            </button>);

            if (videosOpen && matches) {
                // Cap the tiles at MAX_SHOWN unless the user asked for all.
                const showAll = expandedAll.has(ck);
                const shown = showAll ? matches : matches.slice(0, MAX_SHOWN);
                // The keyframe right after the person's first appearance, so
                // it hopefully shows them / their scene.
                const faceThumbUrl = (m: FaceMatch, firstTimeMs: number | undefined): string | undefined =>
                    (firstTimeMs !== undefined ? getKeyframeAtOrAfterUrlSync(m.fileKey, firstTimeMs) : undefined)
                        ?? pickThumbForDisplay(m.fileKey, 160);

                const pushVideoTile = (m: FaceMatch) => {
                    const vidName = files.getSingleFieldSync(m.fileKey, "name") ?? m.fileKey;
                    // This person's character in the MATCHED video — its frame
                    // times drive both the thumbnail choice and the expander.
                    const matchedCk = characterKey(m.fileKey, m.characterIdx);
                    const frameTimes = faceFrames.getSingleFieldSync(matchedCk, "frameTimes");
                    const times = frameTimes ? Array.from(frameTimes).sort((a, b) => a - b) : [];
                    const thumbUrl = faceThumbUrl(m, times[0]);
                    const timesKey = `${ck}|${m.fileKey}`;
                    const timesOpen = expandedTimes.has(timesKey);
                    items.push(<div key={`${ck}|v|${m.fileKey}`} className={css.vbox(4).width(160)}>
                        <div
                            className={css.size(160, 90).flexShrink(0).pointer
                                .backgroundSize("cover").backgroundPosition("center")
                                .bord(1, "hsl(0, 0%, 24%)")
                                // hsl sets the `background` SHORTHAND, which
                                // clobbers backgroundImage — never both.
                                + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css.hsl(0, 0, 16))}
                            title={`${vidName} · distance ${m.distance.toFixed(2)} · click to play, middle-click for a new tab`}
                            onMouseDown={e => {
                                if (e.button === 0) { closeFacesModal(); goToPlayer(m.fileKey); }
                                // Middle-click → background tab. preventDefault
                                // stops the browser's middle-click autoscroll.
                                else if (e.button === 1) { e.preventDefault(); window.open(buildPlayerHref(m.fileKey), "_blank"); }
                            }}
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
                            className={css.fillWidth.hbox(4, 2).wrap.alignCenter.pad2(4, 2)}>
                            <span className={css.fontSize(11).color("hsl(0, 0%, 55%)").maxWidth(240).ellipsis + RS.Muted}
                                title={vidName}>
                                {vidName}:
                            </span>
                            {times.map((tms, i) => {
                                const sec = tms / 1000;
                                const seekSec = Math.max(0, sec - 3);
                                return <button
                                    key={i}
                                    className={expanderBtn}
                                    title={`Face at ${formatDurationHM(sec)} — play from 3s before (middle-click for a new tab)`}
                                    onMouseDown={e => {
                                        if (e.button === 0) { closeFacesModal(); goToPlayer(m.fileKey, seekSec); }
                                        else if (e.button === 1) { e.preventDefault(); window.open(buildPlayerHref(m.fileKey, { seekSec }), "_blank"); }
                                    }}
                                >
                                    {formatDurationHM(sec)}
                                </button>;
                            })}
                            {times.length === 0 && <span className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>
                                {frameTimes ? "no recorded timestamps" : "loading timestamps…"}
                            </span>}
                        </div>);
                    }
                };

                // Collapse matches by series: ≥2 matched videos in the same
                // series folder become one series tile (with match + total
                // time counts) that expands into its video tiles. A lone
                // match in a series stays a plain video tile — collapsing it
                // would just add a click.
                const parents = getSeriesParents();
                const parentOf = (fk: string) => {
                    const slash = fk.lastIndexOf("/");
                    return slash >= 0 ? fk.slice(0, slash) : "";
                };
                const byParent = new Map<string, FaceMatch[]>();
                for (const m of shown) {
                    const parent = parentOf(m.fileKey);
                    if (!parent || !parents.has(parent)) continue;
                    let list = byParent.get(parent);
                    if (!list) byParent.set(parent, list = []);
                    list.push(m);
                }
                const emittedSeries = new Set<string>();
                for (const m of shown) {
                    const parent = parentOf(m.fileKey);
                    const group = byParent.get(parent);
                    if (!group || group.length < 2) {
                        pushVideoTile(m);
                        continue;
                    }
                    if (emittedSeries.has(parent)) continue;
                    emittedSeries.add(parent);
                    const folderName = parent.slice(parent.lastIndexOf("/") + 1) || parent;
                    const totalTimes = group.reduce((s, g) => s + g.memberCount, 0);
                    const seriesKey = `${ck}|s|${parent}`;
                    const seriesOpen = expandedSeries.has(seriesKey);
                    // Series thumb = the top match's face thumb (group is in
                    // the same most-appearances-first order as `matches`).
                    const best = group[0];
                    const bestCk = characterKey(best.fileKey, best.characterIdx);
                    const bestFrameTimes = faceFrames.getSingleFieldSync(bestCk, "frameTimes");
                    const bestFirst = bestFrameTimes ? Math.min(...bestFrameTimes) : undefined;
                    const thumbUrl = faceThumbUrl(best, bestFirst);
                    items.push(<button
                        key={seriesKey}
                        onMouseDown={() => runInAction(() => {
                            if (seriesOpen) expandedSeries.delete(seriesKey); else expandedSeries.add(seriesKey);
                        })}
                        title={`${parent} — ${group.length} matched videos in this series, ${totalTimes} appearances · click to expand`}
                        className={css.vbox(4).width(172).pad2(5, 5).pointer.alignItems("stretch")
                            + (seriesOpen
                                ? css.hsl(50, 30, 16).bord(1, "hsl(50, 50%, 40%)")
                                : css.hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)").hslhover(0, 0, 17))
                            + RS.Button}
                    >
                        <div className={css.size(160, 90).flexShrink(0)
                            .backgroundSize("cover").backgroundPosition("center")
                            .bord(1, "hsl(0, 0%, 24%)")
                            + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css.hsl(0, 0, 16))} />
                        <div className={css.fontSize(11).color("hsl(0, 0%, 85%)").maxWidth(160).ellipsis.textAlign("left")} title={parent}>
                            {folderName}
                        </div>
                        <div className={css.fontSize(11).textAlign("left")
                            .color(seriesOpen ? "hsl(50, 90%, 85%)" : "hsl(0, 0%, 65%)")}>
                            {group.length} video{group.length === 1 ? "" : "s"} · {totalTimes} time{totalTimes === 1 ? "" : "s"} {seriesOpen ? "▾" : "▸"}
                        </div>
                    </button>);
                    if (seriesOpen) {
                        for (const sm of group) pushVideoTile(sm);
                    }
                }

                // Full-width footer: how many were shown out of the total, with
                // a toggle to expand to all matches (or collapse back).
                if (matches.length > MAX_SHOWN) {
                    items.push(<div key={`${ck}|more`} className={css.fillWidth.hbox(0)}>
                        <button
                            className={(showAll ? expanderBtnActive : expanderBtn)}
                            onMouseDown={() => runInAction(() => {
                                if (showAll) expandedAll.delete(ck); else expandedAll.add(ck);
                            })}
                            title={showAll
                                ? `Showing all ${matches.length} matches — click to show only the top ${MAX_SHOWN}`
                                : `Only the top ${MAX_SHOWN} of ${matches.length} matches are shown — click to show all`}
                        >
                            {showAll
                                ? `Showing all ${matches.length} — show top ${MAX_SHOWN} ▴`
                                : `Showing ${MAX_SHOWN} of ${matches.length} — show all ▾`}
                        </button>
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
                    {charKeys.length === 0 && (
                        charsLoading ? (
                            <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                                Loading faces…
                            </div>
                        ) : extract?.running ? (
                            <div className={css.fontSize(13).color("hsl(48, 85%, 70%)")}>
                                Extracting faces — {extract.status}
                            </div>
                        ) : (
                            <div className={css.vbox(10).alignItems("flex-start")}>
                                <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                                    {extract ? extract.status
                                        : facesRan ? "No faces were found in this video."
                                        : "Face extraction hasn't run for this video yet."}
                                </div>
                                <button
                                    onMouseDown={() => void extractFacesNow(key)}
                                    className={controlSurfaceAccent + css.pad2(12, 6).fontSize(13).pointer + RS.ButtonPrimary}
                                    title="Extract faces for this video now (runs metadata / keyframes first if they're missing)"
                                >
                                    {facesRan || extract ? "Re-extract faces" : "Extract faces now"}
                                </button>
                            </div>
                        )
                    )}
                    <div className={css.hbox(10, 2).wrap.alignItems("center")}>
                        {items}
                    </div>
                </div>
            </div>
        </div>;
    }
}
