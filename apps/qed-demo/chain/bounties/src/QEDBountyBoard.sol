// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title  QEDBountyBoard: refutation bounties that pay the committed finder, not whoever copies a claim first
/// @notice LOCAL RESEARCH CONTRACT for the QED wallet's local chain (R11 section 9, R10-009). Not audited. It is
///         deployed only on the wallet's local Anvil chain; nothing here is, or may be, deployed on a public network
///         without the owner's approval.
///
///         The release's OptimalityBounty and MaximalityBounty pay their whole balance to `msg.sender` of the first
///         valid claim, and a claim's validity depends only on its calldata, so whoever copies a pending claim and is
///         mined first is paid. This board keeps each bounty's pool itself and uses an UNMODIFIED release bounty as the
///         bounty's JUDGE. The judge holds nothing between transactions: inside a reveal the board lends it the pool,
///         calls it with the revealed claim, and requires the whole pool back, which the judge pays only to its caller
///         and only for a valid claim. So the refutation condition is exactly the release's, and only this board's
///         commit and reveal decide who is paid:
///
///         1. commit(bountyId, c) with c = commitmentOf(bountyId, claimant, recipient, claim, salt): an EIP-712 digest
///            whose domain binds this chain's id and this contract's address, over the bounty id, the claimant, the
///            recipient of the pool, the exact calldata of the judge's claim and a secret random salt. The board
///            records c under msg.sender, with a global sequence number and the time.
///         2. reveal(bountyId, recipient, claim, salt), sent by the claimant, no earlier than `revealDelay` seconds
///            after its commit and before `revealWindow` more seconds have passed (the commitment then expires). The
///            judge rules on `claim`, and its own error (e.g. TheoremHolds) comes back unchanged. The first valid
///            reveal becomes the provisional winner and opens a contest of `contestWindow` seconds; inside it, a valid
///            reveal takes over only if its commitment is strictly older. A commitment is revealed at most once.
///         3. settle(bountyId), by anyone, once the contest has closed: the whole pool goes to the winner's recipient.
///
///         Why a copier is not paid: it learns the claim only from the finder's reveal, so any commitment it can make
///         is younger than the finder's; a copied reveal recomputes the digest with the copier as claimant, which
///         matches no record; a copied commit is recorded under the copier's own address and has no preimage the
///         copier could reveal; a claim sent straight to the judge is paid the judge's balance, which is zero.
///
/// @dev    Limits, each exercised in test/: the finder is paid if its reveal is included within
///         revealDelay + contestWindow seconds of being broadcast (and before its commitment expires), so a block
///         producer who censors it longer can let a copier win; a reveal broadcast before its commitment is old enough
///         reverts but still publishes the claim; tokens sent straight to a judge are not protected until the next
///         reveal sweeps them into the pool; fee-on-transfer tokens make every reveal revert (the pool cannot come back
///         whole), so they cannot be claimed; once settled, a bounty takes no more funds, commitments or reveals.
///         No owner of the pools, no pause, no withdrawal: like the release's bounties, a funded pool leaves only through
///         settle(). Because of that, a judge that never pays back (it keeps the loan, or refuses every claim) would
///         strand its bounty's money for good. So `open` accepts only judges whose runtime code hash (EXTCODEHASH, which
///         covers the judge's immutables: its token and verifier) is on an allowlist (R13). The deployer sets the list at
///         construction (on the wallet's chain: the judges it opens) and may change it later; a change affects only
///         bounties opened after it. The deployer can do nothing else.
/// @notice A judge `open` accepts (R13): its runtime code hash (EXTCODEHASH) and its claim function, the one function a
///         reveal may call on it. Review fix F7: the claim function is the judge's own, not the opener's choice.
struct Judge {
    bytes32 codeHash;
    bytes4 claimSelector;
}

