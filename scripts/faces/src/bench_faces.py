"""Benchmark + profile the face pipeline on a single video.

Runs each stage as its own phase over ALL gathered keyframes and times it, so we
can see exactly where the time goes:

    1. gather       decode keyframes from the file (parallel)
    2. preprocess   resize + pad into a uint8 canvas (CPU; normalize is now on GPU)
    3. inference    fused preprocess+SCRFD on the GPU (one image at a time)
    4. postprocess  anchor-decode + threshold + NMS (CPU, numpy)
    5. align        norm_crop each face to 112x112 (CPU)
    6. embed        ArcFace recognition, batched (GPU)

Uses the same fused detector the real pipeline uses, so the breakdown reflects
production. Also reports the ONNX providers actually in use.

Usage:
    yarn bench-faces "<video path>"
"""
from __future__ import annotations

import sys
import time
import warnings
from pathlib import Path

import cv2
import numpy as np

from face_pipeline import (
    FaceEngine, MAX_FACES_PER_FRAME, RECOGNITION_BATCH_SIZE,
    _scrfd_resize_pad, _scrfd_decode, _estimate_norm_batch,
)
from process_one import _iter_keyframes_parallel

# norm_crop emits a FutureWarning per face; it drowns the report.
warnings.filterwarnings("ignore", category=FutureWarning)


def _rate(count: int, secs: float) -> float:
    return count / secs if secs > 0 else 0.0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    if len(sys.argv) < 2:
        print("usage: bench_faces.py <video_path>", file=sys.stderr)
        return 2
    video_path = Path(sys.argv[1])
    if not video_path.is_file():
        print(f"[bench] not a file: {video_path}", file=sys.stderr)
        return 2

    engine = FaceEngine()
    engine.ensure_loaded()
    det, rec = engine._det, engine._rec
    from insightface.utils import face_align
    print(f"[bench] providers: {det.session.get_providers()}  fused detector: {engine._det_fused is not None}")
    if engine._det_fused is None:
        print("[bench] fused detector unavailable — aborting (this bench measures the fused path)", file=sys.stderr)
        return 1
    size = engine._det_size
    out_names = det.output_names

    # 1. gather (decode keyframes)
    t = time.monotonic()
    frames = [bgr for _, bgr in _iter_keyframes_parallel(video_path)]
    g = time.monotonic() - t
    n = len(frames)
    print(f"[bench] 1. gather       {n} kf in {g:6.2f}s  ({_rate(n, g):7.1f} kf/s)")
    if n == 0:
        print("[bench] no keyframes — nothing to measure", file=sys.stderr)
        return 1

    # 2. preprocess (resize + pad into a uint8 canvas; normalize is in the model)
    t = time.monotonic()
    canvases, scales = [], []
    for f in frames:
        c, s = _scrfd_resize_pad(f, size)
        canvases.append(c)
        scales.append(s)
    p = time.monotonic() - t
    print(f"[bench] 2. preprocess   {n} kf in {p:6.2f}s  ({_rate(n, p):7.1f} kf/s)")

    # Warm up before timing the GPU (first run pays CUDA init + cuDNN autotune).
    engine._det_fused.run(out_names, {"pp_image": canvases[0]})

    # 3. inference (fused preprocess + SCRFD on the GPU)
    t = time.monotonic()
    net_outs_all = [engine._det_fused.run(out_names, {"pp_image": c}) for c in canvases]
    inf = time.monotonic() - t
    print(f"[bench] 3. inference    {n} kf in {inf:6.2f}s  ({_rate(n, inf):7.1f} kf/s)")

    # 4. postprocess (anchor decode + NMS)
    t = time.monotonic()
    kept = []  # (frame index, kps)
    for i, (no, sc) in enumerate(zip(net_outs_all, scales)):
        d, kpss = _scrfd_decode(det, no, sc)
        if kpss is None or len(d) == 0:
            continue
        for j in np.argsort(d[:, 4])[::-1][:MAX_FACES_PER_FRAME]:
            kept.append((i, kpss[j]))
    pp = time.monotonic() - t
    print(f"[bench] 4. postprocess  {n} kf in {pp:6.2f}s  ({_rate(n, pp):7.1f} kf/s); {len(kept)} faces")

    # 5. align — batched Umeyama estimate (replaces per-face skimage) + cv2 warp
    crop_size = rec.input_size[0]
    kps_arr = np.asarray([k for _, k in kept], dtype=np.float32)
    if len(kept):
        ref = np.stack([face_align.estimate_norm(k, crop_size) for _, k in kept])
        got = _estimate_norm_batch(kps_arr, crop_size)
        print(f"[bench]    est batched vs skimage: max abs diff {float(np.abs(ref - got).max()):.2e}")
    t = time.monotonic()
    mats = _estimate_norm_batch(kps_arr, crop_size)
    est_s = time.monotonic() - t
    t = time.monotonic()
    crops = [cv2.warpAffine(frames[i], mats[idx], (crop_size, crop_size), borderValue=0.0)
             for idx, (i, _) in enumerate(kept)]
    warp_s = time.monotonic() - t
    al = est_s + warp_s
    print(f"[bench] 5a.align-est    {len(kept)} faces in {est_s:6.2f}s  ({_rate(len(kept), est_s):7.0f} faces/s)")
    print(f"[bench] 5b.align-warp   {len(crops)} faces in {warp_s:6.2f}s  ({_rate(len(crops), warp_s):7.0f} faces/s)")

    # 6. embed (ArcFace recognition, batched)
    t = time.monotonic()
    embedded = 0
    for s in range(0, len(crops), RECOGNITION_BATCH_SIZE):
        embedded += rec.get_feat(crops[s:s + RECOGNITION_BATCH_SIZE]).shape[0]
    em = time.monotonic() - t
    print(f"[bench] 6. embed        {embedded} faces in {em:6.2f}s  ({_rate(embedded, em):7.0f} faces/s)")

    face_s = p + inf + pp + al + em
    print(f"[bench] face-parse (preprocess..embed): {face_s:6.2f}s for {n} kf ({_rate(n, face_s):7.1f} kf/s)")
    print(f"[bench] total incl. gather:             {g + face_s:6.2f}s for {n} kf ({_rate(n, g + face_s):7.1f} kf/s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
