import * as preact from "preact";
import { observable, runInAction, computed } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { files } from "../appState";
import { modalParam } from "../router";
import { playSound } from "../sounds";
import { cap } from "../search/gridShared";
import { formatBytes } from "../scan/thumbnails";
import { actionBtn, buttonDown, fieldInput, settingsPanelPad } from "../styles";
import { RS } from "../restyle/classNames";

const MODAL_KEY = "libraryDetails";
const PAGE_SIZE = 200;
const SIZE_COLUMN_WIDTH = 110;
const CODEC_COLUMN_WIDTH = 130;
const NOT_SCANNED_LABEL = "(not scanned)";
const NO_AUDIO_LABEL = "(no audio)";
const UNKNOWN_CODEC_LABEL = "(unknown)";

const search = observable.box<string>("");
const limit = observable.box<number>(PAGE_SIZE);

export function openLibraryDetails(): void {
    playSound("modalOpen");
    runInAction(() => {
        search.set("");
        limit.set(PAGE_SIZE);
    });
    modalParam.set(MODAL_KEY);
}
export function closeLibraryDetails(): void {
    playSound("modalClose");
    if (modalParam.get() === MODAL_KEY) modalParam.set("");
}

interface LibraryFile {
    key: string;
    name: string;
    size?: number;
    videoCodec: string;
    audioCodec: string;
    searchText: string;
}
interface CodecGroup {
    codec: string;
    count: number;
    bytes: number;
}
interface LibrarySummary {
    loaded: boolean;
    files: LibraryFile[];
    totalBytes: number;
    unknownSizeCount: number;
    videoCodecs: CodecGroup[];
    audioCodecs: CodecGroup[];
}

function groupByCodec(libraryFiles: LibraryFile[], codecOf: (file: LibraryFile) => string): CodecGroup[] {
    const groups = new Map<string, CodecGroup>();
    for (const file of libraryFiles) {
        const codec = codecOf(file);
        let group = groups.get(codec);
        if (!group) {
            group = { codec, count: 0, bytes: 0 };
            groups.set(codec, group);
        }
        group.count++;
        group.bytes += file.size ?? 0;
    }
    return [...groups.values()].sort((a, b) => (b.bytes - a.bytes) || (b.count - a.count) || a.codec.localeCompare(b.codec));
}

function summarizeLibrary(): LibrarySummary {
    const nameCol = files.getColumnSync("name");
    const sizeCol = files.getColumnSync("size");
    const videoCodecCol = files.getColumnSync("videoCodec");
    const audioCodecCol = files.getColumnSync("audioCodec");
    const metadataVersionCol = files.getColumnSync("metadataVersion");
    if (!nameCol) {
        return { loaded: false, files: [], totalBytes: 0, unknownSizeCount: 0, videoCodecs: [], audioCodecs: [] };
    }
    const byKey = <T,>(col: { key: string; value: T }[] | undefined) => {
        const map = new Map<string, T>();
        if (col) {
            for (const row of col) map.set(row.key, row.value);
        }
        return map;
    };
    const sizes = byKey(sizeCol);
    const videoCodecs = byKey(videoCodecCol);
    const audioCodecs = byKey(audioCodecCol);
    const metadataVersions = byKey(metadataVersionCol);

    const libraryFiles: LibraryFile[] = [];
    let totalBytes = 0;
    let unknownSizeCount = 0;
    for (const { key, value: name } of nameCol) {
        const rawSize = sizes.get(key);
        const size = typeof rawSize === "number" ? rawSize : undefined;
        if (size === undefined) {
            unknownSizeCount++;
        } else {
            totalBytes += size;
        }
        const scanned = metadataVersions.get(key) !== undefined;
        const videoCodec = videoCodecs.get(key) || (scanned ? UNKNOWN_CODEC_LABEL : NOT_SCANNED_LABEL);
        const audioCodec = audioCodecs.get(key) || (scanned ? NO_AUDIO_LABEL : NOT_SCANNED_LABEL);
        const displayName = name || key;
        libraryFiles.push({
            key,
            name: displayName,
            size,
            videoCodec,
            audioCodec,
            searchText: `${displayName} ${key} ${videoCodec} ${audioCodec}`.toLowerCase(),
        });
    }
    libraryFiles.sort((a, b) => ((b.size ?? -1) - (a.size ?? -1)) || a.name.localeCompare(b.name));
    return {
        loaded: true,
        files: libraryFiles,
        totalBytes,
        unknownSizeCount,
        videoCodecs: groupByCodec(libraryFiles, file => file.videoCodec),
        audioCodecs: groupByCodec(libraryFiles, file => file.audioCodec),
    };
}

