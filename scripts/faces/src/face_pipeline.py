"""Face detection + embedding for one decoded frame.

Uses insightface's prebuilt FaceAnalysis with the buffalo_l zoo —
det_10g.onnx (SCRFD) + w600k_r50.onnx (ArcFace ResNet50). Same weights
the browser pulls from B2 (`web/faceEmbed/index.ts`'s MODEL_BASE_URL),
so detection scores + embedding distances line up with what the
in-browser pipeline produces.

Wrapped in this thin module so process_one.py doesn't need to know
about ONNX runtime providers / model warmup details, and so we can
fall back to a stubbed implementation (no inference) when invoked with
--stub-faces for orchestration testing.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np


def _setup_cuda_runtime() -> None:
    """Make onnxruntime-gpu's CUDA execution provider loadable on Windows.
    The provider DLL depends on cuBLAS/cuDNN/cuFFT/cuRAND/cudart DLLs shipped in
    the nvidia-*-cu12 wheels under site-packages/nvidia/<lib>/bin. We prepend
    those dirs to PATH (which the Windows loader searches for a DLL's transitive
    deps — unlike os.add_dll_directory, which ORT's internal loader doesn't opt
    into) and ask onnxruntime to preload them. No-op off Windows / without the
    wheels."""
    if not sys.platform.startswith("win"):
        return
    try:
        import nvidia
    except ImportError:
        return
    bin_dirs = [str(p) for base in nvidia.__path__ for p in Path(base).glob("*/bin") if p.is_dir()]
    for d in bin_dirs:
        try:
            os.add_dll_directory(d)
        except OSError:
            pass
    if bin_dirs:
        os.environ["PATH"] = os.pathsep.join(bin_dirs) + os.pathsep + os.environ.get("PATH", "")
    # onnxruntime ≥1.20 can explicitly load the CUDA/cuDNN DLLs from those wheels.
    try:
        import onnxruntime as ort
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
    except Exception:
        pass

# Frame target width — matches FACES_FRAME_TARGET_W in web/MetadataExtractor.ts.
# SCRFD's native input is 640×640 and the detector letterboxes anyway, so
# feeding 640-wide already-cropped frames is the lossless choice.
FACES_FRAME_TARGET_W = 640

# Per-frame cap on detected faces we keep. Same as
# web/faceEmbed/index.ts MAX_FACES_PER_FRAME.
MAX_FACES_PER_FRAME = 10

# 512-float embedding from ArcFace ResNet50.
EMBEDDING_DIM = 512

# How many aligned face crops to hand ArcFace per recognition call. Recognition
# is the one InsightFace step that batches (get_feat takes a list), so we group
# faces across frames into one GPU call instead of one per face.
RECOGNITION_BATCH_SIZE = 64

# Fused detector model: det_10g.onnx with the blobFromImage preprocessing
# (BGR->RGB + (x-127.5)/128 + HWC->CHW) spliced onto the front, so it runs on the
# GPU fused with the conv layers instead of on the CPU per frame. Built lazily
# from the stock model and cached next to it. Bit-identical outputs; ~2.8x faster
# preprocess+inference. Keeping it all ONNX also leaves the door open to a single
# TensorRT build later.
FUSED_DETECTOR_SUFFIX = "_pre.onnx"

# FP16 is built + validated (recognition cosine ~1.0 vs FP32) but OFF by default:
# at batch-1 the detector is launch/transfer-bound, not compute-bound, so FP16
# is ~7% SLOWER (the extra cast nodes don't pay for themselves). It only helps
# once we're compute-bound — i.e. after batching. Flip on via FaceEngine(fp16=True).
FP16_DEFAULT = False


def _model_cache(src_path: Path, suffix: str) -> Path:
    """Derived models live in a `fused/` subdir of the model dir, NOT the model
    dir itself — FaceAnalysis globs `<model_dir>/*.onnx` non-recursively and
    would otherwise pick them up as duplicate detection/recognition models."""
    return src_path.parent / "fused" / (src_path.stem + suffix)


def fused_detector_path(det_path: Path) -> Path:
    return _model_cache(det_path, FUSED_DETECTOR_SUFFIX)


def build_fp16_model(src_path: Path, dst_path: Path) -> Path:
    """Convert an FP32 ONNX model to FP16. keep_io_types keeps the graph inputs
    and outputs float32 (callers feed/read float32; only the internal compute is
    FP16), so it's a drop-in session swap. Cached next to the fused models."""
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(src_path))
    model16 = float16.convert_float_to_float16(model, keep_io_types=True)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model16, str(dst_path))
    return dst_path


