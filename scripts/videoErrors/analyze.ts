// Offline triage tool for the videos whose browser extraction failed.
//
//   yarn vid-errors [summary]                      breakdown by category
//   yarn vid-errors scan [--reprobe]               (re)build the ffprobe cache
//   yarn vid-errors messages [--uncat] [--limit N] distinct error signatures + counts
//   yarn vid-errors list   [--cat ID|--uncat] [--limit N] [<substr>]   per-file path + error
//   yarn vid-errors paths  [--cat ID|--uncat] [--limit N] [<substr>]   absolute paths only
//   yarn vid-errors probe  [--cat ID|--uncat] [--limit N] [--decode]   group by what's inside
//   yarn vid-errors inspect [--cat ID|--uncat] [--limit N] [<substr>]  deep dump per file
//
// Records are enriched with a cached ffprobe summary on load (first run probes,
// later runs are instant — see probeCache.ts), so categorization keys on the
// real codec. Pass --no-probe to skip probing entirely.
//
// This is the one reusable entry point — every operation is a subcommand, so the
// permission to run it only needs granting once.

import { loadErrorRecords, loadMediaInfo } from "./db";
import { enrich, EnrichedRecord } from "./probeCache";
import { categorize, rules, errorSignature, Support } from "./rules";
import { runFfprobe, ffmpegDecodeTest, describeProbe } from "./ffmpeg";
import { sort } from "socket-function/src/misc";

interface Args {
    sub: string;
    cat?: string;
    uncat: boolean;
    limit?: number;
    decode: boolean;
    reprobe: boolean;
    noProbe: boolean;
    conc: number;
    substr?: string;
}

function parseArgs(argv: string[]): Args {
    const out: Args = { sub: "summary", uncat: false, decode: false, reprobe: false, noProbe: false, conc: 16 };
    let first = true;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--uncat") out.uncat = true;
        else if (a === "--decode") out.decode = true;
        else if (a === "--reprobe") out.reprobe = true;
        else if (a === "--no-probe") out.noProbe = true;
        else if (a === "--cat") out.cat = argv[++i];
        else if (a.startsWith("--cat=")) out.cat = a.slice("--cat=".length);
        else if (a === "--limit") out.limit = Number(argv[++i]);
        else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
        else if (a === "--conc") out.conc = Number(argv[++i]);
        else if (a.startsWith("--conc=")) out.conc = Number(a.slice("--conc=".length));
        else if (first) { out.sub = a; first = false; }
        else out.substr = a;
    }
    return out;
}

const supportTag: Record<Support, string> = {
    offline: "SHOULD-WORK (offline)",
    unsupported: "unsupported",
    investigate: "investigate",
};

function selectRecords(all: EnrichedRecord[], args: Args): EnrichedRecord[] {
    const { buckets, uncategorized } = categorize(all);
    let set: EnrichedRecord[];
    if (args.uncat) set = uncategorized;
    else if (args.cat) set = buckets.find(b => b.rule.id === args.cat)?.records ?? [];
    else set = all;
    if (args.substr) {
        const needle = args.substr.toLowerCase();
        set = set.filter(r =>
            r.relativePath.toLowerCase().includes(needle) ||
            r.extractionError.toLowerCase().includes(needle));
    }
    return set;
}

function summary(all: EnrichedRecord[]): void {
    const { buckets, uncategorized } = categorize(all);
    const probed = all.filter(r => r.probe).length;
    console.log(`\n${all.length} files with an extraction error (${probed} probed)\n`);
    console.log(`${"category".padEnd(30)} ${"support".padEnd(22)} count`);
    console.log("-".repeat(66));
    const totals: Record<Support, number> = { offline: 0, unsupported: 0, investigate: 0 };
    for (const b of sort(buckets, b => -b.records.length)) {
        totals[b.rule.support] += b.records.length;
        console.log(`${b.rule.id.padEnd(30)} ${supportTag[b.rule.support].padEnd(22)} ${b.records.length}`);
    }
    console.log("-".repeat(66));
    console.log(`${"UNCATEGORIZED".padEnd(30)} ${"".padEnd(22)} ${uncategorized.length}`);
    console.log("");
    console.log(`SHOULD-WORK offline: ${totals.offline}    unsupported: ${totals.unsupported}    investigate: ${totals.investigate}    uncategorized: ${uncategorized.length}`);
    console.log("");
}

function messages(all: EnrichedRecord[], args: Args): void {
    const set = selectRecords(all, args);
    const groups = new Map<string, { count: number; example: EnrichedRecord }>();
    for (const rec of set) {
        const sig = errorSignature(rec);
        const g = groups.get(sig);
        if (g) g.count++;
        else groups.set(sig, { count: 1, example: rec });
    }
    const ordered = sort([...groups.entries()], e => -e[1].count);
    const limit = args.limit ?? ordered.length;
    console.log(`\n${set.length} files, ${groups.size} distinct error signatures${args.uncat ? " (uncategorized only)" : ""}\n`);
    for (const [sig, g] of ordered.slice(0, limit)) {
        console.log(`[${String(g.count).padStart(4)}]  ${sig}`);
        console.log(`        e.g. ${g.example.relativePath}`);
    }
    console.log("");
}

