// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  QEDClearing — proof-gated multilateral netting for agent economies
/// @notice AI businesses owe each other money in cycles (A owes B, B owes C, C owes A). Settling every
///         obligation gross needs far more cash than anyone holds: the economy is in gridlock.
///         Netting cancels debts along cycles without moving a token, but whoever computes the
///         netting could be wrong, lazy or self-serving.
///
///         QEDClearing lets ANYONE submit a netting, and executes it only if it carries a proof that:
///           (1) every member's net position is exactly unchanged          (no value moves)
///           (2) no obligation is cut below zero, and none is created       (exposures only shrink)
///           (3) no larger netting exists                                   (maximality, exact)
///
///         (3) is a linear-programming duality certificate. The netting problem
///             maximise Σₑ xₑ   s.t.   Σ_out(v) x = Σ_in(v) x  ∀ members v,   0 ≤ xₑ ≤ dₑ
///         has the dual
///             minimise Σₑ dₑ·yₑ   s.t.   π_debtor(e) − π_creditor(e) + yₑ ≥ 1,   yₑ ≥ 0,
///         and weak duality gives Σₑ xₑ ≤ Σₑ dₑ·yₑ for every feasible pair. So a proposal whose
///         cancelled total EQUALS its dual bound is maximal. The constraint matrix is totally
///         unimodular, so integer potentials and multipliers always exist: the check is exact,
///         with no tolerance and no rounding.
///
///         Joining is explicit consent to exactly these rules (see TERMS). Netting is permissionless:
///         with (1)–(3) enforced by the contract, executing a valid proof can only help every member.
contract QEDClearing is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Obligation {
        address debtor;
        address creditor;
        uint128 amount; // outstanding, token units
        uint64 dueAt;
        bool open;
        bytes32 memo;
    }

    /// @notice A netting proposal plus its optimality certificate.
    struct Netting {
        uint256[] ids; //        every open obligation, strictly increasing
        uint128[] amounts; //    their current amounts: binds the proof to this exact state
        uint128[] x; //          amount cancelled on each obligation
        int256[] potential; //   dual potential π per member, indexed like `members`
        uint128[] y; //          dual multiplier y per obligation
    }

    bytes32 public constant TERMS = keccak256(
        "QED Clearing v1: I consent to any netting that leaves my net position unchanged, creates no new claim, and is proven maximal on-chain."
    );
    uint256 public constant MAX_OPEN = 128;
    uint256 public constant MAX_MEMBERS = 64;
    int256 internal constant POT_BOUND = 1 << 64;
    uint256 internal constant Y_BOUND = 1 << 64;

    IERC20 public immutable asset;

    address[] public members;
    mapping(address => uint256) public memberIndex; // 1-based; 0 = not a member
    mapping(uint256 => Obligation) internal _obligations;
    uint256 public obligationCount;
    uint256 public openCount;
    uint256 public grossOpen;
    uint256 public rounds;
    uint256 public totalCleared;

    event Joined(address indexed member, uint256 index, bytes32 terms);
    event Issued(uint256 indexed id, address indexed debtor, address indexed creditor, uint256 amount, uint64 dueAt, bytes32 memo);
    event Paid(uint256 indexed id, address indexed debtor, address indexed creditor, uint256 amount);
    event Reduced(uint256 indexed round, uint256 indexed id, uint256 cancelled, uint256 remaining);
    event Netted(uint256 indexed round, address indexed prover, uint256 obligations, uint256 grossBefore, uint256 cleared, uint256 grossAfter);

    error AlreadyMember(address member);
    error TooManyMembers();
    error NotMember(address account);
    error SelfObligation();
    error ZeroAmount();
    error TooManyOpenObligations();
    error NotDebtor(address caller);
    error NotOpen(uint256 id);
    error LengthMismatch();
    error IncompleteSnapshot(uint256 provided, uint256 open);
    error IdsNotIncreasing(uint256 index);
    error StaleAmount(uint256 id, uint256 provided, uint256 current);
    error ExceedsObligation(uint256 id, uint256 cancelled, uint256 amount);
    error ValueOutOfRange();
    error DualInfeasible(uint256 id);
    error NetPositionChanged(address member, int256 delta);
    error NothingToNet();
    error NotProvablyMaximal(uint256 cleared, uint256 dualBound);

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    // ───────────────────────────────── membership & obligations ─────────────────────────────────

    /// @notice Join the clearing house, consenting to TERMS.
    function join() external {
        if (memberIndex[msg.sender] != 0) revert AlreadyMember(msg.sender);
        if (members.length >= MAX_MEMBERS) revert TooManyMembers();
        members.push(msg.sender);
        memberIndex[msg.sender] = members.length;
        emit Joined(msg.sender, members.length - 1, TERMS);
    }

    /// @notice A member acknowledges a debt to another member. Nobody can create a debt for someone else.
    function issue(address creditor, uint128 amount, uint64 dueAt, bytes32 memo) external returns (uint256 id) {
        if (memberIndex[msg.sender] == 0) revert NotMember(msg.sender);
        if (memberIndex[creditor] == 0) revert NotMember(creditor);
        if (creditor == msg.sender) revert SelfObligation();
        if (amount == 0) revert ZeroAmount();
        if (openCount >= MAX_OPEN) revert TooManyOpenObligations();
        id = ++obligationCount;
        _obligations[id] = Obligation(msg.sender, creditor, amount, dueAt, true, memo);
        openCount += 1;
        grossOpen += amount;
        emit Issued(id, msg.sender, creditor, amount, dueAt, memo);
    }

    /// @notice The debtor settles an obligation in full with tokens.
    function pay(uint256 id) external nonReentrant {
        Obligation storage o = _obligations[id];
        if (!o.open) revert NotOpen(id);
        if (msg.sender != o.debtor) revert NotDebtor(msg.sender);
        uint256 amount = o.amount;
        o.amount = 0;
        o.open = false;
        openCount -= 1;
        grossOpen -= amount;
        asset.safeTransferFrom(o.debtor, o.creditor, amount);
        emit Paid(id, o.debtor, o.creditor, amount);
    }

    // ───────────────────────────────── proof-gated netting ─────────────────────────────────

    /// @notice Execute a netting. Reverts with the precise failed condition unless the proposal covers
    ///         every open obligation at its current amount, leaves every member's net position unchanged,
    ///         and carries a dual certificate whose bound equals the amount cleared.
    function net(Netting calldata p) external nonReentrant returns (uint256 cleared) {
        uint256 n = p.ids.length;
        uint256 m = members.length;
        if (p.amounts.length != n || p.x.length != n || p.y.length != n || p.potential.length != m) {
            revert LengthMismatch();
        }
        if (n != openCount) revert IncompleteSnapshot(n, openCount);
        for (uint256 k; k < m; ++k) {
            int256 pk = p.potential[k];
            if (pk > POT_BOUND || pk < -POT_BOUND) revert ValueOutOfRange();
        }

        int256[] memory delta = new int256[](m); // cancelled payables − cancelled receivables
        uint256 bound;
        uint256 prev;
        for (uint256 i; i < n; ++i) {
            uint256 id = p.ids[i];
            if (i > 0 && id <= prev) revert IdsNotIncreasing(i);
            prev = id;
            Obligation storage o = _obligations[id];
            if (!o.open) revert NotOpen(id);
            uint256 d = o.amount;
            if (p.amounts[i] != d) revert StaleAmount(id, p.amounts[i], d);
            uint256 xi = p.x[i];
            if (xi > d) revert ExceedsObligation(id, xi, d);
            uint256 yi = p.y[i];
            if (yi > Y_BOUND) revert ValueOutOfRange();
            uint256 u = memberIndex[o.debtor] - 1;
            uint256 v = memberIndex[o.creditor] - 1;
            // dual feasibility: π_u − π_v + y ≥ 1
            if (p.potential[u] - p.potential[v] + int256(yi) < 1) revert DualInfeasible(id);
            delta[u] += int256(xi);
            delta[v] -= int256(xi);
            cleared += xi;
            bound += d * yi;
        }
        for (uint256 k; k < m; ++k) {
            if (delta[k] != 0) revert NetPositionChanged(members[k], delta[k]);
        }
        if (cleared == 0) revert NothingToNet();
        if (cleared != bound) revert NotProvablyMaximal(cleared, bound);

        uint256 round = ++rounds;
        uint256 grossBefore = grossOpen;
        for (uint256 i; i < n; ++i) {
            uint256 xi = p.x[i];
            if (xi == 0) continue;
            Obligation storage o = _obligations[p.ids[i]];
            o.amount -= uint128(xi);
            if (o.amount == 0) {
                o.open = false;
                openCount -= 1;
            }
            emit Reduced(round, p.ids[i], xi, o.amount);
        }
        grossOpen = grossBefore - cleared;
        totalCleared += cleared;
        emit Netted(round, msg.sender, n, grossBefore, cleared, grossOpen);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function getObligation(uint256 id) external view returns (Obligation memory) {
        return _obligations[id];
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function allMembers() external view returns (address[] memory) {
        return members;
    }

    /// @notice Every open obligation, in id order — exactly the snapshot a netting proof must cover.
    function openObligations() external view returns (uint256[] memory ids, Obligation[] memory obs) {
        ids = new uint256[](openCount);
        obs = new Obligation[](openCount);
        uint256 j;
        for (uint256 id = 1; id <= obligationCount && j < openCount; ++id) {
            if (_obligations[id].open) {
                ids[j] = id;
                obs[j] = _obligations[id];
                ++j;
            }
        }
    }

    /// @notice Receivables and payables per member. Netting never changes receivable − payable.
    function positions() external view returns (address[] memory who, uint256[] memory receivable, uint256[] memory payable_) {
        uint256 m = members.length;
        who = members;
        receivable = new uint256[](m);
        payable_ = new uint256[](m);
        for (uint256 id = 1; id <= obligationCount; ++id) {
            Obligation storage o = _obligations[id];
            if (!o.open) continue;
            receivable[memberIndex[o.creditor] - 1] += o.amount;
            payable_[memberIndex[o.debtor] - 1] += o.amount;
        }
    }
}
