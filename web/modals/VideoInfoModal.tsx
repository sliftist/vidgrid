// Full file-info modal — opened from the grid (expanded card) and from the
// player overlay. Reads every column we have on the file via reactive sync
// reads so a metadata write that lands while the modal is open updates it.

import { getPositionMs } from "../player/positions";
import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { actionBtn, modalCloseBtn, dangerBtn, reparseStatusPill, buttonDown, selectorBtn, selectorBtnActive } from "../styles";
import { RS } from "../restyle/classNames";
import {
    state, files, thumbnails, keyframes as keyframesDb, characters, removeFromLibrary, transcripts,
    extractMetadataForKey, extractKeyframesForKey, facesScanEnabled,
    saveHdrExposure, DEFAULT_HDR_EXPOSURE, seriesMinVideos, playback,
} from "../appState";
import { Input } from "sliftutils/render-utils/Input";
import { applyLiveExposure, getActiveHdrKey } from "../player/exposureBridge";
import { getSeries, findSeriesForKey } from "../search/series";
import { extractFacesForKey } from "../faces/faceExtraction";
import { NativeLinkButton } from "../player/NativeLinkButton";
import type { MediaTrackInfo } from "../MetadataExtractor";
import { formatBytes, formatDurationHM } from "../scan/thumbnails";
import { decodeKeyframes2, getKeyframes2BlobUrls } from "../scan/keyframes2";
import { formatTime } from "socket-function/src/formatting/format";
import { getCharacterKeysForFileSync, setFaceSearch } from "../faces/faceSearch";
import { FaceAvatar } from "../faces/FaceAvatar";
import { AddToList } from "../lists/AddToList";
import { goToSearch, goToPlayer } from "../router";
import { openThumbnailPicker } from "./ThumbnailPickerModal";
import { playSound } from "../sounds";
import { TranscriptPanel, resetTranscriptFilter } from "../transcript/TranscriptPanel";

const infoModalKey = observable.box<string | undefined>(undefined);

type InfoTab = "overview" | "tracks" | "faces" | "keyframes" | "transcript" | "processing";
type InfoRow = { label: string; value: preact.ComponentChildren };
const infoTab = observable.box<InfoTab>("overview");

export function openVideoInfo(key: string) {
    playSound("modalOpen");
    resetTranscriptFilter();
    runInAction(() => {
        infoTab.set("overview");
        infoModalKey.set(key);
    });
}

function renderInfoTable(rows: InfoRow[]): preact.ComponentChildren {
    if (rows.length === 0) return null;
    return <table className={css.fontSize(12).borderCollapse("collapse")}>
        <tbody>
            {rows.map(({ label, value }) => <tr key={label}>
                <td className={css.pad2(4, 1).color("hsl(0, 0%, 60%)")
                    .verticalAlign("top").whiteSpace("nowrap") + RS.Muted}>
                    {label}
                </td>
                <td className={css.pad2(4, 1)
                    .verticalAlign("top").overflowWrap("break-word")}>{value}</td>
            </tr>)}
        </tbody>
    </table>;
}

function renderEmptyTab(text: string): preact.ComponentChildren {
    return <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>{text}</div>;
}

export function closeVideoInfo() {
    playSound("modalClose");
    runInAction(() => infoModalKey.set(undefined));
}

// Reparse (mirrors the grid cell's Reparse): metadata + thumbnails, keyframe
// strip, then faces. Only one info modal is open at a time, so a single shared
// status object suffices. Faces obey the same Settings kill-switch as the grid.
const reparse = observable({ running: false, status: "" });

