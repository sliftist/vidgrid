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
import { observable, runInAction, reaction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatNumber } from "socket-function/src/formatting/format";
import { modalCloseBtn, controlSurfaceAccent, buttonDown } from "../styles";
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
    faceThreshold,
} from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import {
    getBlacklistedFacesSync, matchBlacklistSync, blacklistFace,
} from "../faces/faceBlacklist";
import { openBlacklistModal } from "./BlacklistModal";
import { pickThumbForDisplay, getKeyframeAtOrAfterUrlSync, formatDurationHM } from "../scan/thumbnails";
import { goToPlayer } from "../router";
import { buildPlayerHref, isPlainLeftClick } from "../search/gridShared";
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
// The identity of the characters `bestFaceEmbedding` column each cached result
// was computed against. When face data changes under the modal, the column ref
// changes — we DON'T silently re-scan (a background scan ingesting faces would
// loop the search forever, exactly like the main page). Instead render compares
// this to the live column and shows a "faces changed — search again" notice.
const matchColRef = observable.map<string, unknown>();
// Guards double-starting a search when the face is clicked again before the
// first progress callback fires.
const inFlight = new Set<string>();
// Bumping the session cancels any in-flight search — it polls at every yield.
let searchSession = 0;

// Results depend on BOTH the character and the current distance threshold, so
// the threshold is part of the cache key: changing it (re-searches at) a new
// key rather than reusing stale matches. Reads faceThreshold reactively, so
// render re-keys automatically when the user edits the threshold.
function matchKey(ck: string): string {
    return `${ck}@${faceThreshold.value}`;
}

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
        matchColRef.clear();
        facesModalKey.set(key);
    });
}

// Re-run the searches for every currently-open face against the CURRENT face
// data — the only path that re-scans after faces change. Triggered by the
// "search again" notice, never automatically.
function refreshFacesModalSearch(): void {
    searchSession++;
    inFlight.clear();
    const open: string[] = [];
    for (const ck of expandedVideos) open.push(ck);
    runInAction(() => {
        for (const ck of open) {
            const mk = matchKey(ck);
            matchResults.delete(mk);
            matchColRef.delete(mk);
        }
    });
    for (const ck of open) void runCharacterSearch(ck);
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
    // The threshold is snapshotted into the cache key, so switching thresholds
    // re-searches at a fresh key rather than clobbering the previous result.
    const mk = matchKey(ck);
    const threshold = faceThreshold.value;
    if (inFlight.has(mk) || matchResults.has(mk)) return;
    inFlight.add(mk);
    const session = searchSession;
    const cancelled = () => session !== searchSession;
    try {
        const emb = await characters.getSingleField(ck, "bestFaceEmbedding");
        if (cancelled()) return;
        if (!emb) {
            runInAction(() => {
                matchResults.set(mk, []);
                matchColRef.set(mk, characters.getColumnSync("bestFaceEmbedding"));
            });
            return;
        }
        const byFile = await getClosestCharactersByFileAsync(emb, {
            shouldCancel: cancelled,
            onProgress: (done, total) => runInAction(() => matchProgress.set(mk, { done, total })),
        });
        if (!byFile || cancelled()) return;
        const matches: FaceMatch[] = [];
        for (const [fk, m] of byFile) {
            if (m.distance <= threshold) {
                matches.push({ fileKey: fk, distance: m.distance, characterIdx: m.characterIdx, memberCount: m.memberCount });
            }
        }
        // Order by most appearances first (how many times the person shows up
        // in each video), closest distance breaking ties. All matches are
        // within the threshold, so they're all confident hits — the
        // interesting ranking is "who appears the most", not raw distance.
        matches.sort((a, b) => b.memberCount - a.memberCount || a.distance - b.distance);
        // Keep the full list — the render caps display at MAX_SHOWN and offers
        // a "show all" control so the total is always visible. Snapshot the
        // column ref this ran against so render can detect later face changes.
        runInAction(() => {
            matchResults.set(mk, matches);
            matchColRef.set(mk, characters.getColumnSync("bestFaceEmbedding"));
        });
    } catch (err) {
        console.warn(`[faces-modal] match search failed:`, err);
    } finally {
        inFlight.delete(mk);
        runInAction(() => matchProgress.delete(mk));
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

// Editable match-distance threshold, shown in the modal header. Keeps a local
// draft while the user types and only commits (to the URL-backed faceThreshold)
// on Enter or blur — an invalid or non-positive value is discarded, snapping
// the field back to the live value.
@observer
class ThresholdInput extends preact.Component<{}, { draft: string | undefined }> {
    state = { draft: undefined as string | undefined };
    private commit = () => {
        const raw = this.state.draft;
        this.setState({ draft: undefined });
        if (raw === undefined) return;
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
            runInAction(() => { faceThreshold.value = parsed; });
        }
    };
    render() {
        const shown = this.state.draft ?? String(faceThreshold.value);
        return <label className={css.hbox(6).alignCenter.fontSize(12).color("hsl(0, 0%, 70%)")}>
            Threshold
            <input
                type="text"
                inputMode="decimal"
                value={shown}
                onInput={e => this.setState({ draft: (e.target as HTMLInputElement).value })}
                onBlur={this.commit}
                onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                }}
                className={css.width(56).pad2(6, 3).fontSize(12).textAlign("center")
                    .hsl(0, 0, 16).color("white").bord(1, "hsl(0, 0%, 30%)")}
                title="Max L2 distance for a face to count as a match — lower is stricter. Commits on Enter or blur, and re-searches every open face."
            />
        </label>;
    }
}

