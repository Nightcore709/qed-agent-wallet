// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "qed/src/TestUSD.sol";
import {IBoard} from "../IBoard.sol";
import {BoardFixtures} from "../BoardFixtures.sol";

/// @notice Drives one race for a bounty between a finder, a copier and a griefer, in whatever order the fuzzer picks,
///         with time in seconds. The copier sees everything the finder broadcasts from the moment it is broadcast and
///         may copy the commit, copy the reveal (to its own recipient or byte for byte), commit the claim under its own
///         name and reveal it, send the claim straight to the judge, or settle. The griefer commits garbage, reveals a
///         claim the judge rejects, and funds the pool. Anyone settles.
///         ASSUMPTION (the board's stated limit): the finder broadcasts its reveal only once its commitment may be
///         revealed and early enough to be included before it expires, and the reveal is included within
///         revealDelay + contestWindow seconds of being broadcast. `timePasses` enforces the last part; the reveal is
///         included whether or not it succeeds.
contract BoardRaceHandler is Test {
    IBoard public immutable board;
    TestUSD public immutable usd;
    uint256 public immutable id;
    address public immutable judge;
    bytes4 public immutable claimSelector;
    address public immutable finder;
    address public immutable finderVault;
    address public immutable copier;
    address public immutable copierVault;
    address public immutable griefer;
    uint256 public immutable delay;
    uint256 public immutable window;
    uint256 public immutable contest;
    bytes32 public constant SALT = keccak256("the finder's secret salt");
    bytes internal claim;
    bytes internal rejected;

    uint256 public timeNow;
    bool public commitPublic; //        the finder's commit has been broadcast
    uint256 public finderCommitAt; //   when the finder's commit was mined (0: not yet)
    uint256 public broadcastAt; //      when the finder broadcast its reveal (0: not yet)
    bool public finderRevealIncluded;
    bool public finderRevealSucceeded;
    uint256 public funded; //           everything ever put into this bounty's pool
    bytes32[] internal copierSalts;
    bytes32[] internal grieferSalts;

    // Ghost records of the states a run reached (the reachability canaries in seeded/ read them).
    bool public copierLed;
    bool public finderTookTheLeadFromTheCopier;
    uint256 public forcedInclusions;
    uint256 public settlements;
    uint256 public grieferRejections;
    uint256 public allowlistChanges; // R13: how often the deployer changed the judge allowlist during a run

    constructor(IBoard board_, TestUSD usd_, uint256 id_, bytes memory claim_, bytes memory rejected_, address[5] memory actors, uint256 pool) {
        board = board_;
        usd = usd_;
        id = id_;
        uint64 d;
        uint64 w;
        uint64 k;
        bytes4 sel;
        (judge, d,, w,, k,,, sel,,,,) = board_.bounties(id_);
        claimSelector = sel;
        delay = d;
        window = w;
        contest = k;
        claim = claim_;
        rejected = rejected_;
        (finder, finderVault, copier, copierVault, griefer) = (actors[0], actors[1], actors[2], actors[3], actors[4]);
        timeNow = vm.getBlockTimestamp();
        funded = pool;
    }

    modifier atTimeNow() {
        vm.warp(timeNow);
        _;
    }

    // ───────────── the finder ─────────────

    function finderBroadcastsCommit() external atTimeNow {
        commitPublic = true;
    }

    function finderCommitIsMined() external atTimeNow {
        if (!commitPublic || finderCommitAt != 0) return;
        bytes32 h = _finderCommitment();
        vm.prank(finder);
        try board.commit(id, h) {
            finderCommitAt = timeNow;
        } catch {}
    }

    function finderBroadcastsReveal() external atTimeNow {
        if (finderCommitAt == 0 || broadcastAt != 0 || timeNow < finderCommitAt + delay) return;
        if (timeNow + delay + contest > finderCommitAt + delay + window) return; // too late to be sure of inclusion
        broadcastAt = timeNow; // from here on the copier knows the claim
    }

    function finderRevealIsMined() external atTimeNow {
        if (broadcastAt == 0 || finderRevealIncluded) return;
        _includeFinderReveal();
    }

    // ───────────── the copier ─────────────

    function copierCopiesTheCommit() external atTimeNow {
        if (!commitPublic) return;
        bytes32 h = _finderCommitment();
        vm.prank(copier);
        try board.commit(id, h) {} catch {}
    }

    function copierCopiesTheReveal(bool toItself) external atTimeNow {
        if (broadcastAt == 0) return;
        vm.prank(copier);
        try board.reveal(id, toItself ? copierVault : finderVault, claim, SALT) {
            _noteCopierLead();
        } catch {}
    }

    function copierCommitsTheClaimAsItsOwn(uint256 seed) external atTimeNow {
        if (broadcastAt == 0) return;
        bytes32 s = keccak256(abi.encode("copier", seed));
        bytes32 h = board.commitmentOf(id, copier, copierVault, claim, s);
        vm.prank(copier);
        try board.commit(id, h) {
            copierSalts.push(s);
        } catch {}
    }

    function copierRevealsItsOwn(uint256 i) external atTimeNow {
        if (copierSalts.length == 0) return;
        bytes32 s = copierSalts[i % copierSalts.length];
        vm.prank(copier);
        try board.reveal(id, copierVault, claim, s) {
            _noteCopierLead();
        } catch {}
    }

    function copierGoesStraightToTheJudge() external atTimeNow {
        if (broadcastAt == 0) return;
        vm.prank(copier);
        (bool ok,) = judge.call(claim); // valid, so it succeeds and pays whatever the judge holds: nothing
        ok;
    }

    // ───────────── the griefer and the funders ─────────────

    function grieferCommits(uint256 seed, bool garbage) external atTimeNow {
        bytes32 s = keccak256(abi.encode("griefer", seed));
        bytes32 h = garbage ? keccak256(abi.encode("garbage", seed)) : board.commitmentOf(id, griefer, griefer, rejected, s);
        vm.prank(griefer);
        try board.commit(id, h) {
            if (!garbage) grieferSalts.push(s);
        } catch {}
    }

    function grieferRevealsARejectedClaim(uint256 i) external atTimeNow {
        if (grieferSalts.length == 0) return;
        bytes32 s = grieferSalts[i % grieferSalts.length];
        vm.prank(griefer);
        try board.reveal(id, griefer, rejected, s) {
            revert("the judge accepted a claim it must reject");
        } catch {
            ++grieferRejections;
        }
    }

    /// @dev A funder outside the race (its balance is not part of the race's accounting) adds to the pool; refused
    ///      once the bounty is settled.
    function someoneFunds(uint256 amount) external atTimeNow {
        amount = bound(amount, 1, 1_000e6);
        address funder = address(0xF0DE5);
        deal(address(usd), funder, amount);
        vm.startPrank(funder);
        usd.approve(address(board), amount);
        try board.fund(id, amount) {
            funded += amount;
        } catch {}
        vm.stopPrank();
    }

    /// @dev R13: the board's deployer changes the judge allowlist at any moment, the raced bounty's own judge included.
    ///      An open bounty must not notice: every invariant below holds whatever it does.
    function deployerChangesTheAllowlist(bool allowed, bool theRacedJudge) external atTimeNow {
        bytes32 h = theRacedJudge ? judge.codehash : keccak256(abi.encode("another judge", allowed));
        vm.prank(board.deployer());
        board.setJudge(h, allowed ? claimSelector : bytes4(0));
        ++allowlistChanges;
    }

    function someoneSettles(bool theCopier) external atTimeNow {
        if (theCopier) vm.prank(copier);
        try board.settle(id) {
            ++settlements;
        } catch {}
    }

    // ───────────── time ─────────────

    function timePasses(uint256 secs) external {
        secs = bound(secs, 1, delay + contest);
        uint256 target = timeNow + secs;
        if (broadcastAt != 0 && !finderRevealIncluded) {
            uint256 lastChance = broadcastAt + delay + contest - 1;
            if (target > lastChance) {
                timeNow = lastChance; // never behind timeNow: every earlier call applied the same rule
                vm.warp(timeNow);
                ++forcedInclusions;
                _includeFinderReveal();
            }
        }
        timeNow = target;
        vm.warp(timeNow);
    }

    // ───────────── internals ─────────────

    function _includeFinderReveal() internal {
        finderRevealIncluded = true;
        (,,,, address w,,,,,,,,) = board.bounties(id);
        bool copierWasLeading = w == copier;
        vm.prank(finder);
        try board.reveal(id, finderVault, claim, SALT) {
            finderRevealSucceeded = true;
            if (copierWasLeading) finderTookTheLeadFromTheCopier = true;
        } catch {}
    }

    function _noteCopierLead() internal {
        (,,,, address w,,,,,,,,) = board.bounties(id);
        if (w == copier) copierLed = true;
    }

    function _finderCommitment() internal view returns (bytes32) {
        return board.commitmentOf(id, finder, finderVault, claim, SALT);
    }
}