def _splice_preprocess(model, size: int):
    """Prepend a preprocess subgraph (uint8 HWC BGR -> normalized NCHW float32
    RGB) onto an SCRFD graph, rewired to its image input. The new nodes stay
    float32 even on an FP16 model — they feed the model's float32 (keep_io_types)
    input, whose internal cast takes it to FP16. Mutates and returns `model`."""
    from onnx import TensorProto, helper, numpy_helper

    g = model.graph
    init_names = {i.name for i in g.initializer}
    image_inputs = [i for i in g.input if i.name not in init_names]
    if len(image_inputs) != 1:
        raise RuntimeError(f"Expected one image input, found {[i.name for i in image_inputs]}")
    scrfd_in = image_inputs[0].name

    inits = [
        numpy_helper.from_array(np.array([2, 1, 0], np.int64), "pp_rgb_idx"),  # BGR->RGB
        numpy_helper.from_array(np.array(127.5, np.float32), "pp_mean"),
        numpy_helper.from_array(np.array(1.0 / 128.0, np.float32), "pp_scale"),
        numpy_helper.from_array(np.array([1, 3, size, size], np.int64), "pp_shape"),
    ]
    nodes = [
        helper.make_node("Cast", ["pp_image"], ["pp_f"], to=TensorProto.FLOAT),
        helper.make_node("Gather", ["pp_f", "pp_rgb_idx"], ["pp_rgb"], axis=2),
        helper.make_node("Sub", ["pp_rgb", "pp_mean"], ["pp_sub"]),
        helper.make_node("Mul", ["pp_sub", "pp_scale"], ["pp_hwc"]),
        helper.make_node("Transpose", ["pp_hwc"], ["pp_chw"], perm=[2, 0, 1]),
        # Reshape (not Unsqueeze) to add the batch dim — opset-agnostic.
        helper.make_node("Reshape", ["pp_chw", "pp_shape"], [scrfd_in]),
    ]
    # Protobuf repeated fields reject slice assignment, so rebuild the node list
    # with the preprocess nodes first (they produce scrfd_in for the old graph).
    old_nodes = list(g.node)
    del g.node[:]
    g.node.extend(nodes)
    g.node.extend(old_nodes)
    g.initializer.extend(inits)
    g.input.remove(image_inputs[0])
    g.input.insert(0, helper.make_tensor_value_info("pp_image", TensorProto.UINT8, [size, size, 3]))
    return model


def build_fused_detector(det_path: Path, size: int) -> Path:
    """Fuse preprocess onto the FP32 SCRFD graph; cache under fused/."""
    import onnx
    model = _splice_preprocess(onnx.load(str(det_path)), size)
    onnx.checker.check_model(model)
    out_path = fused_detector_path(det_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(out_path))
    return out_path


def build_fused_detector_fp16(det_path: Path, size: int, out_path: Path) -> Path:
    """FP16 fused detector: convert the stock SCRFD to FP16 FIRST (so the
    converter sees a clean graph), THEN splice the float32 preprocess on. Doing
    it the other way confuses the converter on the hand-built Cast nodes."""
    import onnx
    from onnxconverter_common import float16
    model16 = float16.convert_float_to_float16(onnx.load(str(det_path)), keep_io_types=True)
    _splice_preprocess(model16, size)
    onnx.checker.check_model(model16)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model16, str(out_path))
    return out_path


def _scrfd_resize_pad(img: np.ndarray, size: int) -> Tuple[np.ndarray, float]:
    """SCRFD's aspect-preserving resize into the top-left of a size x size uint8
    canvas (the cheap CPU half of detection preprocessing — the normalize/
    transpose now lives in the fused model). Returns (canvas, det_scale)."""
    import cv2
    h, w = img.shape[:2]
    im_ratio = h / w
    if im_ratio > 1.0:
        new_h = size
        new_w = int(size / im_ratio)
    else:
        new_w = size
        new_h = int(size * im_ratio)
    det_scale = new_h / h
    resized = cv2.resize(img, (new_w, new_h))
    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    canvas[:new_h, :new_w, :] = resized
    return canvas, det_scale


