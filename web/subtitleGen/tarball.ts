// Fetch a .tar.gz of model files and unpack it into the browser's Cache
// Storage, so transformers.js can read the files back out without us hosting a
// directory tree anywhere.
//
// Why a tarball at all: the hosting is one immutable public bucket, and a model
// is 5-7 files including one ~450 MB .onnx. Shipping them as one archive means
// one URL to upload, one URL to pin in the code, and one request from the
// browser instead of a fan-out that has to match HuggingFace's directory layout
// byte for byte.
//
// Unpacking is streamed: gzip goes through DecompressionStream, and each entry
// is turned into Blob slices every few MB so the heap never holds a whole
// 450 MB file even though the archive is bigger than most tabs want to be.

// Bumping this name invalidates every extracted model at once.
const CACHE_NAME = "vidgrid-model-tarballs-v1";
// Cache Storage keys must be real URLs, so extracted paths live under a prefix
// on our own origin that no route will ever serve.
const VIRTUAL_PREFIX = "/__model-tarball__/";
// Blob-of-blobs: each flush hands its chunks to the Blob (which the browser can
// spill to disk) and drops the JS references, capping heap use per entry.
const FLUSH_BYTES = 8 * 1024 * 1024;

function virtualUrl(path: string): string {
    return new URL(VIRTUAL_PREFIX + path, location.origin).toString();
}

function doneUrl(tarUrl: string): string {
    return new URL(VIRTUAL_PREFIX + "@done/" + encodeURIComponent(tarUrl), location.origin).toString();
}

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

export async function untar(
    stream: ReadableStream<Uint8Array>,
    onFile: (path: string, body: Blob) => Promise<void>,
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

        let parts: BlobPart[] = [];
        let pending: Uint8Array[] = [];
        let pendingBytes = 0;
        let left = size;
        const flush = () => {
            if (!pendingBytes) return;
            parts.push(new Blob(pending));
            pending = [];
            pendingBytes = 0;
        };
        while (left > 0) {
            const want = Math.min(left, FLUSH_BYTES);
            const got = await q.take(want);
            const n = got.reduce((a, p) => a + p.length, 0);
            if (n === 0) break; // truncated archive
            for (const p of got) pending.push(p);
            pendingBytes += n;
            left -= n;
            if (pendingBytes >= FLUSH_BYTES) flush();
        }
        flush();
        await onFile(path, new Blob(parts));
        parts = [];
        await q.take(padding);
    }
}

// --- public API ------------------------------------------------------------

export type TarProgress = (message: string, fraction: number | undefined) => void;

function mb(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Downloads and unpacks `tarUrl` unless it has already been unpacked. Safe to
// call repeatedly; concurrent calls for the same URL share one download.
const inFlight = new Map<string, Promise<void>>();

export function ensureTarballExtracted(
    tarUrl: string, label: string, onProgress?: TarProgress,
): Promise<void> {
    let pending = inFlight.get(tarUrl);
    if (!pending) {
        pending = extract(tarUrl, label, onProgress).catch(e => {
            inFlight.delete(tarUrl);
            throw e;
        });
        inFlight.set(tarUrl, pending);
    }
    return pending;
}

async function extract(tarUrl: string, label: string, onProgress?: TarProgress): Promise<void> {
    if (typeof caches === "undefined") {
        throw new Error("Cache Storage is unavailable, so model files cannot be unpacked.");
    }
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(doneUrl(tarUrl))) return;

    onProgress?.(`Downloading ${label}...`, 0);
    const res = await fetch(tarUrl);
    if (!res.ok || !res.body) {
        throw new Error(`Could not download ${label} (HTTP ${res.status}).`);
    }
    const total = Number(res.headers.get("content-length")) || 0;

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
    await untar(stream, async (path, body) => {
        onProgress?.(`Unpacking ${label}: ${path.split("/").pop()}`, total ? received / total : undefined);
        await cache.put(virtualUrl(path), new Response(body, {
            headers: {
                "content-length": String(body.size),
                "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream",
            },
        }));
        written.push(path);
    });

    if (!written.length) throw new Error(`${label} archive was empty.`);
    // Written last, so an interrupted unpack simply redoes itself next time
    // rather than leaving a half-populated model that looks complete.
    await cache.put(doneUrl(tarUrl), new Response(JSON.stringify(written)));
    onProgress?.(`${label} ready`, 1);
}

// Reads one file back out of an extracted archive, by its path INSIDE the tar
// (including the archive's top-level directory). Returns the Response rather
// than bytes so the caller picks its own representation -- arrayBuffer() for an
// ONNX graph, text() for a vocab -- instead of this function forcing a 650 MB
// copy nobody asked for.
export async function readExtractedFile(path: string): Promise<Response | undefined> {
    if (typeof caches === "undefined") return undefined;
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(virtualUrl(path));
}

// A transformers.js `env.customCache`: it only has to implement the two Web
// Cache methods transformers.js actually calls. Lookups arrive as either
// "/models/<repo>/<file>" or "<remoteHost><repo>/<file>", and both end with the
// tar's own path for that file -- so slicing at the repo id maps one to the
// other exactly, with no guessing.
class ModelTarCache {
    private repos: string[] = [];
    private cache: Cache | undefined;

    registerRepo(repo: string): void {
        if (!this.repos.includes(repo)) this.repos.push(repo);
    }

    private key(request: any): string | undefined {
        const url = typeof request === "string" ? request : String(request?.url ?? request);
        for (const repo of this.repos) {
            const at = url.lastIndexOf(repo + "/");
            if (at >= 0) return virtualUrl(url.slice(at));
        }
        return undefined;
    }

    async match(request: any): Promise<Response | undefined> {
        const key = this.key(request);
        if (!key) return undefined;
        if (!this.cache) this.cache = await caches.open(CACHE_NAME);
        return await this.cache.match(key);
    }

    // transformers.js writes back anything it had to fetch. We are already the
    // authority on what exists, and a miss here means a file genuinely absent
    // from the archive, so there is nothing worth storing.
    async put(): Promise<void> { }
}

export const modelTarCache = new ModelTarCache();