/// @notice The race's setup, shared by the real board's invariants (test/) and the seeded twin and the reachability
///         canaries (seeded/). The raced bounty is the release's optimality positive control (claimable); beside it
///         sits the original optimality bounty (sound), which nothing in the race may touch.
abstract contract BoardRaceSetup is BoardFixtures {
    BoardRaceHandler internal handler;
    IBoard internal board;
    uint256 internal raced;
    uint256 internal untouched;
    address internal raceJudge;
    address internal finder = makeAddr("finder");
    address internal finderVault = makeAddr("finder's vault");
    address internal copier = makeAddr("copier");
    address internal copierVault = makeAddr("copier's vault");
    address internal griefer = makeAddr("griefer");

    function _newBoard() internal virtual returns (IBoard);

    function setUp() public {
        vm.warp(1_800_000_000);
        _loadFixtures();
        board = _newBoard();
        raceJudge = _unsoundOptimality();
        raced = _openFunded(board, raceJudge, _optimalitySelector(), POOL);
        untouched = _openFunded(board, _soundOptimality(), _optimalitySelector(), POOL);
        handler = new BoardRaceHandler(board, usd, raced, _optimalityClaim(), _ba1(), [finder, finderVault, copier, copierVault, griefer], POOL);
        targetContract(address(handler));
    }

    function _pool(uint256 bountyId) internal view returns (uint256 p) {
        (,,,,,,,,,,, p,) = board.bounties(bountyId);
    }

    function _winner() internal view returns (address w) {
        (,,,, w,,,,,,,,) = board.bounties(raced);
    }

    function _settled() internal view returns (bool s) {
        (,,,,,,,,,, s,,) = board.bounties(raced);
    }
}

