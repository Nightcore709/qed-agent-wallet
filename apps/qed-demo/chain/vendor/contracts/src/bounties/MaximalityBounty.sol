// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  MaximalityBounty — money on the clearing house's theorem
/// @notice Pays its entire balance to anyone who exhibits an agent economy, a netting that QEDClearing's
///         acceptance rule would execute as "proven maximal", and a strictly larger valid netting of the
///         same debts. That would refute weak LP duality (docs/ALGORITHMS.md §9.2):
///
///           for every circulation x' with 0 ≤ x' ≤ d,   Σx' ≤ Σ d·y   whenever  π_u − π_v + y_e ≥ 1, y ≥ 0.
///
///         `accepts` re-states QEDClearing.net's acceptance conditions line for line (same bounds, same
///         order, same errors), over an economy passed as calldata instead of contract storage; the test
///         suite checks the two agree on every generated economy.
contract MaximalityBounty is ReentrancyGuard {
    using SafeERC20 for IERC20;

    int256 internal constant POT_BOUND = 1 << 64;
    uint256 internal constant Y_BOUND = 1 << 64;
    uint256 internal constant MAX_EDGES = 128;
    uint256 internal constant MAX_MEMBERS = 64;

    IERC20 public immutable token;

    /// @notice One debt: `debtor` owes `creditor` the amount `d` (member indices).
    struct Economy {
        uint256 members;
        uint256[] debtor;
        uint256[] creditor;
        uint256[] d;
    }

    /// @notice A netting with its certificate, exactly as QEDClearing.net receives it.
    struct Certified {
        uint256[] x;
        int256[] potential;
        uint256[] y;
    }

    event Refuted(address indexed claimant, uint256 payout, uint256 provenMaximal, uint256 larger);

    error LengthMismatch();
    error BadEconomy();
    error ValueOutOfRange();
    error ExceedsObligation(uint256 index, uint256 cancelled, uint256 amount);
    error DualInfeasible(uint256 index);
    error NetPositionChanged(uint256 member, int256 delta);
    error NothingToNet();
    error NotProvablyMaximal(uint256 cleared, uint256 dualBound);
    error TheoremHolds(uint256 provenMaximal, uint256 larger);

    constructor(IERC20 token_) {
        token = token_;
    }

    /// @notice QEDClearing.net's acceptance rule. Returns the amount it would cancel, or reverts with its reason.
    function accepts(Economy calldata e, Certified calldata p) public pure virtual returns (uint256 cleared) {
        uint256 n = e.d.length;
        uint256 m = e.members;
        if (e.debtor.length != n || e.creditor.length != n || p.x.length != n || p.y.length != n || p.potential.length != m) {
            revert LengthMismatch();
        }
        if (n == 0 || n > MAX_EDGES || m < 2 || m > MAX_MEMBERS) revert BadEconomy();
        for (uint256 k; k < m; ++k) {
            int256 pk = p.potential[k];
            if (pk > POT_BOUND || pk < -POT_BOUND) revert ValueOutOfRange();
        }
        int256[] memory delta = new int256[](m);
        uint256 bound;
        for (uint256 i; i < n; ++i) {
            uint256 u = e.debtor[i];
            uint256 v = e.creditor[i];
            uint256 d = e.d[i];
            if (u >= m || v >= m || u == v || d == 0 || d > type(uint128).max) revert BadEconomy();
            uint256 xi = p.x[i];
            if (xi > d) revert ExceedsObligation(i, xi, d);
            uint256 yi = p.y[i];
            if (yi > Y_BOUND) revert ValueOutOfRange();
            if (p.potential[u] - p.potential[v] + int256(yi) < 1) revert DualInfeasible(i);
            delta[u] += int256(xi);
            delta[v] -= int256(xi);
            cleared += xi;
            bound += d * yi;
        }
        for (uint256 k; k < m; ++k) {
            if (delta[k] != 0) revert NetPositionChanged(k, delta[k]);
        }
        if (cleared == 0) revert NothingToNet();
        if (cleared != bound) revert NotProvablyMaximal(cleared, bound);
    }

    /// @notice Total of a netting that leaves every net position unchanged and cancels no debt below zero;
    ///         reverts otherwise.
    function validNetting(Economy calldata e, uint256[] calldata x) public pure returns (uint256 total) {
        uint256 n = e.d.length;
        if (x.length != n || e.debtor.length != n || e.creditor.length != n) revert LengthMismatch();
        int256[] memory delta = new int256[](e.members);
        for (uint256 i; i < n; ++i) {
            if (x[i] > e.d[i]) revert ExceedsObligation(i, x[i], e.d[i]);
            if (e.debtor[i] >= e.members || e.creditor[i] >= e.members) revert BadEconomy();
            delta[e.debtor[i]] += int256(x[i]);
            delta[e.creditor[i]] -= int256(x[i]);
            total += x[i];
        }
        for (uint256 k; k < e.members; ++k) {
            if (delta[k] != 0) revert NetPositionChanged(k, delta[k]);
        }
    }

    /// @notice Submit a refutation: an accepted (proven-maximal) netting and a strictly larger valid one.
    function claim(Economy calldata e, Certified calldata accepted, uint256[] calldata larger)
        external
        nonReentrant
        returns (uint256 payout)
    {
        uint256 proven = accepts(e, accepted);
        uint256 alt = validNetting(e, larger);
        if (alt <= proven) revert TheoremHolds(proven, alt);
        payout = token.balanceOf(address(this));
        emit Refuted(msg.sender, payout, proven, alt);
        token.safeTransfer(msg.sender, payout);
    }
}
