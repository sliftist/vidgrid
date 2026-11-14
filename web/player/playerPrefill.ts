import { observable, runInAction } from "mobx";
import { files, FileRecord } from "../appState";

const PREFILL_PARAM = "pre";
const DEFERRED_LOAD_AFTER_PLAYBACK_MS = 15_000;

const PREFILL_FIELDS = [
    "name",
    "relativePath",
    "size",
    "durationSec",
    "width",
    "height",
    "videoCodec",
    "audioCodec",
    "fileModifiedAt",
    "metadataExtractionMs",
    "engine",
    "subtitleOffsetMs",
    "hdrExposure",
    "hdrTemperature",
    "hdrTint",
    "loopEnabled",
    "loopStartMs",
    "loopEndMs",
] as const satisfies readonly (keyof FileRecord)[];

export type PrefillField = typeof PREFILL_FIELDS[number];
type Prefill = Partial<Pick<FileRecord, PrefillField>>;

const prefills = observable.map<string, Prefill>(undefined, { deep: false });
const deferred = observable({ readyFor: undefined as string | undefined });
let deferTimer: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
const linkPrefills = new Map<string, Prefill>();

function consumeUrlPrefill(): void {
    if (typeof location === "undefined" || typeof history === "undefined") return;
    const url = new URL(location.href);
    const raw = url.searchParams.get(PREFILL_PARAM);
    if (raw === null) return;
    url.searchParams.delete(PREFILL_PARAM);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.warn(`[prefill] ignoring unparseable ${PREFILL_PARAM} param:`, (err as Error).stack ?? err);
        return;
    }
    const obj = parsed as { key?: unknown; fields?: unknown };
    if (typeof obj.key !== "string" || !obj.fields || typeof obj.fields !== "object") {
        console.warn(`[prefill] ignoring ${PREFILL_PARAM} param without key and fields: ${raw.slice(0, 500)}`);
        return;
    }
    const fields = obj.fields as Prefill;
    prefills.set(obj.key, fields);
    console.log(`[prefill] player opened with ${Object.keys(fields).length} fields for ${obj.key} from the link; vidgrid_index and thumbnails wait until ${DEFERRED_LOAD_AFTER_PLAYBACK_MS}ms after playback starts`);
}
consumeUrlPrefill();

export function playerIndexDeferred(): boolean {
    return prefills.size > 0;
}

export function playerFieldSync<F extends PrefillField>(key: string, field: F): FileRecord[F] | undefined {
    const pre = prefills.get(key);
    if (pre) return pre[field];
    if (playerIndexDeferred()) return undefined;
    return files.getSingleFieldSync(key, field);
}

export async function playerField<F extends PrefillField>(key: string, field: F): Promise<FileRecord[F] | undefined> {
    const pre = prefills.get(key);
    if (pre) return pre[field];
    return await files.getSingleField(key, field);
}

export function notePlayerFieldsWritten(key: string, fields: Prefill): void {
    const pre = prefills.get(key);
    if (!pre) return;
    runInAction(() => prefills.set(key, { ...pre, ...fields }));
}

export function deferredLoadsReady(key: string): boolean {
    return deferred.readyFor === key;
}

export function markPlaybackUnderway(key: string): void {
    if (deferred.readyFor === key) return;
    if (deferTimer?.key === key) return;
    if (deferTimer) clearTimeout(deferTimer.timer);
    const timer = setTimeout(() => {
        deferTimer = undefined;
        const hadPrefill = prefills.size > 0;
        runInAction(() => {
            deferred.readyFor = key;
            prefills.clear();
        });
        console.log(`[prefill] ${DEFERRED_LOAD_AFTER_PLAYBACK_MS}ms after playback of ${key} started: loading the favicon thumbnail${hadPrefill ? " and switching the player from link fields to vidgrid_index" : ""}`);
    }, DEFERRED_LOAD_AFTER_PLAYBACK_MS);
    deferTimer = { key, timer };
}

export async function primePlayerLink(key: string): Promise<void> {
    const values = await Promise.all(PREFILL_FIELDS.map(field => files.getSingleField(key, field)));
    if (!values[PREFILL_FIELDS.indexOf("relativePath")]) return;
    const fields: Record<string, unknown> = {};
    PREFILL_FIELDS.forEach((field, i) => {
        if (values[i] !== undefined) fields[field] = values[i];
    });
    linkPrefills.set(key, fields as Prefill);
}

export function linkPrefillParam(key: string): string | undefined {
    const fields = linkPrefills.get(key);
    if (!fields) return undefined;
    return JSON.stringify({ key, fields });
}

export { PREFILL_PARAM };
