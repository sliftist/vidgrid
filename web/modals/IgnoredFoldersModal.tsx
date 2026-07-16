// Modal for managing the ignored-folder list — the SAME `ignoredFolders` DB
// the coordinator's file walk honors (workerScanCore.runFileWalk's
// shouldSkipFolder). Adding a folder here means no future scan (browser OR
// yarn parse) will descend into it. Removing lifts the block on next walk.
//
// The library's folder set is derived from the files DB (relativePath
// column) — every ancestor of every file becomes a folder we can offer to
// ignore. Video counts per folder are cumulative (self + descendants) so
// "ignore Movies/Foreign" tells you how many videos will disappear.

import * as preact from "preact";
import { observable, runInAction, computed } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { files, ignoredFolders, ignoreFolder, unignoreFolder } from "../appState";
import { modalParam } from "../router";
import { playSound } from "../sounds";
import { cap } from "../search/gridShared";
import {
    actionBtn, buttonDown, cellActionBtn, cellActionBtnWarn, chipBtn, chipDim,
    fieldInput, settingsPanelPad,
} from "../styles";
import { RS } from "../restyle/classNames";

const MODAL_KEY = "ignoredFolders";

export function openIgnoredFolders(): void {
    playSound("modalOpen");
    modalParam.set(MODAL_KEY);
}
export function closeIgnoredFolders(): void {
    playSound("modalClose");
    if (modalParam.get() === MODAL_KEY) modalParam.set("");
}

interface FolderEntry {
    path: string;
    videoCount: number; // videos anywhere under this folder
}

// Enumerate every folder that appears anywhere in the library's file tree,
// including intermediate ancestors, with cumulative video counts. Reactive:
// re-computes whenever files.relativePath changes.
function enumerateFolders(): FolderEntry[] {
    const relCol = files.getColumnSync("relativePath");
    if (!relCol) return [];
    const counts = new Map<string, number>();
    for (const r of relCol) {
        const rp = r.value;
        if (typeof rp !== "string") continue;
        // Every ancestor folder of this file counts as containing it.
        let i = rp.lastIndexOf("/");
        while (i > 0) {
            const folder = rp.slice(0, i);
            counts.set(folder, (counts.get(folder) ?? 0) + 1);
            i = folder.lastIndexOf("/");
        }
    }
    const out: FolderEntry[] = [];
    for (const [path, videoCount] of counts) out.push({ path, videoCount });
    // Most videos first, then alphabetical within same count.
    out.sort((a, b) => (b.videoCount - a.videoCount) || a.path.localeCompare(b.path));
    return out;
}

// Reactive read of the currently ignored folders (relative paths) from the DB.
export function ignoredFolderPathsSync(): string[] {
    const col = ignoredFolders.getColumnSync("ignoredAt");
    if (!col) return [];
    return col.map(r => r.key).sort((a, b) => a.localeCompare(b));
}

const search = observable.box<string>("");

@observer
export class IgnoredFoldersModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && modalParam.get() === MODAL_KEY) {
            e.preventDefault();
            closeIgnoredFolders();
        }
    };

    private allFolders = computed<FolderEntry[]>(() => enumerateFolders());

    render() {
        if (modalParam.get() !== MODAL_KEY) return null;
        const q = search.get().trim().toLowerCase();
        const ignoredSet = new Set(ignoredFolderPathsSync());
        const ignoredList = [...ignoredSet].sort();
        const folders = this.allFolders.get()
            .filter(f => !q || f.path.toLowerCase().includes(q));

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeIgnoredFolders(); } }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(880).fillWidth.maxHeight("85vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={settingsPanelPad + css.flexGrow(1).minHeight(0).overflowAuto.vbox(14)}>
                    <div className={css.hbox(12).alignItems("center")}>
                        <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>
                            {cap("ignored folders")} ({ignoredList.length})
                        </div>
                        <button
                            onMouseDown={buttonDown(() => closeIgnoredFolders())}
                            className={actionBtn}
                            title="Close (Esc)"
                        >
                            ✕
                        </button>
                    </div>
                    <div className={css.fontSize(12).opacity(0.75) + RS.Muted}>
                        Folders in this list are pruned from every future file walk — both the browser scan and yarn parse honor them. Videos already recorded from an ignored folder stay in the library until you remove them individually; the walk just stops discovering new ones.
                    </div>

                    {/* Currently ignored — top slot so the user can see + lift what's active. */}
                    {ignoredList.length > 0 && <div className={css.vbox(6)}>
                        <div className={css.fontSize(12).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em")}>
                            {cap("currently ignored")}
                        </div>
                        <div className={css.vbox(4).bord(1, "hsl(0, 0%, 18%)").pad(6).hsl(0, 0, 8) + RS.Surface}>
                            {ignoredList.map(p => <div key={p} className={css.hbox(8).alignItems("center").fillWidth}>
                                <div className={css.fontSize(12).flexGrow(1).overflowWrap("break-word")}>{p}</div>
                                <button
                                    className={cellActionBtn}
                                    onMouseDown={buttonDown()}
                                    onClick={() => { playSound("toggle"); void unignoreFolder(p); }}
                                    title="Lift the ignore — the next walk will descend into this folder again."
                                >
                                    {cap("unignore")}
                                </button>
                            </div>)}
                        </div>
                    </div>}

                    {/* Add-from-library. Every folder that has files in it, most-videos first. */}
                    <div className={css.vbox(6)}>
                        <div className={css.hbox(10).alignItems("center")}>
                            <div className={css.fontSize(12).opacity(0.85).textTransform("uppercase").letterSpacing("0.04em") + css.flexGrow(1)}>
                                {cap("library folders")}
                            </div>
                            <input
                                className={fieldInput + css.maxWidth(280)}
                                placeholder="Search folder path..."
                                value={search.get()}
                                onInput={e => runInAction(() => search.set((e.currentTarget as HTMLInputElement).value))}
                            />
                        </div>
                        <div className={css.vbox(2).bord(1, "hsl(0, 0%, 18%)").hsl(0, 0, 8).maxHeight(360).overflowAuto + RS.Surface}>
                            {folders.length === 0 && <div className={css.pad(10).fontSize(12).opacity(0.7)}>
                                {q ? "No folders match this search." : "No folders discovered yet — run a scan first."}
                            </div>}
                            {folders.map(f => {
                                const isIgnored = ignoredSet.has(f.path);
                                return <div key={f.path} className={css.hbox(8).alignItems("center").pad2(8, 4).borderBottom("1px solid hsl(0, 0%, 14%)")}>
                                    <div className={css.fontSize(12).flexGrow(1).overflowWrap("break-word")}>{f.path}</div>
                                    <div className={css.fontSize(11).opacity(0.7).whiteSpace("nowrap")}>{f.videoCount} {f.videoCount === 1 ? cap("video") : cap("videos")}</div>
                                    <button
                                        className={isIgnored ? cellActionBtn : cellActionBtnWarn}
                                        onMouseDown={buttonDown()}
                                        onClick={() => {
                                            playSound("toggle");
                                            if (isIgnored) void unignoreFolder(f.path);
                                            else void ignoreFolder(f.path);
                                        }}
                                        title={isIgnored
                                            ? "Lift the ignore — the next walk will descend into this folder again."
                                            : "Skip this folder in every future walk. Files already indexed stay until you remove them individually."}
                                    >
                                        {isIgnored ? cap("unignore") : cap("ignore")}
                                    </button>
                                </div>;
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>;
    }
}
