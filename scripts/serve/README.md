# Self-hosted deploy: static server + auto-rebuild watcher + push webhook

Serves the built vidgrid site from this box instead of (or alongside) GitHub Pages. A plain Python
HTTP server hands out the files; a watcher + GitHub webhook rebuild and republish on every push to
`main`. Put a TLS-terminating proxy (Cloudflare, nginx, ...) in front — this server speaks plain HTTP.

## Pieces

- `serve.py` — `ThreadingHTTPServer` handing out `/root/vidgrid-web` on **:8059**. Threaded so a slow
  request doesn't block the rest. `index.html` is `no-cache`; the fingerprint-less JS bundles are
  cached `immutable` and busted via a `?v=<stamp>` query the deploy step rewrites into both
  `index.html` (the `browser.js` tag) and `browser.js` (the `metadataWorker.js` URL).
- `../deployLocal.ts` (`yarn deploy-local [branch]`) → `../deployLib.ts` — builds `origin/<branch>`
  in an **isolated clone** at `/root/vidgrid-build` (its own `.git` + real `node_modules`, so esbuild
  resolves consistently and the dev checkout is never touched) and writes the output into
  `/root/vidgrid-web`. `main` → root; other branches → `/<branch>/`.
- `watch.sh` — polls `origin/main` every 3 minutes and runs `yarn deploy-local` on a new tip. The
  self-healing fallback for missed webhooks.
- `githubDeployHook.ts` (`yarn deploy-hook`) — HTTP webhook listener on **:8060**. GitHub POSTs here
  on every push; on a valid signed push to `main` it runs `yarn deploy-local`. The fast path (deploy
  starts within a few hundred ms). Secret at `~/vidgrid-deploy-hook-secret`.
- `vidgrid-serve.service`, `vidgrid-watch.service`, `vidgrid-hook.service` — systemd units.
- `setup.sh` — installs + enables all three (idempotent).

## First-time setup on the box

```bash
sudo scripts/serve/setup.sh            # serve + watch + hook
# or, without the webhook listener:
sudo scripts/serve/setup.sh --no-hook

# tail any of them
journalctl -u vidgrid-serve -f
journalctl -u vidgrid-watch -f
journalctl -u vidgrid-hook  -f
```

## GitHub webhook (optional — the fast path)

1. Create `~/vidgrid-deploy-hook-secret` (chmod 600) with a random secret as its only contents.
2. Repo → Settings → Webhooks → Add webhook:
   - Payload URL `http://<this-box-or-proxy>:8060/`
   - Content type `application/json`
   - Secret: the same string
   - Events: just the push event.

The watcher deploys without any of this; the webhook only makes it faster.

## Proxy

Point your public hostname at this box and proxy 80/443 → **port 8059** as plain HTTP (the proxy
terminates HTTPS; this server never sees TLS).

## Manual redeploy

```bash
cd /root/video && yarn deploy-local        # builds origin/main → /root/vidgrid-web
```

## Overrides (env, all optional)

- `LOCAL_WEB_ROOT` — serve dir (default `/root/vidgrid-web`)
- `LOCAL_WEB_PORT` — serve port (default `8059`)
- `LOCAL_WEB_BIND` — bind address (default `0.0.0.0`)
- `POLL_SECONDS` — watcher poll cadence (default `30`; the unit sets `180`)
- `BRANCH` — watcher branch (default `main`)
- `HOOK_PORT` — webhook listen port (default `8060`)

## Relationship to `yarn deploy`

`yarn deploy` (scripts/deploy.js) still pushes a bundle to the `gh-pages` branch for GitHub Pages.
This stack is independent and builds the exact same `yarn build-web` output — just served from here.
