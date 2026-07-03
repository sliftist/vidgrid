// Scan-breakdown modal — a drill-down tree of the last file walk. Loads
// the per-folder stats bundle written at the end of the walk (one binary
// record, see web/scan/scanReport.ts), aggregates descendants at display
// time, and lets the user mark folders as ignored so future scans never
// descend into them.
//
// Navigation is drill-down: the view shows ONE focused node (root by
// default) with its ancestors as a breadcrumb above and its children
// below. Clicking a child drills into it; clicking an ancestor climbs
// back up. Each child row's background bar is sized by the active
// breakdown mode — video count, even, or scan time.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { cacheWeak } from "socket-function/src/caching";
import { formatTime } from "socket-function/src/formatting/format";
import { modalCloseBtn } from "../styles";
import { RS } from "../restyle/classNames";
import {
    scanReports, SCAN_REPORT_KEY,
    ignoredFolders, ignoreFolder, unignoreFolder,
} from "../appState";
import { decodeScanReport, FolderScanStat } from "../scan/scanReport";
import { playSound } from "../sounds";

const scanReportOpen = observable.box<boolean>(false);
const focusPath = observable.box<string>("");
type BreakdownMode = "count" | "files" | "time";
const breakdownMode = observable.box<BreakdownMode>("count");

export function openScanReport() {
    playSound("modalOpen");
    runInAction(() => {
        focusPath.set("");
        scanReportOpen.set(true);
    });
}

export function closeScanReport() {
    playSound("modalClose");
    runInAction(() => scanReportOpen.set(false));
}

interface TreeNode {
    path: string;
    name: string;
    // Direct (non-recursive) stats from the walk.
    timeMs: number;
    fileCount: number;
    videoCount: number;
    // Self + all descendants.
    totalTimeMs: number;
    totalFiles: number;
    totalVideos: number;
    folderCount: number;
    children: TreeNode[];
}

function buildTree(stats: FolderScanStat[]): Map<string, TreeNode> {
    const byPath = new Map<string, TreeNode>();
    const ensure = (path: string): TreeNode => {
        let node = byPath.get(path);
        if (node) return node;
        const slash = path.lastIndexOf("/");
        node = {
            path,
            name: path === "" ? "(root)" : path.slice(slash + 1),
            timeMs: 0, fileCount: 0, videoCount: 0,
            totalTimeMs: 0, totalFiles: 0, totalVideos: 0, folderCount: 1,
            children: [],
        };
        byPath.set(path, node);
        if (path !== "") {
            const parent = ensure(slash < 0 ? "" : path.slice(0, slash));
            parent.children.push(node);
        }
        return node;
    };
    ensure("");
    for (const s of stats) {
        const node = ensure(s.path);
        node.timeMs = s.timeMs;
        node.fileCount = s.fileCount;
        node.videoCount = s.videoCount;
    }
    // Post-order accumulate. Children are always created after their
    // parent's ensure(), so reverse insertion order visits children first.
    const nodes = [...byPath.values()].sort((a, b) => b.path.length - a.path.length);
    for (const n of nodes) {
        n.totalTimeMs += n.timeMs;
        n.totalFiles += n.fileCount;
        n.totalVideos += n.videoCount;
        if (n.path !== "") {
            const slash = n.path.lastIndexOf("/");
            const parent = byPath.get(slash < 0 ? "" : n.path.slice(0, slash))!;
            parent.totalTimeMs += n.totalTimeMs;
            parent.totalFiles += n.totalFiles;
            parent.totalVideos += n.totalVideos;
            parent.folderCount += n.folderCount;
        }
    }
    return byPath;
}

const decodeCached = cacheWeak((bytes: Uint8Array) => decodeScanReport(bytes));
const treeCached = cacheWeak((stats: FolderScanStat[]) => buildTree(stats));

const modeBtn = css.fontSize(11).pad2(8, 3).pointer.hsl(0, 0, 16)
    .color("hsl(0, 0%, 78%)").bord(1, "hsl(0, 0%, 26%)").hslhover(0, 0, 22) + RS.Button;
const modeBtnActive = css.fontSize(11).pad2(8, 3).pointer.hsl(50, 40, 30)
    .color("hsl(50, 90%, 85%)").bord(1, "hsl(50, 50%, 40%)") + RS.Button;
const smallBtn = css.fontSize(10).pad2(6, 2).pointer.hsl(0, 0, 18)
    .color("hsl(0, 0%, 75%)").bord(1, "hsl(0, 0%, 28%)").hslhover(0, 0, 24) + RS.Button;

function nodeStatsLine(n: Pick<TreeNode, "totalVideos" | "totalFiles" | "totalTimeMs" | "folderCount">): string {
    const parts = [
        `${n.totalVideos} video${n.totalVideos === 1 ? "" : "s"}`,
        `${n.totalFiles} file${n.totalFiles === 1 ? "" : "s"}`,
        formatTime(n.totalTimeMs),
    ];
    if (n.folderCount > 1) parts.push(`${n.folderCount} folders`);
    return parts.join(" · ");
}

