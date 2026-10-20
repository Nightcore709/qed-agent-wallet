// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {QEDVault} from "./QEDVault.sol";
import {QEDExecution, IV2Pair} from "./QEDExecution.sol";

/// @title  QEDTreasuryPolicy — the owner's standing conversion policy, enforced by the chain
/// @notice The owner states an objective once: keep at least `targetFree` of the reserve's token free (not
///         ring-fenced) in the reserve vault, converting from the treasury in tranches of `minTranche` to
///         `maxTranche`, at an execution cost of at most `maxImpactBps` against the venues' mid price.
///         From then on the agent decides when and how much to convert. This contract is QEDExecution's
///         operator, so the agent's hot key can trade only through `convert`, which refuses, in the same
///         transaction as the trade:
///           · a conversion when the reserve already meets its target            (NoShortfall)
///           · a tranche outside the owner's bounds                              (TrancheOutOfBounds)
///           · a tranche that cost more than κ against the depth-weighted mid    (ExecutionCostTooHigh)
///           · a tranche provably larger than the shortfall required              (OverConversion)
///         on top of everything QEDVault (mandate, co-signer, caps, solvency) and QEDExecution (best
///         execution within τ of the bound, nothing left behind) already enforce.
///
///         Over-conversion is decided without solving anything: the best achievable output OPT(x) of the
///         owner's venues is concave in the input with OPT(0) = 0, so for a smaller tranche a' < a,
///         OPT(a') ≥ (a'/a)·OPT(a) ≥ (a'/a)·out. If that lower bound already covers the shortfall, the trade
///         converted more than needed: a' = a·(1 − needSlackBps/10⁴) would have sufficed. (Concavity holds
///         for the continuous routing problem; integer rounding moves outputs by raw units, far inside the slack.)
///
///         Execution cost is measured against the depth-weighted mid price of the venues that trade the pair
///         directly, read before the trade: mid = Σ R_out / Σ R_in, so out ≥ a·mid·(1 − κ).
contract QEDTreasuryPolicy {
    struct Policy {
        uint256 targetFree; //   keep at least this much of tokenOut free in the reserve
        uint256 minTranche; //   smallest conversion, in the treasury's asset
        uint256 maxTranche; //   largest conversion, in the treasury's asset
        uint16 maxImpactBps; //  κ: most a tranche may pay against the mid price
        uint16 needSlackBps; //  how much larger than needed a tranche may provably be
        uint64 validUntil; //    the policy lapses after this time
    }

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_IMPACT_BPS = 1_000;
    uint16 public constant MAX_SLACK_BPS = 1_000;

    QEDExecution public immutable execution;
    QEDVault public immutable treasury;
    QEDVault public immutable reserve;
    address public immutable tokenIn;
    address public immutable tokenOut;

    address public agent;
    Policy public policy;
    uint256 public policyNonce;

    event PolicySet(uint256 indexed nonce, uint256 targetFree, uint256 minTranche, uint256 maxTranche, uint16 maxImpactBps, uint16 needSlackBps, uint64 validUntil);
    event AgentSet(address indexed agent);
    event PolicyConversion(
        bytes32 indexed intentId,
        uint256 indexed nonce,
        uint256 amountIn,
        uint256 amountOut,
        uint256 midOut,
        uint256 freeBefore,
        uint256 freeAfter
    );

    error NotOwner(address caller);
    error NotAgent(address caller);
    error ZeroAddress();
    error InvalidPolicy();
    error PolicyLapsed(uint64 validUntil, uint256 nowTs);
    error WrongOrder(address tokenOut, address recipient);
    error TrancheOutOfBounds(uint256 amount, uint256 minTranche, uint256 maxTranche);
    error NoShortfall(uint256 free, uint256 target);
    error NoDirectVenue();
    error ExecutionCostTooHigh(uint256 amountOut, uint256 midOut, uint16 maxImpactBps);
    error OverConversion(uint256 freeBefore, uint256 amountOut, uint256 target);
    error ReserveMismatch(uint256 expected, uint256 actual);

    constructor(QEDExecution execution_, QEDVault reserve_, address agent_) {
        if (address(execution_) == address(0) || address(reserve_) == address(0) || agent_ == address(0)) revert ZeroAddress();
        execution = execution_;
        treasury = execution_.vault();
        reserve = reserve_;
        tokenIn = address(execution_.asset());
        tokenOut = address(reserve_.asset());
        agent = agent_;
        emit AgentSet(agent_);
    }

    modifier onlyOwner() {
        if (msg.sender != treasury.owner()) revert NotOwner(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice States (or replaces) the standing policy. Only the treasury vault's owner.
    function setPolicy(Policy calldata p) external onlyOwner {
        if (p.minTranche == 0 || p.minTranche > p.maxTranche || p.maxImpactBps > MAX_IMPACT_BPS || p.needSlackBps > MAX_SLACK_BPS || p.targetFree == 0) {
            revert InvalidPolicy();
        }
        policy = p;
        unchecked {
            ++policyNonce;
        }
        emit PolicySet(policyNonce, p.targetFree, p.minTranche, p.maxTranche, p.maxImpactBps, p.needSlackBps, p.validUntil);
    }

    /// @notice Ends the policy at once.
    function revoke() external onlyOwner {
        policy.validUntil = 0;
        emit PolicySet(policyNonce, policy.targetFree, policy.minTranche, policy.maxTranche, policy.maxImpactBps, policy.needSlackBps, 0);
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentSet(agent_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Agent
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice One tranche under the policy. The certificate, order, route and prices are exactly those of
    ///         QEDExecution.trade; this contract adds the policy's checks around it.
    function convert(
        QEDVault.Mandate calldata m,
        bytes calldata ownerSig,
        QEDVault.Certificate calldata c,
        bytes calldata cosignerSig,
        QEDExecution.Order calldata order,
        QEDExecution.Hop[] calldata route,
        QEDExecution.Price[] calldata prices
    ) external returns (uint256 amountOut) {
        if (msg.sender != agent) revert NotAgent(msg.sender);
        Policy memory p = policy;
        if (block.timestamp > p.validUntil) revert PolicyLapsed(p.validUntil, block.timestamp);
        if (order.tokenOut != tokenOut || order.recipient != address(reserve)) revert WrongOrder(order.tokenOut, order.recipient);
        uint256 a = c.amount;
        if (a < p.minTranche || a > p.maxTranche) revert TrancheOutOfBounds(a, p.minTranche, p.maxTranche);

        // 1 · a shortfall must exist now
        uint256 freeBefore = reserve.freeBalance();
        if (freeBefore >= p.targetFree) revert NoShortfall(freeBefore, p.targetFree);

        // 2 · the mid-price reference, from the direct venues' reserves before the trade
        uint256 refOut = _midOut(a);

        // 3 · the trade itself: mandate, co-signer, caps, solvency, best execution
        (amountOut, ) = execution.trade(m, ownerSig, c, cosignerSig, order, route, prices);

        // 4 · execution cost within κ of the mid price
        if (amountOut * BPS < refOut * (BPS - p.maxImpactBps)) revert ExecutionCostTooHigh(amountOut, refOut, p.maxImpactBps);

        // 5 · no provable over-conversion: OPT(a') ≥ out·a'/a for a' = a·(1 − slack)
        uint256 smaller = a - (a * p.needSlackBps) / BPS;
        if (freeBefore * a + amountOut * smaller >= p.targetFree * a) revert OverConversion(freeBefore, amountOut, p.targetFree);

        // 6 · the reserve received exactly the output, and it stays free (not ring-fenced)
        uint256 freeAfter = reserve.freeBalance();
        if (freeAfter != freeBefore + amountOut) revert ReserveMismatch(freeBefore + amountOut, freeAfter);
        emit PolicyConversion(c.intentId, policyNonce, a, amountOut, refOut, freeBefore, freeAfter);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice What `amountIn` would buy at the direct venues' depth-weighted mid price (rounded down).
    function midOut(uint256 amountIn) external view returns (uint256) {
        return _midOut(amountIn);
    }

    /// @notice The reserve's current shortfall against the policy's target (0 if met).
    function shortfall() external view returns (uint256) {
        uint256 free = reserve.freeBalance();
        return free >= policy.targetFree ? 0 : policy.targetFree - free;
    }

    function _midOut(uint256 amountIn) private view returns (uint256) {
        QEDExecution.Venue[] memory vs = execution.venues();
        uint256 depthIn;
        uint256 depthOut;
        for (uint256 i; i < vs.length; ++i) {
            bool zIn = vs[i].token0 == tokenIn && vs[i].token1 == tokenOut;
            bool zOut = vs[i].token0 == tokenOut && vs[i].token1 == tokenIn;
            if (!zIn && !zOut) continue;
            (uint112 r0, uint112 r1, ) = IV2Pair(vs[i].pool).getReserves();
            depthIn += zIn ? r0 : r1;
            depthOut += zIn ? r1 : r0;
        }
        if (depthIn == 0) revert NoDirectVenue();
        return Math.mulDiv(amountIn, depthOut, depthIn);
    }
}
