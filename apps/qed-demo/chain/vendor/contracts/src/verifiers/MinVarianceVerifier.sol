// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @title  MinVarianceVerifier — on-chain optimality certificate checker for Markowitz portfolios
/// @notice Certifies that a delivered portfolio w solves the long-only minimum-variance problem
///
///             minimise ½·wᵀΣw   subject to   1ᵀw = 1,  w ≥ 0
///
///         WITHOUT solving it. The provider attaches a Karush–Kuhn–Tucker (KKT) certificate
///         (ν, μ) and a Cholesky-type factor L proving Σ is (numerically) positive semidefinite.
///         The verifier then checks, in exact integer arithmetic:
///
///           primal feasibility      w ≥ 0,  |1ᵀw − 1| ≤ τ
///           dual feasibility        μ ≥ 0
///           stationarity            |(Σw)ᵢ − ν − μᵢ| ≤ τ          for every asset i
///           complementary slackness Σᵢ wᵢμᵢ ≤ τ                  (this IS the duality gap)
///           convexity               |Σᵢⱼ − (LLᵀ)ᵢⱼ| ≤ τ          for every i ≥ j
///
///         Theorem (docs/ALGORITHMS.md §4): if all checks pass, ½wᵀΣw ≤ OPT + (2n + 3 + |ν|)·τ + O(τ²).
///         i.e. the escrow pays only for answers that are provably within a known, tiny distance of
///         the global optimum — no human reviewer, no oracle, no trust in the AI that produced it.
///
/// @dev    Fixed-point WAD (1e18) inputs; all comparisons are done at 1e36 scale with no rounding.
///         spec     = abi.encode(uint256 n, int256[] cov /*n×n row-major*/, uint256 tol, bytes32 universe)
///         solution = abi.encode(int256[] w, int256 nu, int256[] mu, int256[] L /*packed lower-tri*/)
contract MinVarianceVerifier is IProofVerifier {
    int256 internal constant WAD = 1e18;
    uint256 public constant MAX_N = 16;
    uint256 public constant MAX_TOL = 1e16; // 1% — clients may not post meaningless tolerances
    int256 internal constant BOUND = 1e27; // |input| ≤ 1e9 in real units: rules out overflow games

    error DimensionMismatch();
    error InvalidTolerance(uint256 tol);
    error ValueOutOfRange();
    error CovarianceNotSymmetric(uint256 i, uint256 j);
    error NonPositiveVariance(uint256 i);
    error NegativeWeight(uint256 i, int256 w);
    error BudgetViolated(int256 sumW);
    error NegativeMultiplier(uint256 i, int256 mu);
    error StationarityViolated(uint256 i, int256 residual);
    error DualityGapTooLarge(int256 gap);
    error NotPositiveSemidefinite(uint256 i, uint256 j, int256 residual);

    function problemClass() external pure returns (string memory) {
        return "markowitz.min-variance.long-only/v1";
    }

    function verify(bytes calldata specBytes, bytes calldata solutionBytes)
        external
        pure
        returns (bytes32 resultDigest)
    {
        (uint256 n, int256[] memory cov, uint256 tolU,) = abi.decode(specBytes, (uint256, int256[], uint256, bytes32));
        (int256[] memory w, int256 nu, int256[] memory mu, int256[] memory L) =
            abi.decode(solutionBytes, (int256[], int256, int256[], int256[]));

        if (n < 2 || n > MAX_N) revert DimensionMismatch();
        if (cov.length != n * n || w.length != n || mu.length != n || L.length != (n * (n + 1)) / 2) {
            revert DimensionMismatch();
        }
        if (tolU == 0 || tolU > MAX_TOL) revert InvalidTolerance(tolU);
        int256 tol = int256(tolU);
        int256 tolHi = tol * WAD; // tolerance at 1e36 scale

        _checkRanges(cov, w, nu, mu, L);
        _checkCovariance(n, cov);
        _checkPrimal(n, w, tol);
        int256 variance = _checkStationarityAndGap(n, cov, w, nu, mu, tolHi);
        _checkConvexity(n, cov, L, tolHi);

        // Certified objective value wᵀΣw (WAD). Recorded on-chain by the escrow.
        return bytes32(uint256(variance));
    }

    // ───────────────────────────────────────────────────────────────────────────

    function _checkRanges(int256[] memory cov, int256[] memory w, int256 nu, int256[] memory mu, int256[] memory L)
        internal
        pure
    {
        if (_abs(nu) > BOUND) revert ValueOutOfRange();
        for (uint256 i; i < cov.length; ++i) {
            if (_abs(cov[i]) > BOUND) revert ValueOutOfRange();
        }
        for (uint256 i; i < w.length; ++i) {
            if (_abs(w[i]) > BOUND || _abs(mu[i]) > BOUND) revert ValueOutOfRange();
        }
        for (uint256 i; i < L.length; ++i) {
            if (_abs(L[i]) > BOUND) revert ValueOutOfRange();
        }
    }

    function _checkCovariance(uint256 n, int256[] memory cov) internal pure {
        for (uint256 i; i < n; ++i) {
            if (cov[i * n + i] <= 0) revert NonPositiveVariance(i);
            for (uint256 j = i + 1; j < n; ++j) {
                if (cov[i * n + j] != cov[j * n + i]) revert CovarianceNotSymmetric(i, j);
            }
        }
    }

    function _checkPrimal(uint256 n, int256[] memory w, int256 tol) internal pure {
        int256 sumW;
        for (uint256 i; i < n; ++i) {
            if (w[i] < 0) revert NegativeWeight(i, w[i]);
            sumW += w[i];
        }
        if (_abs(sumW - WAD) > tol) revert BudgetViolated(sumW);
    }

    function _checkStationarityAndGap(
        uint256 n,
        int256[] memory cov,
        int256[] memory w,
        int256 nu,
        int256[] memory mu,
        int256 tolHi
    ) internal pure returns (int256 variance) {
        int256 gap; // Σ wᵢμᵢ at 1e36 scale
        int256 quad; // wᵀΣw at 1e54 scale
        for (uint256 i; i < n; ++i) {
            if (mu[i] < 0) revert NegativeMultiplier(i, mu[i]);
            int256 g; // (Σw)ᵢ at 1e36 scale
            for (uint256 j; j < n; ++j) {
                g += cov[i * n + j] * w[j];
            }
            int256 residual = g - (nu + mu[i]) * WAD;
            if (_abs(residual) > tolHi) revert StationarityViolated(i, residual / WAD);
            gap += w[i] * mu[i];
            quad += w[i] * g;
        }
        if (gap > tolHi) revert DualityGapTooLarge(gap / WAD);
        variance = quad / (WAD * WAD);
    }

    /// @dev Proves Σ ≈ LLᵀ, a PSD matrix, so the problem is convex and KKT ⇒ global optimality.
    function _checkConvexity(uint256 n, int256[] memory cov, int256[] memory L, int256 tolHi) internal pure {
        for (uint256 i; i < n; ++i) {
            uint256 ri = (i * (i + 1)) / 2;
            for (uint256 j; j <= i; ++j) {
                uint256 rj = (j * (j + 1)) / 2;
                int256 p;
                for (uint256 k; k <= j; ++k) {
                    p += L[ri + k] * L[rj + k];
                }
                int256 residual = cov[i * n + j] * WAD - p;
                if (_abs(residual) > tolHi) revert NotPositiveSemidefinite(i, j, residual / WAD);
            }
        }
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x >= 0 ? x : -x;
    }
}
