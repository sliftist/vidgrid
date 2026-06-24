# vidgrid face processor

Headless Python equivalent of the in-browser face extraction phase.
Pulls work from the on-disk bulk databases via two TypeScript bridge
scripts, runs SCRFD + ArcFace per video, clusters faces into characters,
and writes the results back through the same bridge.

## Why

The browser worker can do face extraction but it's bound by:
- WebGPU buffer budgets and ONNX Runtime web's limited op coverage
- Per-tab CPU/GPU contention with playback and UI
- Mediabunny's keyframe iteration speed in JS

Running the same pipeline in Python with a real GPU is roughly an order
of magnitude faster, and it can chew through a library overnight while
the browser handles only live face search against already-extracted
embeddings.

## Layout

```
scripts/faces/
  getWork.ts         TypeScript: dump work-needing FileRecords to JSON
  writeResult.ts     TypeScript: ingest one video's result JSON
  pyproject.toml     uv project metadata
  README.md          this file
  src/
    face_pipeline.py SCRFD detect + ArcFace embed via insightface
    clustering.py    Port of web/faceEmbed/clustering.ts
    process_one.py   Per-video pipeline (decode → detect → cluster)
    run.py           Orchestrator: get-work → loop → write-result
```

## Run

```sh
# one prerequisite: install uv as a Python package so it's reachable
# via `python -m uv` regardless of whether the standalone `uv` is on PATH
# (Windows in particular doesn't drop uv.exe onto PATH by default):
python -m pip install --upgrade uv

# then, from the vidgrid repo root, point at the folder of videos:
yarn parse E:/downloads/
```

`uv run` handles the Python venv + dependency install on first call;
later runs reuse it. Bulk databases are written next to the videos at
`<video_root>/data/bulkDatabases2/` (override with `--data-root PATH`).

InsightFace pulls the buffalo_l weights from its own model zoo on
first inference — `~/.insightface/models/buffalo_l/`. To use weights
you already have on disk, drop `det_10g.onnx` and `w600k_r50.onnx`
into that folder before running.

`yarn parse` will:

1. Call `getWork.ts` (chdir → `<video_root>` → bulk DBs at `data/bulkDatabases2/`).
2. Read the JSON list of work items.
3. For each item:
   - Decode keyframes via `av`, ≥3 s apart, letterboxed to 640 px wide.
   - Run InsightFace's `app.get()` on each keyframe → bbox + landmarks
     + 512-float L2-normalised embedding (matches the browser path
     because both sides use buffalo_l weights).
   - Keep top 10 faces per frame by detection score.
   - Cluster all faces into characters (`OnlineClusterer` + medoid
     prune at L2 threshold 1.1, top 30 by member count). Same logic
     as `web/faceEmbed/clustering.ts`.
   - JPEG-encode the kept frames (640-wide, q 0.80) so the cell strip
     thumbnails match what the browser would have stored.
   - Write a temp JSON payload + call `writeResult.ts` to commit.

## Sharing the GPU with another process

`yarn parse` runs through a thin supervisor (`src/manager.py`) so it can
coexist with another process on the machine that genuinely owns the GPU. The
command line is unchanged — every flag is forwarded verbatim to `run.py`.

The owner announces its intent through a shared state file:

- Linux: `/tmp/runpod-worker/shared_gpu_state`
- Windows: `<drive>:\tmp\runpod-worker\shared_gpu_state`

Two atomically-written lines: `active`/`inactive`, then the unix-seconds
timestamp it entered that state. `active` means "get off the GPU" (the owner
gives a 60s grace after flipping); `inactive` means the VRAM is already free.

The supervisor polls that file every few seconds. When it sees `active` it
**force-kills the parse** (SIGKILL on the Python process — that's what holds the
VRAM), which frees the card well inside the 60s window; the `writeServer.ts`
child flushes the bulk DB on its own when our socket drops, so nothing is lost.
When the file returns to `inactive` it relaunches, and the normal getWork
skip-completed logic resumes the run where it left off. A missing or unreadable
file is treated as `active` (stay off the GPU).

Overrides:
- `SHARED_GPU_STATE_FILE` — full path to the state file (any OS).
- `RUNPOD_WORKER_DRIVE` — Windows drive letter only (default `C`).

To bypass the supervisor entirely (e.g. on a machine with no GPU owner), use
`yarn parse-direct …`, which calls `run.py` straight.

## Done-ness + retries

A file is "done" iff its FileRecord's `facesVersion === FACES_VERSION`
(from `web/MetadataExtractor.ts`). When the version is bumped on the
TypeScript side, re-running `run.py` picks up everything stale
automatically. Pass `--force` to `getWork.ts` (or `run.py --force`) to
ignore the version stamp and reprocess every file.

## Testing without a GPU

`pyproject.toml` defaults to `onnxruntime` (CPU). Embedding + detection
will be slow (a few seconds per keyframe) but every code path works.
For real runs, install `onnxruntime-gpu` alongside CUDA + cuDNN matching
your driver, then reinstall.

The orchestrator + JSON shapes can be exercised without any inference
at all: see `process_one.py`'s `--stub-faces` flag, which emits a
synthetic single-character single-frame payload so you can verify the
bridge scripts write to the bulk DBs end-to-end.
