// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OptimalityBounty} from "qed/src/bounties/OptimalityBounty.sol";
import {MaximalityBounty} from "qed/src/bounties/MaximalityBounty.sol";
import {MinVarianceVerifier} from "qed/src/verifiers/MinVarianceVerifier.sol";
import {QEDBountyBoard} from "../src/QEDBountyBoard.sol";
import {BoardCase} from "./BoardCase.sol";
import {DomainChecks} from "./DomainChecks.sol";
import {IBoard} from "./IBoard.sol";

/// @dev A judge that accepts any claim and keeps the pool: the board must refuse it (PoolNotReturned).
contract KeepsThePool {
    /// The token it names (R13 review fix F7: `open` checks it against the bounty's), though it never pays it back.
    IERC20 public immutable token;

    constructor(IERC20 t) {
        token = t;
    }

    function claim(bytes calldata, bytes calldata, int256[] calldata) external pure returns (uint256) {
        return 0;
    }
}

/// @dev A judge that tries to re-enter the board while it holds the pool.
contract Reenters {
    IBoard public immutable board;
    IERC20 public immutable token;
    uint8 public mode;

    constructor(IBoard b, IERC20 t) {
        board = b;
        token = t;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function claim(bytes calldata, bytes calldata, int256[] calldata) external returns (uint256) {
        if (mode == 1) board.settle(1);
        else if (mode == 2) board.commit(1, keccak256("inside"));
        else if (mode == 3) board.fund(1, 1);
        else if (mode == 4) board.reveal(1, address(this), msg.data, bytes32(0));
        uint256 all = token.balanceOf(address(this));
        token.transfer(msg.sender, all);
        return all;
    }
}

/// @notice The domain and replay checks against the real board.
contract DomainChecksTest is DomainChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }
}

