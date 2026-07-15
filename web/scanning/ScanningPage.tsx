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
    keyframesScanEnabled, facesScanEnabled,
} from "../appState";
import { METADATA_VERSION, KEYFRAMES_VERSION, FACES_VERSION } from "../MetadataExtractor";
import { ScanStatus } from "../scan/ScanStatus";
import { forceRescanAll, forceRescanFile, forceRescanFileAllPhases, forceFullRescan } from "../scan/scanCommands";
import { recentScanErrors, clearScanErrors } from "../scan/scanErrors";
import { goToSearch, scanSearch, scanOnlyUnscanned } from "../router";
import { openVideoInfo } from "../modals/VideoInfoModal";
import { cap } from "../search/gridShared";
import { buttonDown, actionBtn, primaryBtn, dangerBtn, chipBtn, chipDim, cellActionBtn, fieldInput, checkboxInput, sidebarSectionTitle } from "../styles";
import { RS } from "../restyle/classNames";
import { playSound } from "../sounds";

// The Scanning page: the shared status bar on top, a software-decode toggle,
// force-rescan controls, and a searchable, paginated table of every file's
// per-phase scan status — sorted MOST-RECENTLY-SCANNED FIRST. Replaces the old
// ScanReportModal. Uses the app's shared control styles throughout.

const PAGE_SIZE = 100;

function fmtWhen(ts: number | undefined): string {
    return ts ? new Date(ts).toLocaleString() : "—";
}
function fmtDur(ms: number | undefined): string {
    return ms && ms > 0 ? formatTime(ms) : "—";
}

@observer
export class ScanningPage extends preact.Component {
    private limit = observable.box(PAGE_SIZE);

    componentDidMount() {
        // This page shows keyframe scan times; opt it in so the column populates.
        markKeyframesAccessed();
    }

