// Series detection.
//
// Rules (per spec):
//   - A *folder* (not the root) directly containing between SERIES_MIN and
//     SERIES_MAX videos counts as a series. Direct children only — anything
//     in a deeper subfolder belongs to that subfolder's potential series.
//   - Order of series: pure alphabetical on the folder path.
//   - Order of videos inside a series: alphabetical by filename.
//
// Caching: detection is pure over the set of {relativePath} we feed it, and
// in practice that set changes infrequently (a scan adding/removing files).
// We stringify the sorted relativePath list as the cache key and remember
// the last result. One-entry cache is enough — series detection is fast
// and the new list invalidates the old one anyway.

export const SERIES_MIN = 5;
export const SERIES_MAX = 100;

export interface SeriesVideo {
    key: string;
    name: string;
    relativePath: string;
}

export interface SeriesGroup {
    // Folder path *relative to the scan root*, e.g. "Movies/Friends/Season 1".
    parentPath: string;
    // Just the final segment of parentPath, used as the display name.
    folderName: string;
    // Videos directly inside the folder, sorted alphabetically by name.
    videos: SeriesVideo[];
}

function detectSeries(records: SeriesVideo[]): Map<string, SeriesGroup> {
    const byParent = new Map<string, SeriesVideo[]>();
    for (const r of records) {
        const slash = r.relativePath.lastIndexOf("/");
        if (slash < 0) continue; // root-level file — never a series
        const parentPath = r.relativePath.slice(0, slash);
        let list = byParent.get(parentPath);
        if (!list) {
            list = [];
            byParent.set(parentPath, list);
        }
        list.push(r);
    }
    const out = new Map<string, SeriesGroup>();
    for (const [parentPath, videos] of byParent) {
        if (videos.length < SERIES_MIN || videos.length > SERIES_MAX) continue;
        const folderName = parentPath.slice(parentPath.lastIndexOf("/") + 1) || parentPath;
        const sorted = videos.slice().sort((a, b) => a.name.localeCompare(b.name));
        out.set(parentPath, { parentPath, folderName, videos: sorted });
    }
    return out;
}

let lastKey: string | undefined;
let lastResult: Map<string, SeriesGroup> | undefined;

export function getSeries(records: SeriesVideo[]): Map<string, SeriesGroup> {
    // Sort relativePaths and join — same record set → same key regardless of
    // input order. The join is intentionally a single string so it's a fast
    // === compare against the cached key.
    const paths = records.map(r => r.relativePath).sort();
    const key = paths.join("\n");
    if (key === lastKey && lastResult) return lastResult;
    lastKey = key;
    lastResult = detectSeries(records);
    return lastResult;
}

// Sorted list of SeriesGroups for display. Pure alphabetical on parentPath.
export function listSeriesAlphabetical(map: Map<string, SeriesGroup>): SeriesGroup[] {
    return Array.from(map.values()).sort((a, b) => a.parentPath.localeCompare(b.parentPath));
}

// Series that the given video key belongs to, if any.
export function findSeriesForKey(map: Map<string, SeriesGroup>, key: string): SeriesGroup | undefined {
    for (const group of map.values()) {
        for (const v of group.videos) if (v.key === key) return group;
    }
    return undefined;
}

// Same as findSeriesForKey but also returns the 0-based index within the
// (alphabetically-sorted) series videos.
export function locateInSeries(map: Map<string, SeriesGroup>, key: string): { group: SeriesGroup; index: number } | undefined {
    for (const group of map.values()) {
        const idx = group.videos.findIndex(v => v.key === key);
        if (idx >= 0) return { group, index: idx };
    }
    return undefined;
}