/// @notice QEDBountyBoard: claimant binding, copying, timing, liveness, the judge's interface, and the two original
///         bounties preserved exactly (they still reject the five claims recorded on Sepolia, with the recorded errors).
contract QEDBountyBoardTest is BoardCase {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }

    // ───────────────────────────── configuration and funding ─────────────────────────────

    function test_Open_RefusesABadConfiguration() public {
        address judge = _unsoundOptimality();
        IERC20 t = IERC20(address(usd));
        bytes4 s = _optimalitySelector();
        uint64 max = uint64(365 days);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(makeAddr("an address without code"), t, s, DELAY, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, IERC20(makeAddr("a token without code")), s, DELAY, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(address(board), t, s, DELAY, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(address(usd), t, s, DELAY, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, bytes4(0), DELAY, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, 0, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, DELAY, 0, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, DELAY, WINDOW, 0);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, max + 1, WINDOW, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, DELAY, max + 1, CONTEST);
        vm.expectRevert(QEDBountyBoard.BadConfig.selector);
        board.open(judge, t, s, DELAY, WINDOW, max + 1);
        assertEq(board.bountyCount(), 4);
        // R13: a well-formed bounty whose judge is not on the allowlist is refused too, and opens once allowed
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.JudgeNotAllowed.selector, judge, judge.codehash));
        board.open(judge, t, s, max, max, max);
        board.setJudge(judge.codehash, s);
        assertEq(board.open(judge, t, s, max, max, max), 5);
    }

    function test_Open_RecordsItsConfiguration_IdsCountFromOne() public view {
        assertEq(board.bountyCount(), 4);
        (address judge, uint64 d, IERC20 t, uint64 w, address winner, uint64 k, address r, uint64 ws, bytes4 sel, uint64 ends, bool settled, uint256 pool, uint256 paid) = board.bounties(optimality);
        assertTrue(judge != address(0) && judge.code.length > 0);
        assertEq(address(t), address(usd));
        assertEq(uint256(d), uint256(DELAY));
        assertEq(uint256(w), uint256(WINDOW));
        assertEq(uint256(k), uint256(CONTEST));
        assertEq(sel, OptimalityBounty.claim.selector);
        assertEq(winner, address(0));
        assertEq(r, address(0));
        assertEq(uint256(ws), 0);
        assertEq(uint256(ends), 0);
        assertEq(paid, 0);
        assertFalse(settled);
        assertEq(pool, POOL);
        assertEq(uint256(board.phase(optimality)), uint256(P_OPEN));
        assertEq(uint256(board.phase(99)), uint256(P_NONE));
        assertEq(usd.balanceOf(address(board)), 4 * POOL);
        assertEq(usd.balanceOf(judge), 0, "a judge holds nothing");
    }

    function test_Fund_CountsWhatArrives_AnyoneMayFund_NothingForAnUnknownBounty() public {
        _fund(board, optimality, 5e6);
        assertEq(_poolOf(optimality), POOL + 5e6);
        vm.expectRevert(QEDBountyBoard.ZeroAmount.selector);
        board.fund(optimality, 0);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.UnknownBounty.selector, 99));
        board.fund(99, 1);
        // tokens sent to the board directly are not a bounty's pool
        usd.mint(address(board), 7);
        assertEq(_poolOf(optimality), POOL + 5e6);
    }

    // ───────────────────────────── the positive controls pay the committed finder only ─────────────────────────────

    function _race(uint256 id) internal {
        bytes memory claim = _claimFor(id);
        // 1. the finder's commit is mined; nothing in it shows the claim
        _commit(finder, id, finderVault, claim, SALT);
        // 2. once it is old enough, the finder broadcasts its reveal: from here on everybody knows the claim
        vm.warp(vm.getBlockTimestamp() + DELAY);
        // 3. the copier, seeing the pending reveal, tries everything at once, ahead of it:
        (bool ok, bytes memory err) = _tryReveal(copier, id, copierVault, claim, SALT);
        assertFalse(ok, "a copied reveal (copier's recipient) succeeded");
        (ok, err) = _tryReveal(copier, id, finderVault, claim, SALT);
        assertFalse(ok, "a copied reveal (byte-identical) succeeded");
        assertEq(bytes4(err), QEDBountyBoard.NoCommitment.selector);
        (ok,) = _tx(copier, _judgeOf(id), claim); // straight to the judge, which holds nothing
        assertTrue(ok, "the judge refused a valid claim");
        bytes32 mine = board.commitmentOf(id, copier, copierVault, claim, COPIER_SALT);
        vm.prank(copier);
        board.commit(id, mine); // its own commitment, younger than the finder's
        // 4. the finder's reveal is mined
        _reveal(finder, id, finderVault, claim, SALT);
        assertEq(_winnerOf(id), finder);
        assertEq(uint256(board.phase(id)), uint256(P_CONTEST));
        // 5. the copier's own reveal, once old enough, cannot take over
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (ok, err) = _tryReveal(copier, id, copierVault, claim, COPIER_SALT);
        assertFalse(ok, "a younger commitment took over");
        assertEq(bytes4(err), QEDBountyBoard.NotFirst.selector);
        // 6. anyone settles after the contest; only the finder's recipient is paid
        vm.warp(_contestEndsAt(id));
        vm.prank(copier);
        assertEq(board.settle(id), POOL);
        assertEq(usd.balanceOf(finderVault), POOL);
        assertEq(usd.balanceOf(copier), 0);
        assertEq(usd.balanceOf(copierVault), 0);
        assertEq(usd.balanceOf(finder), 0);
        assertEq(usd.balanceOf(_judgeOf(id)), 0);
        assertEq(uint256(board.phase(id)), uint256(P_SETTLED));
    }

    function test_OptimalityControl_TheCopierGetsNothing_TheFinderIsPaid() public {
        _race(optControl);
        // the other pools were not touched
        assertEq(usd.balanceOf(address(board)), 3 * POOL);
    }

    function test_MaximalityControl_TheCopierGetsNothing_TheFinderIsPaid() public {
        _race(maxControl);
        assertEq(usd.balanceOf(address(board)), 3 * POOL);
    }

    /// The release's positive controls are unchanged: sent straight to a funded judge, a valid claim pays its sender
    /// (which is exactly the copying weakness the board removes).
    function test_PositiveControls_UnprotectedJudgesStillPayWhoeverSendsTheClaim() public {
        address o = _unsoundOptimality();
        address m = _unsoundMaximality();
        usd.mint(o, POOL);
        usd.mint(m, POOL);
        (bool ok,) = _tx(copier, o, _optimalityClaim());
        assertTrue(ok);
        (ok,) = _tx(copier, m, _maximalityClaim());
        assertTrue(ok);
        assertEq(usd.balanceOf(copier), 2 * POOL);
    }

    function testFuzz_AnyCopierIsNeverPaid(address someone, bytes32 itsSalt) public {
        vm.assume(someone != finder && someone != address(0) && someone != address(board) && someone.code.length == 0);
        vm.assume(someone != finderVault && someone != _judgeOf(optControl));
        bytes memory claim = _optimalityClaim();
        _commit(finder, optControl, finderVault, claim, SALT);
        // the copier copies the commit, word for word, and later the reveal
        bytes32 copied = board.commitmentOf(optControl, finder, finderVault, claim, SALT);
        vm.prank(someone);
        board.commit(optControl, copied);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok,) = _tryReveal(someone, optControl, someone, claim, SALT);
        assertFalse(ok);
        (ok,) = _tryReveal(someone, optControl, finderVault, claim, SALT);
        assertFalse(ok);
        bytes32 own = board.commitmentOf(optControl, someone, someone, claim, itsSalt);
        vm.prank(someone);
        board.commit(optControl, own);
        _reveal(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (ok,) = _tryReveal(someone, optControl, someone, claim, itsSalt);
        assertFalse(ok);
        vm.warp(_contestEndsAt(optControl));
        board.settle(optControl);
        assertEq(usd.balanceOf(someone), 0);
        assertEq(usd.balanceOf(finderVault), POOL);
    }

    /// A copier whose reveal is mined before the finder's leads only until the finder's (older) commitment is revealed.
    function test_TheOlderCommitmentWins_EvenIfItIsRevealedSecond() public {
        bytes memory claim = _optimalityClaim();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY); // the finder broadcasts; the copier commits at once
        _commit(copier, optControl, copierVault, claim, COPIER_SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY); // the finder's reveal is held back; the copier reveals first
        _reveal(copier, optControl, copierVault, claim, COPIER_SALT);
        assertEq(_winnerOf(optControl), copier);
        vm.warp(_contestEndsAt(optControl) - 1); // the last second of the contest
        _reveal(finder, optControl, finderVault, claim, SALT);
        assertEq(_winnerOf(optControl), finder);
        assertEq(_recipientOf(optControl), finderVault);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.ContestOpen.selector, _contestEndsAt(optControl)));
        board.settle(optControl);
        vm.warp(_contestEndsAt(optControl));
        board.settle(optControl);
        assertEq(usd.balanceOf(finderVault), POOL);
        assertEq(usd.balanceOf(copierVault), 0);
    }

    // ───────────────────────────── timing ─────────────────────────────

    function test_Timing_TheDelay_TheExpiry_AndTheContestAreExactAtTheirBoundaries() public {
        bytes memory claim = _optimalityClaim();
        uint256 t0 = vm.getBlockTimestamp();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(t0 + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.TooEarly.selector, uint64(t0 + DELAY)));
        _reveal(finder, optControl, finderVault, claim, SALT);
        // a second commitment, revealed at the last second before its expiry
        _commit(copier, optControl, copierVault, claim, COPIER_SALT);
        uint256 t1 = vm.getBlockTimestamp();
        vm.warp(t1 + DELAY + WINDOW);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.Expired.selector, uint64(t1 + DELAY + WINDOW)));
        _reveal(copier, optControl, copierVault, claim, COPIER_SALT);
        vm.warp(t1 + DELAY + WINDOW - 1);
        _reveal(copier, optControl, copierVault, claim, COPIER_SALT);
        // the finder's commitment expired long ago: it cannot take over, although it is older
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.Expired.selector, uint64(t0 + DELAY + WINDOW)));
        _reveal(finder, optControl, finderVault, claim, SALT);
        uint64 ends = _contestEndsAt(optControl);
        assertEq(uint256(ends), vm.getBlockTimestamp() + CONTEST);
        vm.warp(ends - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.ContestOpen.selector, ends));
        board.settle(optControl);
        vm.warp(ends);
        assertEq(uint256(board.phase(optControl)), uint256(P_SETTLEABLE));
        board.settle(optControl);
        assertEq(usd.balanceOf(copierVault), POOL);
    }

    /// The board's stated limit: with the copier committing the moment the finder broadcasts its reveal and revealing as
    /// early as it can, the finder is paid if and only if its reveal is mined within revealDelay + contestWindow
    /// seconds of being broadcast.
    function testFuzz_Limit_TheFinderIsPaidIffItsRevealLandsWithinDelayPlusContest(uint256 latency) public {
        latency = bound(latency, 0, 2 * (DELAY + CONTEST));
        bytes memory claim = _optimalityClaim();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        uint256 broadcast = vm.getBlockTimestamp();
        _commit(copier, optControl, copierVault, claim, COPIER_SALT);
        bool finderFirst = latency < DELAY;
        if (finderFirst) {
            vm.warp(broadcast + latency);
            _reveal(finder, optControl, finderVault, claim, SALT);
            vm.warp(broadcast + DELAY);
            (bool ok,) = _tryReveal(copier, optControl, copierVault, claim, COPIER_SALT);
            assertFalse(ok);
        } else {
            vm.warp(broadcast + DELAY);
            _reveal(copier, optControl, copierVault, claim, COPIER_SALT);
            vm.warp(broadcast + latency);
            _tryReveal(finder, optControl, finderVault, claim, SALT);
        }
        vm.warp(broadcast + 2 * (DELAY + CONTEST) + 1);
        board.settle(optControl);
        bool finderPaid = usd.balanceOf(finderVault) == POOL;
        assertEq(finderPaid, latency < DELAY + CONTEST, "the finder's payout does not match the stated limit");
        assertEq(usd.balanceOf(finderVault) + usd.balanceOf(copierVault), POOL);
    }

    /// The other limit: a reveal broadcast too early reverts but publishes the claim. The finder still wins if it
    /// reveals again in time (its commitment is older), and loses only if it never does.
    function test_Limit_AnEarlyRevealPublishesTheClaim_TheFinderStillWinsIfItRevealsAgainInTime() public {
        bytes memory claim = _optimalityClaim();
        uint256 t0 = vm.getBlockTimestamp();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(t0 + 1);
        (bool ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT); // too early: reverted, but public
        assertFalse(ok);
        _commit(copier, optControl, copierVault, claim, COPIER_SALT);
        vm.warp(t0 + 1 + DELAY);
        _reveal(copier, optControl, copierVault, claim, COPIER_SALT);
        assertEq(_winnerOf(optControl), copier);
        _reveal(finder, optControl, finderVault, claim, SALT); // again, now old enough
        vm.warp(_contestEndsAt(optControl));
        board.settle(optControl);
        assertEq(usd.balanceOf(finderVault), POOL);
    }

    // ───────────────────────────── liveness ─────────────────────────────

    function test_Liveness_ACommitterWhoNeverRevealsBlocksNobody() public {
        bytes memory claim = _optimalityClaim();
        _commit(stranger, optControl, stranger, claim, keccak256("never revealed"));
        vm.warp(vm.getBlockTimestamp() + 10);
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _reveal(finder, optControl, finderVault, claim, SALT);
        vm.warp(_contestEndsAt(optControl));
        vm.prank(stranger);
        board.settle(optControl); // anyone settles; it can only pay the recorded recipient
        assertEq(usd.balanceOf(finderVault), POOL);
        assertEq(usd.balanceOf(stranger), 0);
    }

    function test_Liveness_CommitsWaitForAFundedPool_AndCommitsStopWhileAContestRuns() public {
        address j = _unsoundOptimality();
        board.setJudge(j.codehash, _optimalitySelector());
        uint256 empty = board.open(j, IERC20(address(usd)), _optimalitySelector(), DELAY, WINDOW, CONTEST);
        bytes memory claim = _optimalityClaim();
        _commit(finder, empty, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(QEDBountyBoard.EmptyPool.selector);
        _reveal(finder, empty, finderVault, claim, SALT);
        _fund(board, empty, POOL);
        _reveal(finder, empty, finderVault, claim, SALT);
        uint64 endsAt = _contestEndsAt(empty);
        vm.prank(copier);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.ContestUnderway.selector, endsAt));
        board.commit(empty, keccak256("too late"));
        _fund(board, empty, 3e6); // a contest does not stop funding; the winner gets it all
        vm.warp(_contestEndsAt(empty));
        assertEq(board.settle(empty), POOL + 3e6);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.BountyClosed.selector, empty));
        board.fund(empty, 1);
        vm.expectRevert(QEDBountyBoard.AlreadySettled.selector);
        board.settle(empty);
    }

    function test_Commit_RefusesZeroAndRepeats_AndSettleNeedsAWinner() public {
        vm.expectRevert(QEDBountyBoard.ZeroCommitment.selector);
        board.commit(optControl, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.UnknownBounty.selector, 77));
        board.commit(77, keccak256("x"));
        bytes32 h = _commit(finder, optControl, finderVault, _optimalityClaim(), SALT);
        vm.prank(finder);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.AlreadyCommitted.selector, h));
        board.commit(optControl, h);
        vm.expectRevert(QEDBountyBoard.NoWinner.selector);
        board.settle(optControl);
        (uint64 seq, uint64 at, uint64 id, bool revealed) = board.commitments(finder, h);
        assertEq(uint256(seq), 1);
        assertEq(uint256(at), vm.getBlockTimestamp());
        assertEq(uint256(id), optControl);
        assertFalse(revealed);
    }

    // ───────────────────────────── the judge's interface ─────────────────────────────

    function test_Judge_ARevealMayCallOnlyTheJudgesClaimFunction() public {
        bytes memory notAClaim = abi.encodeCall(OptimalityBounty.scaledBound, (6, 0, 1));
        _commit(finder, optControl, finderVault, notAClaim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.WrongSelector.selector, OptimalityBounty.claim.selector));
        _reveal(finder, optControl, finderVault, notAClaim, SALT);
        bytes memory short = hex"0102";
        _commit(finder, optControl, finderVault, short, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.WrongSelector.selector, OptimalityBounty.claim.selector));
        _reveal(finder, optControl, finderVault, short, SALT);
    }

    /// Even if the deployer allows a judge that keeps the pool (`_openFunded` allows it), the loan comes back.
    function test_Judge_AJudgeThatKeepsThePoolMakesEveryRevealRevert() public {
        uint256 id = _openFunded(board, address(new KeepsThePool(IERC20(address(usd)))), _optimalitySelector(), POOL);
        bytes memory claim = _optimalityClaim();
        _commit(finder, id, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(QEDBountyBoard.PoolNotReturned.selector);
        _reveal(finder, id, finderVault, claim, SALT);
        assertEq(_poolOf(id), POOL);
        assertEq(uint256(board.phase(id)), uint256(P_OPEN));
    }

    function test_Judge_TheRecipientCannotBeNobodyTheBoardOrTheJudge() public {
        bytes memory claim = _optimalityClaim();
        address[3] memory bad = [address(0), address(board), _judgeOf(optControl)];
        for (uint256 i; i < 3; ++i) {
            _commit(finder, optControl, bad[i], claim, SALT);
        }
        vm.warp(vm.getBlockTimestamp() + DELAY);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(abi.encodeWithSelector(QEDBountyBoard.BadRecipient.selector, bad[i]));
            _reveal(finder, optControl, bad[i], claim, SALT);
        }
    }

    function test_Judge_TokensSentStraightToTheJudgeFlowIntoThePool() public {
        usd.mint(_judgeOf(optControl), 11e6); // anyone could take these with a direct claim until the next reveal
        bytes memory claim = _optimalityClaim();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _reveal(finder, optControl, finderVault, claim, SALT);
        assertEq(_poolOf(optControl), POOL + 11e6);
        assertEq(usd.balanceOf(_judgeOf(optControl)), 0);
        vm.warp(_contestEndsAt(optControl));
        board.settle(optControl);
        assertEq(usd.balanceOf(finderVault), POOL + 11e6);
    }

    function test_Judge_AJudgeCannotReenterTheBoard() public {
        QEDBountyBoard b = new QEDBountyBoard(allowedJudges);
        Reenters r = new Reenters(IBoard(address(b)), IERC20(address(usd)));
        b.setJudge(address(r).codehash, _optimalitySelector()); // allowed on purpose: the re-entrancy guard is under test
        usd.mint(address(this), POOL);
        usd.approve(address(b), POOL);
        uint256 id = b.open(address(r), IERC20(address(usd)), _optimalitySelector(), DELAY, WINDOW, CONTEST);
        b.fund(id, POOL);
        bytes memory claim = _optimalityClaim();
        for (uint8 m = 1; m <= 4; ++m) {
            r.setMode(m);
            bytes32 salt = bytes32(uint256(m));
            bytes32 h = b.commitmentOf(id, finder, finderVault, claim, salt);
            vm.prank(finder);
            b.commit(id, h);
            vm.warp(vm.getBlockTimestamp() + DELAY);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            vm.prank(finder);
            b.reveal(id, finderVault, claim, salt);
        }
        r.setMode(0); // the same judge, not re-entering, is paid back and the reveal stands
        bytes32 last = b.commitmentOf(id, finder, finderVault, claim, SALT);
        vm.prank(finder);
        b.commit(id, last);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(finder);
        b.reveal(id, finderVault, claim, SALT);
        assertEq(usd.balanceOf(address(b)), POOL);
    }

    // ───────────────────────────── the two original bounties, preserved exactly ─────────────────────────────

    /// The five claims recorded on Sepolia on 19 Oct 2026 (manifest steps BA1-BA3, BM1-BM2), rebuilt as the release's
    /// script built them, are refused through the board with exactly the recorded errors and arguments, and both
    /// original pools stay at 1,000 tUSD with no winner.
    function test_Originals_TheFiveRecordedClaimsAreRefusedWithTheRecordedErrors() public {
        bytes[5] memory claims = [_ba1(), _ba2(), _ba3(), _bm1(), _bm2()];
        uint256[5] memory ids = [optimality, optimality, optimality, maximality, maximality];
        bytes[5] memory recorded = [
            abi.encodeWithSelector(
                OptimalityBounty.TheoremHolds.selector,
                int256(-17427890834445872562219109117693616905377777777777792),
                int256(30005320910997774926000000000000000000000000000)
            ),
            abi.encodeWithSelector(
                OptimalityBounty.TheoremHolds.selector,
                int256(-33039999999997790320000000000000000000000000000),
                int256(30005320910997774926000000000000000000000000000)
            ),
            abi.encodeWithSelector(MinVarianceVerifier.DualityGapTooLarge.selector, int256(19113333333333332)),
            abi.encodeWithSelector(MaximalityBounty.TheoremHolds.selector, uint256(169000000), uint256(162000000)),
            abi.encodeWithSelector(MaximalityBounty.NetPositionChanged.selector, uint256(0), int256(1000000))
        ];
        for (uint256 i; i < 5; ++i) {
            bytes32 salt = keccak256(abi.encode("recorded", i));
            _commit(finder, ids[i], finderVault, claims[i], salt);
        }
        vm.warp(vm.getBlockTimestamp() + DELAY);
        for (uint256 i; i < 5; ++i) {
            bytes32 salt = keccak256(abi.encode("recorded", i));
            (bool ok, bytes memory err) = _tryReveal(finder, ids[i], finderVault, claims[i], salt);
            assertFalse(ok, "a recorded claim was accepted");
            assertEq(err, recorded[i], "not the error recorded on Sepolia");
            // the judge, called directly, gives the same answer (the board adds nothing to the ruling)
            (bool direct, bytes memory derr) = _tx(stranger, _judgeOf(ids[i]), claims[i]);
            assertFalse(direct);
            assertEq(derr, recorded[i]);
        }
        assertEq(_poolOf(optimality), POOL);
        assertEq(_poolOf(maximality), POOL);
        assertEq(uint256(board.phase(optimality)), uint256(P_OPEN));
        assertEq(uint256(board.phase(maximality)), uint256(P_OPEN));
        assertEq(usd.balanceOf(finderVault), 0);
    }

    /// Any feasible portfolio, through the board: the theorem holds, so nothing pays (the release's fuzz, :96-109).
    function testFuzz_Originals_NoFeasiblePortfolioRefutesTheOptimalityTheorem(uint64[6] memory raw) public {
        int256[] memory x = new int256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += raw[i % 6];
        }
        vm.assume(total > 0);
        int256 s;
        for (uint256 i; i < n; ++i) {
            x[i] = int256((uint256(raw[i % 6]) * uint256(W)) / total);
            s += x[i];
        }
        x[0] += W - s;
        bytes memory claim = abi.encodeCall(OptimalityBounty.claim, (spec, honest, x));
        _commit(finder, optimality, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok, bytes memory err) = _tryReveal(finder, optimality, finderVault, claim, SALT);
        assertFalse(ok);
        assertEq(bytes4(err), OptimalityBounty.TheoremHolds.selector);
        assertEq(_poolOf(optimality), POOL);
    }

    /// Any circulation inside the debts, through the board: weak duality holds, so nothing pays (the release's fuzz,
    /// :170-189).
    function testFuzz_Originals_NoCirculationRefutesTheMaximalityTheorem(uint256 seed) public {
        MaximalityBounty.Economy memory e = _economy();
        uint256 m = e.d.length;
        uint256[] memory x = new uint256[](m);
        for (uint256 k; k < 11; ++k) {
            uint256[] memory cyc = vm.parseJsonUintArray(cfx, string.concat(".cycles[", vm.toString(k), "]"));
            uint256 cap = type(uint256).max;
            for (uint256 t; t < cyc.length; ++t) {
                uint256 room = e.d[cyc[t]] - x[cyc[t]];
                if (room < cap) cap = room;
            }
            uint256 alpha = cap == 0 ? 0 : uint256(keccak256(abi.encode(seed, k))) % (cap + 1);
            for (uint256 t; t < cyc.length; ++t) {
                x[cyc[t]] += alpha;
            }
        }
        bytes memory claim = abi.encodeCall(MaximalityBounty.claim, (e, _optimal(), x));
        _commit(finder, maximality, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok, bytes memory err) = _tryReveal(finder, maximality, finderVault, claim, SALT);
        assertFalse(ok);
        assertEq(bytes4(err), MaximalityBounty.TheoremHolds.selector);
        assertEq(_poolOf(maximality), POOL);
    }
}
