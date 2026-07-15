import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatTime } from "socket-function/src/formatting/format";

import {
    files,
    keyframes as keyframesDb,
    keyframesCollectionAllowed,
    keyframesHasBeenAccessed,
    markKeyframesAccessed,
    scanSoftwareDecode, setScanSoftwareDecode,
} from "../appState";
import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { ScanStatus } from "../scan/ScanStatus";
import { goToSearch } from "../router";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { cap } from "../search/gridShared";
import { buttonDown } from "../styles";
import { playSound } from "../sounds";

// The Scanning page: the shared status bar on top, a software-decode toggle, and
// a searchable, paginated table of every file's per-phase scan status — sorted
// MOST-RECENTLY-SCANNED FIRST so the rows the worker just touched are at the top
// (this ordering is the point of the page). Replaces the old ScanReportModal.

const PAGE_SIZE = 100;

function fmtWhen(ts: number | undefined): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleString();
}
function fmtDur(ms: number | undefined): string {
    return ms && ms > 0 ? formatTime(ms) : "—";
}

@observer
export class ScanningPage extends preact.Component {
    private query = observable.box("");
    private limit = observable.box(PAGE_SIZE);

    componentDidMount() {
        // This page shows keyframe scan times, which need the keyframes column;
        // opt this page in so the counts/times populate.
        markKeyframesAccessed();
    }

