// Fetch a .tar.gz of model files and unpack it onto disk, into the Origin
// Private File System -- the same storage the rest of this app's data lives in,
// and what faceEmbed/opfs.ts already does for its model weights.
//
// Why a tarball at all: the hosting is one immutable public bucket, and a model
// is 5-7 files including one ~650 MB .onnx. Shipping them as one archive means
// one URL to upload, one URL to pin in the code, and one request from the
// browser instead of a fan-out that has to match HuggingFace's directory layout
// byte for byte.
//
// Unpacking is fully streamed: response -> gunzip -> tar -> file, written a few
// MB at a time, so neither an entry nor the archive is ever held in memory.
// (This used to unpack into Cache Storage, which was simply the wrong tool: it
// is an HTTP response cache, it takes its own copy of every Blob handed to it,
// so storing the model needed twice its size and reported failure as
// "Failed to execute 'put' on 'Cache': Unexpected internal error".)

// Directory inside OPFS holding every unpacked archive.
const OPFS_DIR = "model-tarballs";
// The Cache Storage bucket the old implementation wrote to. Deleted on sight,
// so a browser that unpacked a model the old way gets that space back instead
// of paying for two copies.
const LEGACY_CACHE_NAME = "vidgrid-model-tarballs-v1";
const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
// Marker files recording "this archive finished unpacking", kept in their own
// subdirectory so they cannot collide with an archive's own entries.
const DONE_DIR = "@done";

// --- tar reading -----------------------------------------------------------

// A queue of chunks we can take exact byte counts from without ever
// concatenating the whole stream (which would be quadratic on a 450 MB entry).
class ByteQueue {
    private chunks: Uint8Array[] = [];
    private length = 0;
    private done = false;

    constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) { }

    private async fill(n: number): Promise<void> {
        while (this.length < n && !this.done) {
            const r = await this.reader.read();
            if (r.done) { this.done = true; break; }
            if (r.value.length === 0) continue;
            this.chunks.push(r.value);
            this.length += r.value.length;
        }
    }

    // Removes exactly n bytes, or fewer at end of stream. Returns the pieces.
    async take(n: number): Promise<Uint8Array[]> {
        await this.fill(n);
        const out: Uint8Array[] = [];
        let need = n;
        while (need > 0 && this.chunks.length) {
            const head = this.chunks[0];
            if (head.length <= need) {
                out.push(head);
                this.chunks.shift();
                this.length -= head.length;
                need -= head.length;
            } else {
                out.push(head.subarray(0, need));
                this.chunks[0] = head.subarray(need);
                this.length -= need;
                need = 0;
            }
        }
        return out;
    }

    // Like take(), but the caller wants the bytes contiguous. Only used for
    // 512-byte headers, so the copy is trivial.
    async takeFlat(n: number): Promise<Uint8Array | undefined> {
        const parts = await this.take(n);
        const total = parts.reduce((a, p) => a + p.length, 0);
        if (total < n) return undefined;
        const out = new Uint8Array(n);
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
    }
}

function readString(header: Uint8Array, offset: number, length: number): string {
    let end = offset;
    while (end < offset + length && header[end] !== 0) end++;
    return new TextDecoder().decode(header.subarray(offset, end));
}

function readOctal(header: Uint8Array, offset: number, length: number): number {
    const s = readString(header, offset, length).trim();
    if (!s) return 0;
    return parseInt(s, 8) || 0;
}

// True for the all-zero block that terminates an archive.
function isZeroBlock(b: Uint8Array): boolean {
    for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
    return true;
}

// A destination for one entry's bytes. Returning undefined from the sink skips
// the entry without buffering it.
export interface TarEntryWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
export type TarEntrySink = (path: string, size: number) => Promise<TarEntryWriter | undefined>;

export async function untar(
    stream: ReadableStream<Uint8Array>,
    onEntry: TarEntrySink,
): Promise<void> {
    const q = new ByteQueue(stream.getReader());
    for (; ;) {
        const header = await q.takeFlat(512);
        if (!header) return;
        if (isZeroBlock(header)) return;

        // ustar splits long paths across `prefix` (345 bytes at 345) and
        // `name` (100 bytes at 0).
        const name = readString(header, 0, 100);
        const prefix = readString(header, 345, 155);
        const path = prefix ? `${prefix}/${name}` : name;
        const size = readOctal(header, 124, 12);
        const typeFlag = String.fromCharCode(header[156] || 0x30);
        const padding = size % 512 === 0 ? 0 : 512 - (size % 512);

        // '0'/'\0' are regular files. Directories, links, and GNU extension
        // records carry nothing we need, so their bodies are skipped.
        const isFile = typeFlag === "0" || typeFlag === "\0";
        if (!isFile) {
            await q.take(size + padding);
            continue;
        }

        const writer = await onEntry(path, size);
        if (!writer) {
            await q.take(size + padding);
            continue;
        }

        // Straight from the decompressor to the file: at no point does a whole
        // entry exist in memory, which is the only way a 650 MB member of the
        // archive is unremarkable.
        let left = size;
        while (left > 0) {
            const got = await q.take(Math.min(left, WRITE_CHUNK_BYTES));
            const n = got.reduce((a, p) => a + p.length, 0);
            if (n === 0) break;                    // truncated archive
            for (const p of got) await writer.write(p);
            left -= n;
        }
        await writer.close();
        await q.take(padding);
    }
}

