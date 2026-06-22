// Cache large model files in the browser's Origin Private File System
// (OPFS) so they only have to be downloaded once. OPFS is per-origin and
// invisible to the user — perfect for ~200 MB model weights we don't want
// to re-fetch on every reload.

const OPFS_DIR = "face-models";

async function getModelsDir(create = false): Promise<FileSystemDirectoryHandle | undefined> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return undefined;
    const root = await navigator.storage.getDirectory();
    try {
        return await root.getDirectoryHandle(OPFS_DIR, { create });
    } catch {
        return undefined;
    }
}

export async function readCachedModel(name: string): Promise<ArrayBuffer | undefined> {
    const dir = await getModelsDir(false);
    if (!dir) return undefined;
    try {
        const fh = await dir.getFileHandle(name);
        const f = await fh.getFile();
        return await f.arrayBuffer();
    } catch {
        return undefined;
    }
}

export async function writeCachedModel(name: string, bytes: ArrayBuffer): Promise<void> {
    const dir = await getModelsDir(true);
    if (!dir) return;
    const fh = await dir.getFileHandle(name, { create: true });
    // @ts-ignore — createWritable is on FileSystemFileHandle but lib.dom lags.
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
}

export async function deleteCachedModel(name: string): Promise<void> {
    const dir = await getModelsDir(false);
    if (!dir) return;
    try { await dir.removeEntry(name); } catch { }
}

// Fetch a model with progress, prefer cache, write through on miss. The
// callback is invoked with (received, total) — total may be undefined if the
// server doesn't send a Content-Length.
export async function fetchModelWithCache(
    name: string,
    url: string,
    onProgress?: (received: number, total: number | undefined) => void,
): Promise<ArrayBuffer> {
    const cached = await readCachedModel(name);
    if (cached) {
        onProgress?.(cached.byteLength, cached.byteLength);
        return cached;
    }
    const resp = await fetch(url, { mode: "cors" });
    if (!resp.ok) throw new Error(`Model fetch failed: ${resp.status} ${resp.statusText}`);
    const totalHeader = resp.headers.get("content-length");
    const total = totalHeader ? Number(totalHeader) : undefined;
    if (!resp.body) {
        const buf = await resp.arrayBuffer();
        await writeCachedModel(name, buf);
        return buf;
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.byteLength;
            onProgress?.(received, total);
        }
    }
    const buf = new Uint8Array(received);
    let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.byteLength; }
    await writeCachedModel(name, buf.buffer);
    return buf.buffer;
}
