"""Port of web/faceEmbed/clustering.ts to Python.

Same two failure modes the TS version guards against:

1. The raw mean of unit-norm embeddings has norm < 1 and shrinks as
   members diversify — distance comparisons compress and one cluster
   absorbs everything vaguely face-like. Fix: re-normalise the
   centroid to the unit sphere every time it's used.

2. The mean has no membership check after the fact; an embedding can
   join via mean drift even when it disagrees with every actual
   member. Fix: prune() finds the medoid (real member closest to the
   centroid) and drops members whose distance to the medoid is >=
   threshold, then recomputes sum/count from survivors.

The cluster representative for downstream use is the medoid — never
the centroid. SAME_CHARACTER_THRESHOLD = 1.1 (matches
web/faceEmbed/clustering.ts).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Generic, List, Optional, TypeVar

import numpy as np

T = TypeVar("T")

SAME_CHARACTER_THRESHOLD = 1.1


def l2_distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b))


@dataclass
class Cluster(Generic[T]):
    members: List[T] = field(default_factory=list)
    # Sum of embeddings (un-normalised) so adding a new member is O(d).
    sum: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    count: int = 0

    def centroid(self) -> np.ndarray:
        """Unit-normalised mean — re-normalise EVERY call so distance
        comparisons stay metric-consistent regardless of how many
        members have been added since last call."""
        mean = self.sum / max(self.count, 1)
        norm = float(np.linalg.norm(mean))
        if norm < 1e-12:
            return mean
        return mean / norm


class OnlineClusterer(Generic[T]):
    """Single-pass clustering — for each item, find the closest existing
    cluster centroid and either join it (distance < threshold) or start
    a new one. Order matters: callers that care about determinism should
    feed items in a stable order (we feed by timestamp, then face idx)."""

    def __init__(
        self,
        threshold: float,
        get_embedding: Callable[[T], np.ndarray],
    ) -> None:
        self.threshold = threshold
        self.get_embedding = get_embedding
        self.clusters: List[Cluster[T]] = []

    def add(self, item: T) -> None:
        emb = self.get_embedding(item)
        if not self.clusters:
            self._open_cluster(item, emb)
            return
        # Find the closest existing centroid.
        best_idx = -1
        best_d = float("inf")
        for i, c in enumerate(self.clusters):
            d = l2_distance(c.centroid(), emb)
            if d < best_d:
                best_d = d
                best_idx = i
        if best_d < self.threshold and best_idx >= 0:
            c = self.clusters[best_idx]
            c.members.append(item)
            c.sum += emb
            c.count += 1
        else:
            self._open_cluster(item, emb)

    def _open_cluster(self, item: T, emb: np.ndarray) -> None:
        c: Cluster[T] = Cluster()
        c.members.append(item)
        c.sum = emb.astype(np.float32).copy()
        c.count = 1
        self.clusters.append(c)

    def prune(self) -> None:
        """Drop members whose distance to the cluster medoid is >=
        threshold, recompute sum/count from survivors. Empty clusters
        are removed."""
        kept: List[Cluster[T]] = []
        for c in self.clusters:
            if not c.members:
                continue
            centroid = c.centroid()
            medoid_idx = _argmin(
                range(len(c.members)),
                lambda i: l2_distance(self.get_embedding(c.members[i]), centroid),
            )
            medoid_emb = self.get_embedding(c.members[medoid_idx])
            survivors = [
                m for m in c.members
                if l2_distance(self.get_embedding(m), medoid_emb) < self.threshold
            ]
            if not survivors:
                continue
            new_sum = np.zeros_like(survivors[0] if isinstance(survivors[0], np.ndarray) else self.get_embedding(survivors[0]), dtype=np.float32)
            for m in survivors:
                new_sum += self.get_embedding(m)
            nc: Cluster[T] = Cluster()
            nc.members = survivors
            nc.sum = new_sum
            nc.count = len(survivors)
            kept.append(nc)
        self.clusters = kept


def _argmin(seq, key):
    seq = list(seq)
    best = seq[0]
    bestv = key(best)
    for x in seq[1:]:
        v = key(x)
        if v < bestv:
            best = x
            bestv = v
    return best


def medoid_of(items: List[T], get_embedding: Callable[[T], np.ndarray]) -> T:
    """Return the item whose embedding is closest to the running
    centroid of the set. Cluster representatives use this to pick the
    'best face' (the real face whose embedding is most central)."""
    if not items:
        raise RuntimeError("medoid_of on empty list")
    emb_stack = np.stack([get_embedding(i) for i in items])
    centroid = emb_stack.mean(axis=0)
    cn = float(np.linalg.norm(centroid))
    if cn > 1e-12:
        centroid = centroid / cn
    dists = np.linalg.norm(emb_stack - centroid[None, :], axis=1)
    return items[int(np.argmin(dists))]


def cluster_embeddings(
    items: List[T],
    threshold: float,
    get_embedding: Callable[[T], np.ndarray],
) -> List[Cluster[T]]:
    """Convenience wrapper: run an OnlineClusterer through every item
    then prune. Use the class directly if you need to interleave adds
    and inspections."""
    oc: OnlineClusterer[T] = OnlineClusterer(threshold, get_embedding)
    for it in items:
        oc.add(it)
    oc.prune()
    return oc.clusters