const expanderBtn = css.fontSize(11).pad2(6, 2).pointer.hsl(0, 0, 16)
    .color("hsl(0, 0%, 78%)").bord(1, "hsl(0, 0%, 26%)")
    .hslhover(0, 0, 22) + RS.Button;
const expanderBtnActive = css.fontSize(11).pad2(6, 2).pointer.hsl(50, 40, 30)
    .color("hsl(50, 90%, 85%)").bord(1, "hsl(50, 50%, 40%)") + RS.Button;

@observer
export class FacesModal extends preact.Component {
    private disposeThresholdReaction?: () => void;
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
        // When the threshold changes, results re-key automatically (matchKey
        // reads it reactively), but the fresh key has no cached results — so
        // kick off a search at the new threshold for every currently-open face.
        this.disposeThresholdReaction = reaction(
            () => faceThreshold.value,
            () => {
                searchSession++;
                inFlight.clear();
                for (const ck of expandedVideos) void runCharacterSearch(ck);
            },
        );
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
        this.disposeThresholdReaction?.();
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
        // Live face-embedding column ref. A cached result computed against a
        // different ref is out of date (faces changed under us) — we surface a
        // notice rather than re-scan, so a background face scan can't loop the
        // search forever. Reading it here keeps the modal reactive to changes.
        const embCol = characters.getColumnSync("bestFaceEmbedding");
        let matchesStale = false;

