// Port of facegrabs/py/clustering.py — greedy single-pass online cluster
// assignment + medoid prune. Distance metric matches arcface.l2Distance
// (Euclidean over unit-length embeddings). Threshold 1.1 matches the
// Python pipeline's same-character threshold.

import { l2Distance } from "./arcface";

export const SAME_CHARACTER_THRESHOLD = 1.1;

export interface Cluster<T> {
    // Running sum of unit-length embeddings + count. centroid() = sum/count
    // re-normalised. Kept as the running sum so we can update cheaply.
    sum: Float32Array;
    count: number;
    members: T[];
}

function centroidOf<T>(c: Cluster<T>): Float32Array {
    const out = new Float32Array(c.sum.length);
    if (c.count === 0) return out;
    let sumSq = 0;
    for (let i = 0; i < out.length; i++) {
        out[i] = c.sum[i] / c.count;
        sumSq += out[i] * out[i];
    }
    const norm = Math.sqrt(sumSq) + 1e-12;
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

function closestTo<T>(items: T[], reference: Float32Array, getEmbedding: (t: T) => Float32Array): T {
    let best = items[0];
    let bestD = l2Distance(getEmbedding(best), reference);
    for (let i = 1; i < items.length; i++) {
        const d = l2Distance(getEmbedding(items[i]), reference);
        if (d < bestD) { best = items[i]; bestD = d; }
    }
    return best;
}

// Medoid: the actual member whose embedding is closest to the centroid.
// Useful as a "best representative" face — the centroid itself is a
// synthetic average, never a real face crop.
export function medoidOf<T>(items: T[], getEmbedding: (t: T) => Float32Array): T {
    if (items.length === 0) throw new Error("medoidOf: empty input");
    // Build a centroid from items directly (not via Cluster wrapper).
    const dim = getEmbedding(items[0]).length;
    const sum = new Float32Array(dim);
    for (const it of items) {
        const e = getEmbedding(it);
        for (let i = 0; i < dim; i++) sum[i] += e[i];
    }
    const mean = new Float32Array(dim);
    let sumSq = 0;
    for (let i = 0; i < dim; i++) {
        mean[i] = sum[i] / items.length;
        sumSq += mean[i] * mean[i];
    }
    const norm = Math.sqrt(sumSq) + 1e-12;
    for (let i = 0; i < dim; i++) mean[i] /= norm;
    return closestTo(items, mean, getEmbedding);
}

// Online single-pass clusterer — for each new embedding, find the closest
// existing cluster by centroid distance. If within threshold, append.
// Otherwise seed a new cluster.
export class OnlineClusterer<T> {
    clusters: Cluster<T>[] = [];
    constructor(public threshold: number) { }

    assign(embedding: Float32Array): Cluster<T> {
        let best: Cluster<T> | undefined;
        let bestD = Infinity;
        for (const c of this.clusters) {
            const d = l2Distance(embedding, centroidOf(c));
            if (d < bestD) { bestD = d; best = c; }
        }
        if (best && bestD < this.threshold) {
            for (let i = 0; i < embedding.length; i++) best.sum[i] += embedding[i];
            best.count++;
            return best;
        }
        const fresh: Cluster<T> = { sum: new Float32Array(embedding), count: 1, members: [] };
        this.clusters.push(fresh);
        return fresh;
    }

    // After all assignment passes are done, drop members whose embedding
    // drifted away from the cluster's medoid by >= threshold. Recomputes
    // sum/count from survivors so the centroid no longer drags toward
    // the drift.
    prune(getEmbedding: (t: T) => Float32Array): void {
        for (const c of this.clusters) {
            if (c.members.length === 0) continue;
            const medoid = medoidOf(c.members, getEmbedding);
            const medoidEmb = getEmbedding(medoid);
            const survivors = c.members.filter(m =>
                l2Distance(getEmbedding(m), medoidEmb) < this.threshold);
            c.members = survivors;
            const dim = c.sum.length;
            const newSum = new Float32Array(dim);
            for (const m of survivors) {
                const e = getEmbedding(m);
                for (let i = 0; i < dim; i++) newSum[i] += e[i];
            }
            c.sum = newSum;
            c.count = survivors.length;
        }
    }
}

// Final consolidation pass. The online assigner is greedy and order-
// dependent, so the same character can seed two clusters (e.g. a few early
// frames drift the first centroid, then a fresh cluster forms that would
// have matched the settled centroid). This unions any pair of clusters whose
// centroids are within `threshold`, recomputing the merged centroid and
// iterating to a fixed point. O(clusters²) per pass — fine for ≤30 clusters.
export function mergeClusters<T>(clusters: Cluster<T>[], threshold: number): Cluster<T>[] {
    const out = clusters.filter(c => c.members.length > 0);
    let changed = true;
    while (changed) {
        changed = false;
        for (let a = 0; a < out.length && !changed; a++) {
            for (let b = a + 1; b < out.length; b++) {
                if (l2Distance(centroidOf(out[a]), centroidOf(out[b])) < threshold) {
                    const A = out[a], B = out[b];
                    for (let i = 0; i < A.sum.length; i++) A.sum[i] += B.sum[i];
                    A.count += B.count;
                    for (const m of B.members) A.members.push(m);
                    out.splice(b, 1);
                    changed = true;
                    break;
                }
            }
        }
    }
    return out;
}

export function clusterEmbeddings<T>(
    items: T[],
    threshold: number,
    getEmbedding: (t: T) => Float32Array,
): Cluster<T>[] {
    const cl = new OnlineClusterer<T>(threshold);
    for (const it of items) {
        const c = cl.assign(getEmbedding(it));
        c.members.push(it);
    }
    cl.prune(getEmbedding);
    return mergeClusters(cl.clusters, threshold);
}

export { l2Distance };