contract QEDBountyBoard is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The EIP-712 type of a commitment. `claim` is the exact calldata the judge is called with; EIP-712
    ///         encodes a `bytes` member as its keccak256.
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(uint256 bountyId,address claimant,address recipient,bytes claim,bytes32 salt)");

    /// @notice Upper bound of each period, so that no time arithmetic can overflow and no bounty can be configured
    ///         to be unrevealable for centuries.
    uint256 public constant MAX_PERIOD = 365 days;

    enum Phase {
        None, //        no such bounty
        Open, //        commitments and reveals accepted; no valid reveal yet
        Contest, //     a provisional winner; only a strictly older commitment can take over until contestEndsAt
        Settleable, //  the contest has closed; settle() pays the winner's recipient
        Settled //      paid; closed for good
    }

    struct Bounty {
        address judge; //          an unmodified refutation contract that pays its whole balance to its caller iff a claim is valid
        uint64 revealDelay; //     seconds a commitment must age before it may be revealed
        IERC20 token; //           the pool's token
        uint64 revealWindow; //    seconds after that during which it may be revealed; then it expires
        address winner; //         the provisional (then final) winner: the claimant of the oldest valid reveal so far
        uint64 contestWindow; //   seconds after the first valid reveal during which an older commitment may take over
        address recipient; //      where the winner's commitment sends the pool
        uint64 winnerSeq; //       sequence number of the winner's commitment
        bytes4 selector; //        the judge's claim function: a reveal may call nothing else on it
        uint64 contestEndsAt; //   first second at which settle() pays; 0 before the first valid reveal
        bool settled;
        uint256 pool; //           tokens held for this bounty (internal accounting, not balanceOf)
        uint256 paid; //           what settle() paid
    }

    struct Commitment {
        uint64 seq; //       global order of recording, from 1; 0 = no such commitment
        uint64 at; //        block.timestamp when it was recorded
        uint64 bountyId; //  the bounty it was recorded for
        bool revealed;
    }

    /// @notice Bounties by id, from 1.
    mapping(uint256 bountyId => Bounty) public bounties;
    uint256 public bountyCount;

    /// @notice Commitments by the address that recorded them, then by digest. A digest recorded by another address is
    ///         a different record: copying someone's commit records nothing they could ever reveal.
    mapping(address claimant => mapping(bytes32 commitment => Commitment)) public commitments;
    uint64 public commitCount;

    /// @notice The address that deployed this board (R13). It may change which judges NEW bounties may use, and nothing
    ///         else: a bounty's judge, pool, commitments and payout never depend on it once the bounty is open.
    address public immutable deployer;
    /// @notice The claim function of each contract `open` accepts as a judge, by runtime code hash (EXTCODEHASH); zero
    ///         when it is not accepted (R13).
    mapping(bytes32 codeHash => bytes4 claimSelector) public judgeClaim;

    event BountyOpened(
        uint256 indexed bountyId,
        address indexed judge,
        address indexed token,
        bytes4 selector,
        uint64 revealDelay,
        uint64 revealWindow,
        uint64 contestWindow,
        address opener
    );
    event Funded(uint256 indexed bountyId, address indexed from, uint256 amount, uint256 pool);
    event Committed(
        uint256 indexed bountyId,
        address indexed claimant,
        bytes32 indexed commitment,
        uint64 seq,
        uint64 revealableAt,
        uint64 expiresAt
    );
    event Revealed(
        uint256 indexed bountyId,
        address indexed claimant,
        bytes32 indexed commitment,
        address recipient,
        uint64 seq,
        uint64 contestEndsAt,
        address replaced
    );
    event Settled(uint256 indexed bountyId, address indexed winner, address indexed recipient, uint256 payout);
    event JudgeSet(bytes32 indexed codeHash, bytes4 claimSelector);

    error BadConfig();
    error UnknownBounty(uint256 bountyId);
    error BountyClosed(uint256 bountyId);
    error ContestUnderway(uint64 contestEndsAt);
    error ZeroAmount();
    error NothingReceived();
    error ZeroCommitment();
    error AlreadyCommitted(bytes32 commitment);
    error NoCommitment(bytes32 commitment);
    error AlreadyRevealed(bytes32 commitment);
    error TooEarly(uint64 revealableAt);
    error Expired(uint64 expiresAt);
    error BadRecipient(address recipient);
    error WrongSelector(bytes4 expected);
    error WrongToken(address judgeToken);
    error NotFirst(uint64 winnerSeq);
    error ContestClosed(uint64 contestEndsAt);
    error EmptyPool();
    error PoolNotReturned();
    error NoWinner();
    error ContestOpen(uint64 contestEndsAt);
    error AlreadySettled();
    error NotDeployer(address caller);
    error JudgeNotAllowed(address judge, bytes32 codeHash);

    /// @param allowedJudges the judges `open` accepts from the start: each one's runtime code hash and claim function.
    constructor(Judge[] memory allowedJudges) EIP712("QED Bounty Board", "1") {
        deployer = msg.sender;
        for (uint256 i; i < allowedJudges.length; ++i) {
            _setJudge(allowedJudges[i].codeHash, allowedJudges[i].claimSelector);
        }
    }

    /// @notice Allow a judge's runtime code hash with its claim function, or disallow it (zero), for bounties opened from
    ///         now on. The deployer only. A bounty already open keeps its judge and claim function whatever this list
    ///         says later, so no change here can strand a pool.
    function setJudge(bytes32 codeHash, bytes4 claimSelector) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        _setJudge(codeHash, claimSelector);
    }

    // ───────────────────────────── opening and funding ─────────────────────────────

    /// @notice Open a bounty judged by `judge` (an unmodified refutation contract whose `selector` function pays its
    ///         whole balance of `token` to its caller for a valid claim and reverts otherwise). Anyone may open one, with
    ///         a judge whose runtime code hash is allowed (R13), with that judge's own claim function and its own token
    ///         (review fix F7: otherwise no reveal could ever succeed, and the pool, which nobody can withdraw, would be
    ///         stranded); bounties never share accounting, so a bounty cannot affect another. The configuration never
    ///         changes.
    function open(address judge, IERC20 token, bytes4 selector, uint64 revealDelay, uint64 revealWindow, uint64 contestWindow)
        external
        nonReentrant
        returns (uint256 bountyId)
    {
        if (
            judge.code.length == 0 || address(token).code.length == 0 || judge == address(this)
                || judge == address(token) || selector == bytes4(0) || revealDelay == 0 || revealDelay > MAX_PERIOD
                || revealWindow == 0 || revealWindow > MAX_PERIOD || contestWindow == 0 || contestWindow > MAX_PERIOD
        ) revert BadConfig();
        bytes32 codeHash = judge.codehash;
        bytes4 claimSelector = judgeClaim[codeHash];
        if (claimSelector == bytes4(0)) revert JudgeNotAllowed(judge, codeHash);
        if (selector != claimSelector) revert WrongSelector(claimSelector);
        address judgeToken = _tokenOf(judge);
        if (judgeToken != address(token)) revert WrongToken(judgeToken);
        bountyId = ++bountyCount;
        Bounty storage b = bounties[bountyId];
        b.judge = judge;
        b.token = token;
        b.selector = selector;
        b.revealDelay = revealDelay;
        b.revealWindow = revealWindow;
        b.contestWindow = contestWindow;
        emit BountyOpened(bountyId, judge, address(token), selector, revealDelay, revealWindow, contestWindow, msg.sender);
    }

    /// @notice Add `amount` of the bounty's token to its pool (pulled from the caller; what arrives is counted).
    ///         Anyone may fund an unsettled bounty. Nobody can withdraw.
    function fund(uint256 bountyId, uint256 amount) external nonReentrant returns (uint256 received) {
        Bounty storage b = _bounty(bountyId);
        if (b.settled) revert BountyClosed(bountyId);
        if (amount == 0) revert ZeroAmount();
        IERC20 t = b.token;
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        received = t.balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();
        b.pool += received;
        emit Funded(bountyId, msg.sender, received, b.pool);
    }

    // ───────────────────────────── commit, reveal, settle ─────────────────────────────

    /// @notice The commitment a claimant records: the EIP-712 digest of Claim(bountyId, claimant, recipient, claim, salt)
    ///         under this contract's domain (name "QED Bounty Board", version "1", this chain's id, this address).
    ///         `salt` must be secret and random until the reveal: a guessable claim could otherwise be recovered.
    function commitmentOf(uint256 bountyId, address claimant, address recipient, bytes calldata claim, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, bountyId, claimant, recipient, keccak256(claim), salt)));
    }

    /// @notice Record a commitment for an open bounty, under the sender. Refused once a provisional winner exists,
    ///         because a commitment recorded now would be younger than the winner's and could never take over.
    function commit(uint256 bountyId, bytes32 commitment) external nonReentrant returns (uint64 seq) {
        Bounty storage b = _bounty(bountyId);
        if (b.settled) revert BountyClosed(bountyId);
        if (b.winner != address(0)) revert ContestUnderway(b.contestEndsAt);
        if (commitment == bytes32(0)) revert ZeroCommitment();
        Commitment storage c = commitments[msg.sender][commitment];
        if (c.seq != 0) revert AlreadyCommitted(commitment);
        seq = ++commitCount;
        c.seq = seq;
        c.at = uint64(block.timestamp);
        c.bountyId = uint64(bountyId);
        emit Committed(
            bountyId,
            msg.sender,
            commitment,
            seq,
            uint64(block.timestamp + b.revealDelay),
            uint64(block.timestamp + b.revealDelay + b.revealWindow)
        );
    }

    /// @notice Reveal a committed claim, as its claimant. Reverts unless the judge accepts the claim (with the judge's
    ///         own error), unless the commitment is old enough and not expired, and unless it is the oldest valid one so
    ///         far while the contest is open.
    function reveal(uint256 bountyId, address recipient, bytes calldata claim, bytes32 salt) external nonReentrant {
        Bounty storage b = _bounty(bountyId);
        if (b.settled) revert AlreadySettled();
        bytes32 h = commitmentOf(bountyId, msg.sender, recipient, claim, salt);
        Commitment storage c = commitments[msg.sender][h];
        if (c.seq == 0 || c.bountyId != bountyId) revert NoCommitment(h);
        if (c.revealed) revert AlreadyRevealed(h);
        uint256 revealableAt = uint256(c.at) + b.revealDelay;
        if (block.timestamp < revealableAt) revert TooEarly(uint64(revealableAt));
        uint256 expiresAt = revealableAt + b.revealWindow;
        if (block.timestamp >= expiresAt) revert Expired(uint64(expiresAt));
        if (recipient == address(0) || recipient == address(this) || recipient == b.judge) revert BadRecipient(recipient);
        if (claim.length < 4 || bytes4(claim[:4]) != b.selector) revert WrongSelector(b.selector);

        address replaced = b.winner;
        if (replaced == address(0)) {
            b.contestEndsAt = uint64(block.timestamp + b.contestWindow);
        } else {
            if (block.timestamp >= b.contestEndsAt) revert ContestClosed(b.contestEndsAt);
            if (c.seq >= b.winnerSeq) revert NotFirst(b.winnerSeq);
        }
        c.revealed = true;
        b.winner = msg.sender;
        b.recipient = recipient;
        b.winnerSeq = c.seq;
        emit Revealed(bountyId, msg.sender, h, recipient, c.seq, b.contestEndsAt, replaced);
        _judge(b, claim); // last: if the judge rejects the claim, everything above is undone
    }

    /// @notice Pay the whole pool to the winner's recipient once the contest has closed. Anyone may call it; it can only
    ///         pay the recorded recipient, once.
    function settle(uint256 bountyId) external nonReentrant returns (uint256 payout) {
        Bounty storage b = _bounty(bountyId);
        if (b.settled) revert AlreadySettled();
        address w = b.winner;
        if (w == address(0)) revert NoWinner();
        if (block.timestamp < b.contestEndsAt) revert ContestOpen(b.contestEndsAt);
        b.settled = true;
        payout = b.pool;
        b.pool = 0;
        b.paid = payout;
        address to = b.recipient;
        emit Settled(bountyId, w, to, payout);
        b.token.safeTransfer(to, payout);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Where a bounty stands now.
    function phase(uint256 bountyId) external view returns (Phase) {
        Bounty storage b = bounties[bountyId];
        if (b.judge == address(0)) return Phase.None;
        if (b.settled) return Phase.Settled;
        if (b.winner == address(0)) return Phase.Open;
        return block.timestamp < b.contestEndsAt ? Phase.Contest : Phase.Settleable;
    }

    /// @notice The EIP-712 domain separator of this chain and this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _setJudge(bytes32 codeHash, bytes4 claimSelector) private {
        // zero: no account at all; keccak256(""): an account without code. Neither can ever judge.
        if (codeHash == bytes32(0) || codeHash == keccak256("")) revert BadConfig();
        judgeClaim[codeHash] = claimSelector;
        emit JudgeSet(codeHash, claimSelector);
    }

    /// @dev The token a judge pays out (its `token()`; every allowed judge of the release has one), or zero if it has
    ///      none: then no token matches and `open` refuses.
    function _tokenOf(address judge) private view returns (address t) {
        (bool ok, bytes memory ret) = judge.staticcall(abi.encodeWithSignature("token()"));
        if (ok && ret.length == 32) t = abi.decode(ret, (address));
    }

    function _bounty(uint256 bountyId) private view returns (Bounty storage b) {
        b = bounties[bountyId];
        if (b.judge == address(0)) revert UnknownBounty(bountyId);
    }

    /// @dev Lend the whole pool to the judge for one call. A valid claim makes the judge pay its whole balance to its
    ///      caller, which is this contract; anything else reverts, and the revert undoes the loan. Tokens the judge held
    ///      beforehand (sent to it directly) come back with the pool and are added to it.
    function _judge(Bounty storage b, bytes calldata claim) private {
        uint256 lent = b.pool;
        if (lent == 0) revert EmptyPool();
        IERC20 t = b.token;
        address judge = b.judge;
        uint256 before = t.balanceOf(address(this));
        t.safeTransfer(judge, lent);
        (bool ok, bytes memory reason) = judge.call(claim);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        uint256 back = t.balanceOf(address(this));
        if (back < before || t.balanceOf(judge) != 0) revert PoolNotReturned();
        b.pool = lent + (back - before);
    }
}
