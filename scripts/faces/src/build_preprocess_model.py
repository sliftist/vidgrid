"""Build + validate the derived face models: the fused preprocess+detection
model (det_10g_pre.onnx) and the FP16 variants of the detector and recognition
models. Checks the fused model is bit-identical to stock, the FP16 detector is
close, and FP16 recognition embeddings stay ~1.0 cosine to FP32 — then benchmarks.

Usage: yarn build-face-model
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

from face_pipeline import (
    FaceEngine, build_fused_detector, build_fused_detector_fp16, build_fp16_model, _model_cache,
)


def _cos(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-12)
    b = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-12)
    return (a * b).sum(axis=1)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    import cv2
    import onnxruntime as ort

    # fp16=False so we get the stock FP32 rec session + FP32 fused detector to
    # compare against.
    engine = FaceEngine(fp16=False)
    engine.ensure_loaded()
    det, rec = engine._det, engine._rec
    providers = det.session.get_providers()
    size = det.input_size[0]
    det_path = Path(det.model_file)
    rec_path = Path(rec.model_file)

    # ── Fused FP32 detector vs stock blobFromImage (must be bit-identical) ──
    fused_path = build_fused_detector(det_path, size)
    fused = ort.InferenceSession(str(fused_path), providers=providers)
    rng = np.random.default_rng(0)
    img = rng.integers(0, 256, (size, size, 3), dtype=np.uint8)
    blob = cv2.dnn.blobFromImage(img, 1.0 / det.input_std, (size, size),
                                 (det.input_mean, det.input_mean, det.input_mean), swapRB=True)
    stock_out = det.session.run(det.output_names, {det.input_name: blob})
    fused_out = fused.run(det.output_names, {"pp_image": img})
    diff = max(float(np.abs(a - b).max()) for a, b in zip(stock_out, fused_out))
    print(f"[build] fused FP32 vs stock: max abs diff {diff:.2e} ({'OK' if diff < 1e-3 else 'MISMATCH'})")

    # ── FP16 fused detector vs FP32 fused (FP16 tolerance) ──
    fp16_det_path = build_fused_detector_fp16(det_path, size, _model_cache(det_path, "_pre_fp16.onnx"))
    fused16 = ort.InferenceSession(str(fp16_det_path), providers=providers)
    fused16_out = fused16.run(det.output_names, {"pp_image": img})
    diff16 = max(float(np.abs(a - b).max()) for a, b in zip(fused_out, fused16_out))
    print(f"[build] fused FP16 vs FP32:  max abs diff {diff16:.2e}")

    # ── FP16 recognition vs FP32 recognition (cosine similarity must stay ~1) ──
    fp16_rec_path = build_fp16_model(rec_path, _model_cache(rec_path, "_fp16.onnx"))
    crops = [rng.integers(0, 256, (rec.input_size[1], rec.input_size[0], 3), dtype=np.uint8) for _ in range(64)]
    feats32 = rec.get_feat(crops)
    rec.session = ort.InferenceSession(str(fp16_rec_path), providers=providers)
    feats16 = rec.get_feat(crops)
    cos = _cos(feats32, feats16)
    print(f"[build] recognition FP16 cosine vs FP32: mean {cos.mean():.5f}, min {cos.min():.5f}")

    # ── Speed: stock vs fused FP32 vs fused FP16 ──
    imgs = [rng.integers(0, 256, (size, size, 3), dtype=np.uint8) for _ in range(200)]
    for s in (fused, fused16):
        s.run(det.output_names, {"pp_image": img})  # warm
    det.session.run(det.output_names, {det.input_name: blob})

    def time_loop(fn) -> float:
        t = time.monotonic()
        for im in imgs:
            fn(im)
        return time.monotonic() - t

    stock_s = time_loop(lambda im: det.session.run(
        det.output_names, {det.input_name: cv2.dnn.blobFromImage(
            im, 1.0 / det.input_std, (size, size), (det.input_mean,) * 3, swapRB=True)}))
    fp32_s = time_loop(lambda im: fused.run(det.output_names, {"pp_image": im}))
    fp16_s = time_loop(lambda im: fused16.run(det.output_names, {"pp_image": im}))
    n = len(imgs)
    print(f"[build] detector stock CPU-pre : {n/stock_s:7.1f}/s")
    print(f"[build] detector fused FP32    : {n/fp32_s:7.1f}/s")
    print(f"[build] detector fused FP16    : {n/fp16_s:7.1f}/s")
    return 0 if diff < 1e-3 else 1


if __name__ == "__main__":
    sys.exit(main())
