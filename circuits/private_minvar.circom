pragma circom 2.1.9;

// QED Private — a zero-knowledge certificate of portfolio optimality.
//
// Statement proved (n = 6 assets, all quantities integers in fixed point, ONE = 10^12):
//
//   "I know a covariance matrix Σ, a long-only portfolio w and multipliers (ν, μ, L) such that
//      (a) Σ is the matrix the data vendor committed to          Poseidon(Σ, saltΣ) = dataCommitment
//      (b) w is the portfolio committed to                         Poseidon(w, saltW) = weightsCommitment
//      (c) w is feasible                                           w ≥ 0,  Σᵢ wᵢ = 1
//      (d) w satisfies the KKT conditions of  min ½ wᵀΣw  s.t. 1ᵀw = 1, w ≥ 0, to tolerance τ:
//            stationarity      |(Σw)ᵢ − ν − μᵢ| ≤ τ     for every i
//            dual feasibility   μᵢ ≥ 0
//            compl. slackness   Σᵢ wᵢ μᵢ ≤ τ
//      (e) Σ is convex up to τ:  |Σᵢⱼ − (LLᵀ)ᵢⱼ| ≤ τ  with L lower-triangular
//      (f) the certified variance is   variance = wᵀΣw"
//
// By the ε-optimality theorem (docs/ALGORITHMS.md §4.4 and §10) this implies
//   ½ wᵀΣw − min_x ½ xᵀΣx ≤ (2n + 3 + |ν|)·τ + O(τ²)
// while revealing nothing about Σ or w beyond the two commitments and the variance.
//
// Public signals, in snarkjs order: [weightsCommitment, variance, dataCommitment, provider].
// `provider` binds the proof to the agent that produced it, so a proof copied from the mempool
// cannot be replayed under another provider's job.
//
// Encoding. Field elements are integers mod p (BN254, p ≈ 2^254). Signed values use the field's
// negative encoding. Every input is range-checked so that every intermediate sum stays below 2^131
// in magnitude; comparisons are therefore exact integer comparisons, with no wrap-around.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// 0 ≤ x < 2^k
template InRange(k) {
    signal input x;
    component bits = Num2Bits(k);
    bits.in <== x;
}

// −2^k ≤ x < 2^k  (x is a signed integer in the field's negative encoding)
template SignedBound(k) {
    signal input x;
    component bits = Num2Bits(k + 1);
    bits.in <== x + 2 ** k;
}

// |x| ≤ t  for a public constant t ≥ 0, given |x| < 2^(k−1)
template AbsAtMost(k, t) {
    signal input x;
    component hi = Num2Bits(k);
    component lo = Num2Bits(k);
    hi.in <== t - x;
    lo.in <== t + x;
}

// Index of Σ(i, j), i ≤ j, in the row-major upper triangle; Σ is symmetric so Σ(j, i) = Σ(i, j).
function U(n, i, j) {
    var a = i;
    var b = j;
    if (a > b) { a = j; b = i; }
    return a * n - (a * (a - 1)) \ 2 + (b - a);
}

// Index of L(i, j), j ≤ i, in the row-major lower triangle.
function T(i, j) {
    return (i * (i + 1)) \ 2 + j;
}

