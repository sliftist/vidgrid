import http, { IncomingMessage, ServerResponse } from "http";
import crypto from "crypto";
import child_process from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { green, magenta, red } from "socket-function/src/formatting/logColors";

// Standalone HTTP webhook listener for the GitHub push hook. Point a GitHub repo webhook
// (Settings → Webhooks) at http://<this-box>:<HOOK_PORT>/ with content-type application/json and
// the shared secret below.
//
// On a valid signed push to main, calls `yarn deploy-local <branch>` — the same command the polling
// watcher (scripts/serve/watch.sh) uses. The watcher stays around at a slower poll cadence as a
// self-healing fallback for missed webhooks; the webhook itself is the fast path (deploy starts
// within a few hundred ms of the push).

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PORT = Number(process.env.HOOK_PORT || 8060);
// Hard cap on a single branch build. A runaway/hung build is killed (whole process group) so the
// queue can recover.
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

// A push whose commits ONLY touch files matching these patterns is acknowledged but NOT deployed
// (docs edits shouldn't rebuild the app). Patterns: "*.ext" matches by suffix, "dir/" matches by
// prefix, anything else is an exact path.
const NO_DEPLOY_PATTERNS = ["*.md"];

function isNoDeployFile(filePath: string): boolean {
    return NO_DEPLOY_PATTERNS.some(pattern => {
        if (pattern.startsWith("*")) return filePath.endsWith(pattern.slice(1));
        if (pattern.endsWith("/")) return filePath.startsWith(pattern);
        return filePath === pattern;
    });
}

// Append-only audit trail, separate from build stdout. Every incoming webhook AND every deploy
// outcome is recorded here with a timestamp and the caller's IP, so we can always answer "did this
// actually deploy, when, and was it GitHub (a real push) or a local trigger (127.0.0.1)?".
const DEPLOY_AUDIT_LOG = path.join(os.homedir(), "vidgrid-deploy-audit.log");

function audit(message: string) {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
        fs.appendFileSync(DEPLOY_AUDIT_LOG, line + "\n");
    } catch (e) {
        console.error(red(`[deploy-hook] failed to write audit log: ${e}`));
    }
}

// Shared secret — the SAME string set in the GitHub webhook UI. Read from disk (never an env var):
// create this file on the server with the secret as its only contents (chmod 600).
const SECRET_FILE = path.join(os.homedir(), "vidgrid-deploy-hook-secret");

function getSecret(): string | undefined {
    try {
        return fs.readFileSync(SECRET_FILE, "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
}

function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Run one branch deploy as a fully separate, detached subprocess (`yarn deploy-local <branch>`).
// The build can crash, throw, or hang without affecting this listener: a non-zero exit is just
// logged, and a build exceeding DEPLOY_TIMEOUT_MS has its whole process group SIGKILLed. Never
// rejects.
function runDeploySubprocess(branch: string): Promise<void> {
    return new Promise(resolve => {
        const child = child_process.spawn("yarn", ["deploy-local", branch], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: "inherit",
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            console.error(red(`[deploy-hook] ${branch} build exceeded ${DEPLOY_TIMEOUT_MS}ms — killing process group`));
            if (child.pid) {
                try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
            }
        }, DEPLOY_TIMEOUT_MS);

        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            if (timedOut) console.error(red(`[deploy-hook] ${branch} deploy TIMED OUT`));
            else if (code === 0) console.log(green(`[deploy-hook] deployed ${branch}`));
            else console.error(red(`[deploy-hook] ${branch} deploy failed (code=${code}, signal=${signal})`));
            resolve();
        });
        child.on("error", e => {
            clearTimeout(timer);
            console.error(red(`[deploy-hook] failed to start deploy for ${branch}: ${e}`));
            resolve();
        });
    });
}

// Serialize deploys so two pushes never run git/build concurrently.
let deployChain: Promise<void> = Promise.resolve();
function enqueueDeploy(config: { branch: string; source: string; }) {
    const { branch, source } = config;
    deployChain = deployChain.then(async () => {
        const startedAt = Date.now();
        audit(magenta(`[deploy-hook] deploying ${branch} (from ${source})...`));
        await runDeploySubprocess(branch);
        audit(`[deploy-hook] finished ${branch} (from ${source}) in ${Date.now() - startedAt}ms`);
    });
}

