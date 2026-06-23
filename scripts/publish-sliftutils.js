// Publish a new sliftutils version and roll it into vidgrid, end to end:
//
//   sliftutils:  git pull  ->  yarn publish (version bump + tag)  ->  push branch + tag
//   vidgrid:     bump the dependency range  ->  yarn install  ->  commit  ->  push  ->  yarn deploy
//
// Run via `yarn uputils`. Pass a bump type to override the default:
//   yarn uputils minor

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// sliftutils lives next to vidgrid; resolve both from this script's location so
// the command works regardless of the caller's current directory.
const VIDGRID_ROOT = path.resolve(__dirname, "..");
const SLIFTUTILS_DIR = path.resolve(VIDGRID_ROOT, "..", "sliftutils");

const VALID_BUMPS = ["patch", "minor", "major"];
// After publish, the new version isn't instantly resolvable on the npm
// registry. Until it is, `yarn install` can't match the range and drops into
// its interactive "choose a version" prompt — so poll the registry until the
// version actually appears before touching the dependency.
const PUBLISH_POLL_RETRIES = 60;
const PUBLISH_POLL_DELAY_SECONDS = 5;
// Registry edge caches can still lag npm's view, so the reinstall keeps its own
// retry as a backstop.
const INSTALL_RETRIES = 5;
const RETRY_DELAY_SECONDS = 5;

// Default to a patch bump (matches the existing 1.4.x publish cadence).
const bump = process.argv[2] ?? "patch";
if (!VALID_BUMPS.includes(bump)) {
    console.error(`Unknown bump type '${bump}' (expected ${VALID_BUMPS.join(" | ")}).`);
    process.exit(1);
}

function run(cmd, cwd) {
    console.log(`==> ${cmd}`);
    execSync(cmd, { cwd: cwd ?? VIDGRID_ROOT, stdio: "inherit" });
}

function capture(cmd, cwd) {
    return execSync(cmd, { cwd: cwd ?? VIDGRID_ROOT, encoding: "utf8" }).trim();
}

function readVersion(packageJsonPath) {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
}

function hasTrackedChanges(cwd) {
    for (const check of ["git diff --quiet", "git diff --cached --quiet"]) {
        try {
            execSync(check, { cwd, stdio: "ignore" });
        } catch {
            return true;
        }
    }
    return false;
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPublished(version) {
    try {
        execSync(`npm view sliftutils@${version} version`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function hasStagedChanges() {
    try {
        execSync("git diff --cached --quiet", { cwd: VIDGRID_ROOT, stdio: "ignore" });
        return false;
    } catch {
        return true;
    }
}

if (!fs.existsSync(SLIFTUTILS_DIR)) {
    console.error(`Expected sliftutils at ${SLIFTUTILS_DIR} but it isn't there.`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. sliftutils: refuse to publish a dirty tree, pull, then bump + publish.
// ---------------------------------------------------------------------------
// `yarn publish` packs the working directory, so any uncommitted change would
// silently ship in the tarball. Require a clean tree first.
if (hasTrackedChanges(SLIFTUTILS_DIR)) {
    console.error("sliftutils has uncommitted changes — commit or stash them before publishing.");
    console.error(capture("git status --short", SLIFTUTILS_DIR));
    process.exit(1);
}

run("git pull --ff-only", SLIFTUTILS_DIR);
run(`yarn publish --${bump}`, SLIFTUTILS_DIR);

// The version commit + tag yarn just created are local — read the new version and push both.
const newVersion = readVersion(path.join(SLIFTUTILS_DIR, "package.json"));
const sliftBranch = capture("git rev-parse --abbrev-ref HEAD", SLIFTUTILS_DIR);

run(`git push origin ${sliftBranch}`, SLIFTUTILS_DIR);
run(`git push origin v${newVersion}`, SLIFTUTILS_DIR);

// ---------------------------------------------------------------------------
// 2. Wait for the registry to actually serve the new version.
// ---------------------------------------------------------------------------
console.log(`==> waiting for sliftutils@${newVersion} on npm`);
let published = false;
for (let attempt = 1; attempt <= PUBLISH_POLL_RETRIES; attempt++) {
    if (isPublished(newVersion)) {
        published = true;
        break;
    }
    if (attempt < PUBLISH_POLL_RETRIES) {
        console.log(`not resolvable yet; poll ${attempt}/${PUBLISH_POLL_RETRIES} in ${PUBLISH_POLL_DELAY_SECONDS}s...`);
        sleepSync(PUBLISH_POLL_DELAY_SECONDS * 1000);
    }
}
if (!published) {
    const waited = PUBLISH_POLL_RETRIES * PUBLISH_POLL_DELAY_SECONDS;
    console.error(`sliftutils@${newVersion} did not appear on npm after ${waited}s — aborting before deploy.`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. vidgrid: point the dependency at the new version and reinstall.
// ---------------------------------------------------------------------------
console.log(`==> set sliftutils -> ^${newVersion} in package.json`);
const vidgridPackageJson = path.join(VIDGRID_ROOT, "package.json");
// Surgical text replace so the rest of package.json's formatting is untouched.
let pkgText = fs.readFileSync(vidgridPackageJson, "utf8");
const depRegex = /("sliftutils":\s*")[^"]*(")/;
if (!depRegex.test(pkgText)) {
    console.error(`sliftutils dependency not found in ${vidgridPackageJson}`);
    process.exit(1);
}
pkgText = pkgText.replace(depRegex, `$1^${newVersion}$2`);
fs.writeFileSync(vidgridPackageJson, pkgText);

for (let attempt = 1; attempt <= INSTALL_RETRIES; attempt++) {
    try {
        run("yarn install --non-interactive");
        break;
    } catch (err) {
        if (attempt >= INSTALL_RETRIES) {
            console.error(`yarn install failed after ${INSTALL_RETRIES} attempts.`);
            console.error(err.stack ?? err);
            process.exit(1);
        }
        console.log(`yarn install failed (likely npm propagation delay); retry ${attempt}/${INSTALL_RETRIES} in ${RETRY_DELAY_SECONDS}s...`);
        sleepSync(RETRY_DELAY_SECONDS * 1000);
    }
}

// Guard against deploying a stale build: confirm the new version is what got installed.
const installedVersion = readVersion(path.join(VIDGRID_ROOT, "node_modules", "sliftutils", "package.json"));
if (installedVersion !== newVersion) {
    console.error(`Installed sliftutils is ${installedVersion} but expected ${newVersion} — aborting before deploy.`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. vidgrid: commit, push, deploy.
// ---------------------------------------------------------------------------
// Commit the WHOLE working tree, not just package.json — `yarn deploy` refuses
// to run with any uncommitted change, so everything must land in a real commit
// first (same approach as `yarn ship`).
run("git add -A");
if (hasStagedChanges()) {
    run(`git commit -m "Bump sliftutils to ^${newVersion}"`);
} else {
    console.log("==> nothing to commit — deploying current HEAD");
}

const vidgridBranch = capture("git rev-parse --abbrev-ref HEAD");
run(`git push origin ${vidgridBranch}`);

run("yarn deploy");

console.log("");
console.log(`Done. sliftutils@${newVersion} published; vidgrid bumped, pushed, and deployed.`);
