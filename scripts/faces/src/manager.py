"""GPU-cooperative supervisor around run.py.

Another process on this machine genuinely owns the GPU. It announces when it
wants the card by writing a shared state file (the "shared-GPU protocol",
below). This wrapper makes `yarn parse` a good citizen: while that owner is
active we forcefully kill the parse so its VRAM is freed, and when the card is
free again we relaunch — run.py's normal getWork skip-completed logic picks the
run back up where it left off.

It is deliberately transparent: it forwards its argv verbatim to run.py, so
`yarn parse <video_root> [flags]` behaves exactly as before, just GPU-aware.

Why a wrapper and not logic inside run.py: freeing VRAM means ending the
*Python* process (that's where the InsightFace CUDA sessions live). You can't
reliably free a process's VRAM from inside that same process — only by killing
it. A separate supervisor can do that and then start a clean one.

Shared-GPU protocol
-------------------
File (Linux): /tmp/runpod-worker/shared_gpu_state
File (Windows): <drive>:\\tmp\\runpod-worker\\shared_gpu_state
Override the full path with the env var SHARED_GPU_STATE_FILE; on Windows the
drive letter alone can be set with RUNPOD_WORKER_DRIVE (default C).

Two lines, written atomically:
    active | inactive      <- whether the owner wants/holds the GPU
    1750000000             <- unix seconds it entered that state

- active: the owner writes this immediately on its first request, then waits
  60s before loading anything, so we have until line2 + 60 to free our VRAM.
- inactive: the owner has fully unloaded; VRAM is *already* free.
- missing/garbage file: assume active (stay off the GPU).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RUN_PY = SCRIPT_DIR / "run.py"

# How often to re-read the state file. The owner gives us 60s after it flips to
# "active", so a few seconds of poll latency leaves a huge margin.
POLL_SEC = 3.0
# The owner's grace window after it flips to "active" — purely informational
# here (we kill immediately), used to log how much budget we're using.
OWNER_GRACE_SEC = 60
# Upper bound on how long a SIGKILL'd Python takes to actually disappear. Only
# hit if the OS is wedged; logged so it's never silent.
KILL_REAP_SEC = 30


def log(msg: str) -> None:
    print(f"[gpu-manager] {msg}", flush=True)


def resolve_state_file() -> Path:
    override = os.environ.get("SHARED_GPU_STATE_FILE")
    if override:
        return Path(override)
    if os.name == "nt":
        drive = os.environ.get("RUNPOD_WORKER_DRIVE", "C").rstrip(":")
        return Path(f"{drive}:\\tmp\\runpod-worker\\shared_gpu_state")
    return Path("/tmp/runpod-worker/shared_gpu_state")


def read_gpu_state(path: Path) -> tuple[str, int]:
    """(state, since_unix). Missing or unparseable -> ("active", 0): when in
    doubt we assume the owner wants the GPU and stay off it."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ("active", 0)
    lines = text.splitlines()
    state = lines[0].strip() if lines else ""
    if state not in ("active", "inactive"):
        return ("active", 0)
    since = 0
    if len(lines) > 1:
        try:
            since = int(lines[1].strip())
        except ValueError:
            since = 0
    return (state, since)


def launch(args: list[str]) -> subprocess.Popen:
    """Spawn run.py in the same venv (we're already inside `uv run`), forwarding
    argv. New session/process-group so a terminal Ctrl-C lands on us — the
    supervisor — and not directly on run.py; we decide how the child dies."""
    cmd = [sys.executable, str(RUN_PY), *args]
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(cmd, **kwargs)


def force_kill(proc: subprocess.Popen) -> None:
    """Kill ONLY the Python process (proc.pid), which is what holds the VRAM.
    Its writeServer.ts child is left alone on purpose: when our socket drops it
    flushes whatever's pending and exits itself (ws 'close' handler), so the
    bulk DB stays consistent even though we never sent a graceful close."""
    if proc.poll() is not None:
        return
    proc.kill()
    try:
        proc.wait(timeout=KILL_REAP_SEC)
    except subprocess.TimeoutExpired:
        log(f"WARNING: parse process {proc.pid} still alive {KILL_REAP_SEC}s after SIGKILL")


def stop_graceful(proc: subprocess.Popen) -> None:
    """User-initiated quit (Ctrl-C): let run.py run its own shutdown (its
    finally closes the writeServer cleanly) before falling back to a hard kill."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            os.kill(proc.pid, signal.SIGINT)
    except (OSError, ValueError):
        pass
    try:
        proc.wait(timeout=KILL_REAP_SEC)
    except subprocess.TimeoutExpired:
        force_kill(proc)


def wait_until_free(state_path: Path) -> None:
    waited = False
    while True:
        state, _since = read_gpu_state(state_path)
        if state == "inactive":
            if waited:
                log("GPU free again — resuming parse")
            return
        if not waited:
            log("GPU is held by the owner process — waiting for it to free up…")
            waited = True
        time.sleep(POLL_SEC)


def supervise(proc: subprocess.Popen, state_path: Path) -> str:
    """Watch the running parse. Returns "completed" if it exited on its own, or
    "preempted" if we killed it to yield the GPU."""
    while True:
        try:
            proc.wait(timeout=POLL_SEC)
            return "completed"
        except subprocess.TimeoutExpired:
            pass
        state, since = read_gpu_state(state_path)
        if state != "inactive":
            budget = (since + OWNER_GRACE_SEC) - int(time.time()) if since else None
            budget_str = f" (owner's deadline in ~{budget}s)" if budget is not None else ""
            log(f"GPU owner went active{budget_str} — killing parse to free VRAM")
            force_kill(proc)
            log("parse stopped; VRAM released")
            return "preempted"


def main() -> int:
    args = sys.argv[1:]
    state_path = resolve_state_file()
    log(f"watching shared-GPU state at {state_path}")

    proc: subprocess.Popen | None = None
    try:
        while True:
            wait_until_free(state_path)
            proc = launch(args)
            outcome = supervise(proc, state_path)
            code = proc.returncode
            proc = None
            if outcome == "completed":
                log(f"parse finished (exit {code})")
                return code if code is not None else 0
            # preempted → loop: wait for the GPU to free, then relaunch.
    except KeyboardInterrupt:
        log("interrupted — shutting down parse")
        if proc is not None:
            stop_graceful(proc)
        return 130


if __name__ == "__main__":
    sys.exit(main())
