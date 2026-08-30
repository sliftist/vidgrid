import { getDirectoryHandle, type DirectoryWrapper, type FileWrapper } from "sliftutils/storage/FileFolderAPI";

const MODELS_DIR = "models";
const LEGACY_OPFS_DIR = "model-tarballs";
const LEGACY_CACHE_NAME = "vidgrid-model-tarballs-v1";
const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
const RESERVE_CHUNK_BYTES = 8 * 1024 * 1024;
const RESERVE_PART_BYTES = 1024 * 1024 * 1024;
const DONE_DIR = "@done";
const RESERVE_FILE = "@reserve";
const SWAP_SUFFIX = ".crswap";

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

// --- storage layout --------------------------------------------------------

// Same "did the user pick the folder above `data/` or `data/` itself?"
// resolution getFileStorageNested2 does, so models land beside the databases
// rather than in a second, differently-rooted tree.
let modelsDirPromise: Promise<DirectoryWrapper> | undefined;

function modelsDir(): Promise<DirectoryWrapper> {
    if (!modelsDirPromise) {
        modelsDirPromise = (async () => {
            let base = await getDirectoryHandle();
            const dirs: string[] = [];
            let count = 0;
            for await (const [name, entry] of base) {
                if (entry.kind === "directory") dirs.push(name);
                if (++count > 100) break;
            }
            if (count > 100 || dirs.includes(".git") || dirs.includes("data")) {
                base = await base.getDirectoryHandle("data", { create: true });
            }
            return await base.getDirectoryHandle(MODELS_DIR, { create: true });
        })().catch(e => {
            modelsDirPromise = undefined;
            throw e;
        });
    }
    return modelsDirPromise;
}

interface Writable {
    write(value: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
}

async function freshWritable(dir: DirectoryWrapper, name: string): Promise<Writable> {
    await discard(dir, name);
    const fh = await dir.getFileHandle(name, { create: true });
    return await fh.createWritable() as unknown as Writable;
}

async function discard(dir: DirectoryWrapper, name: string): Promise<void> {
    for (const entry of [name, name + SWAP_SUFFIX]) {
        try { await dir.removeEntry(entry); } catch { }
    }
}

// Tar paths carry the archive's own top-level directory, and we mirror that as
// real directories so what lands on disk reads like the archive did.
async function entryLocation(
    path: string, create: boolean,
): Promise<{ dir: DirectoryWrapper; name: string } | undefined> {
    const parts = path.split("/").filter(p => p && p !== "." && p !== "..");
    if (!parts.length) return undefined;
    let dir = await modelsDir();
    const name = parts[parts.length - 1];
    if (!create) {
        try {
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        } catch {
            return undefined;
        }
        return { dir, name };
    }
    for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return { dir, name };
}

async function openForWrite(path: string): Promise<Writable> {
    const at = await entryLocation(path, true);
    if (!at) throw new Error(`Not a usable model file path: ${JSON.stringify(path)}`);
    return await freshWritable(at.dir, at.name);
}

async function readEntry(path: string): Promise<FileWrapper | undefined> {
    const at = await entryLocation(path, false);
    if (!at) return undefined;
    try {
        return await at.dir.getFileHandle(at.name);
    } catch {
        return undefined;
    }
}

function donePath(tarUrl: string): string {
    return `${DONE_DIR}/${encodeURIComponent(tarUrl)}`;
}

let legacyDropped = false;
async function dropLegacy(): Promise<void> {
    if (legacyDropped) return;
    legacyDropped = true;
    if (typeof caches !== "undefined") {
        try { await caches.delete(LEGACY_CACHE_NAME); } catch { }
    }
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage?.getDirectory) return;
    try {
        const root = await storage.getDirectory();
        await root.removeEntry(LEGACY_OPFS_DIR, { recursive: true });
    } catch { }
}

// Writes the whole download as zeros before fetching a byte of it, so a drive
// without room fails in seconds instead of after a multi-gigabyte transfer.
// Split across part files because a single multi-gigabyte file is a portability
// cliff (FAT32 caps at 4 GB, and several network shares lower) that the real
// download never walks off -- the archives unpack into many smaller files.
async function reserveSpace(
    bytes: number, label: string, onProgress?: TarProgress,
): Promise<void> {
    if (!bytes) return;
    const dir = await modelsDir();
    const zeros = new Uint8Array(RESERVE_CHUNK_BYTES);
    const parts: string[] = [];
    let open: Writable | undefined;
    try {
        let done = 0;
        while (done < bytes) {
            const name = `${RESERVE_FILE}.${parts.length}`;
            parts.push(name);
            open = await freshWritable(dir, name);
            const partEnd = Math.min(bytes, done + RESERVE_PART_BYTES);
            while (done < partEnd) {
                const n = Math.min(RESERVE_CHUNK_BYTES, partEnd - done);
                await open.write(n === RESERVE_CHUNK_BYTES ? zeros : zeros.subarray(0, n));
                done += n;
                onProgress?.(
                    `Reserving space for ${label}: ${mb(done)} of ${mb(bytes)}`,
                    done / bytes);
            }
            await open.close();
            open = undefined;
        }
    } finally {
        if (open?.abort) await open.abort().catch(() => { });
        for (const name of parts) await discard(dir, name);
    }
}