function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Only POST");
        return;
    }
    const source = (req.headers["x-forwarded-for"] as string | undefined) || req.socket.remoteAddress || "unknown";
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c as Buffer));
    req.on("end", () => {
        const body = Buffer.concat(chunks);
        const secret = getSecret();
        if (!secret) {
            audit(red(`[deploy-hook] request from ${source} REJECTED — no webhook secret configured at ${SECRET_FILE}`));
            res.statusCode = 500;
            res.end(`No webhook secret configured (expected at ${SECRET_FILE})`);
            return;
        }
        if (!verifySignature(secret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
            audit(red(`[deploy-hook] request from ${source} REJECTED — bad signature`));
            res.statusCode = 401;
            res.end("Bad signature");
            return;
        }
        const event = req.headers["x-github-event"] as string | undefined;
        if (event === "ping") {
            audit(green(`[deploy-hook] ping from ${source} — replying pong`));
            res.statusCode = 200;
            res.end("pong");
            return;
        }
        if (event !== "push") {
            audit(`[deploy-hook] ignored event "${event}" from ${source}`);
            res.statusCode = 200;
            res.end(`Ignored event: ${event}`);
            return;
        }
        let ref: string | undefined;
        let deleted = false;
        let changedFiles: string[] | undefined;
        try {
            const payload = JSON.parse(body.toString("utf8")) as {
                ref?: string;
                deleted?: boolean;
                commits?: { added?: string[]; removed?: string[]; modified?: string[]; }[];
            };
            ref = payload.ref;
            deleted = payload.deleted === true;
            if (payload.commits && payload.commits.length) {
                changedFiles = payload.commits.flatMap(c =>
                    [...(c.added || []), ...(c.removed || []), ...(c.modified || [])]
                );
            }
        } catch {
            audit(red(`[deploy-hook] push from ${source} REJECTED — bad JSON`));
            res.statusCode = 400;
            res.end("Bad JSON");
            return;
        }
        if (!ref || !ref.startsWith("refs/heads/") || deleted) {
            audit(`[deploy-hook] push from ${source} ignored (not a branch push: ref=${ref}, deleted=${deleted})`);
            res.statusCode = 200;
            res.end("Ignored (not a branch push)");
            return;
        }
        const branch = ref.slice("refs/heads/".length);
        // Only deploy main — that's the only branch published to the web-root root; non-main
        // branches would land under /<branch>/ which isn't wired to the public URL.
        if (branch !== "main") {
            audit(`[deploy-hook] push to ${branch} from ${source} ignored (only main is auto-deployed)`);
            res.statusCode = 200;
            res.end(`Ignored (branch ${branch} is not auto-deployed)`);
            return;
        }
        // Skip pushes that only touch non-app files (docs). If the commit list is missing or empty
        // (force pushes, merges with truncated payloads) we can't tell what changed, so we fail
        // open and deploy.
        if (changedFiles && changedFiles.length && changedFiles.every(isNoDeployFile)) {
            audit(`[deploy-hook] push to ${branch} from ${source} SKIPPED — all ${changedFiles.length} changed file(s) are no-deploy (${changedFiles.slice(0, 5).join(", ")})`);
            res.statusCode = 200;
            res.end("Skipped (only no-deploy files changed)");
            return;
        }
        audit(green(`[deploy-hook] push to ${branch} from ${source} — queued`));
        enqueueDeploy({ branch, source });
        res.statusCode = 202;
        res.end(`Queued deploy for ${branch}`);
    });
}

export async function startGithubDeployHookServer(port: number) {
    // Plain HTTP: the payload is HMAC-signed (verifySignature), so TLS isn't needed.
    const server = http.createServer(handle);
    await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve));
    console.log(magenta(`GitHub deploy hook listening on http://0.0.0.0:${port}`));
}

// Standalone entry: `yarn deploy-hook`. This is its OWN long-running process.
if (require.main === module) {
    startGithubDeployHookServer(HOOK_PORT).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