async function runReparse(key: string): Promise<void> {
    if (reparse.running) return;
    runInAction(() => { reparse.running = true; reparse.status = ""; });
    const onProgress = (phase: string) => (info: { message: string }) =>
        runInAction(() => { reparse.status = `${phase}: ${info.message}`; });
    try {
        runInAction(() => { reparse.status = "metadata..."; });
        await extractMetadataForKey(key);
        runInAction(() => { reparse.status = "keyframes..."; });
        await extractKeyframesForKey(key, onProgress("keyframes"));
        if (facesScanEnabled.get()) {
            runInAction(() => { reparse.status = "faces..."; });
            await extractFacesForKey(key, onProgress("faces"));
        }
    } finally {
        runInAction(() => { reparse.running = false; reparse.status = ""; });
    }
}

function fmtFullDate(ms: number | undefined): string | undefined {
    if (!ms) return undefined;
    return new Date(ms).toLocaleString();
}

// Keyframe timestamps as m:ss / h:mm:ss (seconds in), matching the thumbnail
// picker — more precise than formatDurationHM, which rounds to whole minutes.
function fmtClock(seconds: number | undefined): string {
    if (seconds === undefined) return "?";
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBitrate(bps: number | undefined): string | undefined {
    if (!bps || bps <= 0) return undefined;
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
    if (bps >= 1000) return `${(bps / 1000).toFixed(0)} kbps`;
    return `${bps} bps`;
}

function fmtSampleRate(hz: number | undefined): string | undefined {
    if (!hz || hz <= 0) return undefined;
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`;
}

const CHANNEL_LAYOUTS: Record<number, string> = { 1: "Mono", 2: "Stereo", 3: "2.1", 6: "5.1", 8: "7.1" };
function fmtChannels(n: number | undefined): string | undefined {
    if (!n || n <= 0) return undefined;
    const layout = CHANNEL_LAYOUTS[n];
    return layout ? `${n} (${layout})` : `${n}`;
}

// Build the label/value rows for one track, in display order, skipping anything
// the extractor couldn't determine.
function trackRows(t: MediaTrackInfo): { label: string; value: string }[] {
    const rows: { label: string; value: string }[] = [];
    const add = (label: string, value: string | number | undefined) => {
        if (value === undefined || value === "" || value === null) return;
        rows.push({ label, value: String(value) });
    };
    add("Codec", t.codec);
    add("Codec string", t.codecString);
    add("Container codec id", t.internalCodecId);
    if (t.kind === "video") {
        if (t.codedWidth && t.codedHeight) add("Coded resolution", `${t.codedWidth} × ${t.codedHeight}`);
        if (t.displayWidth && t.displayHeight
            && (t.displayWidth !== t.codedWidth || t.displayHeight !== t.codedHeight)) {
            add("Display resolution", `${t.displayWidth} × ${t.displayHeight}`);
        }
        add("Frame rate", t.frameRate !== undefined ? `${t.frameRate} fps` : undefined);
        add("Pixel aspect ratio", t.pixelAspectRatio);
        add("Rotation", t.rotation ? `${t.rotation}°` : undefined);
        add("HDR", t.hdr ? "Yes" : undefined);
        add("Color primaries", t.colorPrimaries);
        add("Color transfer", t.colorTransfer);
        add("Color matrix", t.colorMatrix);
        if (t.colorFullRange !== undefined) add("Color range", t.colorFullRange ? "Full" : "Limited");
    } else if (t.kind === "audio") {
        add("Channels", fmtChannels(t.channels));
        add("Sample rate", fmtSampleRate(t.sampleRate));
    }
    add("Bitrate", fmtBitrate(t.bitrate));
    add("Language", t.language);
    add("Name", t.name);
    return rows;
}

function trackHeading(t: MediaTrackInfo): string {
    const kind = t.kind === "video" ? "Video" : t.kind === "audio" ? "Audio" : "Track";
    return t.number ? `${kind} track ${t.number}` : `${kind} track`;
}

@observer
export class VideoInfoModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && infoModalKey.get() !== undefined) {
            e.preventDefault();
            closeVideoInfo();
        }
    };

    render() {
        const key = infoModalKey.get();
        if (!key) return null;

        const name = files.getSingleFieldSync(key, "name");
        const relativePath = files.getSingleFieldSync(key, "relativePath");
        const size = files.getSingleFieldSync(key, "size");
        const durationSec = files.getSingleFieldSync(key, "durationSec");
        const width = files.getSingleFieldSync(key, "width");
        const height = files.getSingleFieldSync(key, "height");
        const videoCodec = files.getSingleFieldSync(key, "videoCodec");
        const audioCodec = files.getSingleFieldSync(key, "audioCodec");
        const mediaInfo = files.getSingleFieldSync(key, "mediaInfo");
        const fileModifiedAt = files.getSingleFieldSync(key, "fileModifiedAt");
        const addedAt = files.getSingleFieldSync(key, "addedAt");
        const positionSec = (getPositionMs(key) ?? 0) / 1000 || undefined;
        const positionUpdatedAt = playback.getSingleFieldSync(key, "positionUpdatedAt");
        const engine = files.getSingleFieldSync(key, "engine");
        const metadataExtractedAt = files.getSingleFieldSync(key, "metadataExtractedAt");
        const metadataExtractionMs = files.getSingleFieldSync(key, "metadataExtractionMs");
        const metadataVersion = files.getSingleFieldSync(key, "metadataVersion");
        const extractionError = files.getSingleFieldSync(key, "extractionError");
        const thumb160 = thumbnails.getSingleFieldSync(key, "thumb160");
        const thumb320 = thumbnails.getSingleFieldSync(key, "thumb320");
        const thumb640 = thumbnails.getSingleFieldSync(key, "thumb640");
        const keyframeBytes = keyframesDb.getSingleFieldSync(key, "keyframes2");
        const keyframeData = decodeKeyframes2(keyframeBytes);
        const keyframesVersion = keyframesDb.getSingleFieldSync(key, "keyframesVersion");
        const keyframesExtractedAt = keyframesDb.getSingleFieldSync(key, "keyframesExtractedAt");
        const keyframesExtractionMs = keyframesDb.getSingleFieldSync(key, "keyframesExtractionMs");
        const keyframesError = keyframesDb.getSingleFieldSync(key, "keyframesError");
        const scanBlacklisted = files.getSingleFieldObjSync(key, "scanBlacklisted");
        const scanBlacklistedAt = files.getSingleFieldSync(key, "scanBlacklistedAt");

        const rows: InfoRow[] = [];
        const processingRows: InfoRow[] = [];
        const keyframeRows: InfoRow[] = [];
        const faceRows: InfoRow[] = [];
        const pushTo = (target: InfoRow[]) => (label: string, value: preact.ComponentChildren | undefined) => {
            if (value === undefined || value === "" || value === null) return;
            target.push({ label, value });
        };
        const push = pushTo(rows);
        const pushProcessing = pushTo(processingRows);
        const pushKeyframe = pushTo(keyframeRows);
        const pushFace = pushTo(faceRows);

        push("Name", name);
        push("Path", relativePath);
        push("Size", size !== undefined ? `${formatBytes(size)} (${size.toLocaleString()} bytes)` : undefined);
        push("Duration", durationSec !== undefined ? `${formatDurationHM(durationSec)} (${durationSec.toFixed(2)}s)` : undefined);
        push("Resolution", width && height ? `${width} × ${height}` : undefined);
        push("Video codec", videoCodec);
        push("Audio codec", audioCodec);
        push("Container", mediaInfo?.format);
        push("File modified", fmtFullDate(fileModifiedAt));
        push("Added to library", fmtFullDate(addedAt));
        push("Resume position",
            positionSec !== undefined && positionSec > 0
                ? `${formatDurationHM(positionSec)} (${positionSec.toFixed(2)}s)`
                : undefined);
        push("Position updated", fmtFullDate(positionUpdatedAt));
        push("Preferred engine", engine);
        let blacklistedText = "No";
        if (scanBlacklisted?.value) blacklistedText = `Yes (${fmtFullDate(scanBlacklistedAt ?? scanBlacklisted.time)})`;
        pushProcessing("Blacklisted", blacklistedText);
        const parseBlacklisted = files.getSingleFieldSync(key, "parseBlacklisted");
        const parseBlacklistedAt = files.getSingleFieldSync(key, "parseBlacklistedAt");
        const parseBlacklistError = files.getSingleFieldSync(key, "parseBlacklistError");
        let parseBlacklistedText = "No";
        if (parseBlacklisted) parseBlacklistedText = `Yes (${fmtFullDate(parseBlacklistedAt)}) — ${parseBlacklistError ?? ""}`;
        pushProcessing("Python parse blacklisted", parseBlacklistedText);
        pushProcessing("Metadata extracted", fmtFullDate(metadataExtractedAt));
        pushProcessing("Extraction time", metadataExtractionMs !== undefined ? formatTime(metadataExtractionMs) : undefined);
        pushProcessing("Metadata version", metadataVersion);
        pushProcessing("Extraction error", extractionError);
        pushProcessing("Thumbnail 160", thumb160 ? formatBytes(thumb160.byteLength) : undefined);
        pushProcessing("Thumbnail 320", thumb320 ? formatBytes(thumb320.byteLength) : undefined);
        pushProcessing("Thumbnail 640", thumb640 ? formatBytes(thumb640.byteLength) : undefined);
        pushKeyframe("Keyframes buffer",
            keyframeBytes
                ? `${formatBytes(keyframeBytes.byteLength)} · ${keyframeData?.count ?? 0} frames @ 1/${keyframeData?.intervalSec ?? "?"}s`
                : undefined);
        pushKeyframe("Keyframes extracted", fmtFullDate(keyframesExtractedAt));
        pushKeyframe("Keyframes extraction time", keyframesExtractionMs !== undefined ? formatTime(keyframesExtractionMs) : undefined);
        pushKeyframe("Keyframes version", keyframesVersion);
        pushKeyframe("Keyframes error", keyframesError);

        const characterCount = files.getSingleFieldSync(key, "characterCount");
        const faceCount = files.getSingleFieldSync(key, "faceCount");
        const facesExtractedAt = files.getSingleFieldSync(key, "facesExtractedAt");
        const facesExtractionMs = files.getSingleFieldSync(key, "facesExtractionMs");
        const facesVersion = files.getSingleFieldSync(key, "facesVersion");
        const facesError = files.getSingleFieldSync(key, "facesError");

        // Per-file character summary. We only need the keys here; each heavy
        // field (avatar JPEG, memberCount, bestFaceTimeMs) is read lazily per
        // key so the modal never materializes a full character record.
        const charKeys = getCharacterKeysForFileSync(key);
        let avatarBytes = 0;
        let avatarCount = 0;
        for (const { key: ck } of charKeys) {
            const avatar = characters.getSingleFieldSync(ck, "avatarJpeg");
            if (avatar && avatar.byteLength > 0) { avatarBytes += avatar.byteLength; avatarCount++; }
        }
        // Per-face: 512 float32 embedding + a handful of small fields ≈ 2 KB.
        const EMBEDDING_BYTES = 2048;
        const facesBytes = (typeof faceCount === "number" ? faceCount : 0) * EMBEDDING_BYTES;

        pushFace("Characters", typeof characterCount === "number" ? `${characterCount}` : undefined);
        pushFace("Faces", typeof faceCount === "number" ? `${faceCount}` : undefined);
        pushFace("Avatar storage", avatarCount > 0 ? `${avatarCount} · ${formatBytes(avatarBytes)} JPEG` : undefined);
        pushFace("Face embedding storage", facesBytes > 0 ? `${formatBytes(facesBytes)} (${faceCount ?? 0} × ${formatBytes(EMBEDDING_BYTES)})` : undefined);
        pushFace("Faces extracted", fmtFullDate(facesExtractedAt));
        pushFace("Faces extraction time", facesExtractionMs !== undefined ? formatTime(facesExtractionMs) : undefined);
        pushFace("Faces version", facesVersion);
        pushFace("Faces error", facesError);

        push("Key", key);

        const transcriptVersion = transcripts.getSingleFieldSync(key, "transcriptVersion");
        const transcriptWordCount = transcripts.getSingleFieldSync(key, "transcriptWordCount");
        const transcriptError = transcripts.getSingleFieldSync(key, "transcriptError");
        pushProcessing("Transcript version", transcriptVersion);
        pushProcessing("Transcript extracted", fmtFullDate(transcripts.getSingleFieldSync(key, "transcriptExtractedAt")));
        pushProcessing("Transcript words", transcriptWordCount);
        pushProcessing("Transcript error", transcriptError);

        const trackCount = mediaInfo?.tracks.length ?? 0;
        const hasTranscript = transcriptVersion !== undefined && !transcriptError && (transcriptWordCount ?? 0) > 0;
        const tabs: { tab: InfoTab; label: string }[] = [
            { tab: "overview", label: "Overview" },
            { tab: "tracks", label: trackCount > 0 ? `Tracks (${trackCount})` : "Tracks" },
            { tab: "faces", label: charKeys.length > 0 ? `Faces (${charKeys.length})` : "Faces" },
            { tab: "keyframes", label: keyframeData && keyframeData.count > 0 ? `Keyframes (${keyframeData.count})` : "Keyframes" },
            { tab: "transcript", label: hasTranscript ? `Transcript (${(transcriptWordCount ?? 0).toLocaleString()} words)` : "Transcript" },
            { tab: "processing", label: "Processing" },
        ];
        const activeTab = infoTab.get();

        // HDR tone-map exposure control — only shown for HDR (PQ/HLG) video,
        // since the renderer's tone-map (and thus this knob) is a no-op for SDR.
        // Container metadata frequently fails to tag HDR (hasHighDynamicRange()
        // returns false, colorTransfer isn't stored as pq). The decoder-derived
        // signal from the active player is authoritative, so fall back to it.
        const isHdrVideo = getActiveHdrKey() === key || !!mediaInfo?.tracks?.some(t =>
            t.kind === "video" && (t.hdr || t.colorTransfer === "pq" || t.colorTransfer === "hlg"));
        const hdrExposure = files.getSingleFieldSync(key, "hdrExposure") ?? DEFAULT_HDR_EXPOSURE;
        let hdrInSeries = false;
        if (isHdrVideo) {
            const nameCol = files.getColumnSync("name");
            const pathCol = files.getColumnSync("relativePath");
            if (nameCol && pathCol) {
                const pathByKey = new Map<string, string>();
                for (const { key: k, value } of pathCol) pathByKey.set(k, value);
                const recs: { key: string; name: string; relativePath: string }[] = [];
                for (const { key: k, value: n } of nameCol) {
                    const rp = pathByKey.get(k);
                    if (rp) recs.push({ key: k, name: n, relativePath: rp });
                }
                hdrInSeries = !!findSeriesForKey(getSeries(recs, seriesMinVideos.get()), key);
            }
        }
        const applyExposure = (ls: number) => {
            if (!Number.isFinite(ls)) return;
            applyLiveExposure(ls);
            void saveHdrExposure(key, ls);
        };

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeVideoInfo(); } }}
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
                {/* fillWidth: the panel is .vbox(0) (align-items: start), which
                  * would otherwise shrink this scroll area to its content width
                  * and float the scrollbar in the middle of the panel. */}
                <div className={css.pad2(18, 22).flexGrow(1).minHeight(0).overflowAuto.vbox(10).fillWidth}>
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(15).flexGrow(1).ellipsis + RS.ModalTitle} title={name ?? key}>
                        {name ?? key}
                    </div>
                    <button
                        onMouseDown={buttonDown(() => { closeVideoInfo(); openThumbnailPicker(key); })}
                        className={actionBtn}
                        title="Pick a custom thumbnail from the video's keyframes"
                    >
                        Pick thumbnail
                    </button>
                    <button
                        onMouseDown={buttonDown(() => closeVideoInfo())}
                        className={modalCloseBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.hbox(8, 6).wrap.alignCenter.fillWidth}>
                    <NativeLinkButton rootName={state.rootName} relativePath={relativePath ?? undefined} />
                    <button
                        disabled={reparse.running}
                        onMouseDown={buttonDown(() => void runReparse(key))}
                        className={actionBtn}
                        title="Re-run metadata + thumbnail + keyframe + face extraction for this file"
                    >
                        {reparse.running ? "..." : "Reparse"}
                    </button>
                    {reparse.running && reparse.status && <div className={reparseStatusPill} title={reparse.status}>
                        {reparse.status}
                    </div>}
                    <button
                        onMouseDown={buttonDown(() => { void removeFromLibrary(key); closeVideoInfo(); })}
                        className={dangerBtn + css.marginLeft("auto")}
                        title="Remove this file from the library and skip it on future scans (does not delete the file on disk)"
                    >
                        Remove from library
                    </button>
                </div>
                <div className={css.hbox(6, 6).wrap.alignCenter.fillWidth}>
                    {tabs.map(({ tab, label }) => <button
                        key={tab}
                        onMouseDown={buttonDown(() => runInAction(() => infoTab.set(tab)))}
                        className={tab === activeTab ? selectorBtnActive : selectorBtn}
                    >
                        {label}
                    </button>)}
                </div>
                {activeTab === "overview" && isHdrVideo && <div className={css.vbox(6).fillWidth.pad2(10, 12)
                    .hsl(0, 0, 13).bord(1, "hsl(0, 0%, 22%)")}>
                    <div className={css.hbox(10).alignCenter}>
                        <div className={css.fontSize(13).color("hsl(0, 0%, 82%)")}>HDR brightness</div>
                        <Input
                            hot
                            type="number"
                            step={10}
                            min={20}
                            max={1000}
                            value={String(hdrExposure)}
                            onChangeValue={v => applyExposure(Number(v))}
                            className={css.width(90).pad2(4, 8).hsl(0, 0, 8).color("white")
                                .bord(1, "hsl(0, 0%, 30%)")}
                        />
                        <button
                            onMouseDown={buttonDown(() => applyExposure(DEFAULT_HDR_EXPOSURE))}
                            className={actionBtn}
                            title={`Reset to default (${DEFAULT_HDR_EXPOSURE})`}
                        >
                            Reset
                        </button>
                    </div>
                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>
                        HDR→SDR brightness. Higher is brighter (colors unchanged), lower is
                        darker. {hdrInSeries ? "Applies to the whole series." : "Applies to this video."}
                    </div>
                </div>}
                {activeTab === "overview" && renderInfoTable(rows)}
                {activeTab === "overview" && <AddToList itemKey={key} itemType="video" heading="Lists" />}
                {activeTab === "processing" && renderInfoTable(processingRows)}
                {activeTab === "transcript" && <TranscriptPanel
                    fileKey={key}
                    onSeek={seconds => {
                        closeVideoInfo();
                        goToPlayer(key, seconds);
                    }}
                />}
                {activeTab === "tracks" && trackCount === 0 && renderEmptyTab("No track details were extracted for this file.")}
                {activeTab === "tracks" && mediaInfo && trackCount > 0 && <div className={css.vbox(10)}>
                    {mediaInfo.tracks.map((t, idx) => {
                        const tRows = trackRows(t);
                        if (tRows.length === 0) return null;
                        return <div key={idx} className={css.vbox(4)}>
                            <div className={css.fontSize(13).color("hsl(0, 0%, 70%)") + RS.Muted}>
                                {trackHeading(t)}
                            </div>
                            {renderInfoTable(tRows)}
                        </div>;
                    })}
                </div>}
                {activeTab === "faces" && renderInfoTable(faceRows)}
                {activeTab === "faces" && faceRows.length === 0 && charKeys.length === 0 && renderEmptyTab("No faces have been extracted for this file.")}
                {activeTab === "keyframes" && renderInfoTable(keyframeRows)}
                {activeTab === "keyframes" && keyframeRows.length === 0 && renderEmptyTab("No keyframes have been extracted for this file.")}
                {activeTab === "faces" && charKeys.length > 0 && <div className={css.vbox(6)}>
                    <div className={css.fontSize(13).color("hsl(0, 0%, 70%)") + RS.Muted}>
                        Characters ({charKeys.length})
                    </div>
                    <div className={css.hbox(8, 2).wrap}>
                        {charKeys.map(({ key: ck, characterIdx }) => {
                            const memberCount = characters.getSingleFieldSync(ck, "memberCount") ?? 0;
                            const bestFaceTimeMs = characters.getSingleFieldSync(ck, "bestFaceTimeMs") ?? 0;
                            const bestFaceScore = characters.getSingleFieldSync(ck, "bestFaceScore");
                            return <div key={ck} className={css.vbox(4).alignCenter}>
                                <FaceAvatar
                                    characterKey={ck}
                                    size={64}
                                    title={`#${characterIdx} · ${memberCount} frame${memberCount === 1 ? "" : "s"} · best at ${(bestFaceTimeMs / 1000).toFixed(1)}s`
                                        + (bestFaceScore !== undefined ? ` · score ${bestFaceScore.toFixed(2)}` : "")
                                        + ` · click to search`}
                                    onClick={async () => {
                                        const emb = await characters.getSingleField(ck, "bestFaceEmbedding");
                                        if (!emb) return;
                                        setFaceSearch(emb);
                                        closeVideoInfo();
                                        goToSearch();
                                    }}
                                />
                                <div className={css.fontSize(10).color("hsl(0, 0%, 75%)").alignSelf("center") + RS.Muted}>
                                    #{characterIdx} · {memberCount}
                                </div>
                            </div>;
                        })}
                    </div>
                </div>}
                {activeTab === "keyframes" && keyframeBytes && keyframeData && keyframeData.count > 0 && <div className={css.vbox(6)}>
                    <div className={css.fontSize(13).color("hsl(0, 0%, 70%)") + RS.Muted}>
                        Keyframes ({keyframeData.count})
                    </div>
                    <div className={css.hbox(6, 2).wrap}>
                        {getKeyframes2BlobUrls(keyframeBytes, keyframeData.offsets).map((url, idx) => {
                            const start = keyframeData!.offsets[idx];
                            const end = keyframeData!.offsets[idx + 1];
                            const truncated = end > keyframeBytes!.byteLength;
                            return <div
                                key={idx}
                                className={css.vbox(4).alignItems("flex-start")}
                            >
                                <div
                                    title={`Frame at ${fmtClock(keyframeData!.times[idx] ?? 0)}`}
                                    className={css.relative.size(160, 90).flexShrink(0)
                                        .backgroundSize("cover").backgroundPosition("center")
                                        + (truncated ? css.hsl(0, 0, 16) : css.backgroundImage(`url("${url}")`))
                                        + css.bord(1, truncated ? "hsl(0, 50%, 40%)" : "hsl(0, 0%, 22%)")}
                                >
                                    <div className={css.absolute.bottom(2).left(2).pad2(5, 1)
                                        .fontSize(10).color("white").background("hsla(0, 0%, 0%, 0.65)") + RS.Surface}>
                                        {fmtClock(keyframeData!.times[idx] ?? 0)}
                                    </div>
                                </div>
                                {truncated && <div className={css.fontSize(10).color("hsl(0, 70%, 70%)")
                                    .maxWidth(160).overflowWrap("break-word") + RS.Accent}>
                                    range {start}-{end}, file ended at {keyframeBytes!.byteLength}
                                </div>}
                            </div>;
                        })}
                    </div>
                </div>}
                </div>
            </div>
        </div>;
    }
}