function percent(part: number, whole: number): string {
    if (whole <= 0) return "";
    return `${(part / whole * 100).toFixed(1)}%`;
}

const muted = css.color("hsl(0, 0%, 62%)") + RS.Muted;
const sectionTitle = css.fontSize(12).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em");
const cellCss = css.pad2(10, 5).fontSize(12).whiteSpace("nowrap").borderBottom("1px solid hsl(0, 0%, 14%)");
const numberCellCss = cellCss.textAlign("right");
const headCss = css.pad2(10, 6).fontSize(11).textAlign("left")
    .hsl(0, 0, 12).borderBottom("1px solid hsl(0, 0%, 20%)") + RS.Muted;
const numberHeadCss = css.pad2(10, 6).fontSize(11).textAlign("right")
    .hsl(0, 0, 12).borderBottom("1px solid hsl(0, 0%, 20%)") + RS.Muted;
const tableBox = css.bord(1, "hsl(0, 0%, 16%)").background("hsl(0, 0%, 9%)");

function renderCodecTable(config: { title: string; groups: CodecGroup[]; fileCount: number; totalBytes: number }) {
    const { title, groups, fileCount, totalBytes } = config;
    return <div className={css.vbox(6).flexGrow(1).minWidth(300)}>
        <div className={sectionTitle}>{cap(title)} ({groups.length})</div>
        <div className={tableBox}>
            <table className={css.fillWidth.borderCollapse("collapse")}>
                <thead>
                    <tr>
                        <th className={headCss}>{cap("codec")}</th>
                        <th className={numberHeadCss}>{cap("files")}</th>
                        <th className={numberHeadCss}>%</th>
                        <th className={numberHeadCss}>{cap("size")}</th>
                        <th className={numberHeadCss}>%</th>
                    </tr>
                </thead>
                <tbody>
                    {groups.map(group => <tr
                        key={group.codec}
                        className={css.pointer.hslhover(0, 0, 14)}
                        title={`Show only ${group.codec} files in the list below`}
                        onClick={() => runInAction(() => {
                            search.set(group.codec);
                            limit.set(PAGE_SIZE);
                        })}
                    >
                        <td className={cellCss}>{group.codec}</td>
                        <td className={numberCellCss}>{group.count.toLocaleString()}</td>
                        <td className={numberCellCss + muted}>{percent(group.count, fileCount)}</td>
                        <td className={numberCellCss} title={`${group.bytes.toLocaleString()} bytes`}>{formatBytes(group.bytes)}</td>
                        <td className={numberCellCss + muted}>{percent(group.bytes, totalBytes)}</td>
                    </tr>)}
                </tbody>
            </table>
        </div>
    </div>;
}

