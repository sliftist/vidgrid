// Bounded recursive walk over a FileSystemDirectoryHandle.
//
// Rules:
// - Root folder (depth 0) descends into ALL of its subfolders, no cap. A huge
//   movie library at the root is fine.
// - Each top-level child of the root carries a shared per-subtree file budget.
//   Iterating a file (any extension) costs 1 from that subtree's budget;
//   finding a video adds VIDEO_BUDGET_BONUS back. A garbage subtree like
//   node_modules burns through the budget quickly without replenishing and
//   gets aborted whole; a real video subtree's discovery rate keeps the
//   budget growing faster than the walk drains it.
// - Hard cap of MAX_TOTAL_FOLDERS across the whole walk as a final safety net.
//   Set high enough not to truncate normal libraries.
// - Max depth MAX_DEPTH so symlink loops or extreme nesting still terminate.
// - File listing within a folder stops as soon as the subtree budget hits 0.
// - Only files whose name ends in one of VIDEO_EXTENSIONS are reported.
// - BFS so results from the top of the tree come back first.
//
// `onFile` is invoked per match so the caller can stream results into storage
// without holding the whole list in memory.

import { FolderScanStat } from "./scanReport";

export interface FoundVideo {
    name: string;
    // Path *relative to the scan root* (no leading root name). e.g. "Movies/foo.mkv".
    relativePath: string;
    handle: FileSystemFileHandle;
    relativeDepth: number;
}

const VIDEO_EXTENSIONS = [
    ".mkv", ".mp4", ".webm", ".mov", ".m4v", ".avi", ".ts", ".mpg", ".mpeg",
];

const MAX_TOTAL_FOLDERS = 100_000;
const MAX_DEPTH = 20;
// Per-top-level-subtree adaptive file budget. Iterating any file costs 1;
// finding a video credits VIDEO_BUDGET_BONUS back. A subtree that keeps
// finding videos can iterate effectively unbounded; a subtree that mostly
// finds non-video files runs out and gets aborted.
const PER_SUBTREE_INITIAL_FILE_BUDGET = 10_000;
const VIDEO_BUDGET_BONUS = 100;

function isVideoName(name: string): boolean {
    const lower = name.toLowerCase();
    for (const ext of VIDEO_EXTENSIONS) {
        if (lower.endsWith(ext)) return true;
    }
    return false;
}

// Shared budget across every folder in a single top-level subtree. All
// folders that descend from the same root child point at the same object,
// so a sibling's video discovery affects later siblings of the same
// subtree just like the original folder's own discoveries do.
interface SubtreeBudget {
    name: string;
    filesRemaining: number;
    aborted: boolean;
}

interface Queued {
    handle: FileSystemDirectoryHandle;
    relativePath: string;
    depth: number;
    // undefined for the root walk (no budget); set for everything below.
    budget?: SubtreeBudget;
}

export interface TraversalProgress {
    foldersVisited: number;
    videosFound: number;
    currentPath: string;
    truncated: boolean;
}

export interface FindVideosCallbacks {
    onProgress?: (p: TraversalProgress) => void;
    onFile?: (video: FoundVideo) => void | Promise<void>;
    // Polled at the top of each folder iteration. If it returns true, the
    // walk exits early and returns whatever has been seen so far.
    shouldCancel?: () => boolean;
    // Checked before a subfolder is queued. Return true to skip it (and
    // everything under it) entirely — used for user-ignored folders.
    shouldSkipFolder?: (relativePath: string) => boolean;
}

export interface FindVideosResult {
    foldersVisited: number;
    videosFound: number;
    truncated: boolean;
    // Per-folder walk stats (direct counts only), in visit order. Fed into
    // the scan-report bundle after the walk.
    folders: FolderScanStat[];
}