        // Blacklisted faces (global). Any character within the same-person
        // distance of one is pulled out of the normal list and shown in a
        // separate section at the bottom, so we can still spot bad matches.
        const blacklist = getBlacklistedFacesSync();

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
        // Characters that matched a blacklisted face — rendered dimmed at the
        // end so we can verify whether the match was erroneous.
        const blacklistedItems: preact.ComponentChildren[] = [];
        for (const { key: ck, characterIdx } of charKeys) {
            const memberCount = characters.getSingleFieldSync(ck, "memberCount") ?? 0;
            // Ignore one-off / spurious detections (mirrors extraction + the
            // scene merge). A real character recurs in at least 3 frames.
            if (memberCount < 3) continue;
            const bestFaceScore = characters.getSingleFieldSync(ck, "bestFaceScore");

            // If this character's face matches a blacklisted one, relocate it to
            // the blacklisted section instead of the normal list.
            if (blacklist.length > 0) {
                const emb = characters.getSingleFieldSync(ck, "bestFaceEmbedding");
                const hit = emb ? matchBlacklistSync(emb, blacklist) : undefined;
                if (hit) {
                    blacklistedItems.push(<BlacklistedCharacterCard
                        key={ck}
                        characterKey={ck}
                        characterIdx={characterIdx}
                        memberCount={memberCount}
                        bestFaceScore={bestFaceScore}
                        distance={hit.distance}
                        matchedAvatar={hit.entry.avatarJpeg}
                    />);
                    continue;
                }
            }

            const mk = matchKey(ck);
            const matches = matchResults.get(mk);
            const progress = matchProgress.get(mk);
            const videosOpen = expandedVideos.has(ck);
            // Result present but computed against an older face-embedding column
            // → out of date. Only meaningful once both refs are loaded.
            const ranRef = matchColRef.get(mk);
            if (matches && ranRef !== undefined && embCol !== undefined && ranRef !== embCol) {
                matchesStale = true;
            }
            // Opening a face starts its (one-time) library search on demand.
            const toggleVideos = () => {
                runInAction(() => {
                    if (videosOpen) expandedVideos.delete(ck); else expandedVideos.add(ck);
                });
                if (!videosOpen) void runCharacterSearch(ck);
            };

            // Clicking anywhere on the card expands the person's videos; the
            // small ✕ in the corner blacklists the face (a nested button, so the
            // card itself is a div rather than a button).
            items.push(<div
                key={ck}
                onMouseDown={buttonDown(toggleVideos)}
                title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"}`
                    + (bestFaceScore !== undefined ? ` · best-face score ${bestFaceScore.toFixed(2)}` : "")
                    + ` · click to show the videos this person is in`}
                className={css.relative.vbox(6).alignItems("center").pad2(8, 8).pointer
                    + (videosOpen
                        ? css.hsl(50, 30, 16).bord(1, "hsl(50, 50%, 40%)")
                        : css.hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)").hslhover(0, 0, 17))
                    + RS.Button}
            >
                <FaceAvatar characterKey={ck} size={112} />
                <div className={css.fontSize(11).color(videosOpen ? "hsl(50, 90%, 85%)" : "hsl(0, 0%, 78%)")}>
                    {matches ? `${matches.length} video${matches.length === 1 ? "" : "s"}`
                        : progress ? `searching… ${Math.floor(progress.done / Math.max(1, progress.total) * 100)}%`
                        : videosOpen ? "searching…" : `faces (${memberCount})`} {videosOpen ? "▾" : "▸"}
                </div>
                <button
                    onMouseDown={buttonDown(() => { playSound("toggle"); void blacklistFace(ck); })}
                    className={css.absolute.top(2).right(2).size(20, 20).pointer.fontSize(12).lineHeight("18px")
                        .hsla(0, 0, 0, 0.55).color("hsl(0, 0%, 80%)").bord(1, "hsl(0, 0%, 35%)")
                        .color("hsl(0, 80%, 70%)", "hover").hslhover(0, 40, 20) + RS.Button}
                    title="Flag this face as bad — blacklist it and hide it from this list"
                >
                    ✕
                </button>
            </div>);

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
                    const durationSec = files.getSingleFieldSync(m.fileKey, "durationSec");
                    const sizeBytes = files.getSingleFieldSync(m.fileKey, "size");
                    const tooltip = [
                        durationSec ? formatDurationHM(durationSec) : undefined,
                        typeof sizeBytes === "number" ? `${formatNumber(sizeBytes)}B` : undefined,
                        m.distance.toFixed(2),
                        vidName,
                    ].filter(Boolean).join(" · ");
                    // This person's character in the MATCHED video — its frame
                    // times drive both the thumbnail choice and the expander.
                    const matchedCk = characterKey(m.fileKey, m.characterIdx);
                    const frameTimes = faceFrames.getSingleFieldSync(matchedCk, "frameTimes");
                    const times = frameTimes ? Array.from(frameTimes).sort((a, b) => a - b) : [];
                    const thumbUrl = faceThumbUrl(m, times[0]);
                    const timesKey = `${ck}|${m.fileKey}`;
                    const timesOpen = expandedTimes.has(timesKey);
                    items.push(<div key={`${ck}|v|${m.fileKey}`} className={css.vbox(4).width(160)}>
                        <a
                            href={buildPlayerHref(m.fileKey)}
                            className={css.size(160, 90).flexShrink(0).pointer.display("block")
                                .backgroundSize("cover").backgroundPosition("center")
                                .bord(1, "hsl(0, 0%, 24%)")
                                // hsl sets the `background` SHORTHAND, which
                                // clobbers backgroundImage — never both.
                                + (thumbUrl ? css.backgroundImage(`url("${thumbUrl}")`) : css.hsl(0, 0, 16))}
                            title={tooltip}
                            onMouseDown={e => {
                                // Only intercept a plain left-click for SPA nav.
                                // Middle-click / ctrl-click / etc. fall through to
                                // the browser, which opens the href in a
                                // background tab WITHOUT stealing focus.
                                if (!isPlainLeftClick(e)) return;
                                e.preventDefault(); closeFacesModal(); goToPlayer(m.fileKey);
                            }}
                            onClick={e => { if (isPlainLeftClick(e)) e.preventDefault(); }}
                        />
                        <div className={css.fontSize(11).color("hsl(0, 0%, 80%)").maxWidth(160).ellipsis} title={vidName}>
                            {vidName}
                        </div>
                        <button
                            className={(timesOpen ? expanderBtnActive : expanderBtn) + css.alignSelf("flex-start")}
                            onMouseDown={buttonDown(() => runInAction(() => {
                                if (timesOpen) expandedTimes.delete(timesKey); else expandedTimes.add(timesKey);
                            }))}
                            title="Every timestamp this person appears at in this video — click a time to play from 3s before it"
                        >
                            {m.memberCount} time{m.memberCount === 1 ? "" : "s"}{durationSec ? ` · ${formatDurationHM(durationSec)}` : ""} {timesOpen ? "▾" : "▸"}
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
                                return <a
                                    key={i}
                                    href={buildPlayerHref(m.fileKey, { seekSec })}
                                    className={expanderBtn + css.textDecoration("none")}
                                    title={`Face at ${formatDurationHM(sec)} — play from 3s before (middle-click for a new tab)`}
                                    onMouseDown={e => {
                                        if (!isPlainLeftClick(e)) return;
                                        e.preventDefault(); closeFacesModal(); goToPlayer(m.fileKey, seekSec);
                                    }}
                                    onClick={e => { if (isPlainLeftClick(e)) e.preventDefault(); }}
                                >
                                    {formatDurationHM(sec)}
                                </a>;
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
                        onMouseDown={buttonDown(() => runInAction(() => {
                            if (seriesOpen) expandedSeries.delete(seriesKey); else expandedSeries.add(seriesKey);
                        }))}
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
                            onMouseDown={buttonDown(() => runInAction(() => {
                                if (showAll) expandedAll.delete(ck); else expandedAll.add(ck);
                            }))}
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
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeFacesModal(); } }}
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
                {/* Fixed header — never scrolls, so the title stays visible.
                  * Threshold first, then a title that WRAPS (never forces a
                  * horizontal scrollbar), then the close button. */}
                <div className={css.pad2(16, 22).hbox(12).alignItems("flex-start").fillWidth.flexShrink(0)
                    .borderBottom("1px solid hsl(0, 0%, 18%)")}>
                    <ThresholdInput />
                    <div className={css.fontSize(15).flexGrow(1).minWidth(0).overflowWrap("break-word") + RS.ModalTitle}
                        title={name ?? key}>
                        Faces — {name ?? key}
                    </div>
                    <button
                        onMouseDown={buttonDown(() => { playSound("modalOpen"); openBlacklistModal(); })}
                        className={css.fontSize(12).pad2(10, 5).pointer.flexShrink(0).hsl(0, 0, 16)
                            .color("hsl(0, 0%, 82%)").bord(1, "hsl(0, 0%, 30%)").hslhover(0, 0, 22) + RS.Button}
                        title="View and manage the faces you've flagged as bad"
                    >
                        Blacklist{blacklist.length > 0 ? ` (${blacklist.length})` : ""}
                    </button>
                    <button
                        onMouseDown={buttonDown(() => closeFacesModal())}
                        className={modalCloseBtn + css.flexShrink(0)}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                {/* Faces changed under a completed search. We don't auto-rescan
                  * (a background face scan would loop it) — offer a manual
                  * re-run instead, matching the main page's behaviour. */}
                {matchesStale && <div className={css.hbox(8).alignCenter.pad2(10, 22).flexShrink(0).fillWidth
                    .borderBottom("1px solid hsl(0, 0%, 18%)").hsl(50, 30, 12)}>
                    <div className={css.fontSize(12).color("hsl(50, 80%, 75%)").flexGrow(1)}>
                        Face data has changed since these results were found — they may be out of date.
                    </div>
                    <button
                        onMouseDown={buttonDown(() => { playSound("majorAction"); refreshFacesModalSearch(); })}
                        className={controlSurfaceAccent + css.pad2(12, 5).fontSize(12).pointer.flexShrink(0) + RS.ButtonPrimary}
                        title="Re-run the search for every open face over the current face data"
                    >
                        Search again
                    </button>
                </div>}
                <div className={css.pad2(14, 22).flexGrow(1).minHeight(0).overflowY("auto").overflowX("hidden").vbox(12).fillWidth}>
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
                                    onMouseDown={buttonDown(() => void extractFacesNow(key))}
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
                    {blacklistedItems.length > 0 && <div className={css.vbox(8).fillWidth
                        .borderTop("1px solid hsl(0, 0%, 18%)").pad2(0, 0).marginTop(4)}>
                        <div className={css.fontSize(12).color("hsl(0, 60%, 65%)").pad2(0, 8)}>
                            Blacklisted ({blacklistedItems.length}) — these matched a face you flagged as bad
                        </div>
                        <div className={css.hbox(10, 10).wrap.alignItems("flex-start")}>
                            {blacklistedItems}
                        </div>
                    </div>}
                </div>
            </div>
        </div>;
    }
}

