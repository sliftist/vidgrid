const SLOW_FS_OP_LOG_MS = 1000;
const IN_FLIGHT_SUMMARY_OLDEST = 8;

type FsOp = { kind: string; name: string; start: number };

const inFlight = new Set<FsOp>();
let contextLabel = "?";
let installed = false;

function describeTarget(target: unknown, args: unknown[]): string {
    const named = target as { name?: unknown; size?: unknown };
    const base = typeof named.name === "string" && named.name || "?";
    if (typeof args[0] === "string") return `${base}/${args[0]}`;
    if (typeof named.size === "number") return `${base} (${named.size} bytes)`;
    return base;
}

function wrap(proto: object | undefined, method: string, kind: string): void {
    if (!proto) return;
    const holder = proto as Record<string, unknown>;
    const original = holder[method];
    if (typeof original !== "function") return;
    holder[method] = function (this: unknown, ...args: unknown[]): unknown {
        const op: FsOp = { kind, name: describeTarget(this, args), start: performance.now() };
        inFlight.add(op);
        const done = () => {
            inFlight.delete(op);
            const ms = performance.now() - op.start;
            if (ms > SLOW_FS_OP_LOG_MS) {
                console.log(`[fs-timing ${contextLabel}] ${kind} ${op.name} took ${ms.toFixed(0)}ms; ${inFlight.size} other FS ops still in flight: ${inFlightSummary()}`);
            }
        };
        let result: unknown;
        try {
            result = (original as (...a: unknown[]) => unknown).apply(this, args);
        } catch (err) {
            done();
            throw err;
        }
        if (result instanceof Promise) {
            return result.then(value => {
                done();
                return value;
            }, err => {
                done();
                throw err;
            });
        }
        done();
        return result;
    };
}

export function installFsOpTiming(context: string): void {
    if (installed) return;
    installed = true;
    contextLabel = context;
    const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
    wrap(g.FileSystemDirectoryHandle?.prototype, "getFileHandle", "getFileHandle");
    wrap(g.FileSystemDirectoryHandle?.prototype, "getDirectoryHandle", "getDirectoryHandle");
    wrap(g.FileSystemDirectoryHandle?.prototype, "removeEntry", "removeEntry");
    wrap(g.FileSystemFileHandle?.prototype, "getFile", "getFile");
    wrap(g.FileSystemFileHandle?.prototype, "createWritable", "createWritable");
    wrap(g.FileSystemWritableFileStream?.prototype, "write", "writable.write");
    wrap(g.FileSystemWritableFileStream?.prototype, "close", "writable.close");
    wrap(g.Blob?.prototype, "arrayBuffer", "blob.arrayBuffer");
    console.log(`[fs-timing ${contextLabel}] installed; logging FS ops slower than ${SLOW_FS_OP_LOG_MS}ms`);
}

export function inFlightSummary(): string {
    if (inFlight.size === 0) return "none";
    const now = performance.now();
    const byKind = new Map<string, number>();
    for (const op of inFlight) byKind.set(op.kind, (byKind.get(op.kind) ?? 0) + 1);
    const oldest = [...inFlight].sort((a, b) => a.start - b.start).slice(0, IN_FLIGHT_SUMMARY_OLDEST);
    const kinds = [...byKind].map(([k, n]) => `${k}×${n}`).join(", ");
    const ages = oldest.map(op => `${op.kind} ${op.name} ${(now - op.start).toFixed(0)}ms`).join("; ");
    return `${kinds} | oldest: ${ages}`;
}
