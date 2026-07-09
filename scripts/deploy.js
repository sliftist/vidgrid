// Deploy = push the current branch. The production box runs a webhook
// (scripts/serve/githubDeployHook.ts) that rebuilds and republishes on every
// push to main, so pushing is all a deploy needs — there is no separate hosting
// step and no gh-pages branch anymore.

const { execSync } = require("child_process");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

function run(cmd) {
    console.log(`==> ${cmd}`);
    execSync(cmd, { cwd: REPO_ROOT, stdio: "inherit" });
}

function capture(cmd) {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function tryRun(cmd) {
    try {
        execSync(cmd, { cwd: REPO_ROOT, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function hasTrackedChanges() {
    return !tryRun("git diff --quiet") || !tryRun("git diff --cached --quiet");
}

function main() {
    // Refuse to deploy a dirty tree — push only publishes committed work, so
    // uncommitted changes would silently not deploy. Commit first so the served
    // build matches the pushed commit.
    if (hasTrackedChanges()) {
        console.error("Refusing to deploy: working tree has uncommitted changes.");
        console.error("Commit them first so the deployed build matches a pushed commit.");
        console.error(capture("git status --short"));
        process.exit(1);
    }

    const branch = capture("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") {
        console.error("Refusing to deploy from a detached HEAD.");
        process.exit(1);
    }

    run(`git push origin ${branch}`);

    console.log("");
    console.log(`Pushed ${branch}. The production box's deploy webhook rebuilds and republishes on push.`);
}

main();