/// @notice What must hold after every call of every run, whatever the copier and the griefer do, under the handler's
///         assumption.
abstract contract BoardRaceInvariants is BoardRaceSetup {
    function invariant_TheCopierIsNeverPaid() public view {
        assertEq(usd.balanceOf(copier) + usd.balanceOf(copierVault), 0);
    }

    function invariant_OnceTheFindersRevealIsIncludedTheFinderLeads() public view {
        if (handler.finderRevealIncluded()) {
            assertTrue(handler.finderRevealSucceeded(), "the finder's reveal reverted");
            assertEq(_winner(), finder);
        }
    }

    function invariant_ASettlementPaysTheFindersRecipientEverything() public view {
        if (_settled()) {
            assertEq(usd.balanceOf(finderVault), handler.funded());
            assertEq(_pool(raced), 0);
        }
    }

    function invariant_TheJudgesHoldNothingBetweenTransactions() public view {
        assertEq(usd.balanceOf(raceJudge), 0);
    }

    function invariant_PoolsAreExactlyTheBoardsBalance() public view {
        assertEq(usd.balanceOf(address(board)), _pool(raced) + _pool(untouched));
    }

    function invariant_NoTokenIsCreatedOrLost() public view {
        assertEq(
            _pool(raced) + usd.balanceOf(finderVault) + usd.balanceOf(finder) + usd.balanceOf(copier)
                + usd.balanceOf(copierVault) + usd.balanceOf(griefer) + usd.balanceOf(raceJudge),
            handler.funded()
        );
    }

    /// R13: the allowlist never changes a bounty that is open: its judge stays the one it was opened with.
    function invariant_AnOpenBountyKeepsItsJudge() public view {
        (address j,,,,,,,,,,,,) = board.bounties(raced);
        assertEq(j, raceJudge);
    }

    function invariant_TheSoundBountyIsUntouched() public view {
        assertEq(_pool(untouched), POOL);
        assertEq(uint256(board.phase(untouched)), 1);
    }
}
