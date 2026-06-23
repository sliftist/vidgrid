// Persistent ffprobe cache + record enrichment.
//
// The categorization rules want to key on what's ACTUALLY inside each failing
// file (its real video codec, or "ffmpeg can't open it either"), which only
// ffprobe knows. Probing ~900 files takes ~15s, so we cache the per-file probe
// summary to disk: the first run populates it, every run after is instant. This
// is also what makes the "check it off and never look again" loop cheap — a
// classified file's probe never has to be recomputed.

import * as fs from "fs";
import * as path from "path";
import { ErrorRecord } from "./db";
import { runFfprobe, summarizeProbe, ProbeSummary } from "./ffmpeg";

// Lives next to the scripts (absolute, so the runtime chdir into the data root
// doesn't move it). Gitignored — it's a local triage artifact. The filename
// deliberately does NOT share a basename with any .ts module here: Node resolves
// `./foo` to `foo.json` before `foo.ts`, so a `probeCache.json` would shadow
// `probeCache.ts` and every import of this module would silently return the
// cache data instead.
const CACHE_PATH = path.resolve(__dirname, "probe-cache.json");

export interface EnrichedRecord extends ErrorRecord {
    probe?: ProbeSummary;
}

interface CacheEntry extends ProbeSummary {
    // On-disk size at probe time — re-probe if the file changed (re-download).
    fileSize?: number;
}

function loadCache(): Map<string, CacheEntry> {
    if (!fs.existsSync(CACHE_PATH)) return new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
        return new Map(Object.entries(raw));
    } catch (err) {
        console.warn(`[probeCache] ignoring unreadable cache: ${(err as Error).message}`);
        return new Map();
    }
}

function saveCache(cache: Map<string, CacheEntry>): void {
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj));
}

async function pool<T>(items: T[], conc: number, work: (item: T, i: number) => Promise<void>): Promise<void> {
    let next = 0;
    async function runner(): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            await work(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, items.length)) }, () => runner()));
}

interface EnrichOptions {
    // Re-probe every file even if cached.
    force?: boolean;
    // Don't run ffprobe for misses — only attach what's already cached.
    noProbe?: boolean;
    concurrency?: number;
}

// Attach a ProbeSummary to every record, probing (and caching) any that aren't
// already cached. Files missing on disk get a synthetic "can't open" summary.
export async function enrich(records: ErrorRecord[], opts: EnrichOptions = {}): Promise<EnrichedRecord[]> {
    const cache = loadCache();
    const conc = opts.concurrency ?? 16;

    const toProbe = opts.noProbe ? [] : records.filter(rec => {
        if (!rec.exists) return false;
        const hit = cache.get(rec.key);
        return opts.force || !hit || hit.fileSize !== rec.size;
    });

    if (toProbe.length > 0) {
        let done = 0;
        console.error(`[probeCache] probing ${toProbe.length} files (concurrency ${conc})…`);
        await pool(toProbe, conc, async rec => {
            const p = await runFfprobe(rec.absPath);
            cache.set(rec.key, { ...summarizeProbe(p), fileSize: rec.size });
            done++;
            if (done % 100 === 0) console.error(`[probeCache]   …${done}/${toProbe.length}`);
        });
        saveCache(cache);
        console.error(`[probeCache] done (${cache.size} cached total)`);
    }

    return records.map(rec => {
        if (!rec.exists) {
            return { ...rec, probe: { ok: false, hasVideo: false, video: [], audio: [], ffError: "file missing on disk" } };
        }
        const hit = cache.get(rec.key);
        return { ...rec, probe: hit };
    });
}
