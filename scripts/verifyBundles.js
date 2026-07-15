// Post-build sanity check: every emitted bundle must be valid JavaScript.
//
// `build-web` bundles by serializing require.cache; a bundler/cache regression
// (see the sliftutils two-pass fix) once shipped a worker bundle that browsers
// refused to parse. This guards against shipping an unparseable bundle again by
// running node's syntax check on each expected output.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname, "..", "build-web");
const BUNDLES = ["browser.js", "metadataWorker.js", "scanCoordinator.js"];

let failed = false;
for (const name of BUNDLES) {
    const file = path.join(OUT_DIR, name);
    if (!fs.existsSync(file)) {
        console.error(`[verify-bundles] MISSING: ${name}`);
        failed = true;
        continue;
    }
    try {
        // --check parses the file (validates it's valid JS) without executing it,
        // so browser-only globals at import time can't cause a false failure.
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        const sizeMb = (fs.statSync(file).size / 1_000_000).toFixed(1);
        console.log(`[verify-bundles] OK: ${name} (${sizeMb} MB)`);
    } catch (err) {
        console.error(`[verify-bundles] INVALID JS: ${name}`);
        console.error((err.stderr || err.message || "").toString().split("\n").slice(0, 5).join("\n"));
        failed = true;
    }
}

if (failed) {
    console.error("[verify-bundles] build produced an invalid bundle — failing the build.");
    process.exit(1);
}
console.log("[verify-bundles] all bundles valid.");