def _scrfd_decode(det, net_outs, det_scale: float):
    """SCRFD's anchor decode + threshold + NMS over raw model outputs, using the
    detector instance's strides/threshold/nms. Mirrors SCRFD.forward + detect so
    we can run it on the fused model's outputs. Returns (det[n,5], kpss[n,5,2])."""
    from insightface.model_zoo.scrfd import distance2bbox, distance2kps
    in_w, in_h = det.input_size
    fmc = det.fmc
    scores_list, bboxes_list, kpss_list = [], [], []
    for idx, stride in enumerate(det._feat_stride_fpn):
        scores = net_outs[idx]
        bbox_preds = net_outs[idx + fmc] * stride
        height, width = in_h // stride, in_w // stride
        key = (height, width, stride)
        anchor_centers = det.center_cache.get(key)
        if anchor_centers is None:
            anchor_centers = np.stack(np.mgrid[:height, :width][::-1], axis=-1).astype(np.float32)
            anchor_centers = (anchor_centers * stride).reshape((-1, 2))
            if det._num_anchors > 1:
                anchor_centers = np.stack([anchor_centers] * det._num_anchors, axis=1).reshape((-1, 2))
            det.center_cache[key] = anchor_centers
        pos_inds = np.where(scores >= det.det_thresh)[0]
        bboxes = distance2bbox(anchor_centers, bbox_preds)
        scores_list.append(scores[pos_inds])
        bboxes_list.append(bboxes[pos_inds])
        if det.use_kps:
            kpss = distance2kps(anchor_centers, net_outs[idx + fmc * 2] * stride)
            kpss = kpss.reshape((kpss.shape[0], -1, 2))
            kpss_list.append(kpss[pos_inds])
    scores = np.vstack(scores_list)
    order = scores.ravel().argsort()[::-1]
    bboxes = np.vstack(bboxes_list) / det_scale
    pre_det = np.hstack((bboxes, scores)).astype(np.float32, copy=False)[order]
    keep = det.nms(pre_det)
    det_out = pre_det[keep]
    kpss = None
    if det.use_kps:
        kpss = (np.vstack(kpss_list) / det_scale)[order][keep]
    return det_out, kpss


def _estimate_norm_batch(lmk: np.ndarray, image_size: int = 112) -> np.ndarray:
    """Vectorized replacement for insightface.face_align.estimate_norm: the
    closed-form Umeyama similarity fit (5 keypoints -> ArcFace template) for ALL
    faces in one batched SVD, instead of skimage's per-face SimilarityTransform
    (a Python object + SVD that dominates the align phase). Returns (N, 2, 3)
    affine matrices. Assumes non-degenerate (non-collinear) landmarks — true of
    any real face — so it skips skimage's rank-deficient special cases."""
    from insightface.utils.face_align import arcface_dst
    if image_size % 112 == 0:
        ratio = image_size / 112.0
        diff_x = 0.0
    else:
        ratio = image_size / 128.0
        diff_x = 8.0 * ratio
    dst = (arcface_dst * ratio).astype(np.float64)
    dst[:, 0] += diff_x

    src = lmk.astype(np.float64)
    n, n_pts = src.shape[0], src.shape[1]
    src_mean = src.mean(axis=1)                 # (N,2)
    dst_mean = dst.mean(axis=0)                 # (2,)
    src_demean = src - src_mean[:, None, :]     # (N,5,2)
    dst_demean = dst - dst_mean                 # (5,2)
    # Per-face covariance A = dst_demean^T @ src_demean / n_pts.
    A = np.einsum("pk,npj->nkj", dst_demean, src_demean) / n_pts  # (N,2,2)
    U, S, Vt = np.linalg.svd(A)
    d = np.ones((n, 2))
    d[np.linalg.det(A) < 0, 1] = -1.0
    R = np.einsum("nij,nj,njk->nik", U, d, Vt)                    # (N,2,2)
    src_var = (src_demean ** 2).sum(axis=(1, 2)) / n_pts          # (N,)
    scale = (S * d).sum(axis=1) / src_var                         # (N,)
    t = dst_mean[None, :] - scale[:, None] * np.einsum("nij,nj->ni", R, src_mean)

    M = np.empty((n, 2, 3), dtype=np.float32)
    M[:, :, :2] = (scale[:, None, None] * R).astype(np.float32)
    M[:, :, 2] = t.astype(np.float32)
    return M


