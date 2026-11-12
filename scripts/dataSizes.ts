import * as fs from "fs";
import * as path from "path";
import { formatNumber } from "socket-function/src/formatting/format";

const COLLECTIONS = [
    "vidgrid_index",
    "vidgrid_thumbnails",
    "vidgrid_keyframes3",
    "vidgrid_characters3",
    "vidgrid_face_frames3",
    "vidgrid_blacklisted_faces",
    "vidgrid_playback",
    "vidgrid_settings",
    "vidgrid_settings_str",
    "vidgrid_removed",
    "vidgrid_ignored_folders",
    "vidgrid_scan_report",
    "vidgrid_lists",
    "vidgrid_list_memberships",
    "vidgrid_gen_subtitles",
    "vidgrid_scan_errors",
    "vidgrid_scan_status",
];

type Bucket = { count: number; bytes: number; maxBytes: number };

function emptyBucket(): Bucket {
    return { count: 0, bytes: 0, maxBytes: 0 };
}

function fmtBucket(b: Bucket): string {
    return `${b.count} files, ${formatNumber(b.bytes)}B (largest ${formatNumber(b.maxBytes)}B)`;
}

async function measureCollection(dir: string): Promise<{ bulk: Bucket; stream: Bucket; other: Bucket } | undefined> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return undefined;
    }
    const out = { bulk: emptyBucket(), stream: emptyBucket(), other: emptyBucket() };
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const stat = await fs.promises.stat(path.join(dir, entry.name));
        const bucket = entry.name.endsWith(".bulk") ? out.bulk : entry.name.endsWith(".stream") ? out.stream : out.other;
        bucket.count++;
        bucket.bytes += stat.size;
        bucket.maxBytes = Math.max(bucket.maxBytes, stat.size);
    }
    return out;
}

async function main(): Promise<void> {
    const root = process.argv[2];
    if (!root) throw new Error(`Expected the shared folder path as the first argument, got ${JSON.stringify(process.argv.slice(2))}`);
    const dbRoot = path.join(root, "data", "bulkDatabases2");
    for (const name of COLLECTIONS) {
        const m = await measureCollection(path.join(dbRoot, name));
        if (!m) {
            console.log(`${name}: not present`);
            continue;
        }
        console.log(`${name}: bulk ${fmtBucket(m.bulk)} | stream ${fmtBucket(m.stream)} | other ${fmtBucket(m.other)}`);
    }
}

main().then(() => process.exit(0), err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