    render() {
        const q = scanSearch.value.trim().toLowerCase();
        const limit = this.limit.get();

        const onlyUnscanned = scanOnlyUnscanned.value;
        const kfEnabled = keyframesScanEnabled.get();
        const facesEnabled = facesScanEnabled.get();

        const nameCol = files.getColumnSync("name");
        const metaAtCol = files.getColumnSync("metadataExtractedAt");
        const metaMsCol = files.getColumnSync("metadataExtractionMs");
        const metaVerCol = files.getColumnSync("metadataVersion");
        const metaErrCol = files.getColumnSync("extractionError");
        const facesAtCol = files.getColumnSync("facesExtractedAt");
        const facesMsCol = files.getColumnSync("facesExtractionMs");
        const facesVerCol = files.getColumnSync("facesVersion");
        const touchedCol = files.getColumnSync("lastTouchedAt");
        const kfAllowed = keyframesCollectionAllowed() && keyframesHasBeenAccessed.get();
        const kfAtCol = kfAllowed ? keyframesDb.getColumnSync("keyframesExtractedAt") : undefined;
        const kfMsCol = kfAllowed ? keyframesDb.getColumnSync("keyframesExtractionMs") : undefined;
        const kfVerCol = kfAllowed ? keyframesDb.getColumnSync("keyframesVersion") : undefined;
        const kfErrCol = kfAllowed ? keyframesDb.getColumnSync("keyframesError") : undefined;
        const facesErrCol = files.getColumnSync("facesError");

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
        const facesMs = byKey(facesMsCol);
        const facesVer = byKey(facesVerCol);
        const touched = byKey(touchedCol);
        const facesErr = byKey(facesErrCol);
        const kfAt = byKey(kfAtCol);
        const kfMs = byKey(kfMsCol);
        const kfVer = byKey(kfVerCol);
        const kfErr = byKey(kfErrCol);

        // Total time spent scanning each phase across the whole library.
        const sumMs = (m: Map<string, number | undefined>) => {
            let s = 0;
            for (const v of m.values()) if (typeof v === "number") s += v;
            return s;
        };
        const totalMetaMs = sumMs(metaMs);
        const totalKfMs = sumMs(kfMs);
        const totalFacesMs = sumMs(facesMs);

        interface Row {
            key: string; name: string; lastScanAt: number; touchedAt: number;
            metaAt?: number; metaMs?: number; metaDone: boolean; metaErr?: string;
            kfAt?: number; kfMs?: number; kfDone: boolean; kfErr?: string;
            facesAt?: number; facesMs?: number; facesDone: boolean; facesErr?: string;
        }
        const rows: Row[] = [];
        for (const [key, name] of names) {
            const mA = metaAt.get(key), kA = kfAt.get(key), fA = facesAt.get(key);
            const metaDone = metaVer.get(key) === METADATA_VERSION;
            const kfDone = kfVer.get(key) === KEYFRAMES_VERSION;
            const facesDone = facesVer.get(key) === FACES_VERSION;
            const mErr = metaErr.get(key) || undefined;
            const kErr = kfErr.get(key) || undefined;
            const fErr = facesErr.get(key) || undefined;
            // "Unscanned" = not done with every currently-enabled phase.
            const isUnscanned = !metaDone || (kfEnabled && kfAllowed && !kfDone) || (facesEnabled && !facesDone);
            if (onlyUnscanned && !isUnscanned) continue;
            // Search matches name, path, the actual error messages, and status
            // words — so typing "error" (or "pending") finds those files.
            if (q) {
                const hay = [
                    name, key, mErr, kErr, fErr,
                    (mErr || kErr || fErr) ? "error" : "",
                    isUnscanned ? "pending unscanned" : "scanned done",
                ].join(" ").toLowerCase();
                if (!hay.includes(q)) continue;
            }
            rows.push({
                key, name,
                lastScanAt: Math.max(mA ?? 0, kA ?? 0, fA ?? 0),
                touchedAt: touched.get(key) ?? 0,
                metaAt: mA, metaMs: metaMs.get(key), metaDone, metaErr: mErr,
                kfAt: kA, kfMs: kfMs.get(key), kfDone, kfErr: kErr,
                facesAt: fA, facesMs: facesMs.get(key), facesDone, facesErr: fErr,
            });
        }
        // Recently-touched (opened/played) files first, then most-recently-scanned.
        rows.sort((a, b) => (b.touchedAt - a.touchedAt) || (b.lastScanAt - a.lastScanAt));
        const total = rows.length;
        const shown = rows.slice(0, limit);
        const errors = recentScanErrors();

        const muted = css.color("hsl(0, 0%, 62%)") + RS.Muted;
        const doneColor = css.color("hsl(140, 45%, 62%)");
        const cellCss = css.pad2(10, 5).fontSize(12).whiteSpace("nowrap").borderBottom("1px solid hsl(0, 0%, 14%)");
        const headCss = css.pad2(10, 6).fontSize(11).textAlign("left").position("sticky").top(0)
            .hsl(0, 0, 12).borderBottom("1px solid hsl(0, 0%, 20%)") + RS.Muted;

        // One phase column cell: the specific error (red, truncated + full on
        // hover), else the done time + duration, else the pending placeholder.
        const phaseCell = (done: boolean, at: number | undefined, ms: number | undefined, err: string | undefined, pendingLabel: string) => {
            if (err) return <td className={cellCss}>
                <span className={css.color("hsl(0, 60%, 64%)").display("inline-block").maxWidth(320)
                    .overflow("hidden").textOverflow("ellipsis").verticalAlign("bottom")} title={err}>
                    error: {err}
                </span>
            </td>;
            if (done) return <td className={cellCss}>
                <span className={doneColor}>{fmtWhen(at)}</span>
                <span className={css.marginLeft(6) + muted}>{fmtDur(ms)}</span>
            </td>;
            return <td className={cellCss}><span className={muted}>{pendingLabel}</span></td>;
        };

        return <div className={css.vbox(14).minHeight("100vh").pad(16) + RS.Page}>
            <div className={css.hbox(12).alignItems("center")}>
                <button className={actionBtn} onMouseDown={buttonDown()} onClick={() => { playSound("navMove"); goToSearch(); }}>
                    ← {cap("back to grid")}
                </button>
                <div className={css.fontSize(18).fontWeight("bold") + RS.ModalTitle}>{cap("background scanning")}</div>
            </div>

            <ScanStatus compact />

            {/* Software-decode toggle — same row look as the Settings modal. */}
            <label className={css.hbox(10).alignStart.pad(8).maxWidth(560).hsl(0, 0, 13)
                .bord(1, "hsl(0, 0%, 20%)").pointer.hslhover(0, 0, 16) + RS.Surface}>
                <input
                    type="checkbox"
                    className={checkboxInput + css.marginTop(2)}
                    checked={scanSoftwareDecode.get()}
                    onChange={e => { playSound("toggle"); setScanSoftwareDecode((e.currentTarget as HTMLInputElement).checked); }}
                />
                <div className={css.vbox(3).flexGrow(1)}>
                    <div className={css.fontSize(13)}>{cap("software (CPU) decode while scanning")}</div>
                    <div className={css.fontSize(11) + muted}>Independent of the player's decode setting — force the background scanner onto the CPU.</div>
                </div>
            </label>

            {/* Force a re-run. The Full scan button (what you usually want) does
              * every phase; the per-phase buttons re-run just one. */}
            <div className={css.vbox(6).alignItems("flex-start")}>
                <div className={sidebarSectionTitle}>{cap("force re-scan")}</div>
                <div className={css.hbox(6, 2).wrap.alignItems("center")}>
                    <button
                        className={primaryBtn}
                        onMouseDown={buttonDown()}
                        onClick={() => { playSound("scanStart"); void forceFullRescan(); }}
                        title="Enable every phase and re-scan the whole library across all phases (metadata, keyframes, faces)."
                    >
                        {cap("full scan")}
                    </button>
                    {(["metadata", "keyframes", "faces"] as const).map(phase => <button
                        key={phase}
                        className={chipBtn}
                        onMouseDown={buttonDown()}
                        onClick={() => { playSound("scanStart"); void forceRescanAll(phase); }}
                        title={`Clear every file's ${phase} version so the worker re-extracts it`}
                    >
                        {cap(phase)}
                    </button>)}
                </div>
            </div>

            {/* Recent scan errors reported by the background worker. */}
            {errors.length > 0 && <div className={css.vbox(6).alignItems("flex-start").fillWidth}>
                <div className={css.hbox(10).alignItems("center")}>
                    <div className={sidebarSectionTitle}>{cap("scan errors")} ({errors.length})</div>
                    <button className={chipBtn} onMouseDown={buttonDown()} onClick={() => { playSound("toggle"); void clearScanErrors(); }}>
                        {cap("clear")}
                    </button>
                </div>
                <div className={css.vbox(2).fillWidth.maxHeight(180).overflowY("auto")
                    .bord(1, "hsl(0, 60%, 30%)").background("hsl(0, 40%, 8%)").pad(8)}>
                    {errors.slice(0, 50).map(e => <div key={e.key} className={css.fontSize(11).fillWidth}>
                        <span className={css.color("hsl(0, 60%, 66%)")}>[{e.phase ?? "scan"}]</span>
                        {e.file && <span className={css.color("hsl(0, 0%, 80%)").marginLeft(6)}>{e.file}</span>}
                        <span className={css.color("hsl(0, 0%, 60%)").marginLeft(6)}>— {e.message}</span>
                    </div>)}
                </div>
            </div>}

            <input
                className={fieldInput}
                placeholder="Search files (name, path, error, status)…"
                value={scanSearch.value}
                onInput={e => { scanSearch.value = (e.currentTarget as HTMLInputElement).value; }}
            />

            <div className={css.hbox(12).alignItems("center").wrap}>
                <label className={css.hbox(6).alignItems("center").pointer.fontSize(13) + RS.Surface}>
                    <input
                        type="checkbox"
                        className={checkboxInput}
                        checked={onlyUnscanned}
                        onChange={e => { playSound("toggle"); scanOnlyUnscanned.value = (e.currentTarget as HTMLInputElement).checked; }}
                    />
                    {cap("only files that haven't been scanned")}
                </label>
                <div className={css.fontSize(12) + muted}>
                    {cap("showing")} {Math.min(limit, total)} / {total} {cap("files")} · {cap("recently used first")}
                </div>
            </div>

            <div className={css.fillWidth.overflowX("auto").bord(1, "hsl(0, 0%, 16%)").background("hsl(0, 0%, 9%)")}>
                <table className={css.fillWidth.borderCollapse("collapse")}>
                    <thead>
                        <tr>
                            <th className={headCss}>{cap("file")}</th>
                            <th className={headCss}>{cap("metadata")} {totalMetaMs > 0 && <span className={css.opacity(0.7)}>· Σ {formatTime(totalMetaMs)}</span>}</th>
                            <th className={headCss}>{cap("keyframes")} {totalKfMs > 0 && <span className={css.opacity(0.7)}>· Σ {formatTime(totalKfMs)}</span>}</th>
                            <th className={headCss}>{cap("faces")} {totalFacesMs > 0 && <span className={css.opacity(0.7)}>· Σ {formatTime(totalFacesMs)}</span>}</th>
                            <th className={headCss}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map(r => <tr key={r.key}>
                            <td className={cellCss.maxWidth(360).overflow("hidden").textOverflow("ellipsis")} title={r.key}>{r.name}</td>
                            {phaseCell(r.metaDone, r.metaAt, r.metaMs, r.metaErr, "pending")}
                            {phaseCell(r.kfDone, r.kfAt, r.kfMs, r.kfErr, kfAllowed ? "pending" : "—")}
                            {phaseCell(r.facesDone, r.facesAt, r.facesMs, r.facesErr, "—")}
                            <td className={cellCss}>
                                <div className={css.hbox(4).alignItems("center")}>
                                    <button className={cellActionBtn} onMouseDown={buttonDown()}
                                        onClick={() => { playSound("scanStart"); void forceRescanFileAllPhases(r.key); }}
                                        title="Re-scan all phases for this file">
                                        {cap("scan")}
                                    </button>
                                    <button className={cellActionBtn} onMouseDown={buttonDown()}
                                        onClick={() => { playSound("modalOpen"); openVideoInfo(r.key); }}>
                                        {cap("info")}
                                    </button>
                                    {([["metadata", "M"], ["keyframes", "K"], ["faces", "F"]] as const).map(([phase, glyph]) => <button
                                        key={phase}
                                        className={cellActionBtn}
                                        onMouseDown={buttonDown()}
                                        onClick={() => { playSound("scanStart"); void forceRescanFile(r.key, phase); }}
                                        title={`Force re-scan ${phase} for this file`}
                                    >
                                        {glyph}
                                    </button>)}
                                </div>
                            </td>
                        </tr>)}
                    </tbody>
                </table>
            </div>

            {limit < total && <button
                className={actionBtn + css.alignSelf("flex-start")}
                onMouseDown={buttonDown()}
                onClick={() => runInAction(() => this.limit.set(limit + PAGE_SIZE))}
            >
                {cap("show more")} ({total - limit} {cap("more")})
            </button>}
        </div>;
    }
}
