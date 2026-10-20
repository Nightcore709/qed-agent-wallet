// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {QEDExecution, IV2Pair} from "../QEDExecution.sol";

/// @notice What the bounty needs from QEDExecution: its venue set and its bound, unchanged.
interface IBoundSource {
    function venues() external view returns (QEDExecution.Venue[] memory);
    function quoteBound(uint256 amountIn, address tokenOut, QEDExecution.Price[] calldata prices) external view returns (uint256);
}

/// @title  ExecutionBounty — money on the best-execution theorem (docs/ALGORITHMS.md §12.3)
/// @notice Holds a pool of the execution module's input token and pays ALL of its holdings to anyone who
///         shows, on the live venues, a route whose output beats the bound that `QEDExecution.quoteBound`
///         computes for the same input and prices. If the theorem and its integer implementation are
///         right — weak duality, path deficiency of the pools, every rounding step upward — no route can,
///         and every claim reverts with `TheoremHolds(output, bound)`.
///
///         The claim runs on this contract's own funds: it spends up to `amountIn` of the pool through the
///         owner's venues, exactly as QEDExecution would (same pair interface, same integer formula),
///         measures what arrived, and compares. A failed claim reverts, so nothing moves.
contract ExecutionBounty is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IBoundSource public immutable execution;
    IERC20 public immutable asset;
    uint256 public constant MAX_HOPS = 32;

    event Refuted(address indexed claimant, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 bound);

    error TheoremHolds(uint256 amountOut, uint256 bound);
    error InvalidClaim();
    error Overspent(uint256 spent, uint256 amountIn);
    error UnknownVenue(uint8 venue);

    constructor(IBoundSource execution_, IERC20 asset_) {
        execution = execution_;
        asset = asset_;
    }

    /// @param amountIn  how much of the pool the route may spend (the A of the theorem)
    /// @param prices    any price vector with ν(tokenOut) = 1e36; the bound holds for every one of them
    /// @param route     any route over the module's venues; amountIn = 0 spends all received of that token
    function claim(uint256 amountIn, address tokenOut, QEDExecution.Price[] calldata prices, QEDExecution.Hop[] calldata route)
        external
        nonReentrant
    {
        if (amountIn == 0 || tokenOut == address(asset) || route.length == 0 || route.length > MAX_HOPS) revert InvalidClaim();
        uint256 bound = execution.quoteBound(amountIn, tokenOut, prices);
        QEDExecution.Venue[] memory vs = execution.venues();

        // Every venue token, with this contract's holdings before the claim: the route may only use what
        // it receives (the theorem's Ψ_k ≥ 0), never the pool's other holdings.
        address[] memory tokens = new address[](2 * vs.length + 2);
        (tokens[0], tokens[1]) = (address(asset), tokenOut);
        uint256 n = 2;
        for (uint256 i; i < vs.length; ++i) {
            n = _add(tokens, n, vs[i].token0);
            n = _add(tokens, n, vs[i].token1);
        }
        uint256[] memory pre = new uint256[](n);
        for (uint256 k; k < n; ++k) pre[k] = IERC20(tokens[k]).balanceOf(address(this));
        if (amountIn > pre[0]) revert InvalidClaim();

        for (uint256 i; i < route.length; ++i) {
            QEDExecution.Hop calldata h = route[i];
            if (h.venue >= vs.length) revert UnknownVenue(h.venue);
            QEDExecution.Venue memory v = vs[h.venue];
            address tokenIn = h.zeroForOne ? v.token0 : v.token1;
            uint256 amt = h.amountIn;
            if (amt == 0) {
                // "everything received so far": for the input token, whatever is left of the amountIn budget
                // (plus anything bought back), exactly as in QEDExecution
                uint256 base = tokenIn == address(asset) ? pre[0] - amountIn : 0;
                for (uint256 k = 1; k < n; ++k) if (tokens[k] == tokenIn) base = pre[k];
                amt = IERC20(tokenIn).balanceOf(address(this)) - base;
            }
            (uint112 r0, uint112 r1,) = IV2Pair(v.pool).getReserves();
            (uint256 rIn, uint256 rOut) = h.zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 inWithFee = amt * (10_000 - v.feeBps);
            uint256 out = (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
            IERC20(tokenIn).safeTransfer(v.pool, amt);
            IV2Pair(v.pool).swap(h.zeroForOne ? 0 : out, h.zeroForOne ? out : 0, address(this), "");
        }

        uint256 assetAfter = asset.balanceOf(address(this));
        uint256 spent = pre[0] > assetAfter ? pre[0] - assetAfter : 0;
        if (spent > amountIn) revert Overspent(spent, amountIn);
        for (uint256 k = 2; k < n; ++k) {
            if (IERC20(tokens[k]).balanceOf(address(this)) < pre[k]) revert InvalidClaim();
        }
        uint256 outAfter = IERC20(tokenOut).balanceOf(address(this));
        uint256 amountOut = outAfter > pre[1] ? outAfter - pre[1] : 0;
        if (amountOut <= bound) revert TheoremHolds(amountOut, bound);

        // The theorem is false: everything this contract holds goes to the claimant.
        emit Refuted(msg.sender, amountIn, tokenOut, amountOut, bound);
        for (uint256 k; k < n; ++k) {
            uint256 bal = IERC20(tokens[k]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[k]).safeTransfer(msg.sender, bal);
        }
    }

    function _add(address[] memory buf, uint256 len, address t) private pure returns (uint256) {
        for (uint256 k; k < len; ++k) if (buf[k] == t) return len;
        buf[len] = t;
        return len + 1;
    }
}