@dataclass
class DetectedFace:
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    score: float
    embedding: np.ndarray  # shape (512,), L2-normalised float32


class FaceEngine:
    """Thin wrapper around insightface.app.FaceAnalysis. Lazy-loaded so
    importing this module is cheap; the actual ONNX session creation
    only happens on first ensure_loaded() call."""

    def __init__(self, providers: Optional[Sequence[str]] = None, model_pack: str = "buffalo_l",
                 fp16: bool = FP16_DEFAULT) -> None:
        # CUDA first if available, fall back to CPU. The order matters
        # because insightface picks the first provider that initialises.
        self.providers = providers or ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self.model_pack = model_pack
        self.fp16 = fp16
        self._app = None
        self._det = None
        self._rec = None
        # Fused preprocess+detection session; falls back to self._det.detect if
        # the fused model can't be built/loaded.
        self._det_fused = None
        self._det_size = 0

    def ensure_loaded(self) -> None:
        if self._app is not None:
            return
        # Must run before onnxruntime is imported / a CUDA session is created,
        # so the GPU runtime DLLs are resolvable.
        _setup_cuda_runtime()
        # Imported lazily so this file is importable without the heavy
        # dependency tree (numpy is enough for type hints).
        from insightface.app import FaceAnalysis
        # Only detection + recognition. buffalo_l also ships two landmark
        # models and genderage, and FaceAnalysis.get() runs every loaded
        # non-detection model on every face — we only want the ArcFace
        # embedding, so loading the rest just burns GPU time per face.
        app = FaceAnalysis(
            name=self.model_pack,
            providers=list(self.providers),
            allowed_modules=["detection", "recognition"],
        )
        # det_size matches FACES_FRAME_TARGET_W; ctx_id=0 for first GPU,
        # -1 forces CPU. We let insightface pick from providers above.
        app.prepare(ctx_id=0, det_size=(FACES_FRAME_TARGET_W, FACES_FRAME_TARGET_W))
        self._app = app
        self._det = app.det_model
        self._rec = app.models["recognition"]

        # Build (once) + load the fused preprocess+detection model so the
        # blobFromImage normalize/transpose runs on the GPU, optionally in FP16.
        # If anything goes wrong, leave _det_fused None and fall back to
        # det.detect on CPU.
        self._det_size = self._det.input_size[0]
        try:
            import onnxruntime as ort
            det_path = Path(self._det.model_file)
            fused_path = fused_detector_path(det_path)
            if not fused_path.exists():
                build_fused_detector(det_path, self._det_size)
            if self.fp16:
                fp16_path = _model_cache(det_path, "_pre_fp16.onnx")
                if not fp16_path.exists():
                    build_fused_detector_fp16(det_path, self._det_size, fp16_path)
                fused_path = fp16_path
            self._det_fused = ort.InferenceSession(str(fused_path), providers=list(self.providers))
        except Exception as e:
            print(f"[face] fused detector unavailable, using CPU preprocess: {e}", file=sys.stderr)
            self._det_fused = None

        # FP16 recognition: swap the ArcFace session for an FP16 build. Inputs/
        # outputs stay float32 (keep_io_types) so get_feat is unchanged. Skip on
        # any failure — the stock FP32 session keeps working.
        if self.fp16:
            try:
                import onnxruntime as ort
                rec_path = Path(self._rec.model_file)
                fp16_rec = _model_cache(rec_path, "_fp16.onnx")
                if not fp16_rec.exists():
                    build_fp16_model(rec_path, fp16_rec)
                self._rec.session = ort.InferenceSession(str(fp16_rec), providers=list(self.providers))
            except Exception as e:
                print(f"[face] FP16 recognition unavailable, using FP32: {e}", file=sys.stderr)

    def _detect_one(self, frame: np.ndarray):
        """Return (det[n,5], kpss[n,5,2]) for one frame via the fused GPU model,
        or stock det.detect if the fused model isn't available."""
        if self._det_fused is not None:
            canvas, det_scale = _scrfd_resize_pad(frame, self._det_size)
            net_outs = self._det_fused.run(self._det.output_names, {"pp_image": canvas})
            return _scrfd_decode(self._det, net_outs, det_scale)
        return self._det.detect(frame, max_num=0, metric="default")

    def detect_and_embed_batch(self, frames: List[np.ndarray]) -> List[List[DetectedFace]]:
        """Detect faces in each frame (SCRFD is one-image-at-a-time), then run
        ArcFace recognition over ALL detected faces in batches — the one step
        InsightFace batches. Returns a list parallel to `frames`, each entry the
        frame's DetectedFaces (≤ MAX_FACES_PER_FRAME, sorted by score desc)."""
        self.ensure_loaded()
        assert self._det is not None and self._rec is not None
        import cv2
        crop_size = self._rec.input_size[0]

        # Detection pass: per-frame bbox/score + the kept keypoints. We defer
        # align + embed so both can run batched over all faces at once.
        per_frame: List[List[dict]] = []
        kps_list: List[np.ndarray] = []
        crop_locs: List[Tuple[int, int]] = []  # (frame index, face index)
        for fi, frame in enumerate(frames):
            bboxes, kpss = self._detect_one(frame)
            faces: List[dict] = []
            if bboxes is not None and len(bboxes) > 0 and kpss is not None:
                order = np.argsort(bboxes[:, 4])[::-1][:MAX_FACES_PER_FRAME]
                for j in order:
                    kps_list.append(kpss[j])
                    crop_locs.append((fi, len(faces)))
                    faces.append({
                        "bbox": (float(bboxes[j, 0]), float(bboxes[j, 1]), float(bboxes[j, 2]), float(bboxes[j, 3])),
                        "score": float(bboxes[j, 4]),
                    })
            per_frame.append(faces)

        # Align pass: one batched Umeyama for ALL faces' affine matrices, then a
        # cheap cv2 warp each (the warp is ~free; the per-face skimage fit it
        # replaces was the align bottleneck).
        crops: List[np.ndarray] = []
        if kps_list:
            mats = _estimate_norm_batch(np.asarray(kps_list, dtype=np.float32), crop_size)
            crops = [
                cv2.warpAffine(frames[crop_locs[i][0]], mats[i], (crop_size, crop_size), borderValue=0.0)
                for i in range(len(kps_list))
            ]

        # Recognition pass: embed every crop, batched. Normalised at the point
        # of computation; a zero-norm result drops that face.
        embeddings: List[Optional[np.ndarray]] = [None] * len(crops)
        for start in range(0, len(crops), RECOGNITION_BATCH_SIZE):
            feats = self._rec.get_feat(crops[start:start + RECOGNITION_BATCH_SIZE])
            for k in range(feats.shape[0]):
                emb = np.asarray(feats[k], dtype=np.float32).ravel()
                if emb.shape != (EMBEDDING_DIM,):
                    raise RuntimeError(f"Expected embedding shape ({EMBEDDING_DIM},), got {emb.shape}")
                n = float(np.linalg.norm(emb))
                embeddings[start + k] = emb / n if n > 1e-12 else None

        out: List[List[DetectedFace]] = [[] for _ in frames]
        for ci, (fi, fj) in enumerate(crop_locs):
            emb = embeddings[ci]
            if emb is None:
                continue
            meta = per_frame[fi][fj]
            out[fi].append(DetectedFace(bbox=meta["bbox"], score=meta["score"], embedding=emb))
        return out


class StubFaceEngine:
    """No-inference replacement that emits a synthetic single face per
    frame. Used by process_one.py --stub-faces so we can exercise the
    JSON shape + the writeResult.ts bridge without real ONNX weights."""

    def ensure_loaded(self) -> None:
        return

    def detect_and_embed_batch(self, frames: List[np.ndarray]) -> List[List[DetectedFace]]:
        out: List[List[DetectedFace]] = []
        for frame in frames:
            h, w = frame.shape[:2]
            # Deterministic synthetic embedding based on the mean pixel so
            # the stub still clusters frames-from-same-video together.
            seed = int(frame.mean()) & 0xFFFF
            rng = np.random.default_rng(seed)
            emb = rng.standard_normal(EMBEDDING_DIM).astype(np.float32)
            emb = emb / float(np.linalg.norm(emb) + 1e-12)
            out.append([DetectedFace(
                bbox=(w * 0.25, h * 0.25, w * 0.75, h * 0.75),
                score=0.99,
                embedding=emb,
            )])
        return out