async function contentLength(url: string): Promise<number> {
    try {
        const res = await fetch(url, { method: "HEAD" });
        return Number(res.headers.get("content-length")) || 0;
    } catch {
        return 0;
    }
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
    tarUrl: string, label: string, onProgress?: TarProgress,
    range?: TarRange,
): Promise<void> {
    const key = rangeKey(tarUrl, range);
    let pending = inFlight.get(key);
    if (!pending) {
        pending = extract(tarUrl, label, onProgress, range).catch(e => {
            inFlight.delete(key);
            throw e;
        });
        inFlight.set(key, pending);
    }
    return pending;
}

async function extract(
    tarUrl: string, label: string, onProgress?: TarProgress,
    range?: TarRange,
): Promise<void> {
    if (await readExtractedFile(donePath(rangeKey(tarUrl, range)))) return;
    await dropLegacy();

    const total = range ? range.length : await contentLength(tarUrl);
    await reserveSpace(total, label, onProgress);

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
    // Bare .tar (no gzip) is used for the multi-GB Gemma 4B bundles: gzip on
    // already-dense ONNX weights costs CPU without shrinking the transfer.
    const counted = res.body.pipeThrough(counting);
    const stream = tarUrl.endsWith(".tar")
        ? counted
        : counted.pipeThrough(new DecompressionStream("gzip"));
    try {
        await untar(stream, async (path, size) => {
            onProgress?.(`Unpacking ${label}: ${path.split("/").pop()}`,
                total ? received / total : undefined);
            const w = await openForWrite(path);
            written.push(path);
            return w;
        });
    } catch (e: any) {
        await deleteExtracted(written);
        throw new Error(`Could not store ${label}: ${e?.message ?? String(e)}`);
    }

    if (!written.length) throw new Error(`${label} archive was empty.`);
    // Written last, so an interrupted unpack simply redoes itself next time
    // rather than leaving a half-populated model that looks complete.
    const doneWriter = await openForWrite(donePath(rangeKey(tarUrl, range)));
    await doneWriter.write(new TextEncoder().encode(JSON.stringify(written)));
    await doneWriter.close();
    onProgress?.(`${label} ready`, 1);
}

async function deleteExtracted(paths: string[]): Promise<void> {
    for (const path of paths) {
        const at = await entryLocation(path, false);
        if (at) await discard(at.dir, at.name);
    }
}

// A raw file (typically a .onnx graph) that lives on its own URL, not inside a
// tarball. Fetched once, streamed to the model folder at `storePath`, then served by the
// customCache like anything else. Used when a model's weights are hosted as a
// bare file but its tokenizer/config still come from a tarball.
const rawInFlight = new Map<string, Promise<void>>();
export function ensureRawFileFetched(
    url: string, storePath: string, label: string, onProgress?: TarProgress,
): Promise<void> {
    const key = `raw:${storePath}`;
    let pending = rawInFlight.get(key);
    if (!pending) {
        pending = fetchRaw(url, storePath, label, onProgress).catch(e => {
            rawInFlight.delete(key);
            throw e;
        });
        rawInFlight.set(key, pending);
    }
    return pending;
}

async function fetchRaw(
    url: string, storePath: string, label: string, onProgress?: TarProgress,
): Promise<void> {
    const done = donePath("raw:" + url);
    if (await readExtractedFile(done)) return;

    const total = await contentLength(url);
    await reserveSpace(total, label, onProgress);

    onProgress?.(`Downloading ${label}...`, 0);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Could not download ${label} (HTTP ${res.status}).`);
    }

    const w = await openForWrite(storePath);

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
        await deleteExtracted([storePath]);
        throw new Error(`Could not store ${label}: ${e?.message ?? String(e)}`);
    }

    const dw = await openForWrite(done);
    await dw.write(new TextEncoder().encode(JSON.stringify([storePath])));
    await dw.close();
    onProgress?.(`${label} ready`, 1);
}

// Reads one file back out of an extracted archive, by its path INSIDE the tar
// (including the archive's top-level directory). Returns the Response rather
// than bytes so the caller picks its own representation -- arrayBuffer() for an
// ONNX graph, text() for a vocab -- instead of this function forcing a 650 MB
// copy nobody asked for.
export async function readExtractedFile(path: string): Promise<Response | undefined> {
    const fh = await readEntry(path);
    if (!fh) return undefined;
    try {
        // A Response over a File is a view, not a copy -- nothing is read off
        // disk until the caller asks for bytes.
        const got = await fh.getFile();
        const file = got instanceof Blob ? got : new Blob([await got.arrayBuffer()]);
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