    render() {
        const q = this.query.get().trim().toLowerCase();
        const limit = this.limit.get();

        // Columns read reactively — the worker's writes re-render this live.
        const nameCol = files.getColumnSync("name");
        const metaAtCol = files.getColumnSync("metadataExtractedAt");
        const metaMsCol = files.getColumnSync("metadataExtractionMs");
        const metaVerCol = files.getColumnSync("metadataVersion");
        const metaErrCol = files.getColumnSync("extractionError");
        const facesAtCol = files.getColumnSync("facesExtractedAt");
        const facesVerCol = files.getColumnSync("facesVersion");
        const kfAllowed = keyframesCollectionAllowed() && keyframesHasBeenAccessed.get();
        const kfAtCol = kfAllowed ? keyframesDb.getColumnSync("keyframesExtractedAt") : undefined;
        const kfMsCol = kfAllowed ? keyframesDb.getColumnSync("keyframesExtractionMs") : undefined;
        const kfVerCol = kfAllowed ? keyframesDb.getColumnSync("keyframesVersion") : undefined;

        const byKey = <T,>(col: { key: string; value: T }[] | undefined) => {
            const m = new Map<string, T>();
            if (col) for (const r of col) m.set(r.key, r.value);
            return m;
        };
        const names = byKey(nameCol);
        const metaAt = byKey(metaAtCol);
        const metaMs = byKey(metaMsCol);
        const metaVer = byKey(metaVerCol);
        const metaErr = byKey(metaErrCol);
        const facesAt = byKey(facesAtCol);
        const facesVer = byKey(facesVerCol);
        const kfAt = byKey(kfAtCol);
        const kfMs = byKey(kfMsCol);
        const kfVer = byKey(kfVerCol);

        interface Row {
            key: string; name: string;
            lastScanAt: number;
            metaAt?: number; metaMs?: number; metaDone: boolean; metaErr?: string;
            kfAt?: number; kfMs?: number; kfDone: boolean;
            facesAt?: number; facesDone: boolean;
        }
        const rows: Row[] = [];
        for (const [key, name] of names) {
            if (q && !name.toLowerCase().includes(q) && !key.toLowerCase().includes(q)) continue;
            const mA = metaAt.get(key);
            const kA = kfAt.get(key);
            const fA = facesAt.get(key);
            rows.push({
                key, name,
                lastScanAt: Math.max(mA ?? 0, kA ?? 0, fA ?? 0),
                metaAt: mA, metaMs: metaMs.get(key), metaDone: metaVer.get(key) === METADATA_VERSION, metaErr: metaErr.get(key) || undefined,
                kfAt: kA, kfMs: kfMs.get(key), kfDone: kfVer.get(key) === KEYFRAMES_VERSION,
                facesAt: fA, facesDone: facesVer.get(key) === FACES_VERSION,
            });
        }
        // Most-recently-scanned first (files never scanned sort to the bottom).
        rows.sort((a, b) => b.lastScanAt - a.lastScanAt);
        const total = rows.length;
        const shown = rows.slice(0, limit);

        const cellCss = css.pad2(8, 4).fontSize(12).whiteSpace("nowrap");
        const headCss = cellCss.color("hsl(0,0%,65%)").textAlign("left").fontWeight("normal").position("sticky").top(0).hsl(0, 0, 12);

        return <div className={css.vbox(14).minHeight("100vh").hsl(0, 0, 7).color("hsl(0,0%,88%)").pad(16)}>
            <div className={css.hbox(12).alignItems("center")}>
                <button
                    className={css.pad2(8, 5).borderRadius(4).cursor("pointer").fontSize(12)
                        .border("1px solid hsl(0,0%,30%)").background("hsl(0,0%,16%)").color("white")}
                    onMouseDown={buttonDown()}
                    onClick={() => { playSound("navMove"); goToSearch(); }}
                >
                    ← {cap("back to grid")}
                </button>
                <div className={css.fontSize(20).fontWeight("bold")}>{cap("background scanning")}</div>
            </div>

            <ScanStatus compact />

            {/* Software-decode toggle (mirrors the one in Settings). */}
            <label className={css.hbox(8).alignItems("center").cursor("pointer").fontSize(13)}>
                <input
                    type="checkbox"
                    checked={scanSoftwareDecode.get()}
                    onChange={e => { playSound("toggle"); setScanSoftwareDecode((e.target as HTMLInputElement).checked); }}
                />
                {cap("use software (CPU) decode while scanning")}
                <span className={css.fontSize(11).opacity(0.6)}>— independent of the player's decode setting</span>
            </label>

            <input
                className={css.pad2(10, 6).fontSize(13).fillWidth.maxWidth(420)
                    .border("1px solid hsl(0,0%,26%)").borderRadius(4).hsl(0, 0, 12).color("white")}
                placeholder="Search files…"
                value={this.query.get()}
                onInput={e => runInAction(() => this.query.set((e.target as HTMLInputElement).value))}
            />

            <div className={css.fontSize(12).opacity(0.65)}>
                {cap("showing")} {Math.min(limit, total)} / {total} {cap("files")} · {cap("most recently scanned first")}
            </div>

            <div className={css.fillWidth.overflowX("auto").border("1px solid hsl(0,0%,16%)").borderRadius(6)}>
                <table className={css.fillWidth.borderCollapse("collapse")}>
                    <thead>
                        <tr>
                            <th className={headCss}>{cap("file")}</th>
                            <th className={headCss}>{cap("metadata")}</th>
                            <th className={headCss}>{cap("keyframes")}</th>
                            <th className={headCss}>{cap("faces")}</th>
                            <th className={headCss}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map(r => <tr key={r.key} className={css.borderTop("1px solid hsl(0,0%,14%)")}>
                            <td className={cellCss.maxWidth(360).overflow("hidden").textOverflow("ellipsis")} title={r.key}>
                                {r.name}
                            </td>
                            <td className={cellCss}>
                                <span className={r.metaErr ? css.color("hsl(0,60%,60%)") : (r.metaDone ? css.color("hsl(140,45%,60%)") : css.opacity(0.5))}>
                                    {r.metaErr ? "error" : (r.metaDone ? fmtWhen(r.metaAt) : "pending")}
                                </span>
                                {r.metaDone && !r.metaErr && <span className={css.opacity(0.55).marginLeft(6)}>{fmtDur(r.metaMs)}</span>}
                            </td>
                            <td className={cellCss}>
                                <span className={r.kfDone ? css.color("hsl(140,45%,60%)") : css.opacity(0.5)}>
                                    {r.kfDone ? fmtWhen(r.kfAt) : (kfAllowed ? "pending" : "?")}
                                </span>
                                {r.kfDone && <span className={css.opacity(0.55).marginLeft(6)}>{fmtDur(r.kfMs)}</span>}
                            </td>
                            <td className={cellCss}>
                                <span className={r.facesDone ? css.color("hsl(140,45%,60%)") : css.opacity(0.5)}>
                                    {r.facesDone ? fmtWhen(r.facesAt) : "—"}
                                </span>
                            </td>
                            <td className={cellCss}>
                                <button
                                    className={css.pad2(6, 3).fontSize(11).cursor("pointer").borderRadius(3)
                                        .border("1px solid hsl(0,0%,28%)").hsl(0, 0, 16).color("white")}
                                    onMouseDown={buttonDown()}
                                    onClick={() => { playSound("modalOpen"); openVideoInfo(r.key); }}
                                >
                                    {cap("info")}
                                </button>
                            </td>
                        </tr>)}
                    </tbody>
                </table>
            </div>

            {limit < total && <button
                className={css.pad2(12, 7).borderRadius(4).cursor("pointer").fontSize(13).alignSelf("flex-start")
                    .border("1px solid hsl(0,0%,30%)").hsl(0, 0, 16).color("white")}
                onMouseDown={buttonDown()}
                onClick={() => runInAction(() => this.limit.set(limit + PAGE_SIZE))}
            >
                {cap("show more")} ({total - limit} {cap("more")})
            </button>}
        </div>;
    }
}