template PrivateMinVariance(n) {
    var M = n * (n + 1) \ 2;
    var ONE = 10 ** 12;          // 1.0 in fixed point
    var TAU = 10 ** 14;          // τ = 1e-10 at scale ONE² (stationarity, convexity)
    var TAU_CS = 10 ** 26;       // τ = 1e-10 at scale ONE³ (complementary slackness)

    // ── private witness ──
    signal input cov[M];         // Σ, upper triangle, scale ONE, |Σᵢⱼ| < 2^40 (≈ 1.1)
    signal input saltData;       // vendor's blinding salt
    signal input w[n];           // portfolio, scale ONE
    signal input nu;             // ν, scale ONE²
    signal input mu[n];          // μ, scale ONE²
    signal input L[M];           // Cholesky witness, lower triangle, scale ONE
    signal input saltW;          // provider's blinding salt for the portfolio

    // ── public ──
    signal input dataCommitment;
    signal input provider;
    signal output weightsCommitment;
    signal output variance;

    // (0) ranges: keep every product and sum far from the field modulus
    component covB[M];
    component LB[M];
    for (var k = 0; k < M; k++) {
        covB[k] = SignedBound(40); covB[k].x <== cov[k];
        LB[k] = SignedBound(40);   LB[k].x <== L[k];
    }
    component diagPos[n];
    for (var i = 0; i < n; i++) { diagPos[i] = InRange(40); diagPos[i].x <== cov[U(n, i, i)] - 1; }
    component nuB = SignedBound(80);
    nuB.x <== nu;

    // (c) feasibility: w ≥ 0 and Σ w = ONE exactly
    component wB[n];
    var sumW = 0;
    for (var i = 0; i < n; i++) { wB[i] = InRange(40); wB[i].x <== w[i]; sumW += w[i]; }
    sumW === ONE;

    // dual feasibility: μ ≥ 0
    component muB[n];
    for (var i = 0; i < n; i++) { muB[i] = InRange(80); muB[i].x <== mu[i]; }

    // gradient g = Σw (scale ONE²)
    signal sw[n][n];
    signal g[n];
    for (var i = 0; i < n; i++) {
        var acc = 0;
        for (var j = 0; j < n; j++) { sw[i][j] <== cov[U(n, i, j)] * w[j]; acc += sw[i][j]; }
        g[i] <== acc;
    }

    // (d) stationarity: |gᵢ − ν − μᵢ| ≤ τ
    component stat[n];
    for (var i = 0; i < n; i++) { stat[i] = AbsAtMost(90, TAU); stat[i].x <== g[i] - nu - mu[i]; }

    // (d) complementary slackness: Σ wᵢ μᵢ ≤ τ   (scale ONE³)
    signal wm[n];
    var gap = 0;
    for (var i = 0; i < n; i++) { wm[i] <== w[i] * mu[i]; gap += wm[i]; }
    component cs = InRange(130);
    cs.x <== TAU_CS - gap;

    // (e) convexity witness: |Σᵢⱼ·ONE − (LLᵀ)ᵢⱼ| ≤ τ for j ≤ i   (scale ONE²)
    signal ll[n][n][n];
    component psd[M];
    for (var i = 0; i < n; i++) {
        for (var j = 0; j <= i; j++) {
            var s = 0;
            for (var k = 0; k <= j; k++) { ll[i][j][k] <== L[T(i, k)] * L[T(j, k)]; s += ll[i][j][k]; }
            psd[T(i, j)] = AbsAtMost(90, TAU);
            psd[T(i, j)].x <== cov[U(n, j, i)] * ONE - s;
        }
    }

    // (f) certified objective: variance = wᵀΣw   (scale ONE³)
    signal wg[n];
    var v = 0;
    for (var i = 0; i < n; i++) { wg[i] <== w[i] * g[i]; v += wg[i]; }
    variance <== v;

    // (a) the data is exactly what the vendor committed to
    var H = (M + 1) \ 2;                 // 11 + 10 entries for n = 6
    component hA = Poseidon(H);
    component hB = Poseidon(M - H + 1);
    for (var k = 0; k < H; k++) hA.inputs[k] <== cov[k];
    for (var k = H; k < M; k++) hB.inputs[k - H] <== cov[k];
    hB.inputs[M - H] <== saltData;
    component hData = Poseidon(2);
    hData.inputs[0] <== hA.out;
    hData.inputs[1] <== hB.out;
    hData.out === dataCommitment;

    // (b) commitment to the portfolio (the client receives w and saltW off-chain and re-hashes)
    component hW = Poseidon(n + 1);
    for (var i = 0; i < n; i++) hW.inputs[i] <== w[i];
    hW.inputs[n] <== saltW;
    weightsCommitment <== hW.out;

    // bind the proof to its provider (a quadratic constraint keeps the public input in the system)
    signal providerSquared;
    providerSquared <== provider * provider;
}

component main { public [dataCommitment, provider] } = PrivateMinVariance(6);
