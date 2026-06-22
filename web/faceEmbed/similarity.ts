// Umeyama similarity transform (rotation + uniform scale + translation)
// fitting source points to destination points. Used for ArcFace face
// alignment: takes the 5 detected landmarks (eye, eye, nose, mouth, mouth)
// and computes the affine to warp the face into the canonical 112×112 box.

export interface Affine2D {
    a: number; b: number; c: number;
    d: number; e: number; f: number;
}

// Apply (x, y) = (a*x + b*y + c, d*x + e*y + f).
export function applyAffine(t: Affine2D, x: number, y: number): [number, number] {
    return [t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f];
}

// Returns the affine that best maps src points onto dst points (least squares),
// constrained to similarity transforms (no shear, no anisotropic scale).
export function umeyamaSimilarity(src: [number, number][], dst: [number, number][]): Affine2D {
    const n = src.length;
    if (n !== dst.length || n < 2) throw new Error(`umeyama: need >= 2 matched points, got ${n} vs ${dst.length}`);

    // Means.
    let sxMean = 0, syMean = 0, dxMean = 0, dyMean = 0;
    for (let i = 0; i < n; i++) {
        sxMean += src[i][0]; syMean += src[i][1];
        dxMean += dst[i][0]; dyMean += dst[i][1];
    }
    sxMean /= n; syMean /= n; dxMean /= n; dyMean /= n;

    // Variance of src and cross-covariance.
    let srcVar = 0;
    let sxx = 0, sxy = 0, syx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const sx = src[i][0] - sxMean;
        const sy = src[i][1] - syMean;
        const dx = dst[i][0] - dxMean;
        const dy = dst[i][1] - dyMean;
        srcVar += sx * sx + sy * sy;
        sxx += sx * dx;
        sxy += sx * dy;
        syx += sy * dx;
        syy += sy * dy;
    }
    srcVar /= n;
    sxx /= n; sxy /= n; syx /= n; syy /= n;

    // 2x2 SVD of cross-covariance [[sxx, syx], [sxy, syy]]; we only need
    // U and V via the closed form for a 2x2.
    const det = sxx * syy - sxy * syx;
    const trace = sxx + syy;
    const offdiag = sxy - syx;

    // Singular values via the eigenvalues of M^T M then √.
    const mtm00 = sxx * sxx + sxy * sxy;
    const mtm11 = syx * syx + syy * syy;
    const mtm01 = sxx * syx + sxy * syy;
    const tr = mtm00 + mtm11;
    const dt = mtm00 * mtm11 - mtm01 * mtm01;
    const root = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
    const s1 = Math.sqrt(Math.max(0, tr / 2 + root));
    const s2 = Math.sqrt(Math.max(0, tr / 2 - root));

    // Sign matrix S = diag(1, det < 0 ? -1 : 1) so the result is a rotation,
    // not a reflection.
    const dSign = det < 0 ? -1 : 1;

    // For 2D, scale = (s1 + s2 * dSign) / srcVar.
    const scale = srcVar > 0 ? (s1 + s2 * dSign) / srcVar : 1;

    // Rotation angle from cross-covariance.
    // For a similarity transform: R = [[cos θ, -sin θ], [sin θ, cos θ]].
    // The optimal rotation is atan2(offdiag, trace).
    const theta = Math.atan2(offdiag, trace);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    const a = scale * cos;
    const b = -scale * sin;
    const d = scale * sin;
    const e = scale * cos;
    const c = dxMean - (a * sxMean + b * syMean);
    const f = dyMean - (d * sxMean + e * syMean);

    return { a, b, c, d, e, f };
}
