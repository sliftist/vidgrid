"""Orchestrator: get-work → loop per video → write-result.

Lives next to process_one.py and reuses its pipeline. The TS side lives
one directory up under scripts/faces/.

Invoked via `yarn parse <video_root>`. The bulk databases live at
<video_root>/data/bulkDatabases2/ — same convention facegrabs uses,
so the output sits next to the videos rather than spreading across
the filesystem. Pass `--data-root` to override if you want to keep
the databases elsewhere (e.g. ssd).

Writes go to a single long-lived Node process (writeServer.ts) over a
WebSocket. That process loads the bulk-DB index once for the whole run
and appends every write to the same per-collection stream file — the old
one-Node-process-per-video design reloaded the 600MB+ index every video
and littered the DB folder with tens of thousands of tiny stream files.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import deque
from pathlib import Path
from typing import Iterator, Optional

from websockets.sync.client import connect

# Resolve scripts relative to this file so `uv run` from any CWD finds them.
SCRIPT_DIR = Path(__file__).resolve().parent.parent
WRITE_SERVER_TS = SCRIPT_DIR / "writeServer.ts"
# Used to locate the typenode launcher. vidgrid's root.
VIDGRID_ROOT = SCRIPT_DIR.parent.parent

# Temp file pattern. Per-source so a crash mid-run leaves the next
# source's slot free.
WORK_DUMP_NAME = "_face_work.json"
RESULT_NAME_FMT = "_face_result_{idx:05d}.json"

# writeServer.ts prints exactly this once, followed by its WebSocket port.
SERVER_READY_PREFIX = "WRITE_SERVER_LISTENING "
SERVER_START_TIMEOUT_SEC = 60


# Terminal color. Ported from socket-function's src/formatting/logColors.ts so
# this script's output matches the rest of the toolchain — the Node 256-color
# cube form (\x1b[38;5;Nm) renders consistently wherever the JS side's colors do.
def _hsl_to_rgb(h: float, s: float, l: float) -> tuple[int, int, int]:
    h /= 360.0
    s /= 100.0
    l /= 100.0
    if s == 0:
        r = g = b = l
    else:
        def hue2rgb(p: float, q: float, t: float) -> float:
            if t < 0:
                t += 1
            if t > 1:
                t -= 1
            if t < 1 / 6:
                return p + (q - p) * 6 * t
            if t < 1 / 2:
                return q
            if t < 2 / 3:
                return p + (q - p) * (2 / 3 - t) * 6
            return p
        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        r = hue2rgb(p, q, h + 1 / 3)
        g = hue2rgb(p, q, h)
        b = hue2rgb(p, q, h - 1 / 3)
    return int(r * 255), int(g * 255), int(b * 255)


def _ansi_hsl(h: float, s: float, l: float, text: str) -> str:
    r, g, b = _hsl_to_rgb(h, s, l)
    cube = 16 + 36 * round(r / 255 * 5) + 6 * round(g / 255 * 5) + round(b / 255 * 5)
    return f"\x1b[38;5;{cube}m{text}\x1b[0m"


def c_start(text: str) -> str: return _ansi_hsl(205, 90, 65, text)   # cyan-blue — a file begins
def c_done(text: str) -> str: return _ansi_hsl(130, 70, 55, text)    # green — a file finished ok
def c_fail(text: str) -> str: return _ansi_hsl(0, 100, 68, text)     # red — failure
def c_skip(text: str) -> str: return _ansi_hsl(45, 90, 60, text)     # yellow — skipped
def c_dim(text: str) -> str: return _ansi_hsl(0, 0, 50, text)        # gray — aggregate/aux


def c_worker(wi: int, text: str) -> str:
    # Distinct hue per worker so one runner's lines are easy to follow.
    return _ansi_hsl((wi * 67) % 360, 75, 62, text)


def c_crash(text: str) -> str: return _ansi_hsl(300, 90, 72, text)  # magenta — server crash report


# ── File-system walk (streams batches of discovered videos to writeServer) ──
# The walk lives in Python (Python is better at file-system iteration than
# Node, and doing it here keeps writeServer doing only DB writes). os.walk
# uses os.scandir under the hood in Python 3.5+ — no synchronous readdirSync
# blocking the event loop, and no giant in-memory file list: the caller
# consumes batches as they come.
VIDEO_EXTENSIONS = frozenset({
    ".mkv", ".mp4", ".webm", ".mov", ".m4v", ".avi", ".ts", ".mpg", ".mpeg",
})
# Directory names skipped outright — same intent as web/scan/folderTraversal
# (junk trees a real media root shouldn't ever contain).
WALK_SKIP_DIR_NAMES = frozenset({"node_modules", ".git", ".svn", ".hg"})
WALK_BATCH_SIZE = 500


def iter_video_batches(
    video_root: Path,
    *,
    ignored_folders: frozenset[str] = frozenset(),
    removed_files: frozenset[str] = frozenset(),
    batch_size: int = WALK_BATCH_SIZE,
) -> Iterator[list[dict]]:
    """Walk `video_root` and yield batches of {key, name, relativePath} dicts
    for every file with a video extension. Skips hidden entries (name starts
    with '.'), a small set of junk directory names, and any exclusions
    provided by the caller. Paths in the yielded items are forward-slash
    normalized so the DB key matches the browser convention on every
    platform.

    `ignored_folders` is the set of RELATIVE folder paths (forward-slash
    normalized) the user marked ignored in the browser; matching subtrees
    are pruned from os.walk in place. `removed_files` is the set of
    individual file keys the user removed; they're skipped even when present
    on disk. Same two exclusions the browser walk honors, so the two
    pipelines index the same files."""
    root = video_root.resolve()
    batch: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune junk / hidden subdirectories AND user-ignored ones in place.
        # The rel path check turns each candidate child directory into the
        # same forward-slash relative form the browser stores under.
        kept: list[str] = []
        for d in dirnames:
            if d.startswith(".") or d in WALK_SKIP_DIR_NAMES:
                continue
            abs_child = Path(dirpath) / d
            rel_child = str(abs_child.relative_to(root)).replace(os.sep, "/")
            if rel_child in ignored_folders:
                continue
            kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in VIDEO_EXTENSIONS:
                continue
            abs_path = Path(dirpath) / name
            rel = str(abs_path.relative_to(root)).replace(os.sep, "/")
            if rel in removed_files:
                continue
            batch.append({"key": rel, "name": name, "relativePath": rel})
            if len(batch) >= batch_size:
                yield batch
                batch = []
    if batch:
        yield batch


# Server-crash surfacing. writeServer.ts is ours, so when it dies mid-run we
# capture its recent stderr (the crash is almost always in there), restart it,
# and re-print that captured tail every CRASH_REPRINT_SEC — a one-shot log would
# scroll away behind thousands of per-video lines and never get seen.
CRASH_CAPTURE_LINES = 100
CRASH_REPRINT_SEC = 180


class WriteServer:
    """Client for the long-lived writeServer.ts process. Spawned once per
    run; every video's result is streamed to it so the bulk DBs load once
    and writes append to a single stream file per collection.

    The server process is ours, so a crash isn't fatal: when the socket drops
    we capture the server's recent stderr, restart the process, reconnect, and
    transparently retry the in-flight request (writes already acked are durable
    on disk; the fresh process reloads the index). The captured crash tail is
    re-surfaced on a timer so its cause isn't buried under the per-video flood."""

    def __init__(self, data_root: Path) -> None:
        self._cmd = [
            "node", "-r", str(VIDGRID_ROOT / "node_modules" / "typenode" / "index.js"),
            str(WRITE_SERVER_TS), str(data_root),
        ]
        self._next_id = 0
        # One WS connection shared by all worker threads; serialize send+recv so
        # concurrent writes don't interleave on the socket, AND so a restart
        # happens exactly once — the failing request holds the lock across it,
        # blocking the others until the server is back.
        self._lock = threading.Lock()
        # Rolling tail of the server's stderr (DB-load + per-write logs, and
        # crucially any crash stack). Snapshotted on crash for re-surfacing.
        self._stderr_ring: "deque[str]" = deque(maxlen=CRASH_CAPTURE_LINES)
        self._last_crash: Optional[dict] = None
        self._closed = False
        self._spawn()
        # Daemon that re-prints the most recent crash report on a timer so it
        # doesn't disappear behind the per-video logs.
        threading.Thread(target=self._crash_reporter_loop, daemon=True).start()

    def _spawn(self) -> None:
        # stdout is piped purely for the one-line port handshake. stderr is
        # piped (not inherited) so we can echo it live AND keep the tail for
        # crash reports; bufsize=1 keeps the live echo line-prompt.
        self._proc = subprocess.Popen(
            self._cmd, cwd=str(VIDGRID_ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._drain_stderr, args=(self._proc,), daemon=True).start()
        try:
            port = self._read_port()
            # max_size None so the work-list reply / large control payloads
            # don't trip websockets' default 1 MiB frame cap.
            self._ws = connect(f"ws://127.0.0.1:{port}", max_size=None)
        except Exception:
            # Don't leave the Node process orphaned if the handshake/connect
            # never completed.
            self._proc.kill()
            raise

    def _drain_stderr(self, proc: subprocess.Popen) -> None:
        # Echo every server line live (preserving the old inherited-stderr
        # behavior) while keeping the rolling tail. Ends on EOF — i.e. when the
        # process exits or is killed on restart.
        try:
            for raw in proc.stderr:
                line = raw.rstrip("\n")
                self._stderr_ring.append(line)
                print(line, file=sys.stderr, flush=True)
        except Exception:
            pass

    def _read_port(self) -> int:
        deadline = time.monotonic() + SERVER_START_TIMEOUT_SEC
        while True:
            line = self._proc.stdout.readline()
            if line == "":
                raise RuntimeError("writeServer exited before reporting a port")
            line = line.rstrip("\n")
            if line.startswith(SERVER_READY_PREFIX):
                return int(line[len(SERVER_READY_PREFIX):])
            # Stray pre-handshake stdout — echo it so a startup error isn't
            # swallowed.
            if line:
                print(line)
            if time.monotonic() > deadline:
                raise RuntimeError(f"writeServer did not report a port within {SERVER_START_TIMEOUT_SEC}s")

    def _request(self, msg: dict) -> dict:
        with self._lock:
            return self._request_locked(msg, allow_restart=True)

    def _request_locked(self, msg: dict, allow_restart: bool) -> dict:
        self._next_id += 1
        full = {"id": self._next_id, **msg}
        try:
            self._ws.send(json.dumps(full))
            resp = json.loads(self._ws.recv())
        except Exception as e:
            # Socket dropped — the server died (or is dying). Once per request:
            # capture why, bring it back up, retry. If the retry also dies we let
            # it raise (caller records the write as failed and the run keeps
            # going) so a poison payload can't spin an infinite restart loop.
            if self._closed or not allow_restart:
                raise
            self._handle_crash(e)
            return self._request_locked(msg, allow_restart=False)
        if not resp.get("ok"):
            raise RuntimeError(f"writeServer {msg.get('type')} failed: {resp.get('error')}")
        return resp

    def _handle_crash(self, err: Exception) -> None:
        self._last_crash = {
            "when": time.strftime("%H:%M:%S"),
            "err": repr(err),
            "lines": list(self._stderr_ring),
        }
        self._print_crash_report(self._last_crash, "server crashed — restarting")
        self._restart()

    def _restart(self) -> None:
        old = self._proc
        try:
            self._ws.close()
        except Exception:
            pass
        try:
            old.kill()
        except Exception:
            pass
        try:
            old.wait(timeout=SERVER_START_TIMEOUT_SEC)
        except Exception:
            pass
        self._spawn()
        print(c_crash("[writeServer] restarted — writes resumed"), file=sys.stderr, flush=True)

    def _print_crash_report(self, crash: dict, reason: str) -> None:
        lines = crash["lines"]
        head = (f"┌─ writeServer crash report ({reason}) — crashed {crash['when']}, "
                f"error: {crash['err']} — last {len(lines)} server log lines:")
        foot = (f"└─ end writeServer crash report — auto-restarted; "
                f"re-surfaced every {CRASH_REPRINT_SEC}s until the run ends.")
        out = [c_crash(head)]
        for ln in lines:
            out.append(c_crash("    │ " + ln))
        out.append(c_crash(foot))
        print("\n".join(out), file=sys.stderr, flush=True)

    def _crash_reporter_loop(self) -> None:
        while not self._closed:
            time.sleep(CRASH_REPRINT_SEC)
            if self._closed:
                break
            crash = self._last_crash
            if crash:
                self._print_crash_report(crash, "still surfacing last crash")

    def get_walk_exclusions(self) -> dict:
        """Fetch the folders the user marked ignored + the files they removed.
        Python honors these in the walk, matching the browser scan. Without
        this, the offline pipeline would index everything the browser would
        skip -- exactly the count discrepancy you'd see side-by-side."""
        return self._request({"type": "getWalkExclusions"})

    def register_files(self, items: list[dict]) -> dict:
        """Send a batch of discovered files to writeServer for DB registration.
        `items` is a list of {key, name, relativePath}. Server returns the
        per-batch counts {added, updated} — Python accumulates totals across
        batches (the walk itself lives in Python)."""
        return self._request({"type": "registerFiles", "items": items})

    def get_work(self, out_path: Path, force: bool) -> dict:
        return self._request({"type": "getWork", "outPath": str(out_path), "force": force})

    def write(self, result_path: Path) -> dict:
        return self._request({"type": "write", "path": str(result_path)})

    def compact(self) -> None:
        self._request({"type": "compact"})

    def close(self) -> None:
        # Stop restart attempts + the reporter loop before the final flush so a
        # dead server at shutdown doesn't trigger a pointless restart.
        self._closed = True
        try:
            self._request({"type": "close"})
        except Exception as e:
            print(f"[run] writeServer close request failed: {e}", file=sys.stderr)
        finally:
            try:
                self._ws.close()
            except Exception:
                pass
            if self._proc.stdout:
                self._proc.stdout.close()
            try:
                self._proc.wait(timeout=SERVER_START_TIMEOUT_SEC)
            except Exception:
                self._proc.kill()


def _process_video(
    video_root: Path,
    item: dict,
    tmp_dir: Path,
    engine,
    idx: int,
    parallel: int,
) -> Optional[Path]:
    """Run process_one on a single item. Returns the result JSON path
    (None on a missing-file error)."""
    rel = item["relativePath"]
    file_key = item["key"]
    video_path = video_root / rel
    if not video_path.is_file():
        return None

    out_path = tmp_dir / RESULT_NAME_FMT.format(idx=idx)
    from process_one import process_one
    process_one(
        video_path=video_path,
        file_key=file_key,
        out_json_path=out_path,
        engine=engine,
        parallel=parallel,
        duration_sec=item.get("durationSec"),
        folder_video_count=item.get("folderVideoCount"),
    )
    return out_path


def _handle_video(wi, idx, item, video_root, engine, server, tmp_dir, total, parallel) -> str:
    """Process one video and ship its result. Returns "ok" / "skipped" /
    "failed". A pipeline error is recorded against the FileRecord (so the cell
    shows the failure and the file isn't retried) rather than aborting the run.
    The per-idx temp path keeps concurrent workers from colliding. `wi` is the
    worker (parallel runner) index, prefixed on every line so a single runner's
    lifecycle is traceable across interleaved parallel output."""
    tag = c_worker(wi, f"[w{wi}]")
    key = item["key"]
    rel = item["relativePath"]
    t0 = time.monotonic()
    print(f"{tag} " + c_start(f"{idx + 1}/{total} start {rel}"))
    try:
        out_path = _process_video(video_root, item, tmp_dir, engine, idx, parallel)
    except TimeoutError as e:
        # Our own deadline in process_one._iter_keyframes_parallel elapsed. We
        # know for a fact this file is a bad-actor, so blacklist it here — same
        # scanBlacklisted flip the browser-side hard cap does. No re-detection
        # needed downstream: the SITE that timed out is the one that stamps.
        print(f"{tag} " + c_fail(f"{idx + 1}/{total} timeout {rel}: {e} — blacklisting"), file=sys.stderr)
        err_path = tmp_dir / RESULT_NAME_FMT.format(idx=idx)
        err_path.write_text(json.dumps({
            "fileKey": key,
            "error": str(e),
            "blacklist": True,
        }), encoding="utf-8")
        try:
            server.write(err_path)
        except Exception as werr:
            print(f"{tag} " + c_fail(f"{rel}: writeServer failed for blacklist record: {werr}"), file=sys.stderr)
        finally:
            err_path.unlink(missing_ok=True)
        return "failed"
    except Exception as e:  # noqa: BLE001 — keep the run alive
        print(f"{tag} " + c_fail(f"{idx + 1}/{total} pipeline error {rel}: {e}"), file=sys.stderr)
        err_path = tmp_dir / RESULT_NAME_FMT.format(idx=idx)
        err_path.write_text(json.dumps({"fileKey": key, "error": str(e)}), encoding="utf-8")
        try:
            server.write(err_path)
        except Exception as werr:
            print(f"{tag} " + c_fail(f"{rel}: writeServer failed for error record: {werr}"), file=sys.stderr)
        finally:
            err_path.unlink(missing_ok=True)
        return "failed"

    if out_path is None:
        print(f"{tag} " + c_skip(f"{idx + 1}/{total} skip {rel} — file missing"))
        return "skipped"

    try:
        counts = server.write(out_path)
        elapsed = time.monotonic() - t0
        print(f"{tag} " + c_done(
            f"{idx + 1}/{total} done {rel} in {elapsed:.1f}s "
            f"— {counts.get('faces', 0)} faces, {counts.get('characters', 0)} chars, "
            f"{counts.get('frames', 0)} frames, {counts.get('keyframes', 0)} keyframes"))
        return "ok"
    except Exception as werr:
        print(f"{tag} " + c_fail(f"{idx + 1}/{total} writeServer failed {rel}: {werr}"), file=sys.stderr)
        return "failed"
    finally:
        out_path.unlink(missing_ok=True)


def _fmt_eta(secs: float) -> str:
    secs = int(secs)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


class Progress:
    """Thread-safe completion tracker. ETA extrapolates remaining videos at the
    running wall-clock rate (completed / elapsed) — which already accounts for
    --parallel, since N workers retire videos N× faster."""

    def __init__(self, total: int) -> None:
        self.total = total
        self.done = 0
        self.start = time.monotonic()
        self.lock = threading.Lock()

    def complete(self) -> None:
        with self.lock:
            self.done += 1
            done = self.done
            elapsed = time.monotonic() - self.start
            rate = done / elapsed if elapsed > 0 else 0.0
            eta = (self.total - done) / rate if rate > 0 else 0.0
            # "progress:" prefix so this aggregate line reads distinctly from the
            # per-video idx/total "starting"/"done" lines.
            print(
                c_dim(
                    f"[run] progress: {done}/{self.total} done, ETA {_fmt_eta(eta)} "
                    f"({rate * 60:.1f} videos/min, {_fmt_eta(elapsed)} elapsed)"
                ),
                flush=True,
            )


def main() -> int:
    # Stream progress promptly: Python block-buffers stdout when it's a
    # pipe (yarn → uv → python), which would otherwise batch every
    # progress line until the process exits. UTF-8 so non-Latin video paths
    # don't trip Windows' cp1252 stdout with a UnicodeEncodeError.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

    p = argparse.ArgumentParser(prog="yarn parse")
    p.add_argument("video_root", type=Path,
                   help="Folder of videos to process — the same path the browser scanned.")
    p.add_argument("--force", action="store_true")
    p.add_argument("--stub-faces", action="store_true",
                   help="Use the synthetic-face stub instead of running InsightFace.")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--filter", dest="name_filter", default=None,
                   help="Only consider files whose relative path contains this string "
                        "(case-insensitive substring match). Applied after the work list "
                        "is collected, e.g. --filter \"megaman\".")
    p.add_argument("--data-root", type=Path, default=None,
                   help="Where the bulk databases live. Defaults to <video_root>; "
                        "BulkDatabase2 resolves to <data_root>/data/bulkDatabases2/.")
    p.add_argument("--compact", action="store_true",
                   help="After the run, fold the append-log stream files into compressed "
                        "columnar bulk files. Reads each collection fully into memory, so "
                        "it's opt-in; otherwise the browser's normal merge consolidates later.")
    p.add_argument("--parallel", type=int, default=1,
                   help="Process this many videos concurrently. Each gets its own face engine "
                        "(so GPU detection is thread-safe) and a 1/N slice of the CPU cores for "
                        "decoding, so one video's keyframe gather overlaps another's GPU work — "
                        "keeping the GPU fed. Higher N uses more VRAM (one model set each). Default 1.")
    args = p.parse_args()
    parallel = max(1, args.parallel)

    video_root = args.video_root.resolve()
    if not video_root.is_dir():
        print(f"[run] video_root {video_root} is not a directory", file=sys.stderr)
        return 1

    # By default the bulk DBs sit next to the videos. The BulkDatabase2
    # Node backend creates the data/bulkDatabases2/ directories on first
    # write, so we don't need to pre-make them.
    data_root = (args.data_root or video_root).resolve()
    data_root.mkdir(parents=True, exist_ok=True)

    # Scratch JSON (the work dump + per-video result payloads) is purely an IPC
    # handoff to writeServer; it must NOT land in data_root, where it litters the
    # user's video/data tree (which may also be a slow/remote drive). Put it in
    # the OS temp dir — a throwaway location on the local drive — and delete it
    # when the run ends. Paths handed to writeServer are absolute, so its own
    # chdir(data_root) doesn't redirect these writes.
    tmp_dir = Path(tempfile.mkdtemp(prefix="vidgrid-faces-"))

    server = WriteServer(data_root)
    try:
        # Walk the filesystem FIRST so a fresh library has entries in the
        # files DB before get_work runs. Python's os.walk streams — batches
        # ship to writeServer as they're found rather than holding the whole
        # tree in memory. Idempotent on a library the browser already
        # scanned: existing rows are merged, only seenAt refreshes; addedAt
        # is preserved. Honors the SAME exclusions the browser walk honors
        # (ignoredFolders + removedFiles), so the two pipelines index the
        # same files — otherwise the offline pipeline would inject rows the
        # browser was deliberately skipping and every one would show up as
        # "unscanned" on the scanning page.
        exclusions = server.get_walk_exclusions()
        ignored_folders = frozenset(exclusions.get("ignoredFolders") or ())
        removed_files = frozenset(exclusions.get("removedFiles") or ())
        if ignored_folders or removed_files:
            print(f"[run] walk exclusions: {len(ignored_folders)} ignored folders, "
                  f"{len(removed_files)} removed files")
        walk_t0 = time.monotonic()
        walk_total = 0
        walk_added = 0
        walk_updated = 0
        for batch in iter_video_batches(
            video_root,
            ignored_folders=ignored_folders,
            removed_files=removed_files,
        ):
            result = server.register_files(batch)
            walk_total += len(batch)
            walk_added += result.get("added", 0)
            walk_updated += result.get("updated", 0)
            print(f"[run] walk: {walk_total} videos found so far "
                  f"({walk_added} new, {walk_updated} existing)",
                  end="\r", flush=True)
        print(f"[run] walk: {walk_total} videos found in {time.monotonic() - walk_t0:.1f}s "
              f"({walk_added} new, {walk_updated} existing)")

        work_path = tmp_dir / WORK_DUMP_NAME
        server.get_work(work_path, args.force)
        raw = json.loads(work_path.read_text(encoding="utf-8"))
        items: list[dict] = raw["items"]
        if args.name_filter:
            needle = args.name_filter.lower()
            before = len(items)
            items = [it for it in items if needle in it["relativePath"].lower()]
            print(f"[run] --filter {args.name_filter!r}: {len(items)}/{before} items match")
        if args.limit is not None:
            items = items[: args.limit]
        print(f"[run] {len(items)} items to process (force={args.force}, parallel={parallel})")

        # One face engine per concurrent worker (an ONNX CUDA session isn't safe
        # to call from multiple threads, so workers can't share one). Built
        # sequentially up front: the first builds the fused model, the rest load
        # it from cache — building concurrently would race on that file.
        engines = []
        for _ in range(parallel):
            if args.stub_faces:
                from face_pipeline import StubFaceEngine
                engines.append(StubFaceEngine())
            else:
                from face_pipeline import FaceEngine
                engine = FaceEngine()
                engine.ensure_loaded()
                engines.append(engine)

        total = len(items)
        work_q: "queue.Queue" = queue.Queue()
        for idx, item in enumerate(items):
            work_q.put((idx, item))

        # Each worker tallies into its own slot, so no lock is needed for stats;
        # summed after join. [ok, skipped, failed].
        worker_stats = [[0, 0, 0] for _ in range(parallel)]
        # Start the ETA clock here, after the (non-per-video) engine load.
        progress = Progress(total)

        def worker(wi: int) -> None:
            engine = engines[wi]
            tally = worker_stats[wi]
            tag = c_worker(wi, f"[w{wi}]")
            while True:
                try:
                    idx, item = work_q.get_nowait()
                except queue.Empty:
                    break
                # A worker must never die mid-run. _handle_video already records
                # pipeline/write errors, but a daemon thread that hits anything
                # uncaught (a non-Exception BaseException, a broken-pipe in a
                # print) vanishes silently and the pool shrinks one runner at a
                # time. Catch everything here, log it loudly against the worker
                # index, and keep pulling work.
                try:
                    status = _handle_video(wi, idx, item, video_root, engine, server, tmp_dir, total, parallel)
                except BaseException as e:  # noqa: BLE001 — a runner may not crash
                    status = "failed"
                    try:
                        print(f"{tag} " + c_fail(f"unhandled error on {item.get('key')!r}: {e!r}"), file=sys.stderr)
                        traceback.print_exc()
                    except Exception:
                        pass
                tally[0 if status == "ok" else 1 if status == "skipped" else 2] += 1
                try:
                    progress.complete()
                except Exception:
                    pass
            print(f"{tag} " + c_dim("worker exiting — queue drained, no more work"))

        threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(parallel)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        succeeded = sum(s[0] for s in worker_stats)
        skipped = sum(s[1] for s in worker_stats)
        failed = sum(s[2] for s in worker_stats)

        if args.compact:
            print("[run] compacting bulk databases...")
            server.compact()
        print(
            "[run] finished — "
            + c_done(f"{succeeded} ok") + ", "
            + c_skip(f"{skipped} skipped") + ", "
            + c_fail(f"{failed} failed")
        )
        # Final walk summary — restated at the very end so a long face-processing
        # tail can't push the earlier walk log out of view. This is what the
        # walk saw on disk, POST-exclusions, so it's directly comparable to the
        # browser's file count on the scanning page.
        print(f"[run] walk saw {walk_total} video files on disk under {video_root} "
              f"(after {len(ignored_folders)} ignored-folder + {len(removed_files)} removed-file exclusions)")
        return 0 if failed == 0 else 1
    finally:
        server.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