// --- public API ------------------------------------------------------------

export type TarProgress = (message: string, fraction: number | undefined) => void;

function mb(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// --- OPFS layout -----------------------------------------------------------

function opfsRoot(): Promise<FileSystemDirectoryHandle> | undefined {
    const storage = typeof navigator !== "undefined" ? (navigator as any).storage : undefined;
    return storage?.getDirectory ? storage.getDirectory() : undefined;
}

async function modelsDir(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    const rootPromise = opfsRoot();
    if (!rootPromise) return undefined;
    try {
        return await (await rootPromise).getDirectoryHandle(OPFS_DIR, { create });
    } catch {
        return undefined;                          // absent, and not creating
    }
}

// Tar paths carry the archive's own top-level directory, and we mirror that as
// real directories so what lands on disk reads like the archive did.
async function entryFile(
    path: string, create: boolean,
): Promise<FileSystemFileHandle | undefined> {
    const parts = path.split("/").filter(p => p && p !== "." && p !== "..");
    if (!parts.length) return undefined;
    let dir = await modelsDir(create);
    if (!dir) return undefined;
    try {
        for (const part of parts.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(part, { create });
        }
        return await dir.getFileHandle(parts[parts.length - 1], { create });
    } catch {
        return undefined;
    }
}

function donePath(tarUrl: string): string {
    return `${DONE_DIR}/${encodeURIComponent(tarUrl)}`;
}

// The old Cache Storage copy is dead weight the moment OPFS has one; dropping
// it returns ~670 MB of quota rather than leaving both copies parked.
let legacyDropped = false;
async function dropLegacyCache(): Promise<void> {
    if (legacyDropped || typeof caches === "undefined") return;
    legacyDropped = true;
    try { await caches.delete(LEGACY_CACHE_NAME); } catch { /* best effort */ }
}

// OPFS shares one quota with everything else this origin stores, and on a
// scanned library the thumbnail/keyframe/face databases are by far the biggest
// thing in it. A 670 MB model goes on top of all that, so check before spending
// a 456 MB download, and report the numbers if a write fails anyway.
export interface Headroom { usage: number; quota: number; free: number; }

export async function storageHeadroom(): Promise<Headroom | undefined> {
    try {
        const est = await (navigator as any)?.storage?.estimate?.();
        if (!est || !est.quota) return undefined;
        const usage = est.usage ?? 0;
        return { usage, quota: est.quota, free: Math.max(0, est.quota - usage) };
    } catch {
        return undefined;                          // no estimate API: just try
    }
}

function outOfSpaceMessage(label: string, needBytes: number, head: Headroom | undefined): string {
    const need = `${label} needs about ${mb(needBytes)} of storage`;
    if (!head) return `${need}, and this browser reports it cannot store that much. Free up disk space and try again.`;
    return `${need}, but only ${mb(head.free)} is free: this site is using ${mb(head.usage)} of the `
        + `${mb(head.quota)} the browser allows it. Chrome's allowance follows free disk space, so `
        + `freeing space on the drive raises it. Clearing this site's cached thumbnails and keyframes `
        + `also works, at the cost of rescanning them.`;
}

// A byte slice of a larger file that is itself a complete .tar.gz. Lets many
// archives share one uploaded file, fetched with a Range request (see
// packIndex() in models.ts).
export interface TarRange { offset: number; length: number; }

function rangeKey(tarUrl: string, range?: TarRange): string {
    return range ? `${tarUrl}#${range.offset}+${range.length}` : tarUrl;
}

// Downloads and unpacks `tarUrl` unless it has already been unpacked. Safe to
// call repeatedly; concurrent calls for the same URL share one download.
const inFlight = new Map<string, Promise<void>>();

export function ensureTarballExtracted(
    tarUrl: string, label: string, onProgress?: TarProgress, unpackedBytes = 0,
    range?: TarRange,
): Promise<void> {
    const key = rangeKey(tarUrl, range);
    let pending = inFlight.get(key);
    if (!pending) {
        pending = extract(tarUrl, label, onProgress, unpackedBytes, range).catch(e => {
            inFlight.delete(key);
            throw e;
        });
        inFlight.set(key, pending);
    }
    return pending;
}

async function extract(
    tarUrl: string, label: string, onProgress?: TarProgress, unpackedBytes = 0,
    range?: TarRange,
): Promise<void> {
    if (!opfsRoot()) {
        throw new Error("This browser has no private file system, so model files cannot be stored.");
    }
    if (await readExtractedFile(donePath(rangeKey(tarUrl, range)))) return;
    await dropLegacyCache();

    // 5% of headroom over the unpacked size. Writes go straight to disk one
    // entry at a time, so unlike the old Cache Storage path there is no moment
    // where an entry exists twice.
    if (unpackedBytes) {
        const head = await storageHeadroom();
        if (head && head.free < unpackedBytes * 1.05) {
            throw new Error(outOfSpaceMessage(label, unpackedBytes, head));
        }
    }

    onProgress?.(`Downloading ${label}...`, 0);
    const res = await fetch(tarUrl, range
        ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
        : undefined);
    if (!res.ok || !res.body) {
        throw new Error(`Could not download ${label} (HTTP ${res.status}).`);
    }
    // A range request that comes back 200 means the host ignored Range and is
    // sending the WHOLE pack -- gigabytes, and the gzip stream would not even
    // start at the right byte. Fail loudly instead of downloading all of it.
    if (range && res.status !== 206) {
        throw new Error(
            `Could not download ${label}: the server does not support range requests `
            + `(HTTP ${res.status}), so the model cannot be fetched from the pack.`);
    }
    const total = range ? range.length : Number(res.headers.get("content-length")) || 0;

    let received = 0;
    let lastReport = 0;
    const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            received += chunk.byteLength;
            // Reporting every chunk would be thousands of renders; every 2 MB
            // is smooth enough to watch and cheap enough to ignore.
            if (received - lastReport > 2 * 1024 * 1024) {
                lastReport = received;
                onProgress?.(
                    total
                        ? `Downloading ${label}: ${Math.round((received / total) * 100)}% (${mb(received)} of ${mb(total)})`
                        : `Downloading ${label}: ${mb(received)}`,
                    total ? received / total : undefined);
            }
            controller.enqueue(chunk);
        },
    });

    const written: string[] = [];
    const stream = res.body.pipeThrough(counting).pipeThrough(new DecompressionStream("gzip"));
    try {
        await untar(stream, async (path, size) => {
            onProgress?.(`Unpacking ${label}: ${path.split("/").pop()}`,
                total ? received / total : undefined);
            const fh = await entryFile(path, true);
            if (!fh) throw new Error(`Could not create ${path} in the private file system.`);
            const w = await (fh as any).createWritable();
            written.push(path);
            return {
                write: (chunk: Uint8Array) => w.write(chunk),
                close: () => w.close(),
            };
        });
    } catch (e: any) {
        // Do not leave several hundred MB of a model that will never load
        // sitting in the space we may be about to tell the user is full.
        await deleteExtracted(written);
        const head = await storageHeadroom();
        const need = unpackedBytes || 0;
        // A write that fails for lack of room says so in a dozen different
        // ways depending on browser; the numbers are what actually help.
        throw new Error(
            `Could not store ${label}. ${outOfSpaceMessage(label, need, head)} `
            + `(browser said: ${e?.message ?? String(e)})`);
    }

    if (!written.length) throw new Error(`${label} archive was empty.`);
    // Written last, so an interrupted unpack simply redoes itself next time
    // rather than leaving a half-populated model that looks complete.
    const doneFh = await entryFile(donePath(rangeKey(tarUrl, range)), true);
    if (doneFh) {
        const w = await (doneFh as any).createWritable();
        await w.write(new TextEncoder().encode(JSON.stringify(written)));
        await w.close();
    }
    onProgress?.(`${label} ready`, 1);
}