export async function findVideos(
    root: FileSystemDirectoryHandle,
    cb?: FindVideosCallbacks,
): Promise<FindVideosResult> {
    const queue: Queued[] = [{ handle: root, relativePath: "", depth: 0 }];
    let foldersVisited = 0;
    let videosFound = 0;
    let truncated = false;
    let lastReport = 0;
    const folders: FolderScanStat[] = [];

    // Throttle progress updates so a thousand fast folders don't trigger a
    // thousand mobx renders. ~7Hz is fast enough for the path display to feel
    // live and slow enough that the UI stays responsive. If we genuinely
    // stall on one folder, the next report will fire as soon as we move on.
    const PROGRESS_THROTTLE_MS = 150;

    function report(currentPath: string) {
        if (!cb?.onProgress) return;
        const now = Date.now();
        if (now - lastReport < PROGRESS_THROTTLE_MS) return;
        lastReport = now;
        cb.onProgress({ foldersVisited, videosFound, currentPath, truncated });
    }

    while (queue.length > 0) {
        if (cb?.shouldCancel?.()) break;
        const { handle, relativePath, depth, budget } = queue.shift()!;

        // Subtree's budget was exhausted while we were processing an earlier
        // folder of the same subtree — skip this and every remaining queued
        // folder under it. We can't drain the queue eagerly because BFS
        // interleaves subtrees, but the `aborted` flag is cheap to re-check.
        if (budget?.aborted) continue;

        foldersVisited++;
        // Report at the START of the iteration so the UI shows what we're
        // currently working on, not the last folder we finished. Critical for
        // diagnosing "stuck on a giant folder" symptoms.
        report(relativePath);

        const subdirs: { handle: FileSystemDirectoryHandle; name: string }[] = [];
        const folderT0 = performance.now();
        let folderFiles = 0;
        let folderVideos = 0;
        const pushStat = () => folders.push({
            path: relativePath,
            timeMs: performance.now() - folderT0,
            fileCount: folderFiles,
            videoCount: folderVideos,
        });
        try {
            // @ts-ignore — .entries() is on the handle but lib.dom types lag.
            for await (const [name, entry] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
                // Stop iterating the moment we burn through this subtree's
                // budget — the FS read is the cost we're trying to avoid.
                if (budget && budget.filesRemaining <= 0) break;
                if (entry.kind === "file") {
                    if (budget) budget.filesRemaining--;
                    folderFiles++;
                    if (isVideoName(name)) {
                        // Video discovery replenishes the budget so an
                        // active video folder stays under its limit
                        // indefinitely.
                        if (budget) budget.filesRemaining += VIDEO_BUDGET_BONUS;
                        // No getFile() here — size comes later in the
                        // metadata phase (which already opens the file via
                        // Mediabunny anyway). Keeping the walk handle-only
                        // shaves an FS round-trip per video, which matters
                        // a lot in large libraries.
                        const fileHandle = entry as FileSystemFileHandle;
                        const found: FoundVideo = {
                            name,
                            relativePath: relativePath ? `${relativePath}/${name}` : name,
                            handle: fileHandle,
                            relativeDepth: depth,
                        };
                        videosFound++;
                        folderVideos++;
                        if (cb?.onFile) await cb.onFile(found);
                    }
                } else if (entry.kind === "directory") {
                    subdirs.push({ handle: entry as FileSystemDirectoryHandle, name });
                }
            }
        } catch (err) {
            console.warn(`[traversal] cannot read folder ${relativePath || "(root)"}:`, (err as Error).message);
            pushStat();
            report(relativePath);
            continue;
        }
        pushStat();

        // Mark the subtree aborted if this folder pushed it over the edge.
        // Logged once per subtree so the user can see which subtree got cut.
        if (budget && budget.filesRemaining <= 0 && !budget.aborted) {
            budget.aborted = true;
            truncated = true;
            console.warn(`[traversal] subtree '${budget.name}' burned through its file budget (no further folders walked under it)`);
        }

        if (depth + 1 <= MAX_DEPTH && (!budget || !budget.aborted)) {
            for (const sd of subdirs) {
                if (foldersVisited + queue.length >= MAX_TOTAL_FOLDERS) {
                    truncated = true;
                    break;
                }
                // Top-level children of the root each get their own
                // fresh budget. Anything nested below shares the
                // parent's budget object — siblings + descendants
                // contribute to and consume the same pool.
                const childPath = relativePath ? `${relativePath}/${sd.name}` : sd.name;
                if (cb?.shouldSkipFolder?.(childPath)) continue;
                const childBudget = depth === 0
                    ? { name: sd.name, filesRemaining: PER_SUBTREE_INITIAL_FILE_BUDGET, aborted: false }
                    : budget;
                queue.push({
                    handle: sd.handle,
                    relativePath: childPath,
                    depth: depth + 1,
                    budget: childBudget,
                });
            }
        } else if (subdirs.length > 0 && depth + 1 > MAX_DEPTH) {
            truncated = true;
        }
        report(relativePath);
    }

    if (cb?.onProgress) cb.onProgress({ foldersVisited, videosFound, currentPath: "", truncated });
    return { foldersVisited, videosFound, truncated, folders };
}

// Resolves a FileSystemFileHandle by walking `relativePath` from `root`. Used
// to re-open a file we previously scanned; we can't persist the handle itself.
// Lets NotFoundError propagate — openFileByKey catches it and returns undefined.
export async function resolveFileHandle(
    root: FileSystemDirectoryHandle,
    relativePath: string,
): Promise<FileSystemFileHandle> {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) throw new Error("relativePath is empty");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
        // @ts-ignore — types lag.
        dir = await (dir as any).getDirectoryHandle(parts[i]);
    }
    // @ts-ignore — types lag.
    return await (dir as any).getFileHandle(parts[parts.length - 1]);
}
