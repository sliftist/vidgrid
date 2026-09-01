import * as fs from "fs";
import * as path from "path";
import { files, keyframes, FileRecord, KeyframesRecord } from "../../web/appState";
import { flushAll } from "./faceIngest";

const DEFAULT_JSON_NAME = "timeouts.json";
const TIMEOUT_PATTERN =/timed out|timeout|exceeded \d+(\.\d+)?s|unresponsive|hung|decoder is stuck/i;

interface BadFileRow {
    key: string;
    relativePath?: string;
    blacklisted: boolean;
    timedOut: boolean;
    phases: string[];
    metadataError?: string;
    keyframesError?: string;
    facesError?: string;
    metadataExtractedAt?: number;
    keyframesExtractedAt?: number;
    facesExtractedAt?: number;
    lastErrorAt?: number;
}

function isoOrDash(at: number | undefined): string {
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "-";
    return new Date(at).toISOString();
}

function columnMap<T>(rows: { key: string; value: T | undefined }[]): Map<string, T> {
    const m = new Map<string, T>();
    for (const { key, value } of rows) {
        if (value !== undefined) m.set(key, value);
    }
    return m;
}

async function main() {
    const argv = process.argv.slice(2);
    const positional: string[] = [];
    let jsonOut: string | undefined;
    let includeAllErrors = false;
    let unblacklist = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") {
            jsonOut = path.resolve(argv[++i] ?? DEFAULT_JSON_NAME);
        } else if (arg === "--all-errors") {
            includeAllErrors = true;
        } else if (arg === "--unblacklist") {
            unblacklist = true;
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown flag ${arg}; expected [<data_root>] [--json <path>] [--all-errors] [--unblacklist]`);
        } else {
            positional.push(arg);
        }
    }
    const root = positional[positional.length - 1];
    if (!root) {
        throw new Error(`Expected <data_root> (the folder holding data/bulkDatabases2), got argv=${JSON.stringify(argv)}`);
    }

    process.chdir(root);

    const [relCol, blCol, extErrCol, facesErrCol, metaAtCol, facesAtCol] = await Promise.all([
        files.getColumn("relativePath"),
        files.getColumn("scanBlacklisted"),
        files.getColumn("extractionError"),
        files.getColumn("facesError"),
        files.getColumn("metadataExtractedAt"),
        files.getColumn("facesExtractedAt"),
    ]);
    const [kfErrCol, kfAtCol] = await Promise.all([
        keyframes.getColumn("keyframesError"),
        keyframes.getColumn("keyframesExtractedAt"),
    ]);

    const relByKey = columnMap(relCol);
    const blByKey = columnMap(blCol);
    const metaErrByKey = columnMap(extErrCol);
    const facesErrByKey = columnMap(facesErrCol);
    const kfErrByKey = columnMap(kfErrCol);
    const metaAtByKey = columnMap(metaAtCol);
    const facesAtByKey = columnMap(facesAtCol);
    const kfAtByKey = columnMap(kfAtCol);

    const candidateKeys = new Set<string>();
    for (const key of blByKey.keys()) {
        if (blByKey.get(key)) candidateKeys.add(key);
    }
    for (const [key, msg] of metaErrByKey) {
        if (msg && (includeAllErrors || TIMEOUT_PATTERN.test(msg))) candidateKeys.add(key);
    }
    for (const [key, msg] of facesErrByKey) {
        if (msg && (includeAllErrors || TIMEOUT_PATTERN.test(msg))) candidateKeys.add(key);
    }
    for (const [key, msg] of kfErrByKey) {
        if (msg && (includeAllErrors || TIMEOUT_PATTERN.test(msg))) candidateKeys.add(key);
    }

    const rows: BadFileRow[] = [];
    for (const key of candidateKeys) {
        const metadataError = metaErrByKey.get(key) || undefined;
        const keyframesError = kfErrByKey.get(key) || undefined;
        const facesError = facesErrByKey.get(key) || undefined;
        const phases: string[] = [];
        if (metadataError) phases.push("metadata");
        if (keyframesError) phases.push("keyframes");
        if (facesError) phases.push("faces");
        const timedOut = [metadataError, keyframesError, facesError].some(m => m && TIMEOUT_PATTERN.test(m));
        const stamps = [metaAtByKey.get(key), kfAtByKey.get(key), facesAtByKey.get(key)].filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
        );
        rows.push({
            key,
            relativePath: relByKey.get(key),
            blacklisted: Boolean(blByKey.get(key)),
            timedOut,
            phases,
            metadataError,
            keyframesError,
            facesError,
            metadataExtractedAt: metaAtByKey.get(key),
            keyframesExtractedAt: kfAtByKey.get(key),
            facesExtractedAt: facesAtByKey.get(key),
            lastErrorAt: stamps.length ? Math.max(...stamps) : undefined,
        });
    }

    rows.sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0));

    const timedOutRows = rows.filter(r => r.timedOut);
    const blacklistedOnly = rows.filter(r => r.blacklisted && !r.timedOut);

    console.log("");
    console.log(`=== TIMED OUT (${timedOutRows.length}) ===`);
    for (const r of timedOutRows) {
        const message = r.facesError ?? r.keyframesError ?? r.metadataError ?? "";
        console.log(`${isoOrDash(r.lastErrorAt)}  ${r.blacklisted ? "[blacklisted]" : "[not-blacklisted]"}  ${r.relativePath ?? r.key}`);
        console.log(`    phases: ${r.phases.join(", ") || "none"}`);
        console.log(`    ${message}`);
    }

    if (blacklistedOnly.length) {
        console.log("");
        console.log(`=== BLACKLISTED, NOT A TIMEOUT (${blacklistedOnly.length}) ===`);
        for (const r of blacklistedOnly) {
            const message = r.facesError ?? r.keyframesError ?? r.metadataError ?? "(no stored error)";
            console.log(`${isoOrDash(r.lastErrorAt)}  ${r.relativePath ?? r.key}`);
            console.log(`    ${message}`);
        }
    }

    console.log("");
    console.log(`total files scanned: ${relByKey.size}; blacklisted: ${rows.filter(r => r.blacklisted).length}; timed out: ${timedOutRows.length}`);
    console.log(`note: timestamps are the phase's last-run time — there is no dedicated blacklistedAt field.`);

    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify(rows, undefined, 2));
        console.log(`wrote ${rows.length} rows to ${jsonOut}`);
    }

    if (!unblacklist) {
        if (timedOutRows.length) {
            console.log(`pass --unblacklist to clear the blacklist + timeout errors on the ${timedOutRows.length} timed-out files above.`);
        }
        return;
    }
    if (!timedOutRows.length) {
        console.log(`nothing to unblacklist.`);
        return;
    }

    const filePatches: (Partial<FileRecord> & { key: string })[] = [];
    const keyframePatches: (Partial<KeyframesRecord> & { key: string })[] = [];
    for (const r of timedOutRows) {
        const patch: Partial<FileRecord> & { key: string } = { key: r.key, scanBlacklisted: undefined };
        if (r.metadataError && TIMEOUT_PATTERN.test(r.metadataError)) {
            patch.extractionError = undefined;
            patch.metadataVersion = undefined;
            patch.metadataExtractedAt = undefined;
            patch.metaAttempts = undefined;
        }
        if (r.facesError && TIMEOUT_PATTERN.test(r.facesError)) {
            patch.facesError = undefined;
            patch.facesVersion = undefined;
            patch.facesExtractedAt = undefined;
            patch.facesEmpty = undefined;
            patch.facesAttempts = undefined;
        }
        if (r.keyframesError && TIMEOUT_PATTERN.test(r.keyframesError)) {
            patch.keyframesDoneVersion = undefined;
            keyframePatches.push({
                key: r.key,
                keyframesError: undefined,
                keyframesVersion: undefined,
                keyframesExtractedAt: undefined,
                kfAttempts: undefined,
            });
        }
        filePatches.push(patch);
    }

    await files.updateBatch(filePatches);
    if (keyframePatches.length) {
        await keyframes.updateBatch(keyframePatches);
    }
    await flushAll();
    console.log(`unblacklisted + cleared timeout state on ${filePatches.length} files (${keyframePatches.length} keyframe rows reset); they will be re-picked on the next scan.`);
}

main().catch(err => {
    console.error((err as Error).stack);
    process.exit(1);
}).finally(() => process.exit(0));
