"""Run the face pipeline on one video, emit the result JSON
writeResult.ts expects.

Decodes keyframes via PyAV at FACES_MIN_INTERVAL_MS spacing, runs
detection + embedding via face_pipeline.FaceEngine, clusters with
OnlineClusterer (port of web/faceEmbed/clustering.ts), JPEG-encodes
the kept frames at the same 640-wide / quality 0.80 the browser uses,
and writes one JSON payload.

Usage (called by run.py — runs standalone for debugging too):

    uv run python -m process_one <video_path> <file_key> <out_json_path>
        [--stub-faces]
        [--max-frames N]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from face_pipeline import (
    EMBEDDING_DIM,
    FACES_FRAME_TARGET_W,
    MAX_FACES_PER_FRAME,
    DetectedFace,
    FaceEngine,
    StubFaceEngine,
)
from clustering import (
    SAME_CHARACTER_THRESHOLD,
    OnlineClusterer,
    medoid_of,
    l2_distance,
)

# Min gap between processed keyframes — matches FACES_MIN_INTERVAL_MS in
# web/MetadataExtractor.ts. Bumped to 3000 to avoid running detection on
# adjacent near-identical shots.
FACES_MIN_INTERVAL_MS = 3000

# JPEG quality for the in-memory detection-frame JPEGs (used to crop avatars
# and the file thumbnail). Same as FACES_FRAME_JPEG_QUALITY in the browser.
FACES_FRAME_JPEG_QUALITY = 80

# Per-character avatar: a square cropped-face JPEG stored on the CharacterRecord
# (CharacterRecord.avatarJpeg). Mirrors FACE_AVATAR_SIZE / quality in
# web/thumbnails.ts cropFaceAvatarJpeg.
FACE_AVATAR_SIZE = 128
FACE_AVATAR_JPEG_QUALITY = 80

# Per-character cap — same as MAX_CHARACTERS_PER_FILE in
# web/faceExtraction.ts.
MAX_CHARACTERS_PER_FILE = 30

# Only the top N characters (by member count) get a stored face image; the
# rest keep their embeddings but leave the avatar blank. Mirrors
# TOP_N_FACE_FRAMES in web/faceExtraction.ts.
TOP_N_FACE_FRAMES = 10

# Auto face-thumbnail config — mirrors the "auto" mode in web/faceExtraction.ts.
# The character is chosen by folder size: a folder with SERIES_FOLDER_THRESHOLD+
# videos is a series (the recurring protagonist is uninteresting, so use the
# 2nd character); a smaller folder is a standalone video (use the 1st). Faces
# are restricted to those past the first 30% of the runtime (skip the opening
# credits) and at least 128px wide in the 640-wide detection frame. Thumbs are
# encoded at the same three widths the browser uses, quality 0.85 (matches
# generateThumbsFromJpeg).
FACE_THUMB_MIN_W = 128
FACE_THUMB_MIN_TIME_FRACTION = 0.3
FACE_THUMB_WIDTHS = (160, 320, 640)
FACE_THUMB_JPEG_QUALITY = 85
SERIES_FOLDER_THRESHOLD = 5

# Keyframe-preview config — mirrors web/MetadataExtractor.ts (extractKeyframes).
# These are the scrub-strip thumbnails, NOT the face-detection frames: sparser
# sampling (one keyframe per interval, the keyframe at-or-before each sample
# point), a wider 600px target, and quality 85. Kept byte-for-byte in step with
# the browser so a file processed offline is indistinguishable from one the
# browser extracted — same KEYFRAMES_VERSION cache then covers both.
KEYFRAMES_TARGET_W = 600
KEYFRAMES_JPEG_QUALITY = 85
# Letterbox detection thresholds — match detectLetterboxRect in the browser:
# a pixel is "dark" if every channel is <= DARK_MAX_CHANNEL, and a row is a bar
# if fewer than NON_DARK_TOLERANCE of its pixels are non-dark.
KEYFRAMES_DARK_MAX_CHANNEL = 20
KEYFRAMES_NON_DARK_TOLERANCE = 0.02
KEYFRAMES_MIN_DIM_FOR_DETECTION = 64
# Reject a letterbox crop that would keep less than this fraction of the frame
# height — guards against a bad first frame (fade/title) producing a sliver crop.
KEYFRAMES_MIN_KEEP_FRACTION = 0.5

# How often to emit an intra-file progress line during the decode/detect loop.
# We don't know how many keyframes will survive the min-interval filter without
# decoding the file, so progress is a running count rather than a percentage.
PROGRESS_INTERVAL_SEC = 5.0

# Phase 1 (gather) decodes keyframes with this many parallel workers, ported
# from ../facegrabs. Each opens its own PyAV container over a contiguous slice
# of the video, so demux + decode runs across all cores. This is the gather
# phase only — detection runs afterwards, as its own phase, over the full set.
FACES_DECODE_WORKERS = 8
# Caps the decode workers' lookahead so a fast decoder doesn't queue more than
# this many keyframes ahead of the gather draining them.
FACES_QUEUE_MAXSIZE = 64

# Phase 2 (faces) processes the gathered keyframes in chunks this size: each
# chunk's faces are embedded together (recognition batches; see
# RECOGNITION_BATCH_SIZE), and it sets the progress-log cadence.
FACES_DETECT_CHUNK = 64

# Per-video wall-clock cap on the keyframe gather (phase 1). Headless decode is
# far faster than this on a healthy file, so exceeding it means a bad/corrupt
# video — we abort + mark it with an error (via run.py) so it isn't retried. The
# browser uses a 30s extraction timeout; offline we allow 60s.
FACES_GATHER_TIMEOUT_SEC = 60.0
# On timeout (or any teardown) we wait at most this long for the decode workers
# to notice the stop signal and exit. A worker stuck inside a C-level ffmpeg
# decode can't be interrupted from Python, so we stop waiting and let it leak as
# a daemon thread (it dies with the process) rather than wedge the whole run.
WORKER_CLEANUP_TIMEOUT_SEC = 5.0


# Sentinel + error marker passed through the decode queue. A worker puts the
# error marker (then a sentinel) if it dies, so the consumer re-raises on the
# main thread instead of hanging or silently dropping a slice.
_DECODE_DONE = object()
_DECODE_ERROR = "__decode_error__"


def _probe_total_frames(video_path: Path, max_frames: Optional[int]) -> Tuple[int, float, float]:
    """Return (total_frames, avg_rate, time_base). MKV/some MP4 don't carry a
    frame count, so fall back to duration × fps — overshoot is harmless since
    each worker caps on the real decoded index."""
    import av

    container = av.open(str(video_path))
    try:
        stream = container.streams.video[0]
        avg_rate = float(stream.average_rate) if stream.average_rate else 0.0
        time_base = float(stream.time_base) if stream.time_base else 0.0
        total = stream.frames
        if not total or total <= 0:
            duration_s = 0.0
            if stream.duration and time_base > 0:
                duration_s = float(stream.duration) * time_base
            elif container.duration:
                duration_s = float(container.duration) / 1_000_000.0
            if duration_s > 0 and avg_rate > 0:
                total = int(duration_s * avg_rate)
    finally:
        container.close()
    if max_frames is not None:
        total = min(total, max_frames) if total else max_frames
    if not total:
        raise RuntimeError(f"Could not determine total frames for {video_path}")
    if avg_rate <= 0 or time_base <= 0:
        raise RuntimeError(f"Expected positive avg_rate and time_base for {video_path}, got avg_rate={avg_rate} time_base={time_base}")
    return total, avg_rate, time_base


def _decode_worker(
    video_path: Path,
    start_idx: int,
    end_idx: int,
    avg_rate: float,
    time_base: float,
    min_interval_ms: int,
    thread_count: int,
    stop_event: "threading.Event",
    q: "queue.Queue",
) -> None:
    """Decode keyframes in frame-index range [start_idx, end_idx), emitting the
    ones ≥min_interval_ms apart as (time_ms, bgr_letterboxed_640w). Seeks to the
    slice so PyAV doesn't decode the gap before it. Bails out once stop_event is
    set (the consumer is tearing the pipeline down)."""
    import av

    try:
        container = av.open(str(video_path))
        try:
            stream = container.streams.video[0]
            # AUTO beat FRAME for HEVC in facegrabs' decode bench; fine for H.264 too.
            stream.thread_type = "AUTO"
            stream.codec_context.thread_count = thread_count
            stream.codec_context.skip_frame = "NONKEY"
            if start_idx > 0:
                container.seek(int(start_idx / avg_rate / time_base), stream=stream, backward=True)

            last_ms = -min_interval_ms
            for frame in container.decode(stream):
                if stop_event.is_set():
                    break
                if frame.pts is None:
                    continue
                idx = int(round(frame.pts * time_base * avg_rate))
                if idx >= end_idx:
                    break
                if idx < start_idx:
                    continue
                time_ms = int(round((frame.time or 0.0) * 1000))
                if time_ms - last_ms < min_interval_ms:
                    continue
                last_ms = time_ms
                bgr = frame.to_ndarray(format="bgr24")
                scaled = _scale_to_width(_letterbox_strip(bgr), FACES_FRAME_TARGET_W)
                q.put((time_ms, scaled))
        finally:
            container.close()
    except Exception:
        q.put((_DECODE_ERROR, traceback.format_exc()))
    finally:
        q.put(_DECODE_DONE)


def _iter_keyframes_parallel(
    video_path: Path,
    min_interval_ms: int = FACES_MIN_INTERVAL_MS,
    max_frames: Optional[int] = None,
    timeout_sec: Optional[float] = None,
    cpu_budget: Optional[int] = None,
):
    """Yield (time_ms, bgr_letterboxed_640w) for keyframes ≥min_interval_ms
    apart, decoded by up to FACES_DECODE_WORKERS threads in parallel. Yields in
    arbitrary time order — the caller re-sorts faces by (timeMs, faceIdx).

    `timeout_sec` caps the whole gather: exceeding it raises TimeoutError (run.py
    records it as a per-file error so the bad video isn't retried). `cpu_budget`
    is the number of decode threads this video may use in total (so several
    videos running in parallel can share the cores instead of each grabbing all);
    defaults to all cores.

    Tears its workers down on ANY exit — normal completion, decode error, timeout,
    or the consumer abandoning us mid-iteration — so no decode thread leaks into
    the long-lived run.py process (process_one runs in-process there)."""
    deadline = (time.monotonic() + timeout_sec) if timeout_sec else None
    budget = cpu_budget if cpu_budget else (os.cpu_count() or 8)
    total, avg_rate, time_base = _probe_total_frames(video_path, max_frames)
    num_workers = max(1, min(FACES_DECODE_WORKERS, total, budget))
    thread_count = max(1, budget // num_workers)
    chunk = max(1, total // num_workers)
    q: "queue.Queue" = queue.Queue(maxsize=FACES_QUEUE_MAXSIZE)
    stop_event = threading.Event()

    workers: List[threading.Thread] = []
    for i in range(num_workers):
        start_idx = i * chunk
        end_idx = (i + 1) * chunk if i < num_workers - 1 else total
        if start_idx >= end_idx:
            continue
        t = threading.Thread(
            target=_decode_worker,
            args=(video_path, start_idx, end_idx, avg_rate, time_base, min_interval_ms, thread_count, stop_event, q),
            daemon=True,
        )
        t.start()
        workers.append(t)

    started = len(workers)
    done = 0
    error: Optional[str] = None
    timed_out = False
    try:
        while done < started:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    item = q.get(timeout=min(remaining, 0.5))
                except queue.Empty:
                    continue
            else:
                item = q.get()
            if item is _DECODE_DONE:
                done += 1
                continue
            if item[0] == _DECODE_ERROR:
                # Stop the other workers promptly, but keep draining below so
                # each still reaches its sentinel before we raise.
                error = item[1]
                stop_event.set()
                continue
            if error is None:
                yield item
    finally:
        # Tell workers to stop and reclaim them, but BOUNDED — a worker stuck in a
        # C-level decode can't be interrupted, so we don't wait on it forever.
        stop_event.set()
        cleanup_deadline = time.monotonic() + WORKER_CLEANUP_TIMEOUT_SEC
        while done < started and time.monotonic() < cleanup_deadline:
            try:
                if q.get(timeout=0.2) is _DECODE_DONE:
                    done += 1
            except queue.Empty:
                pass
        for t in workers:
            t.join(timeout=0.1)
    if error is not None:
        raise RuntimeError(f"keyframe decode failed for {video_path}:\n{error}")
    if timed_out:
        raise TimeoutError(
            f"keyframe gather exceeded {timeout_sec:.0f}s for {video_path.name} — "
            f"skipping as a likely bad/corrupt video"
        )


def _letterbox_strip(bgr: np.ndarray) -> np.ndarray:
    """Detect uniform black bars at top and bottom and crop them out.
    Tolerates compression noise (uses a low brightness threshold). We
    leave horizontal pillarbox alone — most movie sources don't have
    them, and detecting both axes costs an extra full-frame scan."""
    h, w = bgr.shape[:2]
    if h == 0 or w == 0:
        return bgr
    luma = bgr.astype(np.int16).sum(axis=2)  # cheap brightness proxy
    row_max = luma.max(axis=1)
    threshold = 30 * 3  # roughly RGB(30,30,30)
    top = 0
    while top < h and int(row_max[top]) < threshold:
        top += 1
    bottom = h
    while bottom > top and int(row_max[bottom - 1]) < threshold:
        bottom -= 1
    if top == 0 and bottom == h:
        return bgr
    # Sanity: don't crop away more than 40% of the height — letterbox
    # detection has gone wrong if it claims a tiny letterbox.
    if (bottom - top) < int(h * 0.6):
        return bgr
    return bgr[top:bottom, :, :]


def _scale_to_width(bgr: np.ndarray, target_w: int) -> np.ndarray:
    """Aspect-preserving scale to target_w using cv2.INTER_AREA (high-
    quality downscale). Matches the browser's `imageSmoothingQuality:
    "high"` setting in iterateFacesFrames."""
    import cv2
    h, w = bgr.shape[:2]
    if w == 0 or h == 0:
        return bgr
    if w <= target_w:
        return bgr
    new_h = max(1, int(round(target_w * h / w)))
    return cv2.resize(bgr, (target_w, new_h), interpolation=cv2.INTER_AREA)


def _encode_jpeg(bgr: np.ndarray, quality: int = FACES_FRAME_JPEG_QUALITY) -> bytes:
    import cv2
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("cv2.imencode JPEG failed")
    return bytes(buf)


def _f32_to_b64(arr: np.ndarray) -> str:
    a = np.ascontiguousarray(arr.astype(np.float32, copy=False))
    if a.shape != (EMBEDDING_DIM,):
        raise RuntimeError(f"Expected shape ({EMBEDDING_DIM},), got {a.shape}")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _f32arr_to_b64(arr: np.ndarray) -> str:
    a = np.ascontiguousarray(np.asarray(arr, dtype=np.float32).ravel())
    return base64.b64encode(a.tobytes()).decode("ascii")


def _bytes_to_b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _decode_jpeg_b64(b64: str) -> Optional[np.ndarray]:
    import cv2
    data = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    return img if img is not None else None


def _generate_thumbs_from_bgr(bgr: np.ndarray) -> dict:
    """Downscale a frame to the three thumbnail widths (160/320/640) and
    JPEG-encode each — the same shape generateThumbsFromJpeg produces in
    the browser. thumbW/thumbH are the source frame's full dimensions."""
    import cv2
    h, w = bgr.shape[:2]
    out: dict = {"thumbW": int(w), "thumbH": int(h)}
    for tw in FACE_THUMB_WIDTHS:
        th = max(1, int(round(tw * h / w))) if w > 0 else 1
        resized = cv2.resize(bgr, (tw, th), interpolation=cv2.INTER_AREA)
        out[f"thumb{tw}_b64"] = _bytes_to_b64(_encode_jpeg(resized, FACE_THUMB_JPEG_QUALITY))
    return out


def _crop_face_avatar(bgr: np.ndarray, x1, y1, x2, y2) -> Optional[bytes]:
    """Crop a square region centred on the face bbox and re-encode at
    FACE_AVATAR_SIZE — mirrors cropFaceAvatarJpeg in web/thumbnails.ts. The
    bbox is in the frame's own pixel space (the 640-wide detection frame)."""
    import cv2
    h_img, w_img = bgr.shape[:2]
    w = x2 - x1
    h = y2 - y1
    side = min(max(w, h, 1), w_img, h_img)
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    side_i = int(round(side))
    if side_i < 1:
        return None
    sx = int(round(min(max(cx - side / 2.0, 0), w_img - side)))
    sy = int(round(min(max(cy - side / 2.0, 0), h_img - side)))
    crop = bgr[sy:sy + side_i, sx:sx + side_i]
    if crop.size == 0:
        return None
    dim = min(FACE_AVATAR_SIZE, side_i)
    resized = cv2.resize(crop, (dim, dim), interpolation=cv2.INTER_AREA)
    return _encode_jpeg(resized, FACE_AVATAR_JPEG_QUALITY)


def _select_face_thumbnail(clusters, all_frames, duration_sec, folder_video_count):
    """Pick a thumbnail using the folder-aware "auto" rule: series folders
    (folder_video_count >= SERIES_FOLDER_THRESHOLD) use the 2nd most-common
    character, standalone folders use the 1st (clusters are pre-sorted by
    member count descending). Among that character's faces past the first 30%
    of the runtime and ≥128px wide, choose the most representative (closest to
    the character centroid), then downscale its frame. Returns the thumbnail
    payload dict, or None when nothing qualifies."""
    if not clusters:
        return None
    use_second = (folder_video_count or 1) >= SERIES_FOLDER_THRESHOLD
    if use_second and len(clusters) > 1:
        top = clusters[1]
    else:
        top = clusters[0]
    members = top.members
    if not members:
        return None
    if duration_sec and duration_sec > 0:
        end_ms = duration_sec * 1000.0
    else:
        end_ms = max((m["timeMs"] for m in members), default=0)
    min_time_ms = end_ms * FACE_THUMB_MIN_TIME_FRACTION
    eligible = [
        m for m in members
        if m["timeMs"] >= min_time_ms and (m["bboxX2"] - m["bboxX1"]) >= FACE_THUMB_MIN_W
    ]
    if not eligible:
        return None
    centroid = top.centroid()
    best = min(eligible, key=lambda m: l2_distance(m["_embedding"], centroid))
    frame = all_frames.get(best["timeMs"])
    if frame is None:
        return None
    bgr = _decode_jpeg_b64(frame["jpeg_b64"])
    if bgr is None:
        return None
    return _generate_thumbs_from_bgr(bgr)


def _per_sec(count: int, secs: float) -> float:
    return count / secs if secs > 0 else 0.0


def keyframe_interval_for_duration(duration_sec: float) -> int:
    """Sampling interval by movie length — matches keyframeIntervalForDuration
    in web/MetadataExtractor.ts. Short videos get a denser strip."""
    if duration_sec < 15 * 60:
        return 15
    if duration_sec < 30 * 60:
        return 30
    return 60


def _detect_keyframe_crop(bgr: np.ndarray) -> Optional[Tuple[int, int]]:
    """Top/bottom black-bar detection matching detectLetterboxRect in the
    browser (per-channel <= 20, 2% non-dark tolerance). Returns (top, bottom)
    row bounds to crop to, or None to keep the full frame."""
    h, w = bgr.shape[:2]
    if w < KEYFRAMES_MIN_DIM_FOR_DETECTION or h < KEYFRAMES_MIN_DIM_FOR_DETECTION:
        return None
    dark = np.all(bgr <= KEYFRAMES_DARK_MAX_CHANNEL, axis=2)
    row_is_bar = ((~dark).sum(axis=1) / w) < KEYFRAMES_NON_DARK_TOLERANCE
    top = 0
    while top < h and bool(row_is_bar[top]):
        top += 1
    bottom = h
    while bottom > top and bool(row_is_bar[bottom - 1]):
        bottom -= 1
    if top == 0 and bottom == h:
        return None
    # Reject pathological crops. The shared crop is locked from the first
    # sampled frame, which is often a fade-in / title card / mostly-black frame
    # whose only bright rows are a thin band — that produced a ~600x18 strip
    # applied to the whole video. A real letterbox keeps well over half the
    # height (2.39:1 in 16:9 keeps ~75%), so if we'd keep less than half, treat
    # the detection as bad and keep the full frame.
    if bottom - top < h * KEYFRAMES_MIN_KEEP_FRACTION:
        return None
    return (top, bottom)


def _apply_keyframe_crop(bgr: np.ndarray, crop: Optional[Tuple[int, int]]) -> np.ndarray:
    if crop is None:
        return bgr
    top, bottom = crop
    return bgr[top:bottom, :, :]


def _decode_keyframe_at(container, stream, t_sec: float, time_base: float) -> Optional["object"]:
    """Seek to the keyframe at-or-before t_sec and return the first decoded
    frame (a keyframe, since skip_frame is NONKEY) — the same frame the
    browser's packetSink.getKeyPacket(t) would land on."""
    if t_sec > 0 and time_base > 0:
        container.seek(int(t_sec / time_base), stream=stream, backward=True)
    else:
        container.seek(0, stream=stream, backward=True)
    for frame in container.decode(stream):
        return frame
    return None


def _kf_decode_chunk(
    video_path: Path,
    sample_times: List[float],
    time_base: float,
    out: List[Tuple[object, float, bytes]],
) -> None:
    """One worker's slice of the preview sampling: for each sample point, decode
    the keyframe at-or-before it, letterbox-crop that frame independently,
    downscale to 600w, and JPEG-encode at q85. Appends (dedup_key, time_sec,
    jpeg_bytes) — the dedup key folds together keyframes shared by adjacent
    sample points. Cropping is per-frame so a video that legitimately changes
    aspect ratio is cropped correctly at every point."""
    import av

    container = av.open(str(video_path))
    try:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        stream.codec_context.skip_frame = "NONKEY"
        for t in sample_times:
            frame = _decode_keyframe_at(container, stream, t, time_base)
            if frame is None:
                continue
            time_sec = float(frame.time or 0.0)
            # Dedup key for keyframes shared by adjacent sample points. pts is
            # ideal but some containers/codecs return None for seeked keyframes;
            # fall back to the decoded time, then the sample point — never drop
            # the frame just because pts is missing (that produced empty strips).
            dedup_key = frame.pts
            if dedup_key is None:
                dedup_key = round(frame.time, 3) if frame.time is not None else t
            bgr = frame.to_ndarray(format="bgr24")
            cropped = _apply_keyframe_crop(bgr, _detect_keyframe_crop(bgr))
            scaled = _scale_to_width(cropped, KEYFRAMES_TARGET_W)
            out.append((dedup_key, time_sec, _encode_jpeg(scaled, KEYFRAMES_JPEG_QUALITY)))
    finally:
        container.close()


def _extract_preview_keyframes(
    video_path: Path,
    duration_sec: Optional[float],
    cpu_budget: Optional[int],
    timeout_sec: float,
) -> Optional[dict]:
    """Decode the keyframe-preview strip exactly as web/MetadataExtractor.ts'
    extractKeyframes does: sample one keyframe per interval (15/30/60s by
    duration), pick the keyframe at-or-before each sample point, letterbox-crop
    each frame independently, downscale to 600w, JPEG q85.

    JPEG encoding (and decode) run across up to FACES_DECODE_WORKERS threads —
    cv2.imencode and PyAV both release the GIL, so this is real parallelism.

    Returns {intervalSec, keyframesExtractionMs, frames:[{timeSec, jpeg_b64}]}
    sorted by time, or None when nothing decoded. Best-effort: the caller treats
    None / a raised error as 'no preview this pass'."""
    import av

    t0 = time.monotonic()
    container = av.open(str(video_path))
    try:
        stream = container.streams.video[0]
        time_base = float(stream.time_base) if stream.time_base else 0.0
        dur = duration_sec
        if not dur or dur <= 0:
            if stream.duration and time_base > 0:
                dur = float(stream.duration) * time_base
            elif container.duration:
                dur = float(container.duration) / 1_000_000.0
    finally:
        container.close()
    if not dur or dur <= 0:
        raise RuntimeError("could not determine duration for keyframe preview")
    if time_base <= 0:
        raise RuntimeError("missing video time_base for keyframe preview")

    interval = keyframe_interval_for_duration(dur)
    n = int(dur // interval) + 1
    sample_times = [i * interval for i in range(n) if i * interval < dur]
    if not sample_times:
        sample_times = [0.0]

    budget = cpu_budget if cpu_budget else (os.cpu_count() or 8)
    num_workers = max(1, min(FACES_DECODE_WORKERS, len(sample_times), budget))
    per = (len(sample_times) + num_workers - 1) // num_workers
    results: List[List[Tuple[object, float, bytes]]] = [[] for _ in range(num_workers)]
    workers: List[threading.Thread] = []
    for wi in range(num_workers):
        chunk = sample_times[wi * per:(wi + 1) * per]
        if not chunk:
            continue
        t = threading.Thread(
            target=_kf_decode_chunk,
            args=(video_path, chunk, time_base, results[wi]),
            daemon=True,
        )
        t.start()
        workers.append(t)
    deadline = time.monotonic() + timeout_sec
    for t in workers:
        t.join(timeout=max(0.0, deadline - time.monotonic()))

    merged = [item for r in results for item in r]
    merged.sort(key=lambda x: x[1])  # by time_sec, ascending — matches browser order
    seen: set = set()
    frames_out: List[dict] = []
    for dedup_key, time_sec, jpeg in merged:
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        frames_out.append({"timeSec": time_sec, "jpeg_b64": _bytes_to_b64(jpeg)})
    if not frames_out:
        return None
    return {
        "intervalSec": interval,
        "keyframesExtractionMs": int((time.monotonic() - t0) * 1000),
        "frames": frames_out,
    }


def process_one(
    video_path: Path,
    file_key: str,
    out_json_path: Path,
    engine,
    max_frames: Optional[int] = None,
    parallel: int = 1,
    duration_sec: Optional[float] = None,
    folder_video_count: Optional[int] = None,
) -> Dict:
    """Gather keyframes → detect+embed → cluster → JSON. Returns the payload.

    `parallel` is how many videos run() is processing concurrently. We give each
    video a 1/parallel slice of the cores for its decode, and scale the gather
    timeout by `parallel` (a video with 1/N the CPU takes ~N× longer, so the
    bad-video threshold has to stretch too)."""
    t0 = time.monotonic()
    name = video_path.name
    parallel = max(1, parallel)
    cpu_budget = max(2, (os.cpu_count() or 8) // parallel)
    gather_timeout = FACES_GATHER_TIMEOUT_SEC * parallel

    # ── Phase 1: gather every keyframe up front (parallel decode). ──
    # We decode the whole file first so the GPU-bound face work runs as its own
    # phase over a complete set, never interleaved with decoding.
    print(f"[face] {name}: gathering keyframes…", flush=True)
    frames = list(_iter_keyframes_parallel(
        video_path, max_frames=max_frames, timeout_sec=gather_timeout, cpu_budget=cpu_budget))
    gather_secs = time.monotonic() - t0
    print(
        f"[face] {name}: gathered {len(frames)} keyframes in {gather_secs:.1f}s "
        f"({_per_sec(len(frames), gather_secs):.1f} kf/s); detecting faces…",
        flush=True,
    )

    # ── Phase 2: detect + embed, in chunks so recognition runs as a batch. ──
    detect_t0 = time.monotonic()
    all_faces: List[dict] = []
    all_frames: Dict[int, dict] = {}  # time_ms -> frame payload
    last_progress = time.monotonic()
    for start in range(0, len(frames), FACES_DETECT_CHUNK):
        chunk = frames[start:start + FACES_DETECT_CHUNK]
        results = engine.detect_and_embed_batch([bgr for _, bgr in chunk])
        for (time_ms, bgr), detected in zip(chunk, results):
            if not detected:
                continue
            # Save the frame JPEG once (faces from the same frame share it).
            if time_ms not in all_frames:
                jpeg = _encode_jpeg(bgr)
                h, w = bgr.shape[:2]
                all_frames[time_ms] = {
                    "timeMs": time_ms,
                    "width": w,
                    "height": h,
                    "jpeg_b64": _bytes_to_b64(jpeg),
                }
            for idx, face in enumerate(detected):
                # bbox + embedding are in-memory only (used for avatar crop,
                # thumbnail eligibility, clustering). Detection score is never
                # persisted. The per-character embeddings/frameTimes payload is
                # built from these after clustering.
                all_faces.append({
                    "timeMs": time_ms,
                    "faceIdx": idx,
                    "bboxX1": face.bbox[0], "bboxY1": face.bbox[1],
                    "bboxX2": face.bbox[2], "bboxY2": face.bbox[3],
                    "_embedding": face.embedding,
                })
        now = time.monotonic()
        if now - last_progress >= PROGRESS_INTERVAL_SEC:
            done = min(start + FACES_DETECT_CHUNK, len(frames))
            print(
                f"[face] {name}: detected {done}/{len(frames)} keyframes, "
                f"{len(all_faces)} faces ({now - t0:.0f}s)",
                flush=True,
            )
            last_progress = now

    # The gathered frames are no longer needed once detection has run — release
    # them before clustering rather than holding the whole file's keyframes.
    keyframe_count = len(frames)
    del frames

    detect_secs = time.monotonic() - detect_t0
    print(
        f"[face] {name}: detection done — {keyframe_count} keyframes in {detect_secs:.1f}s "
        f"({_per_sec(keyframe_count, detect_secs):.1f} kf/s), {len(all_faces)} faces",
        flush=True,
    )

    # Keyframe-preview strip — independent of faces (a video with zero detected
    # faces still gets one). Best-effort: a failure here must not sink the faces
    # result, so we log + carry on. The same gather timeout the faces phase uses
    # caps it (it's sparse, so it almost never approaches that).
    keyframe_payload = None
    keyframe_error = ""
    try:
        print(f"[kf] {name}: extracting preview keyframes…", flush=True)
        keyframe_payload = _extract_preview_keyframes(video_path, duration_sec, cpu_budget, gather_timeout)
        if keyframe_payload:
            print(
                f"[kf] {name}: {len(keyframe_payload['frames'])} preview keyframes "
                f"(interval {keyframe_payload['intervalSec']}s) in "
                f"{keyframe_payload['keyframesExtractionMs']}ms",
                flush=True,
            )
        else:
            keyframe_error = "no preview keyframes produced"
            print(f"[kf] {name}: {keyframe_error}", flush=True)
    except Exception as e:  # noqa: BLE001 — keyframes are a bonus, never fatal
        keyframe_error = f"preview keyframe extraction failed: {e}"
        print(f"[kf] {name}: {keyframe_error}", file=sys.stderr)

    payload = {
        "fileKey": file_key,
        "durationMs": 0,  # filled in by caller if known
        "characters": [],
        "keyframes": keyframe_payload,
        "keyframesError": keyframe_error,
        "stats": {
            "faceCount": 0,
            "characterCount": 0,
            "facesExtractionMs": 0,
        },
    }

    if not all_faces:
        payload["stats"]["facesExtractionMs"] = int((time.monotonic() - t0) * 1000)
        out_json_path.write_text(json.dumps(payload), encoding="utf-8")
        return payload

    print(f"[face] {name}: clustering {len(all_faces)} faces…", flush=True)

    # Cluster into characters (medoid-prune at L2 1.1, top 30 by count).
    clusterer: OnlineClusterer[dict] = OnlineClusterer(
        SAME_CHARACTER_THRESHOLD,
        get_embedding=lambda f: f["_embedding"],
    )
    # Sort by (timeMs, faceIdx) so feed-order is deterministic — same
    # ordering the browser uses, so cluster contents line up.
    all_faces.sort(key=lambda f: (f["timeMs"], f["faceIdx"]))
    for face in all_faces:
        clusterer.add(face)
    clusterer.prune()

    # Keep top N by member count.
    clusters = sorted(clusterer.clusters, key=lambda c: len(c.members), reverse=True)[:MAX_CHARACTERS_PER_FILE]
    chars_out = []
    face_total = 0
    for char_idx, c in enumerate(clusters):
        # Re-compute the centroid (normalised) for storage.
        centroid = c.centroid()
        # Best face = real member closest to the centroid.
        best = medoid_of(c.members, get_embedding=lambda f: f["_embedding"])
        # Crop the avatar from the best face's frame (best-effort), only for the
        # top N characters; the rest keep embeddings but store a blank avatar.
        avatar_b64 = None
        best_frame = all_frames.get(best["timeMs"]) if char_idx < TOP_N_FACE_FRAMES else None
        if best_frame is not None:
            frame_bgr = _decode_jpeg_b64(best_frame["jpeg_b64"])
            if frame_bgr is not None:
                avatar = _crop_face_avatar(
                    frame_bgr, best["bboxX1"], best["bboxY1"], best["bboxX2"], best["bboxY2"])
                if avatar is not None:
                    avatar_b64 = _bytes_to_b64(avatar)
        # Concatenate every member embedding + a parallel frame-time array —
        # the heavy per-frame data the browser stores in the faceFrames record.
        member_embeddings = np.concatenate(
            [np.asarray(m["_embedding"], dtype=np.float32).ravel() for m in c.members])
        frame_times = np.asarray([float(m["timeMs"]) for m in c.members], dtype=np.float32)
        chars_out.append({
            "characterIdx": char_idx,
            "memberCount": len(c.members),
            "bestFaceTimeMs": int(best["timeMs"]),
            "centroid_b64": _f32_to_b64(centroid),
            "bestFaceEmbedding_b64": _f32_to_b64(best["_embedding"]),
            "embeddings_b64": _f32arr_to_b64(member_embeddings),
            "frameTimes_b64": _f32arr_to_b64(frame_times),
            "avatarJpeg_b64": avatar_b64,
        })
        face_total += len(c.members)

    # Auto thumbnail from the second most-common character (see
    # _select_face_thumbnail). Done before serialise so the cluster members
    # still carry their in-memory "_embedding".
    thumbnail = _select_face_thumbnail(clusters, all_frames, duration_sec, folder_video_count)
    if thumbnail is not None:
        payload["thumbnail"] = thumbnail

    payload["characters"] = chars_out
    payload["stats"]["faceCount"] = face_total
    payload["stats"]["characterCount"] = len(chars_out)
    payload["stats"]["facesExtractionMs"] = int((time.monotonic() - t0) * 1000)
    out_json_path.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    p = argparse.ArgumentParser()
    p.add_argument("video_path", type=Path)
    p.add_argument("file_key")
    p.add_argument("out_json_path", type=Path)
    p.add_argument("--stub-faces", action="store_true",
                   help="Skip ONNX entirely; emit a synthetic face per frame for bridge testing.")
    p.add_argument("--max-frames", type=int, default=None)
    args = p.parse_args()

    engine = StubFaceEngine() if args.stub_faces else FaceEngine()
    process_one(args.video_path, args.file_key, args.out_json_path, engine, args.max_frames)
    return 0


if __name__ == "__main__":
    sys.exit(main())
