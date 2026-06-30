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
drive letter alone can be set with RUNPOD_WORKER_DRIVE, which otherwise defaults
to the drive the parse is running from (running from D:\\... reads D:\\tmp\\...).

The file is present whenever the owner worker is alive. Two lines:
    active | inactive      <- whether the owner wants/holds the GPU
    1750000000             <- unix-seconds LIVENESS HEARTBEAT (NOT a transition
                              time): the owner rewrites it every ~5 min while
                              alive, so a far-in-the-past value means the owner
                              died/wedged without flipping back to inactive.

How we decide, per poll:
- inactive                  -> GPU is free; run.
- active + fresh heartbeat  -> owner wants the card; stay off.
- active + stale heartbeat  -> heartbeat older than HEARTBEAT_STALE_SEC means
                               the owner is dead/hung and never released the
                               card; treat the GPU as free and run.
- missing/garbage file      -> assume active (stay off the GPU).

On inactive->active the owner gives a ~60s grace before loading, but we do NOT
derive that deadline from line 2 (it's the heartbeat, not the transition
time) — we just vacate immediately on `active`, which is well inside the grace.
An owner launched with --no-shared-gpu writes `active` permanently; we simply
stay off the GPU the whole time, which is the correct cooperative behavior.
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
# The owner rewrites its liveness heartbeat (line 2) every ~5 min. If `active`
# but the heartbeat hasn't moved in this long, the owner is dead/wedged and
# never released the card — we treat the GPU as free. Generous multiple of the
# ~5 min beat so a single missed write never falsely steals the card.
HEARTBEAT_STALE_SEC = 15 * 60
# Upper bound on how long a SIGKILL'd Python takes to actually disappear. Only
# hit if the OS is wedged; logged so it's never silent.
KILL_REAP_SEC = 30
# While blocked waiting for the GPU to free, re-log a status line this often so a
# multi-hour wait isn't a single silent line — and so the timestamp + state-file
# snapshot reveal whether we're wrongly stuck on a card that's actually free.
WAIT_STATUS_SEC = 5 * 60


def log(msg: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[gpu-manager {stamp}] {msg}", flush=True)


def describe_state(path: Path) -> str:
    """One-line snapshot of the shared-GPU file for diagnostics: the raw state
    word plus, for `active`, how stale the heartbeat is. Lets a stuck wait loop
    show *why* it still thinks the card is busy."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return f"unreadable ({e.__class__.__name__})"
    lines = text.splitlines()
    state = lines[0].strip() if lines else "<empty>"
    if state != "active":
        return f"state={state!r}"
    beat: int | None = None
    if len(lines) > 1:
        try:
            beat = int(lines[1].strip())
        except ValueError:
            beat = None
    if beat is None:
        return "state='active', heartbeat=<missing/garbage>"
    age = int(time.time() - beat)
    return (f"state='active', heartbeat age {age}s "
            f"(stale threshold {HEARTBEAT_STALE_SEC}s)")


def resolve_state_file() -> Path:
    """Locate the shared-GPU state file.

    SHARED_GPU_STATE_FILE overrides the full path. On Windows the worker keeps
    the file on the same drive the work runs from, so the drive defaults to the
    current working directory's — running the parse from `D:\\repos\\vidgrid`
    reads `D:\\tmp\\runpod-worker\\shared_gpu_state`, not C:. RUNPOD_WORKER_DRIVE
    overrides just the drive letter."""
    override = os.environ.get("SHARED_GPU_STATE_FILE")
    if override:
        return Path(override)
    if os.name == "nt":
        drive = os.environ.get("RUNPOD_WORKER_DRIVE") or os.path.splitdrive(os.getcwd())[0] or "C:"
        drive = drive.rstrip(":")
        return Path(f"{drive}:\\tmp\\runpod-worker\\shared_gpu_state")
    return Path("/tmp/runpod-worker/shared_gpu_state")


def gpu_is_free(path: Path) -> bool:
    """Whether we may use the GPU right now (see the shared-GPU protocol above).

    inactive -> free. active + fresh heartbeat -> not free. active + stale
    heartbeat (older than HEARTBEAT_STALE_SEC) -> free, since the owner died
    without flipping back. Missing/garbage -> not free (assume active; stay
    off). Line 2 is liveness only — never treated as a transition time."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    lines = text.splitlines()
    state = lines[0].strip() if lines else ""
    if state == "inactive":
        return True
    if state != "active":
        return False  # garbage line 1 — assume active, stay off
    beat: int | None = None
    if len(lines) > 1:
        try:
            beat = int(lines[1].strip())
        except ValueError:
            beat = None
    if beat is None:
        return False  # active with no readable heartbeat — stay off
    return (time.time() - beat) > HEARTBEAT_STALE_SEC


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
    last_status = 0.0
    while True:
        if gpu_is_free(state_path):
            if waited:
                log("GPU free again — resuming parse")
            return
        now = time.monotonic()
        if not waited:
            log(f"GPU is held by the owner process — waiting for it to free up… ({describe_state(state_path)})")
            waited = True
            last_status = now
        elif now - last_status >= WAIT_STATUS_SEC:
            log(f"still waiting for the GPU to free up… ({describe_state(state_path)})")
            last_status = now
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
        if not gpu_is_free(state_path):
            log("GPU owner went active — killing parse to free VRAM")
            force_kill(proc)
            log("parse stopped; VRAM released")
            return "preempted"


def main() -> int:
    args = sys.argv[1:]
    state_path = resolve_state_file()
    presence = "present" if state_path.exists() else "not present yet"
    log(f"watching shared-GPU state at {state_path} ({presence})")

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