@observer
export class ScanReportModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && scanReportOpen.get()) {
            e.preventDefault();
            closeScanReport();
        }
    };

    render() {
        if (!scanReportOpen.get()) return null;

        const rootName = scanReports.getSingleFieldSync(SCAN_REPORT_KEY, "rootName");
        const scannedAt = scanReports.getSingleFieldSync(SCAN_REPORT_KEY, "scannedAt");
        const totalMs = scanReports.getSingleFieldSync(SCAN_REPORT_KEY, "totalMs");
        const bundle = scanReports.getSingleFieldSync(SCAN_REPORT_KEY, "bundle");
        const stats = bundle ? decodeCached(bundle) : undefined;
        const tree = stats ? treeCached(stats) : undefined;

        // Ignored-folder set, reactive off the ignoredAt column.
        const ignoredCol = ignoredFolders.getColumnSync("ignoredAt");
        const ignoredSet = new Set<string>();
        if (ignoredCol) for (const { key } of ignoredCol) ignoredSet.add(key);

        // Focused node — fall back to the root if the stored path vanished
        // (e.g. a new scan no longer has it).
        let focus = tree?.get(focusPath.get());
        if (!focus && tree) focus = tree.get("");

        const mode = breakdownMode.get();
        const metricOf = (n: TreeNode) =>
            mode === "time" ? n.totalTimeMs : mode === "files" ? n.totalFiles : n.totalVideos;

        const children = focus ? [...focus.children] : [];
        children.sort((a, b) => metricOf(b) - metricOf(a) || a.name.localeCompare(b.name));
        let metricSum = 0;
        for (const c of children) metricSum += metricOf(c);

        // Breadcrumb: root … focus, each ancestor clickable.
        const crumbs: { label: string; path: string }[] = [{ label: rootName || "(root)", path: "" }];
        if (focus && focus.path !== "") {
            const parts = focus.path.split("/");
            for (let i = 0; i < parts.length; i++) {
                crumbs.push({ label: parts[i], path: parts.slice(0, i + 1).join("/") });
            }
        }

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeScanReport(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(900).fillWidth.maxHeight("85vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={css.pad2(18, 22).flexGrow(1).minHeight(0).overflowAuto.vbox(12).fillWidth}>
                    <div className={css.hbox(12).alignCenter}>
                        <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>
                            Scan breakdown
                        </div>
                        <button onMouseDown={() => closeScanReport()} className={modalCloseBtn} title="Close (Esc)">
                            ✕
                        </button>
                    </div>

                    {!tree && <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                        No scan report recorded yet — it's written the next time the file scan completes.
                    </div>}

                    {tree && focus && <>
                        <div className={css.fontSize(12).color("hsl(0, 0%, 60%)") + RS.Muted}>
                            {scannedAt ? `Scanned ${new Date(scannedAt).toLocaleString()}` : ""}
                            {totalMs !== undefined ? ` · walk took ${formatTime(totalMs)}` : ""}
                        </div>

                        <div className={css.hbox(8).alignCenter}>
                            <span className={css.fontSize(12).color("hsl(0, 0%, 60%)") + RS.Muted}>Break down by</span>
                            {(["count", "files", "time"] as BreakdownMode[]).map(m => <button
                                key={m}
                                className={mode === m ? modeBtnActive : modeBtn}
                                onMouseDown={() => runInAction(() => breakdownMode.set(m))}
                                title={m === "count" ? "Size each folder's bar by videos found inside it"
                                    : m === "files" ? "Size each folder's bar by total files found inside it"
                                    : "Size each folder's bar by time spent scanning it"}
                            >
                                {m === "count" ? "Video count" : m === "files" ? "File count" : "Scan time"}
                            </button>)}
                        </div>

                        {/* Breadcrumb — ancestors of the focused node; click to climb. */}
                        <div className={css.hbox(4).wrap.alignCenter.fontSize(13)}>
                            {crumbs.map((c, i) => <preact.Fragment key={c.path}>
                                {i > 0 && <span className={css.color("hsl(0, 0%, 45%)")}>/</span>}
                                {i < crumbs.length - 1
                                    ? <span
                                        className={css.pointer.color("hsl(200, 70%, 70%)").hslhover(0, 0, 18).pad2(3, 1) + RS.Accent}
                                        onMouseDown={() => runInAction(() => focusPath.set(c.path))}
                                    >{c.label}</span>
                                    : <span className={css.color("hsl(0, 0%, 90%)").pad2(3, 1)}>{c.label}</span>}
                            </preact.Fragment>)}
                        </div>

                        <div className={css.fontSize(12).color("hsl(0, 0%, 70%)")}>
                            {nodeStatsLine(focus)}
                            {focus.videoCount > 0 && focus.children.length > 0
                                && ` · ${focus.videoCount} video${focus.videoCount === 1 ? "" : "s"} directly here`}
                        </div>

                        <div className={css.vbox(4).fillWidth}>
                            {children.length === 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)") + RS.Muted}>
                                No subfolders were scanned under this folder.
                            </div>}
                            {children.map(c => {
                                const frac = metricSum > 0 ? metricOf(c) / metricSum : 0;
                                const ignored = ignoredSet.has(c.path);
                                return <div
                                    key={c.path}
                                    className={css.relative.fillWidth.hbox(10).alignCenter.pad2(10, 6)
                                        .hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)").overflowHidden
                                        + (ignored ? css.opacity(0.5) : css) + RS.Surface}
                                >
                                    {/* Proportional bar behind the row content. */}
                                    <div className={css.absolute.left(0).top(0).bottom(0)
                                        .width(`${Math.round(frac * 10000) / 100}%`)
                                        .hsla(200, 50, 40, 0.25).pointerEvents("none")} />
                                    <div
                                        className={css.relative.flexGrow(1).minWidth(0).vbox(2).pointer}
                                        onMouseDown={() => runInAction(() => focusPath.set(c.path))}
                                        title={`${c.path} — click to drill down`}
                                    >
                                        <div className={css.fontSize(13).ellipsis
                                            + (ignored ? css.textDecoration("line-through") : css)}>
                                            {c.name}
                                        </div>
                                        <div className={css.fontSize(11).color("hsl(0, 0%, 60%)") + RS.Muted}>
                                            {nodeStatsLine(c)}
                                        </div>
                                    </div>
                                    <button
                                        className={smallBtn + css.relative.flexShrink(0)}
                                        onMouseDown={e => {
                                            e.stopPropagation();
                                            void (ignored ? unignoreFolder(c.path) : ignoreFolder(c.path, {
                                                scannedAt,
                                                totalTimeMs: c.totalTimeMs,
                                                totalFiles: c.totalFiles,
                                                totalVideos: c.totalVideos,
                                                folderCount: c.folderCount,
                                            }));
                                        }}
                                        title={ignored
                                            ? "This folder is skipped by future scans — click to scan it again"
                                            : "Skip this folder (and everything under it) on all future scans"}
                                    >
                                        {ignored ? "Unignore" : "Ignore"}
                                    </button>
                                </div>;
                            })}
                        </div>

                    </>}

                    {ignoredSet.size > 0 && <div className={css.vbox(6)}>
                        <div className={css.fontSize(13).color("hsl(0, 0%, 70%)") + RS.Muted}>
                            Ignored folders ({ignoredSet.size}) — skipped by every scan, so their stats are frozen at the last scan that saw them
                        </div>
                        {[...ignoredSet].sort().map(p => {
                            // Snapshot stored at ignore time. Records ignored
                            // before snapshots existed fall back to the last
                            // scan report — which only still contains the
                            // folder if it was ignored after that scan ran.
                            const storedVideos = ignoredFolders.getSingleFieldSync(p, "totalVideos");
                            const stat = storedVideos !== undefined
                                ? {
                                    totalVideos: storedVideos,
                                    totalFiles: ignoredFolders.getSingleFieldSync(p, "totalFiles") ?? 0,
                                    totalTimeMs: ignoredFolders.getSingleFieldSync(p, "totalTimeMs") ?? 0,
                                    folderCount: ignoredFolders.getSingleFieldSync(p, "folderCount") ?? 1,
                                    scannedAt: ignoredFolders.getSingleFieldSync(p, "scannedAt"),
                                }
                                : (() => {
                                    const node = tree?.get(p);
                                    return node && {
                                        totalVideos: node.totalVideos,
                                        totalFiles: node.totalFiles,
                                        totalTimeMs: node.totalTimeMs,
                                        folderCount: node.folderCount,
                                        scannedAt,
                                    };
                                })();
                            return <div key={p} className={css.hbox(10).alignCenter.pad2(10, 6)
                                .hsl(0, 0, 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
                                <div className={css.flexGrow(1).minWidth(0).vbox(2)}>
                                    <div className={css.fontSize(12).ellipsis.textDecoration("line-through")
                                        .color("hsl(0, 0%, 60%)")} title={p}>
                                        {p || "(root)"}
                                    </div>
                                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>
                                        {stat
                                            ? nodeStatsLine(stat)
                                                + (stat.scannedAt ? ` · last scanned ${new Date(stat.scannedAt).toLocaleString()}` : "")
                                            : "no scan information recorded"}
                                    </div>
                                </div>
                                <button
                                    className={smallBtn + css.flexShrink(0)}
                                    onMouseDown={() => void unignoreFolder(p)}
                                    title="Scan this folder again on future scans"
                                >
                                    Unignore
                                </button>
                            </div>;
                        })}
                    </div>}
                </div>
            </div>
        </div>;
    }
}