@observer
export class LibraryDetailsModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && modalParam.get() === MODAL_KEY) {
            e.preventDefault();
            closeLibraryDetails();
        }
    };

    private summary = computed<LibrarySummary>(() => summarizeLibrary());

    render() {
        if (modalParam.get() !== MODAL_KEY) return null;
        const summary = this.summary.get();
        const q = search.get().trim().toLowerCase();
        const shownLimit = limit.get();
        const matching = q ? summary.files.filter(file => file.searchText.includes(q)) : summary.files;
        const shown = matching.slice(0, shownLimit);
        let matchingBytes = 0;
        for (const file of matching) matchingBytes += file.size ?? 0;

        return <div
            data-modal="1"
            onMouseDown={e => {
                if (e.currentTarget === e.target) {
                    e.preventDefault();
                    closeLibraryDetails();
                }
            }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(1100).fillWidth.maxHeight("90vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={settingsPanelPad + css.flexGrow(1).minHeight(0).overflowAuto.vbox(14)}>
                    <div className={css.hbox(12).alignItems("center")}>
                        <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>
                            {cap("library details")}
                        </div>
                        <button
                            onMouseDown={buttonDown(() => closeLibraryDetails())}
                            className={actionBtn}
                            title="Close (Esc)"
                        >
                            ✕
                        </button>
                    </div>

                    {!summary.loaded && <div className={css.fontSize(13) + muted}>Loading the library...</div>}

                    {summary.loaded && <>
                        <div className={css.hbox(28).alignItems("baseline").wrap}>
                            <div className={css.hbox(8).alignItems("baseline")}>
                                <span className={css.fontSize(22).fontWeight("bold")}>{summary.files.length.toLocaleString()}</span>
                                <span className={css.fontSize(13) + muted}>{summary.files.length === 1 ? "file" : "files"}</span>
                            </div>
                            <div className={css.hbox(8).alignItems("baseline")} title={`${summary.totalBytes.toLocaleString()} bytes`}>
                                <span className={css.fontSize(22).fontWeight("bold")}>{formatBytes(summary.totalBytes)}</span>
                                <span className={css.fontSize(13) + muted}>total size</span>
                            </div>
                            {summary.unknownSizeCount > 0 && <div className={css.fontSize(12) + muted}>
                                {summary.unknownSizeCount.toLocaleString()} {summary.unknownSizeCount === 1 ? "file has" : "files have"} no recorded size yet and count as 0
                            </div>}
                        </div>

                        <div className={css.hbox(16).alignItems("flex-start").wrap}>
                            {renderCodecTable({ title: "video codecs", groups: summary.videoCodecs, fileCount: summary.files.length, totalBytes: summary.totalBytes })}
                            {renderCodecTable({ title: "audio codecs", groups: summary.audioCodecs, fileCount: summary.files.length, totalBytes: summary.totalBytes })}
                        </div>

                        <div className={css.vbox(6)}>
                            <div className={css.hbox(10).alignItems("center")}>
                                <div className={sectionTitle + css.flexGrow(1)}>
                                    {cap("files")} · {matching.length.toLocaleString()}{q && ` of ${summary.files.length.toLocaleString()}`} · {formatBytes(matchingBytes)} · {cap("largest first")}
                                </div>
                                <input
                                    className={fieldInput + css.maxWidth(320)}
                                    placeholder="Search name, path, or codec..."
                                    value={search.get()}
                                    onInput={e => {
                                        const value = (e.currentTarget as HTMLInputElement).value;
                                        runInAction(() => {
                                            search.set(value);
                                            limit.set(PAGE_SIZE);
                                        });
                                    }}
                                />
                            </div>
                            <div className={tableBox}>
                                <table className={css.fillWidth.borderCollapse("collapse").tableLayout("fixed")}>
                                    <thead>
                                        <tr>
                                            <th className={headCss}>{cap("file")}</th>
                                            <th className={numberHeadCss + css.width(SIZE_COLUMN_WIDTH)}>{cap("size")}</th>
                                            <th className={headCss + css.width(CODEC_COLUMN_WIDTH)}>{cap("video")}</th>
                                            <th className={headCss + css.width(CODEC_COLUMN_WIDTH)}>{cap("audio")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {shown.map(file => <tr key={file.key}>
                                            <td className={cellCss.overflow("hidden").textOverflow("ellipsis")} title={file.key}>{file.name}</td>
                                            <td
                                                className={numberCellCss}
                                                title={file.size !== undefined ? `${file.size.toLocaleString()} bytes` : "size not recorded yet"}
                                            >
                                                {file.size !== undefined ? formatBytes(file.size) : <span className={muted}>—</span>}
                                            </td>
                                            <td className={cellCss.overflow("hidden").textOverflow("ellipsis")}>{file.videoCodec}</td>
                                            <td className={cellCss.overflow("hidden").textOverflow("ellipsis")}>{file.audioCodec}</td>
                                        </tr>)}
                                    </tbody>
                                </table>
                                {shownLimit < matching.length && <div className={css.pad(10)}>
                                    <button
                                        className={actionBtn}
                                        onMouseDown={buttonDown()}
                                        onClick={() => runInAction(() => limit.set(shownLimit + PAGE_SIZE))}
                                    >
                                        {cap("show more")} ({(matching.length - shownLimit).toLocaleString()} {cap("more")})
                                    </button>
                                </div>}
                            </div>
                        </div>
                    </>}
                </div>
            </div>
        </div>;
    }
}
