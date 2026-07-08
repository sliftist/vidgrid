import path from "path";
import fs from "fs";
import child_process from "child_process";

// Shared deploy machinery for the self-hosted static server (scripts/serve/serve.py).
// deployBranchTo() builds ONE branch's web bundle — read from origin, in an isolated build clone so
// the running dev checkout is never disturbed — into a caller-provided target directory. The
// on-server watcher (scripts/serve/watch.sh) and webhook (scripts/serve/githubDeployHook.ts) both
// call it via `yarn deploy-local` to republish into /root/vidgrid-web, which the on-box Python HTTP
// server hands to the outside world.
//
// This is the local-hosting analogue of scripts/deploy.js (which pushes to the gh-pages branch).
// Both build the same bundle; this one just writes the files straight into a served folder with no
// git commit and no push.

export const PROJECT_ROOT = path.resolve(__dirname, "..");
// FULLY SEPARATE clone used only for building — its own .git and its own real node_modules, NOT a
// worktree of this repo and NOT a symlinked node_modules. A shared/worktree/symlinked setup makes
// esbuild resolve modules differently and can emit a different (broken) bundle.
const BUILD_DIR = path.resolve(PROJECT_ROOT, "../vidgrid-build");

function sh(cmd: string, args: string[], opts: child_process.SpawnSyncOptions = {}) {
    const result = child_process.spawnSync(cmd, args, { stdio: "inherit", ...opts });
    if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
}
function shOut(cmd: string, args: string[], opts: child_process.SpawnSyncOptions = {}): string {
    const result = child_process.spawnSync(cmd, args, { encoding: "utf-8", ...opts });
    if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}\n${result.stderr}`);
    return (result.stdout || "").toString().trim();
}

// Deploy folder for a branch: main lives at the deploy root (""), everything else under its own
// sanitized subfolder (e.g. "feature/foo" → "feature-foo").
export function branchFolder(branch: string): string {
    if (branch === "main") return "";
    return branch.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

// Ensure BUILD_DIR is a standalone clone of this repo with its own real node_modules. Idempotent —
// clones + installs only the first time.
function ensureBuildClone() {
    if (!fs.existsSync(path.join(BUILD_DIR, ".git"))) {
        const url = shOut("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT });
        fs.rmSync(BUILD_DIR, { recursive: true, force: true });
        sh("git", ["clone", url, BUILD_DIR]);
    }
    if (!fs.existsSync(path.join(BUILD_DIR, "node_modules"))) {
        sh("yarn", ["install"], { cwd: BUILD_DIR });
    }
}

// Point the build clone at the latest origin/<branch>, discarding any prior throwaway build state.
function checkoutBranch(branch: string) {
    sh("git", ["fetch", "origin", branch], { cwd: BUILD_DIR });
    sh("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: BUILD_DIR });
    sh("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: BUILD_DIR });
    // Drop untracked leftovers (a previous build's buildVersion.ts / build-web/) so the tree is
    // pristine — the build regenerates them.
    sh("git", ["clean", "-fdx", "--", "buildVersion.ts", "build-web"], { cwd: BUILD_DIR });
}

// Append ?v=<stamp> to every unhashed bundle URL so a new deploy busts browser + CDN cache. The
// bundles have fixed filenames (no content hash), so without this the browser keeps whatever it
// cached. Two references need stamping:
//   1. index.html's <script src="./browser.js">
//   2. the worker URL string baked INTO browser.js ("./metadataWorker.js" — see
//      web/scan/MetadataExtractorClient.ts). Stamping browser.js's content is safe because
//      browser.js is itself refetched (its index.html query changed), so the new worker query is
//      seen on the next load.
function cacheBust(outFolder: string, stamp: number) {
    const indexPath = path.join(outFolder, "index.html");
    if (fs.existsSync(indexPath)) {
        const text = fs.readFileSync(indexPath, "utf8");
        // Match a clean `browser.js` OR one already carrying a stale `?v=...` from a prior deploy.
        const rewritten = text.replace(/(src=["'])(\.\/)?browser\.js(\?v=\d+)?(["'])/g, `$1$2browser.js?v=${stamp}$4`);
        fs.writeFileSync(indexPath, rewritten);
    }
    const browserPath = path.join(outFolder, "browser.js");
    if (fs.existsSync(browserPath)) {
        const js = fs.readFileSync(browserPath, "utf8");
        // Rewrite the fixed worker URL, again tolerating an existing ?v= from a prior stamp.
        const rewritten = js.replace(/(["'])(\.\/)?metadataWorker\.js(\?v=\d+)?(["'])/g, `$1$2metadataWorker.js?v=${stamp}$4`);
        if (rewritten !== js) fs.writeFileSync(browserPath, rewritten);
    }
}

// Copy the built artifacts (index.html + every *.js + assets/) from the build clone's build-web/
// output into the deploy folder. Fixed filenames, so we overwrite in place — no clean step, so a
// build failure never strands a half-empty folder.
function copyBuildOutput(buildOut: string, outFolder: string) {
    fs.mkdirSync(outFolder, { recursive: true });
    fs.copyFileSync(path.join(buildOut, "index.html"), path.join(outFolder, "index.html"));
    for (const file of fs.readdirSync(buildOut)) {
        if (file.endsWith(".js")) fs.copyFileSync(path.join(buildOut, file), path.join(outFolder, file));
    }
    const assetsDir = path.join(buildOut, "assets");
    if (fs.existsSync(assetsDir)) {
        fs.cpSync(assetsDir, path.join(outFolder, "assets"), { recursive: true });
    }
}

// Build origin/<branch> into a caller-provided target directory. main → root, other branches →
// /<branch>/. Runs the repo's own `yarn build-web` inside the isolated clone (which stamps
// buildVersion.ts and bundles both the browser and metadata-worker entry points), then copies the
// output into the served folder and cache-busts the unhashed bundle URLs.
export async function deployBranchTo(branch: string, targetRoot: string): Promise<void> {
    ensureBuildClone();
    checkoutBranch(branch);

    // Build with the repo's normal pipeline so this never drifts from `yarn deploy` / `yarn build`.
    sh("yarn", ["build-web"], { cwd: BUILD_DIR });
    const buildOut = path.join(BUILD_DIR, "build-web");
    if (!fs.existsSync(path.join(buildOut, "index.html")) || !fs.existsSync(path.join(buildOut, "browser.js"))) {
        throw new Error(`build-web output missing — expected ${buildOut}/index.html and browser.js`);
    }

    const folder = branchFolder(branch);
    const out = folder === "" ? targetRoot : path.join(targetRoot, folder);
    copyBuildOutput(buildOut, out);
    cacheBust(out, Date.now());
    console.log(`Built ${branch} → ${targetRoot}${folder === "" ? "" : "/" + folder}`);
}
