#!/usr/bin/env python3
"""
Threaded static-file HTTP server for the built site. Chosen over `python3 -m http.server` because
the module's default is single-threaded (BaseHTTPServer.HTTPServer), so one slow request stalls
every other one. ThreadingHTTPServer spawns a thread per request, which handles the mixed load of
big asset transfers + worker-bundle downloads + index.html hits without blocking.

Cache policy: index.html is served with `no-cache` so the browser always fetches the latest, while
the JS bundles are cached aggressively. The bundle filenames are fixed (no content hash), so the
deploy step (scripts/deployLib.ts) appends a `?v=<stamp>` query to both the browser.js <script> tag
in index.html AND the worker URL baked into browser.js. A new deploy changes those query strings,
so the browser downloads the new files naturally despite the immutable cache.

Whatever fronts this box (Cloudflare, nginx, etc.) is expected to terminate HTTPS and proxy plain
HTTP to the port below, so this server never needs to see TLS.
"""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
import mimetypes
import os
import sys

DEFAULT_ROOT = "/root/vidgrid-web"
DEFAULT_PORT = 8059
DEFAULT_BIND = "0.0.0.0"

# Make script/wasm/svg mime types explicit so a mistyped extension never sneaks through as
# octet-stream (which browsers refuse to execute as a module/worker).
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("image/svg+xml", ".svg")


class SiteHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("/") or path.endswith("/index.html") or path == "":
            # Always re-fetch the entry document so a new deploy is picked up on the next reload —
            # the bundle URLs inside are ?v=BUILD-stamped so their URLs change and the browser
            # downloads the new copies naturally.
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        elif path.endswith("scanCoordinator.js"):
            # The ONE background-scan SharedWorker is loaded from a STABLE url (no ?v= — a versioned
            # url would let different-build tabs spawn DIFFERENT coordinators, and there must only
            # ever be one). So it can't ride the immutable + ?v= scheme the other bundles use. A
            # newer tab replaces the running coordinator via an in-app handshake (scanClient.ts asks
            # it to self.close(), then everyone reconnects) — and `no-cache` is what makes that
            # respawn actually fetch the NEW bytes instead of a year-stale immutable copy. It still
            # revalidates cheaply (304) when unchanged.
            self.send_header("Cache-Control", "no-cache")
        elif path.endswith(".js") or path.endswith(".wasm") or path.startswith("/assets/"):
            # Query-string-versioned or content-addressable — safe to cache for a long time.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Basic security headers: no framing by other origins (clickjacking), only send the origin
        # as referrer cross-origin, and opt out of sensor/media permissions we never use.
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, format, *args):
        # Compact one-line log to stdout — systemd journals it. Skip the verbose default.
        sys.stdout.write(f"{self.address_string()} {format % args}\n")
        sys.stdout.flush()


def main():
    root = os.environ.get("LOCAL_WEB_ROOT", DEFAULT_ROOT)
    port = int(os.environ.get("LOCAL_WEB_PORT", DEFAULT_PORT))
    bind = os.environ.get("LOCAL_WEB_BIND", DEFAULT_BIND)

    if not os.path.isdir(root):
        # Serve an empty dir rather than crashing — the watcher fills it in after the first build,
        # and the box shouldn't 500 in the meantime.
        os.makedirs(root, exist_ok=True)

    os.chdir(root)
    handler = partial(SiteHandler, directory=root)
    with ThreadingHTTPServer((bind, port), handler) as httpd:
        # daemon_threads=True: request-handler threads don't hold the process open past SIGTERM.
        httpd.daemon_threads = True
        print(f"serving {root} on http://{bind}:{port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
