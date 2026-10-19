// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MinVarianceVerifier} from "../src/verifiers/MinVarianceVerifier.sol";

/// @notice Soundness of the optimality checker: honest certificates pass; perturbed or invented ones fail.
contract MinVarianceVerifierTest is Test {
    MinVarianceVerifier internal v;
    bytes internal spec;
    uint256 internal n;
    int256[] internal cov;
    uint256 internal tol;
    bytes32 internal universe;
    int256[] internal w;
    int256 internal nu;
    int256[] internal mu;
    int256[] internal L;

    function setUp() public {
        v = new MinVarianceVerifier();
        string memory fx = vm.readFile("contracts/test/fixtures/minvar.json");
        spec = vm.parseJsonBytes(fx, ".spec");
        (n, cov, tol, universe) = abi.decode(spec, (uint256, int256[], uint256, bytes32));
        (w, nu, mu, L) = abi.decode(vm.parseJsonBytes(fx, ".honest"), (int256[], int256, int256[], int256[]));
    }

    function _sol() internal view returns (bytes memory) {
        return abi.encode(w, nu, mu, L);
    }

    function test_HonestCertificatePasses_AndReturnsVariance() public view {
        bytes32 d = v.verify(spec, _sol());
        assertEq(uint256(d), uint256(nu), "at the optimum, w'Sw equals nu");
        assertEq(v.problemClass(), "markowitz.min-variance.long-only/v1");
    }

    function test_GasCostOfCertification() public {
        uint256 g = gasleft();
        v.verify(spec, _sol());
        uint256 used = g - gasleft();
        emit log_named_uint("gas to verify a 6-asset optimality certificate", used);
        assertLt(used, 300_000);
    }

    /// @dev THE THEOREM, fuzzed: whatever reallocation is attempted, if the checker accepts it then the
    ///      certified variance is within 2(2n+3+|nu|)tau of the true optimum (docs/ALGORITHMS.md section 4).
    function testFuzz_AcceptedImpliesEpsilonOptimal(uint256 i, uint256 j, uint256 delta) public {
        i = bound(i, 0, n - 1);
        j = bound(j, 0, n - 1);
        vm.assume(i != j);
        delta = bound(delta, 1, 0.5e18);
        vm.assume(w[i] >= int256(delta));
        int256 optimum = nu;
        w[i] -= int256(delta);
        w[j] += int256(delta);
        uint256 boundWad = 2 * (2 * n + 3) * tol + 2 * uint256(nu) * tol / 1e18;
        try v.verify(spec, _sol()) returns (bytes32 d) {
            assertLe(uint256(d), uint256(optimum) + boundWad, "accepted => epsilon-optimal");
        } catch {}
    }

    /// @dev Any material reallocation (>= 0.001% of the portfolio) is rejected outright.
    function testFuzz_MaterialReallocationIsRejected(uint256 i, uint256 j, uint256 delta) public {
        i = bound(i, 0, n - 1);
        j = bound(j, 0, n - 1);
        vm.assume(i != j);
        delta = bound(delta, 1e13, 0.5e18);
        vm.assume(w[i] >= int256(delta));
        w[i] -= int256(delta);
        w[j] += int256(delta);
        vm.expectRevert();
        v.verify(spec, _sol());
    }

    /// @dev An arbitrary long-only portfolio, dressed with the best-possible multipliers, must be rejected.
    function testFuzz_RandomPortfolioWithBestMultipliersIsRejected(uint256[6] memory raw) public {
        uint256 total;
        for (uint256 k; k < n; ++k) {
            raw[k] = bound(raw[k], 0, 1e18);
            total += raw[k];
        }
        vm.assume(total > 0);
        int256 sum;
        for (uint256 k; k < n; ++k) {
            w[k] = int256((raw[k] * 1e18) / total);
            sum += w[k];
        }
        w[0] += 1e18 - sum;
        int256 optimum = nu;
        // the forger's best move: make stationarity hold exactly with nu = min_i (Sigma w)_i
        int256 minG = type(int256).max;
        int256[] memory g = new int256[](n);
        for (uint256 a; a < n; ++a) {
            for (uint256 b; b < n; ++b) {
                g[a] += cov[a * n + b] * w[b];
            }
            g[a] /= 1e18;
            if (g[a] < minG) minG = g[a];
        }
        nu = minG;
        for (uint256 a; a < n; ++a) {
            mu[a] = g[a] - minG;
        }
        // Accept only if this really is the optimum to within tolerance; otherwise it must revert.
        try v.verify(spec, _sol()) returns (bytes32 d) {
            assertLe(uint256(d), uint256(optimum) + 1e10, "accepted implies optimal");
        } catch {}
    }

    function test_Revert_NegativeWeight_ShortSelling() public {
        w[3] = -1;
        w[1] += 1;
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.NegativeWeight.selector, 3, int256(-1)));
        v.verify(spec, _sol());
    }

    function test_Revert_BudgetViolated() public {
        w[1] += 1e10;
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.BudgetViolated.selector, int256(1e18 + 1e10)));
        v.verify(spec, _sol());
    }

    function test_Revert_NegativeMultiplier() public {
        mu[3] = -1;
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.NegativeMultiplier.selector, 3, int256(-1)));
        v.verify(spec, _sol());
    }

    function test_Revert_AsymmetricCovariance() public {
        cov[1] += 1;
        bytes memory s2 = abi.encode(n, cov, tol, universe);
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.CovarianceNotSymmetric.selector, 0, 1));
        v.verify(s2, _sol());
    }

    function test_Revert_ToleranceGames() public {
        bytes memory loose = abi.encode(n, cov, uint256(1e17), universe);
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.InvalidTolerance.selector, uint256(1e17)));
        v.verify(loose, _sol());
        bytes memory zero = abi.encode(n, cov, uint256(0), universe);
        vm.expectRevert(abi.encodeWithSelector(MinVarianceVerifier.InvalidTolerance.selector, uint256(0)));
        v.verify(zero, _sol());
    }

    function test_Revert_OverflowGames() public {
        nu = type(int256).max / 2;
        vm.expectRevert(MinVarianceVerifier.ValueOutOfRange.selector);
        v.verify(spec, _sol());
    }

    function test_Revert_DimensionMismatch() public {
        int256[] memory shortW = new int256[](5);
        bytes memory bad = abi.encode(shortW, nu, mu, L);
        vm.expectRevert(MinVarianceVerifier.DimensionMismatch.selector);
        v.verify(spec, bad);
    }
}
