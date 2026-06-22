import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { setRecord } from "sliftutils/misc/https/dns";
import { getExternalIP } from "socket-function/src/networking";

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

const HTTPS_PORT = 6399;
const HOST = "video.letterquick.com";
// Letterfast-server owns the wildcard cert for *.letterquick.com; we just read its
// on-disk cache and let letterfast handle renewal. Re-read periodically so we pick
// up rolled certs without a restart.
const CERT_PATH = "/root/letterfast-server/letterquick.com.cert";
const CERT_REFRESH_INTERVAL = 60 * 60 * 1000;
const STATIC_ROOT = path.resolve(__dirname, "..", "build-web");
// Face-detection / embedding models live outside the build tree so they're
// not baked into the static bundle. Drop ONNX files into FACE_MODELS_DIR and
// they're served (with CORS) under /face-models/<filename>.
const FACE_MODELS_DIR = "/root/face-models";

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
};

const COMPRESSIBLE = new Set([
    "text/html; charset=utf-8",
    "application/javascript; charset=utf-8",
    "text/css; charset=utf-8",
    "application/json; charset=utf-8",
    "image/svg+xml",
    "text/plain; charset=utf-8",
    "application/wasm",
]);

interface CachedFile {
    mtimeMs: number;
    size: number;
    raw: Buffer;
    gzip?: Buffer;
    etag: string;
    type: string;
}

const fileCache = new Map<string, CachedFile>();

function pickEncoding(acceptEncoding: string | undefined): "gzip" | undefined {
    const ae = (acceptEncoding || "").toLowerCase();
    if (ae.includes("gzip")) return "gzip";
    return undefined;
}

function loadFromCache(absPath: string, type: string): CachedFile | undefined {
    let cached = fileCache.get(absPath);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(absPath);
    } catch {
        return undefined;
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached;
    }
    let raw: Buffer;
    try {
        raw = fs.readFileSync(absPath);
    } catch {
        return undefined;
    }
    const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
    const entry: CachedFile = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        raw,
        etag: `"${hash}"`,
        type,
    };
    // gzip level 1 — ~70% compression of JS at ~100ms for 10 MB on this box.
    // Brotli is intentionally skipped: even at low quality settings it's seconds
    // of sync work on a 10 MB bundle and the marginal size win isn't worth it
    // in dev.
    if (COMPRESSIBLE.has(type)) {
        try { entry.gzip = zlib.gzipSync(raw, { level: 1 }); } catch (e) { console.warn("[static] gzip failed:", e); }
    }
    fileCache.set(absPath, entry);
    return entry;
}

function faceModelsHandler(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    // Permissive CORS — these are static model weights, no auth, no privacy.
    const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-None-Match",
        "Access-Control-Expose-Headers": "Content-Length, ETag, Accept-Ranges",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }

    const rel = urlPath.slice("/face-models/".length);
    if (!rel || rel.includes("..") || rel.startsWith("/")) {
        res.writeHead(400, corsHeaders); res.end("Bad path"); return;
    }
    const filePath = path.join(FACE_MODELS_DIR, rel);
    if (!filePath.startsWith(FACE_MODELS_DIR)) {
        res.writeHead(403, corsHeaders); res.end("Forbidden"); return;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch {
        res.writeHead(404, corsHeaders); res.end("Not found"); return;
    }
    if (stat.isDirectory()) { res.writeHead(404, corsHeaders); res.end("Not found"); return; }

    const headers: Record<string, string> = {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
    };
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
}

function staticHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        res.writeHead(405, { "Allow": "GET, HEAD, OPTIONS" });
        res.end("Method Not Allowed");
        return;
    }

    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath.startsWith("/face-models/") || urlPath === "/face-models") {
        return faceModelsHandler(req, res, urlPath);
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";

    const filePath = path.join(STATIC_ROOT, urlPath);
    if (!filePath.startsWith(STATIC_ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    let resolved = filePath;
    let stat: fs.Stats | undefined;
    try {
        stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
            resolved = path.join(resolved, "index.html");
            stat = fs.statSync(resolved);
        }
    } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    const entry = loadFromCache(resolved, type);
    if (!entry) {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    const inm = req.headers["if-none-match"];
    if (inm && inm === entry.etag) {
        res.writeHead(304, {
            "ETag": entry.etag,
            "Cache-Control": "public, max-age=0, must-revalidate",
        });
        res.end();
        return;
    }

    const encoding = pickEncoding(req.headers["accept-encoding"] as string | undefined);
    let body: Buffer = entry.raw;
    const headers: Record<string, string> = {
        "Content-Type": type,
        "ETag": entry.etag,
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Vary": "Accept-Encoding",
    };
    if (encoding === "gzip" && entry.gzip) {
        body = entry.gzip;
        headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = String(body.length);

    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    res.end(body);
}

interface KeyCert { key: string; cert: string; }

function readKeyCert(): KeyCert {
    const json = fs.readFileSync(CERT_PATH, "utf8");
    const parsed = JSON.parse(json) as KeyCert;
    if (!parsed.key || !parsed.cert) {
        throw new Error(`Cert file at ${CERT_PATH} missing key or cert field`);
    }
    return parsed;
}

async function main() {
    if (!fs.existsSync(STATIC_ROOT)) {
        throw new Error(`Build output missing at ${STATIC_ROOT}. Run \`yarn build-web\` first.`);
    }
    const keyCert = readKeyCert();
    const server = https.createServer({ key: keyCert.key, cert: keyCert.cert }, staticHandler);
    server.on("error", err => console.error("[https] server error:", err));
    server.listen(HTTPS_PORT, () => {
        console.log(`[https] serving ${STATIC_ROOT} at https://${HOST}:${HTTPS_PORT}/`);
    });

    setInterval(() => {
        try {
            const fresh = readKeyCert();
            server.setSecureContext({ key: fresh.key, cert: fresh.cert });
        } catch (err) {
            console.error("[https] cert refresh failed:", (err as Error).stack ?? err);
        }
    }, CERT_REFRESH_INTERVAL);

    void (async () => {
        try {
            const ip = await getExternalIP();
            await setRecord("A", HOST, ip);
            console.log(`[dns] A record for ${HOST} ensured at ${ip}`);
        } catch (err) {
            console.error(`[dns] Failed to ensure A record for ${HOST}:`, (err as Error).stack ?? err);
        }
    })();
}

main().catch(err => console.error("Server startup failed:", (err as Error).stack ?? err));
