// Categorization engine for extraction errors.
//
// The idea (per the triage plan): instead of eyeballing ~900 failing files one
// by one, we encode each recognized failure mode as a rule. A rule matches a
// family of files, assigns a support classification, and — crucially — pulls
// those files OUT of the "uncategorized" pool so they stop showing up. As rules
// are added the uncategorized list shrinks toward zero; that list is the only
// thing that still needs human eyes.
//
// Classification keys on what ffprobe actually found inside each file (attached
// via probeCache.enrich), not just the browser's error text — because the same
// browser error ("cannot be decoded") covers half a dozen different codecs, and
// the only thing that matters for "can we fix it" is whether ffmpeg can open a
// real video stream. First matching rule wins, so order specific before generic.

import type { EnrichedRecord } from "./probeCache";

// What we can do about a category:
// - "offline":     the browser can't, but ffmpeg/our own decoders can — ffprobe
//                  opens a real video stream. These SHOULD produce a thumbnail
//                  once extraction runs outside the browser.
// - "unsupported": genuinely can't / shouldn't support — ffmpeg also fails to
//                  open it (truncated/corrupt download), the file is gone, or
//                  there's no real video stream. Acknowledged dead-ends.
// - "investigate": recognized as a cluster but root cause not yet pinned down.
export type Support = "offline" | "unsupported" | "investigate";

export interface Rule {
    id: string;
    label: string;
    support: Support;
    note?: string;
    match: (rec: EnrichedRecord) => boolean;
}

const errIs = (rec: EnrichedRecord, re: RegExp): boolean => re.test(rec.extractionError);
const videoIs = (rec: EnrichedRecord, codec: string): boolean => !!rec.probe?.hasVideo && rec.probe.primaryVideo === codec;

// ────────────────────────────────────────────────────────────────────────────
// Rules. Order matters — dead-ends first, then codec buckets, then catch-alls.
export const rules: Rule[] = [
    {
        id: "file-missing",
        label: "File no longer on disk",
        support: "unsupported",
        note: "Index points at a path that no longer exists — stale row, not a decode problem.",
        match: rec => !rec.exists,
    },
    {
        id: "corrupt-container",
        label: "Corrupt / truncated container (ffmpeg also fails)",
        support: "unsupported",
        note: "ffprobe can't open it either (moov atom not found / EBML header parsing failed / starts with 0x00) — an incomplete or damaged download, not a codec gap. Re-download to fix.",
        match: rec => !!rec.probe && !rec.probe.ok,
    },
    {
        id: "no-real-video",
        label: "No decodable video stream (cover-art / audio only)",
        support: "unsupported",
        note: "ffprobe opens the file but finds only attached cover art (mjpeg/png) or audio — there's no moving picture to thumbnail.",
        match: rec => !!rec.probe?.ok && !rec.probe.hasVideo,
    },

    // ── Codec buckets: ffprobe found a real video stream the browser refused.
    //    All offline-fixable (ffmpeg / our TS decoders read every one of these).
    {
        id: "mpeg2",
        label: "MPEG-2 video (DVD remux etc.)",
        support: "offline",
        note: "WebCodecs has no MPEG-2 decoder; ffmpeg does.",
        match: rec => videoIs(rec, "mpeg2video"),
    },
    {
        id: "vc1",
        label: "VC-1 video (BluRay remux)",
        support: "offline",
        note: "WebCodecs has no VC-1 decoder; ffmpeg does.",
        match: rec => videoIs(rec, "vc1"),
    },
    {
        id: "mpeg4-part2",
        label: "MPEG-4 Part 2 (XviD/DivX)",
        support: "offline",
        note: "WebCodecs can't decode mp4v; our pure-TS Mpeg4Decoder and ffmpeg both can. Most live in AVI.",
        match: rec => videoIs(rec, "mpeg4") || (rec.ext === "avi" && rec.probe?.ok !== false),
    },
    {
        id: "mpeg1",
        label: "MPEG-1 video",
        support: "offline",
        note: "WebCodecs has no MPEG-1 decoder; ffmpeg does.",
        match: rec => videoIs(rec, "mpeg1video"),
    },
    {
        id: "hevc",
        label: "HEVC / H.265",
        support: "offline",
        note: "HEVC isn't decodable by WebCodecs on this setup (often 10-bit / HDR / DV); ffmpeg decodes it.",
        match: rec => videoIs(rec, "hevc"),
    },
    {
        id: "h264-browser-refused",
        label: "H.264 the browser refused (likely 10-bit / 4K / exotic profile)",
        support: "offline",
        note: "ffprobe reads H.264 fine, so ffmpeg can thumbnail it. WebCodecs usually balks here on Hi10P (10-bit) or very high resolutions, or trips over an exotic audio track during setup.",
        match: rec => videoIs(rec, "h264"),
    },
    {
        id: "other-readable-video",
        label: "Other ffmpeg-readable video (av1/vp9/...)",
        support: "offline",
        note: "ffprobe found a real video stream in a codec ffmpeg can decode — extractable offline.",
        match: rec => !!rec.probe?.hasVideo,
    },

    // ── Fallbacks for records with no probe data (cache not built / --no-probe).
    {
        id: "avi-unprobed",
        label: "AVI (assumed MPEG-4 Part 2), not yet probed",
        support: "offline",
        note: "AVI almost always carries XviD/DivX here; probe to confirm the codec.",
        match: rec => rec.ext === "avi" && !rec.probe,
    },
    {
        id: "browser-undecodable-unprobed",
        label: "Browser-undecodable, not yet probed",
        support: "investigate",
        note: "Run `yarn vid-errors scan` to probe and split these by real codec.",
        match: rec => !rec.probe && errIs(rec, /cannot be decoded by this browser|decod(er|ing) error|unrecognizable format/i),
    },
    {
        id: "timeout-unprobed",
        label: "Extraction timed out, not yet probed",
        support: "investigate",
        note: "Browser extraction exceeded its time budget. Probe to see the codec/size.",
        match: rec => !rec.probe && errIs(rec, /timed out/i),
    },
];

export interface Bucket {
    rule: Rule;
    records: EnrichedRecord[];
}

export interface Categorized {
    buckets: Bucket[];
    uncategorized: EnrichedRecord[];
}

export function categorize(records: EnrichedRecord[]): Categorized {
    const byRule = new Map<string, EnrichedRecord[]>();
    for (const r of rules) byRule.set(r.id, []);
    const uncategorized: EnrichedRecord[] = [];

    for (const rec of records) {
        const rule = rules.find(r => r.match(rec));
        if (rule) {
            const list = byRule.get(rule.id);
            if (list) list.push(rec);
        } else {
            uncategorized.push(rec);
        }
    }

    const buckets: Bucket[] = [];
    for (const r of rules) {
        const recs = byRule.get(r.id) ?? [];
        if (recs.length > 0) buckets.push({ rule: r, records: recs });
    }
    return { buckets, uncategorized };
}

// Normalize an error message into a signature so distinct-but-equivalent
// messages (different paths, offsets, byte counts) collapse into one group.
export function errorSignature(rec: EnrichedRecord): string {
    let s = rec.extractionError;
    if (rec.relativePath) s = s.split(rec.relativePath).join("<file>");
    const name = rec.relativePath.split(/[\\/]/).pop();
    if (name) s = s.split(name).join("<file>");
    return s
        .replace(/0x[0-9a-fA-F]+/g, "0x#")
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
}