function list(all: EnrichedRecord[], args: Args): void {
    const set = selectRecords(all, args);
    const limit = args.limit ?? set.length;
    console.log(`\n${set.length} files${limit < set.length ? ` (showing ${limit})` : ""}\n`);
    for (const rec of set.slice(0, limit)) {
        const pv = rec.probe?.hasVideo ? rec.probe.primaryVideo : (rec.probe ? "(no video)" : "(unprobed)");
        console.log(`${rec.relativePath}    [${pv}]`);
        console.log(`    ${rec.extractionError.replace(/\s+/g, " ").slice(0, 280)}`);
    }
    console.log("");
}

function paths(all: EnrichedRecord[], args: Args): void {
    const set = selectRecords(all, args);
    const limit = args.limit ?? set.length;
    for (const rec of set.slice(0, limit)) console.log(rec.absPath);
}

function probeGroups(all: EnrichedRecord[], args: Args): void {
    const set = selectRecords(all, args);
    const groups = new Map<string, { count: number; example: EnrichedRecord }>();
    for (const rec of set) {
        const p = rec.probe;
        const desc = !p ? "(unprobed)"
            : !p.ok ? `UNREADABLE: ${p.ffError ?? "?"}`
                : `${p.container ?? "?"} | v=${p.video.join(",") || "none"} a=${p.audio.join(",") || "none"}`;
        const g = groups.get(desc);
        if (g) g.count++;
        else groups.set(desc, { count: 1, example: rec });
    }
    const ordered = sort([...groups.entries()], e => -e[1].count);
    console.log(`\n${set.length} files, ${groups.size} distinct probe results:\n`);
    for (const [desc, g] of ordered) {
        console.log(`[${String(g.count).padStart(4)}]  ${desc}`);
        console.log(`        e.g. ${g.example.relativePath}`);
    }
    console.log("");
}

// Run an async worker over items with a fixed concurrency cap.
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

async function decodeReport(all: EnrichedRecord[], args: Args): Promise<void> {
    let set = selectRecords(all, args).filter(r => r.exists);
    if (args.limit !== undefined) set = set.slice(0, args.limit);
    console.log(`\nDecode-testing ${set.length} files, concurrency ${args.conc}…\n`);
    const groups = new Map<string, { count: number; example: EnrichedRecord }>();
    let done = 0;
    await pool(set, args.conc, async rec => {
        const d = await ffmpegDecodeTest(rec.absPath);
        const key = d.ok ? "OK" : (d.timedOut ? "TIMEOUT" : (d.stderr.split("\n").pop() ?? "FAIL").slice(0, 120));
        const g = groups.get(key);
        if (g) g.count++;
        else groups.set(key, { count: 1, example: rec });
        done++;
        if (done % 50 === 0) process.stderr.write(`  …${done}/${set.length}\n`);
    });
    for (const [desc, g] of sort([...groups.entries()], e => -e[1].count)) {
        console.log(`[${String(g.count).padStart(4)}]  ${desc}`);
        console.log(`        e.g. ${g.example.relativePath}`);
    }
    console.log("");
}

async function inspect(all: EnrichedRecord[], args: Args): Promise<void> {
    const set = selectRecords(all, args).slice(0, args.limit ?? 5);
    for (const rec of set) {
        console.log(`\n========================================================`);
        console.log(rec.relativePath);
        console.log(`key:   ${rec.key}`);
        console.log(`error: ${rec.extractionError}`);
        console.log(`cached probe: ${JSON.stringify(rec.probe)}`);
        const mi = await loadMediaInfo(rec.key);
        if (mi) console.log(`mediaInfo: ${JSON.stringify(mi)}`);
        if (!rec.exists) { console.log("(file missing on disk — skipping ffprobe)"); continue; }
        const p = await runFfprobe(rec.absPath);
        console.log(`ffprobe: ${describeProbe(p)}`);
        for (const s of p.streams) {
            console.log(`   #${s.index} ${s.codec_type}: ${s.codec_name}${s.profile ? ` (${s.profile})` : ""}${s.width ? ` ${s.width}x${s.height}` : ""}${s.pix_fmt ? ` ${s.pix_fmt}` : ""}${s.codec_tag_string ? ` tag=${s.codec_tag_string}` : ""}`);
        }
        if (p.error || p.stderr) console.log(`ffprobe notes: ${p.error ?? ""} ${p.stderr ?? ""}`.trim());
        const d = await ffmpegDecodeTest(rec.absPath);
        console.log(`decode test: ${d.ok ? "OK" : `FAIL${d.timedOut ? " (timeout)" : ""}: ${d.stderr.split("\n").slice(-3).join(" | ")}`}`);
    }
    console.log("");
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const records = await loadErrorRecords();
    // Subcommands that don't need probe data skip it; everything else enriches
    // (cheap after the first run thanks to the on-disk cache).
    const skipProbe = args.noProbe || args.sub === "messages";
    const all = await enrich(records, { force: args.reprobe, noProbe: skipProbe, concurrency: args.conc });

    if (args.sub === "summary" || args.sub === "scan") summary(all);
    else if (args.sub === "messages") messages(all, args);
    else if (args.sub === "list") list(all, args);
    else if (args.sub === "paths") paths(all, args);
    else if (args.sub === "probe") probeGroups(all, args);
    else if (args.sub === "decode") await decodeReport(all, args);
    else if (args.sub === "inspect") await inspect(all, args);
    else if (args.sub === "rules") {
        for (const r of rules) console.log(`${r.id.padEnd(30)} ${supportTag[r.support].padEnd(22)} ${r.label}`);
    } else {
        console.error(`Unknown subcommand: ${args.sub}`);
        process.exit(2);
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
