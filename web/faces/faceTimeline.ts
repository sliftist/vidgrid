// Face timeline: turns a file's merged face groups into a set of overlapping
// rows for display on the player trackbar. Each group's sporadic per-frame
// appearances are first bridged into continuous segments (gaps up to a
// configurable threshold are filled), then groups are greedily packed into
// rows most-frequent-first: the most frequent face always lands in row 0, and
// any two faces whose segments never overlap can share a row. ALL faces are
// packed into rows here; the caller decides how many top rows to actually draw.

import { MergedFaces } from "./faceScenes";

export interface FaceSegment {
    startMs: number;
    endMs: number;
}

export interface TimelineGroup {
    groupId: number;
    repCharKey: string;
    appearances: number; // how many frames this group appears in (drives rank)
    hue: number;         // stable colour for this group's bars
    segments: FaceSegment[];
}

export interface FaceTimelineRow {
    groups: TimelineGroup[];
}

export interface FaceTimeline {
    rows: FaceTimelineRow[];
}

// Stable per-group hue via the golden-angle so adjacent group ids get
// well-separated colours. Same input → same colour across renders.
export function groupHue(groupId: number): number {
    return (groupId * 137.508) % 360;
}

// Bridge a group's sorted appearance times into continuous segments, filling
// any gap no larger than fillGapMs. A lone appearance yields a zero-width
// segment; the renderer enforces a minimum visible width.
function buildSegments(times: number[], fillGapMs: number): FaceSegment[] {
    if (times.length === 0) return [];
    const out: FaceSegment[] = [];
    let start = times[0];
    let prev = times[0];
    for (let i = 1; i < times.length; i++) {
        const t = times[i];
        if (t - prev <= fillGapMs) {
            prev = t;
        } else {
            out.push({ startMs: start, endMs: prev });
            start = t;
            prev = t;
        }
    }
    out.push({ startMs: start, endMs: prev });
    return out;
}

// Do two sorted, internally non-overlapping segment lists touch anywhere?
// Touching endpoints count as overlap so bars never visually abut in a row.
function segmentsOverlap(a: FaceSegment[], b: FaceSegment[]): boolean {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const x = a[i];
        const y = b[j];
        if (x.startMs <= y.endMs && y.startMs <= x.endMs) return true;
        if (x.endMs < y.endMs) i++;
        else j++;
    }
    return false;
}

interface PackRow {
    segments: FaceSegment[]; // merged, sorted — for overlap tests
    groups: TimelineGroup[];
}

// Build the full row-packing. Groups are ranked by appearance count (desc),
// tie-broken by member count then id, so the most frequent face is placed
// first and therefore always occupies row 0.
export function buildFaceTimeline(merged: MergedFaces, fillGapMs: number): FaceTimeline {
    const ranked = [...merged.groups].sort((a, b) =>
        (b.times.length - a.times.length) ||
        (b.memberCount - a.memberCount) ||
        (a.groupId - b.groupId));

    const rows: PackRow[] = [];
    for (const g of ranked) {
        const segments = buildSegments(g.times, fillGapMs);
        if (segments.length === 0) continue;
        const tg: TimelineGroup = {
            groupId: g.groupId,
            repCharKey: g.repCharKey,
            appearances: g.times.length,
            hue: groupHue(g.groupId),
            segments,
        };
        let placed = false;
        for (const row of rows) {
            if (!segmentsOverlap(row.segments, segments)) {
                row.segments = [...row.segments, ...segments].sort((x, y) => x.startMs - y.startMs);
                row.groups.push(tg);
                placed = true;
                break;
            }
        }
        if (!placed) rows.push({ segments: [...segments], groups: [tg] });
    }

    return { rows: rows.map(r => ({ groups: r.groups })) };
}

// Memoize on the merged-faces identity (stable while its inputs are unchanged,
// see getMergedFacesSync) plus the gap threshold.
let cache: { merged: MergedFaces; fillGapMs: number; value: FaceTimeline } | undefined;

export function getFaceTimelineSync(merged: MergedFaces, fillGapMs: number): FaceTimeline {
    if (cache && cache.merged === merged && cache.fillGapMs === fillGapMs) return cache.value;
    const value = buildFaceTimeline(merged, fillGapMs);
    cache = { merged, fillGapMs, value };
    return value;
}