// A character that matched a blacklisted face. Dimmed, read-only (no expand /
// search), showing how close it was so we can judge whether the match was
// correct. Its own avatar plus the blacklisted face it matched, side by side.
@observer
class BlacklistedCharacterCard extends preact.Component<{
    characterKey: string;
    characterIdx: number;
    memberCount: number;
    bestFaceScore: number | undefined;
    distance: number;
    matchedAvatar: Uint8Array | undefined;
}> {
    render() {
        const { characterKey: ck, characterIdx, memberCount, bestFaceScore, distance, matchedAvatar } = this.props;
        return <div className={css.vbox(6).alignItems("center").pad2(8, 8).opacity(0.72)
            .hsl(0, 20, 11).bord(1, "hsl(0, 30%, 24%)") + RS.Surface}
            title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"}`
                + (bestFaceScore !== undefined ? ` · best-face score ${bestFaceScore.toFixed(2)}` : "")
                + ` · matched a blacklisted face at distance ${distance.toFixed(2)}`}>
            <div className={css.hbox(4).alignItems("center")}>
                <FaceAvatar characterKey={ck} size={80} />
                <span className={css.fontSize(14).color("hsl(0, 0%, 45%)")}>≈</span>
                <FaceAvatar jpeg={matchedAvatar} size={80} />
            </div>
            <div className={css.fontSize(11).color("hsl(0, 50%, 70%)")}>
                d={distance.toFixed(2)} · {memberCount} frame{memberCount === 1 ? "" : "s"}
            </div>
        </div>;
    }
}
