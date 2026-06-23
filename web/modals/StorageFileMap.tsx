// Per-file map for a storage collection, shown when a row in the settings
// Storage section is expanded. Two stacked sections — one keyed by file time
// range, one keyed by each file's key span within the global sorted key list.
// Every file is one 2px line spanning its start→end; bulk and stream files get
// different colors. getDetails() resolves per file at different times, so each
// line renders as soon as its own details land; until then it shows a
// full-span loading bar. Files are ordered most-recently-modified first.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { sort } from "socket-function/src/misc";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import type { BulkFileDetails } from "sliftutils/storage/BulkDatabase2/BulkDatabaseBase";
import { RS } from "../restyle/classNames";

type FileVis = {
    type: "bulk" | "stream";
    lastModified: number;
    details: BulkFileDetails | undefined;
    failed: boolean;
};

const BULK_COLOR = "hsl(210, 70%, 58%)";
const STREAM_COLOR = "hsl(95, 55%, 52%)";
const LOADING_COLOR = "hsla(0, 0%, 60%, 0.18)";
const ROW_HEIGHT = 2;

@observer
export class StorageFileMap extends preact.Component<{ db: BulkDatabase2<any> }> {
    synced = observable({
        files: undefined as FileVis[] | undefined,
        error: undefined as string | undefined,
    });

    componentDidMount() {
        void this.load();
    }

    private async load() {
        try {
            const info = await this.props.db.getFileInfo();
            const paired = info.files.map(entry => ({
                entry,
                vis: observable({
                    type: entry.type,
                    lastModified: entry.lastModified,
                    details: undefined as BulkFileDetails | undefined,
                    failed: false,
                }) as FileVis,
            }));
            const ordered = sort(paired.slice(), p => -p.vis.lastModified).map(p => p.vis);
            runInAction(() => { this.synced.files = ordered; });
            for (const { entry, vis } of paired) {
                entry.getDetails().then(
                    d => runInAction(() => { vis.details = d; }),
                    () => runInAction(() => { vis.failed = true; }),
                );
            }
        } catch (err) {
            runInAction(() => { this.synced.error = (err as Error).message ?? String(err); });
        }
    }

    render() {
        const { files, error } = this.synced;
        if (error) return <div className={css.fontSize(11).color("hsl(0, 70%, 60%)") + RS.Muted}>{error}</div>;
        if (!files) return <div className={css.fontSize(11).color("hsl(0, 0%, 55%)") + RS.Muted}>loading…</div>;
        if (files.length === 0) return null;

        const loaded = files.filter(f => f.details);
        let minTime = Infinity;
        let maxTime = -Infinity;
        const keySet = new Set<string>();
        for (const f of loaded) {
            const d = f.details;
            if (!d) continue;
            if (d.minTime < minTime) minTime = d.minTime;
            if (d.maxTime > maxTime) maxTime = d.maxTime;
            for (const k of d.keys) keySet.add(k);
        }
        const timeSpan = maxTime - minTime;
        const sortedKeys = sort([...keySet], k => k);
        const keyIndex = new Map<string, number>();
        for (let i = 0; i < sortedKeys.length; i++) keyIndex.set(sortedKeys[i], i);
        const keyMax = sortedKeys.length - 1;

        const timeFrac = (d: BulkFileDetails) => {
            if (timeSpan <= 0) return { left: 0, width: 1 };
            return { left: (d.minTime - minTime) / timeSpan, width: (d.maxTime - d.minTime) / timeSpan };
        };
        const keyFrac = (d: BulkFileDetails) => {
            if (keyMax <= 0) return { left: 0, width: 1 };
            let lo = Infinity;
            let hi = -Infinity;
            for (const k of d.keys) {
                const idx = keyIndex.get(k);
                if (idx === undefined) continue;
                if (idx < lo) lo = idx;
                if (idx > hi) hi = idx;
            }
            if (lo > hi) return { left: 0, width: 0 };
            return { left: lo / keyMax, width: (hi - lo) / keyMax };
        };

        return <div className={css.vbox(8)}>
            {this.section("By time", files, timeFrac)}
            {this.section("By key", files, keyFrac)}
        </div>;
    }

    private section(
        title: string,
        files: FileVis[],
        frac: (d: BulkFileDetails) => { left: number; width: number },
    ) {
        return <div className={css.vbox(3)}>
            <div className={css.fontSize(10).color("hsl(0, 0%, 60%)") + RS.Muted}>{title}</div>
            <div className={css.vbox(0).fillWidth.hsl(0, 0, 8).bord(1, "hsl(0, 0%, 18%)") + RS.StorageMap}>
                {files.map((f, i) => this.row(f, i, frac))}
            </div>
        </div>;
    }

    private row(
        f: FileVis,
        i: number,
        frac: (d: BulkFileDetails) => { left: number; width: number },
    ) {
        const bar = (() => {
            if (!f.details) {
                return <div className={css.absolute.left(0).right(0).fillHeight
                    .background(LOADING_COLOR) + RS.StorageMapLoading} />;
            }
            const { left, width } = frac(f.details);
            const color = f.type === "stream" ? STREAM_COLOR : BULK_COLOR;
            return <div className={css.absolute.fillHeight.background(color).minWidth(1)
                .left(`${left * 100}%`).width(`${Math.max(0, width) * 100}%`)
                + (f.type === "stream" ? RS.StorageMapStream : RS.StorageMapBulk)} />;
        })();
        return <div key={i} className={css.relative.fillWidth.height(ROW_HEIGHT)}>
            {bar}
        </div>;
    }
}