async function deleteExtracted(paths: string[]): Promise<void> {
    const dir = await modelsDir(false);
    if (!dir) return;
    for (const path of paths) {
        const parts = path.split("/").filter(p => p && p !== "." && p !== "..");
        try {
            let at = dir;
            for (const part of parts.slice(0, -1)) at = await at.getDirectoryHandle(part);
            await at.removeEntry(parts[parts.length - 1]);
        } catch { /* already gone */ }
    }
}

// A raw file (typically a .onnx graph) that lives on its own URL, not inside a
// tarball. Fetched once, streamed to OPFS at `opfsPath`, then served by the
// customCache like anything else. Used when a model's weights are hosted as a
// bare file but its tokenizer/config still come from a tarball.
const rawInFlight = new Map<string, Promise<void>>();
export function ensureRawFileFetched(
    url: string, opfsPath: string, label: string,
    unpackedBytes: number, onProgress?: TarProgress,
): Promise<void> {
    const key = `raw:${opfsPath}`;
    let pending = rawInFlight.get(key);
    if (!pending) {
        pending = fetchRaw(url, opfsPath, label, unpackedBytes, onProgress).catch(e => {
            rawInFlight.delete(key);
            throw e;
        });
        rawInFlight.set(key, pending);
    }
    return pending;
}

