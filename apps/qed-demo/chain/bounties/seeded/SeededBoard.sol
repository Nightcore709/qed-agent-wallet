// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Judge} from "../src/QEDBountyBoard.sol";

/// @title  SeededBoard: QEDBountyBoard with one binding switched off. TEST CODE, EXPECTED TO FAIL its checks.
/// @notice A line-for-line copy of src/QEDBountyBoard.sol with two flags. With both true it behaves as the real board
///         (seeded/Sanity.t.sol shows the real board's checks pass against it). The deliberate faults:
///         - bindClaimant = false: the commitment covers only the bounty, the claim and the salt, and the pool goes to
///           whoever reveals (as in a commit-reveal that forgets who committed). Expected: a copier who copied the
///           finder's commit is paid (the race invariant fails).
///         - bindDomain = false: the commitment is a plain keccak256 of claimant, recipient, claim and salt, with no
///           chain id, no board address and no bounty id, and a reveal does not check which bounty a commitment was
///           recorded for. Expected: the domain checks fail.
///         - checkJudges = false (R13): `open` ignores the judge allowlist, and with it (review fix F7) the binding of the
///           claim function and the token to the judge. Expected: the allowlist checks fail (a
///           judge that keeps the pool is opened, funded and strands the pool).
contract SeededBoard is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(uint256 bountyId,address claimant,address recipient,bytes claim,bytes32 salt)");
    uint256 public constant MAX_PERIOD = 365 days;

    bool public immutable bindClaimant;
    bool public immutable bindDomain;
    bool public immutable checkJudges;
    address public immutable deployer;
    mapping(bytes32 codeHash => bytes4 claimSelector) public judgeClaim;

    enum Phase {
        None,
        Open,
        Contest,
        Settleable,
        Settled
    }

    struct Bounty {
        address judge;
        uint64 revealDelay;
        IERC20 token;
        uint64 revealWindow;
        address winner;
        uint64 contestWindow;
        address recipient;
        uint64 winnerSeq;
        bytes4 selector;
        uint64 contestEndsAt;
        bool settled;
        uint256 pool;
        uint256 paid;
    }

    struct Commitment {
        uint64 seq;
        uint64 at;
        uint64 bountyId;
        bool revealed;
    }

    mapping(uint256 bountyId => Bounty) public bounties;
    uint256 public bountyCount;
    mapping(address claimant => mapping(bytes32 commitment => Commitment)) public commitments;
    uint64 public commitCount;

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
    error NotFirst(uint64 winnerSeq);
    error ContestClosed(uint64 contestEndsAt);
    error EmptyPool();
    error PoolNotReturned();
    error NoWinner();
    error ContestOpen(uint64 contestEndsAt);
    error AlreadySettled();
    error NotDeployer(address caller);
    error JudgeNotAllowed(address judge, bytes32 codeHash);
    error WrongToken(address judgeToken);

    constructor(bool bindClaimant_, bool bindDomain_, bool checkJudges_, Judge[] memory allowedJudges)
        EIP712("QED Bounty Board", "1")
    {
        bindClaimant = bindClaimant_;
        bindDomain = bindDomain_;
        checkJudges = checkJudges_;
        deployer = msg.sender;
        for (uint256 i; i < allowedJudges.length; ++i) {
            _setJudge(allowedJudges[i].codeHash, allowedJudges[i].claimSelector);
        }
    }

    function setJudge(bytes32 codeHash, bytes4 claimSelector) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        _setJudge(codeHash, claimSelector);
    }

    function _setJudge(bytes32 codeHash, bytes4 claimSelector) private {
        if (codeHash == bytes32(0) || codeHash == keccak256("")) revert BadConfig();
        judgeClaim[codeHash] = claimSelector;
    }

    function _tokenOf(address judge) private view returns (address t) {
        (bool ok, bytes memory ret) = judge.staticcall(abi.encodeWithSignature("token()"));
        if (ok && ret.length == 32) t = abi.decode(ret, (address));
    }

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
        if (checkJudges) {
            bytes4 claimSelector = judgeClaim[judge.codehash];
            if (claimSelector == bytes4(0)) revert JudgeNotAllowed(judge, judge.codehash);
            if (selector != claimSelector) revert WrongSelector(claimSelector);
            address judgeToken = _tokenOf(judge);
            if (judgeToken != address(token)) revert WrongToken(judgeToken);
        }
        bountyId = ++bountyCount;
        Bounty storage b = bounties[bountyId];
        b.judge = judge;
        b.token = token;
        b.selector = selector;
        b.revealDelay = revealDelay;
        b.revealWindow = revealWindow;
        b.contestWindow = contestWindow;
    }

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
    }

    function commitmentOf(uint256 bountyId, address claimant, address recipient, bytes calldata claim, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        if (!bindClaimant) {
            // FAULT: who committed, and who is paid, are not part of the commitment
            return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, bountyId, address(0), address(0), keccak256(claim), salt)));
        }
        if (!bindDomain) {
            // FAULT: no chain id, no board address, no bounty id
            return keccak256(abi.encode(claimant, recipient, keccak256(claim), salt));
        }
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, bountyId, claimant, recipient, keccak256(claim), salt)));
    }

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
    }

    function reveal(uint256 bountyId, address recipient, bytes calldata claim, bytes32 salt) external nonReentrant {
        Bounty storage b = _bounty(bountyId);
        if (b.settled) revert AlreadySettled();
        if (!bindClaimant) recipient = msg.sender; // FAULT: the revealer is paid
        bytes32 h = commitmentOf(bountyId, msg.sender, recipient, claim, salt);
        Commitment storage c = commitments[msg.sender][h];
        // FAULT (bindDomain = false): the bounty a commitment was recorded for is not checked
        if (c.seq == 0 || (bindDomain && c.bountyId != bountyId)) revert NoCommitment(h);
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
        _judge(b, claim);
    }

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
        b.token.safeTransfer(b.recipient, payout);
    }

    function phase(uint256 bountyId) external view returns (Phase) {
        Bounty storage b = bounties[bountyId];
        if (b.judge == address(0)) return Phase.None;
        if (b.settled) return Phase.Settled;
        if (b.winner == address(0)) return Phase.Open;
        return block.timestamp < b.contestEndsAt ? Phase.Contest : Phase.Settleable;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _bounty(uint256 bountyId) private view returns (Bounty storage b) {
        b = bounties[bountyId];
        if (b.judge == address(0)) revert UnknownBounty(bountyId);
    }

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
