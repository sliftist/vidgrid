// Long-lived TS writer for the face pipeline. run.py spawns one of these per
// `yarn parse`, then streams every video's result to it over a WebSocket.
//
// Why this exists: the old design spawned a fresh `writeResult.ts` Node process
// per video. Each fresh process is its own BulkDatabase2 "writer", so it (a)
// reloaded the entire vidgrid_index reader from disk every single video — the
// "vidgrid_index loaded in 533ms ... read 628MB" line, paid 10k times — and (b)
// created brand-new per-collection stream files every video, eventually leaving
// tens of thousands of tiny .stream files that make every later load slower.
//
// A single long-lived process loads the index reader ONCE (it's lazily
// memoized) and reuses one stream file per collection for the whole run, so a
// write is a cheap append to an already-open log.
//
// Protocol (one JSON object per WS message, request carries a client `id` the
// reply echoes). Big payloads stay on disk — messages only carry paths:
//   → { id, type: "getWalkExclusions" }        ← { id, ok, ignoredFolders, removedFiles }
//   → { id, type: "registerFiles", items }     ← { id, ok, added, updated }
//   → { id, type: "getWork", outPath, force }  ← { id, ok, total }
//   → { id, type: "write",   path }            ← { id, ok, faces, characters, error? }
//   → { id, type: "flush" }                    ← { id, ok }
//   → { id, type: "compact" }                  ← { id, ok }
//   → { id, type: "close" }                    ← { id, ok }   (then the process exits)

// chdir into the data root before anything else — the DB collections bind their
// storage path to the cwd on first access.
process.chdir(process.argv[2] || ".");

import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { ingestResult, collectWork, flushAll, compactAll, registerFilesBatch, getWalkExclusions, FileRegistrationItem } from "./faceIngest";

// BulkDatabase2 logs DB-load + write progress via console.log; route that (and
// anything else) to stderr so stdout carries ONLY the one-line port handshake
// the Python client parses. stderr is inherited by run.py, so those logs still
// stream live. This runs before any DB operation (those happen in the handlers),
// which is when that logging actually fires.
console.log = (...args: unknown[]) => console.error(...args);

// A long-lived best-effort writer must not die because some utility threw in a
// background task or a stray promise rejected — that drops the WS connection and
// forces run.py to restart us, paying a full index reload. Log loudly (run.py
// captures this stderr tail for its crash report) and carry on; real per-write
// failures still surface to the client through handle()'s own try/catch.
process.on("uncaughtException", err => {
    console.error(`[writeServer] uncaughtException (continuing):`, (err as Error).stack ?? err);
});
process.on("unhandledRejection", reason => {
    console.error(`[writeServer] unhandledRejection (continuing):`, (reason as Error)?.stack ?? reason);
});

const SERVER_READY_PREFIX = "WRITE_SERVER_LISTENING ";

function send(ws: WebSocket, obj: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.send(JSON.stringify(obj), err => err ? reject(err) : resolve());
    });
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        await flushAll();
    } catch (err) {
        console.error(`[writeServer] flush on shutdown failed:`, (err as Error).stack ?? err);
    }
    process.exit(code);
}

async function handle(ws: WebSocket, text: string): Promise<void> {
    let id: unknown;
    try {
        const msg = JSON.parse(text) as { id?: unknown; type?: string;[k: string]: unknown };
        id = msg.id;
        if (msg.type === "getWalkExclusions") {
            // Same two exclusions the browser walk honors. Python reads these
            // once, then prunes ignoredFolders from os.walk in-place and skips
            // removedFiles individually.
            const excl = await getWalkExclusions();
            await send(ws, { id, ok: true, ...excl });
        } else if (msg.type === "registerFiles") {
            // Python walked and sent us a batch of {key, name, relativePath}
            // items. Merge them into the files DB, preserving any existing
            // per-key scan output. Reply with per-batch counts so Python can
            // accumulate totals.
            const items = msg.items as FileRegistrationItem[] | undefined;
            const result = await registerFilesBatch(items ?? []);
            await send(ws, { id, ok: true, ...result });
        } else if (msg.type === "getWork") {
            const outPath = path.resolve(String(msg.outPath));
            const work = await collectWork(!!msg.force);
            fs.writeFileSync(outPath, JSON.stringify(work));
            await send(ws, { id, ok: true, total: work.total });
        } else if (msg.type === "write") {
            const payload = JSON.parse(fs.readFileSync(path.resolve(String(msg.path)), "utf8"));
            const counts = await ingestResult(payload);
            await send(ws, { id, ok: true, ...counts });
        } else if (msg.type === "flush") {
            await flushAll();
            await send(ws, { id, ok: true });
        } else if (msg.type === "compact") {
            await compactAll();
            await send(ws, { id, ok: true });
        } else if (msg.type === "close") {
            await flushAll();
            await send(ws, { id, ok: true });
            // Graceful close: the close frame is queued AFTER the ack frame, so
            // the client reliably gets the ack before the socket drops. The
            // "close" event handler then runs shutdown + exits the process —
            // calling process.exit() here could truncate the ack mid-flight.
            ws.close();
        } else {
            await send(ws, { id, ok: false, error: `Unknown message type ${String(msg.type)}` });
        }
    } catch (err) {
        await send(ws, { id, ok: false, error: (err as Error).stack ?? String(err) });
    }
}

async function main() {
    // cwd is already the data root — see the ./chdirFirst side-effect import.
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("listening", () => {
        const addr = wss.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        // The one and only line written to stdout — run.py blocks on it.
        process.stdout.write(`${SERVER_READY_PREFIX}${port}\n`);
    });

    wss.on("connection", (ws: WebSocket) => {
        console.log(`[writeServer] client connected`);
        // Serialize handlers so writes ingest in send-order even if the client
        // ever pipelines messages instead of awaiting each ack.
        let chain: Promise<void> = Promise.resolve();
        ws.on("message", data => {
            chain = chain.then(() => handle(ws, data.toString()));
        });
        // The client vanished without a clean close (e.g. Python crashed) —
        // persist what we have and exit rather than orphaning the process.
        ws.on("close", () => void shutdown(0));
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => void shutdown(0));
    }
}

main().catch(err => {
    console.error((err as Error).stack);
    process.exit(1);
});