async function fetchRaw(
    url: string, opfsPath: string, label: string,
    unpackedBytes: number, onProgress?: TarProgress,
): Promise<void> {
    if (!opfsRoot()) {
        throw new Error("This browser has no private file system, so model files cannot be stored.");
    }
    // Done-marker doubles as the "have this URL already" flag; keyed by URL so
    // a re-upload at the same OPFS path still redownloads.
    const done = donePath("raw:" + url);
    if (await readExtractedFile(done)) return;

    if (unpackedBytes) {
        const head = await storageHeadroom();
        if (head && head.free < unpackedBytes * 1.05) {
            throw new Error(outOfSpaceMessage(label, unpackedBytes, head));
        }
    }

    onProgress?.(`Downloading ${label}...`, 0);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Could not download ${label} (HTTP ${res.status}).`);
    }
    const total = Number(res.headers.get("content-length")) || unpackedBytes || 0;

    const fh = await entryFile(opfsPath, true);
    if (!fh) throw new Error(`Could not create ${opfsPath} in the private file system.`);
    const w = await (fh as any).createWritable();

    let received = 0, lastReport = 0;
    const reader = res.body.getReader();
    try {
        for (; ;) {
            const r = await reader.read();
            if (r.done) break;
            await w.write(r.value);
            received += r.value.byteLength;
            if (received - lastReport > 2 * 1024 * 1024) {
                lastReport = received;
                onProgress?.(
                    total
                        ? `Downloading ${label}: ${Math.round((received / total) * 100)}% (${mb(received)} of ${mb(total)})`
                        : `Downloading ${label}: ${mb(received)}`,
                    total ? received / total : undefined);
            }
        }
        await w.close();
    } catch (e: any) {
        try { await w.close(); } catch { /* ignore */ }
        await deleteExtracted([opfsPath]);
        const head = await storageHeadroom();
        throw new Error(
            `Could not store ${label}. ${outOfSpaceMessage(label, unpackedBytes || 0, head)} `
            + `(browser said: ${e?.message ?? String(e)})`);
    }

    const doneFh = await entryFile(done, true);
    if (doneFh) {
        const dw = await (doneFh as any).createWritable();
        await dw.write(new TextEncoder().encode(JSON.stringify([opfsPath])));
        await dw.close();
    }
    onProgress?.(`${label} ready`, 1);
}

// Reads one file back out of an extracted archive, by its path INSIDE the tar
// (including the archive's top-level directory). Returns the Response rather
// than bytes so the caller picks its own representation -- arrayBuffer() for an
// ONNX graph, text() for a vocab -- instead of this function forcing a 650 MB
// copy nobody asked for.
export async function readExtractedFile(path: string): Promise<Response | undefined> {
    const fh = await entryFile(path, false);
    if (!fh) return undefined;
    try {
        // A Response over a File is a view, not a copy -- nothing is read off
        // disk until the caller asks for bytes.
        const file = await fh.getFile();
        return new Response(file, {
            headers: {
                "content-length": String(file.size),
                "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream",
            },
        });
    } catch {
        return undefined;
    }
}

// A transformers.js `env.customCache`: it only has to implement the two Web
// Cache methods transformers.js actually calls. Lookups arrive as either
// "/models/<repo>/<file>" or "<remoteHost><repo>/<file>", and both end with the
// tar's own path for that file -- so slicing at the repo id maps one to the
// other exactly, with no guessing.
class ModelTarCache {
    private repos: string[] = [];

    registerRepo(repo: string): void {
        if (!this.repos.includes(repo)) this.repos.push(repo);
    }

    private key(request: any): string | undefined {
        const url = typeof request === "string" ? request : String(request?.url ?? request);
        for (const repo of this.repos) {
            const at = url.lastIndexOf(repo + "/");
            if (at >= 0) return url.slice(at);
        }
        return undefined;
    }

    async match(request: any): Promise<Response | undefined> {
        const key = this.key(request);
        if (!key) return undefined;
        return await readExtractedFile(key);
    }

    // transformers.js writes back anything it had to fetch. We are already the
    // authority on what exists, and a miss here means a file genuinely absent
    // from the archive, so there is nothing worth storing.
    async put(): Promise<void> { }
}

export const modelTarCache = new ModelTarCache();
