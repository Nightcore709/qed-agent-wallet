// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @title  OptimalityBounty — money on a theorem
/// @notice Pays its entire balance to anyone who refutes Theorem 4.4 of docs/ALGORITHMS.md on-chain:
///
///           "If MinVarianceVerifier accepts a certificate (w, ν, μ, L) with tolerance τ, then for every
///            feasible portfolio x:   ½wᵀΣw − ½xᵀΣx ≤ τ(|ν| + 3 + τ) + ½·n·τ·(2 + τ)²."
///
///         A claim is a certificate the deployed verifier accepts plus a feasible portfolio x that beats it
///         by more than that bound. The contract re-runs the verifier, checks x, computes both objectives
///         and the bound in exact integers, and pays out with no human in the loop. If the theorem is true,
///         every claim reverts with `TheoremHolds(advantage, bound)`, which itself shows by how much.
///
/// @dev    Integers, no rounding. With W = 1e18, F(v) = vᵀΣv at scale W³ and t = τ·W, the refutation test
///             F(w) − F(x)  >  2·t·W·(|ν| + 3W + t) + n·t·(2W + t)²
///         is the theorem's inequality multiplied by 2W³. Inputs are bounded by the verifier
///         (|Σᵢⱼ| ≤ 1e27, τ ≤ 1e-2, n ≤ 16) and x ≥ 0 with Σx = W, so no expression can overflow.
contract OptimalityBounty is ReentrancyGuard {
    using SafeERC20 for IERC20;

    int256 internal constant W = 1e18;

    IProofVerifier public immutable verifier;
    IERC20 public immutable token;

    event Refuted(address indexed claimant, uint256 payout, int256 advantage, int256 bound);

    error NotFeasible();
    error TheoremHolds(int256 advantage, int256 bound);

    constructor(IProofVerifier verifier_, IERC20 token_) {
        verifier = verifier_;
        token = token_;
    }

    /// @notice The bound of Theorem 4.4, scaled by 2W³, for a certificate with multiplier ν and tolerance τ.
    function scaledBound(uint256 n, int256 nu, uint256 tol) public pure returns (int256) {
        int256 t = int256(tol);
        int256 absNu = nu < 0 ? -nu : nu;
        return 2 * t * W * (absNu + 3 * W + t) + int256(n) * t * (2 * W + t) * (2 * W + t);
    }

    /// @notice Submit a refutation. Reverts unless (spec, solution) is accepted by the verifier AND x beats it
    ///         by more than the theorem allows; otherwise pays the whole bounty to the caller.
    function claim(bytes calldata spec, bytes calldata solution, int256[] calldata x)
        external
        nonReentrant
        returns (uint256 payout)
    {
        verifier.verify(spec, solution); // bubbles up the verifier's own error for a bad certificate

        (uint256 n, int256[] memory cov, uint256 tol,) = abi.decode(spec, (uint256, int256[], uint256, bytes32));
        (int256[] memory w, int256 nu,,) = abi.decode(solution, (int256[], int256, int256[], int256[]));

        if (x.length != n) revert NotFeasible();
        int256 sumX;
        for (uint256 i; i < n; ++i) {
            if (x[i] < 0) revert NotFeasible();
            sumX += x[i];
        }
        if (sumX != W) revert NotFeasible();

        int256 advantage = _quad(n, cov, w) - _quad(n, cov, x);
        int256 bound = scaledBound(n, nu, tol);
        if (advantage <= bound) revert TheoremHolds(advantage, bound);

        payout = token.balanceOf(address(this));
        emit Refuted(msg.sender, payout, advantage, bound);
        token.safeTransfer(msg.sender, payout);
    }

    function _quad(uint256 n, int256[] memory cov, int256[] memory v) private pure returns (int256 s) {
        for (uint256 i; i < n; ++i) {
            int256 row;
            for (uint256 j; j < n; ++j) row += cov[i * n + j] * v[j];
            s += v[i] * row;
        }
    }
}
