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

The file is present while the owner is alive. Two lines: `active`/`inactive`,
then a unix-seconds **liveness heartbeat** the owner rewrites every ~5 min.
That second line is *not* a transition time — it's a freshness signal, so an
owner that died/wedged without flipping back to `inactive` is detectable.

Per poll the supervisor decides:

- `inactive` → GPU is free; run.
- `active` + a fresh heartbeat (≤15 min old) → owner wants the card; stay off.
- `active` + a stale heartbeat (>15 min old) → owner is dead/hung and never
  released the card; treat the GPU as free and run.
- missing/garbage file → assume `active` (stay off the GPU).

On `active` it **force-kills the parse** (SIGKILL on the Python process — that's
what holds the VRAM); the owner's ~60s post-flip grace gives a huge margin
(we vacate within one poll, ~3s). We do **not** derive that deadline from line 2
— it's the heartbeat, not the transition time. The `writeServer.ts` child
flushes the bulk DB on its own when our socket drops, so nothing is lost. When
the GPU is free again it relaunches, and the normal getWork skip-completed logic
resumes the run where it left off. An owner launched with `--no-shared-gpu`
writes `active` permanently, so we simply stay off the card for its lifetime.

Overrides:
- `SHARED_GPU_STATE_FILE` — full path to the state file (any OS).
- `RUNPOD_WORKER_DRIVE` — Windows drive letter only (default `C`).

To bypass the supervisor entirely (e.g. on a machine with no GPU owner), use
`yarn parse-direct …`, which calls `run.py` straight.

## Done-ness + retries

A file is "done" iff its FileRecord's `facesVersion >= FACES_VERSION`
(from `web/MetadataExtractor.ts`). The comparison is `>=`, not `===`, on
purpose: a file already stamped with a *newer* version is left alone, so
running an old copy of this script never drags the library back to an
older version. When the version is bumped on the TypeScript side, re-running
`run.py` picks up everything stale automatically. Pass `--force` to
`getWork.ts` (or `run.py --force`) to ignore the version stamp and reprocess
every file. (Keyframe writes follow the same rule — a newer `keyframesVersion`
already on disk is never overwritten.)

Pass `--filter "<substring>"` to restrict the run to files whose relative path
contains that string (case-insensitive), e.g. `yarn parse E:/downloads/
--filter "megaman"`. It's applied after the work list is collected, so it
composes with the version/skip-completed logic.

## Testing without a GPU

`pyproject.toml` defaults to `onnxruntime` (CPU). Embedding + detection
will be slow (a few seconds per keyframe) but every code path works.
For real runs, install `onnxruntime-gpu` alongside CUDA + cuDNN matching
your driver, then reinstall.

The orchestrator + JSON shapes can be exercised without any inference
at all: see `process_one.py`'s `--stub-faces` flag, which emits a
synthetic single-character single-frame payload so you can verify the
bridge scripts write to the bulk DBs end-to-end.
