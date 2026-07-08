// Build a branch (default main) directly into the local web root that the on-server Python HTTP
// server (scripts/serve/serve.py) hands out. No git commit, no push — just replaces the built files
// in place, so a page refresh picks up the new version.
//
// Usage:
//   yarn deploy-local            # main → LOCAL_WEB_ROOT
//   yarn deploy-local myBranch   # non-main lands under LOCAL_WEB_ROOT/<sanitized-branch>/
//
// The web root path can be overridden via the LOCAL_WEB_ROOT env var; default is /root/vidgrid-web.
// Cloudflare (or whatever fronts this box) should proxy the public hostname here on the port
// serve.py listens on (default 8059, tunable via LOCAL_WEB_PORT passed to serve.py).
import { deployBranchTo } from "./deployLib";

const DEFAULT_LOCAL_WEB_ROOT = "/root/vidgrid-web";

async function main() {
    const branch = process.argv[2] || "main";
    const targetRoot = process.env.LOCAL_WEB_ROOT || DEFAULT_LOCAL_WEB_ROOT;
    await deployBranchTo(branch, targetRoot);
    console.log(`Deployed ${branch} → ${targetRoot} (no push)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
