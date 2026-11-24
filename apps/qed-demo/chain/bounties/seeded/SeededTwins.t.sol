// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QEDBountyBoard} from "../src/QEDBountyBoard.sol";
import {IBoard} from "board-test/IBoard.sol";
import {DomainChecks} from "board-test/DomainChecks.sol";
import {JudgeChecks} from "board-test/JudgeChecks.sol";
import {BoardRaceInvariants, BoardRaceSetup} from "board-test/invariant/BoardRace.sol";
import {SeededBoard} from "./SeededBoard.sol";

// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL (except the replay check in UndomainedBoardChecks, which the domain does
// not affect). They show that the real board's invariants and checks can fail, and that the race reaches each state.

/// @notice The race invariants against a board whose commitment forgets the claimant and pays whoever reveals.
///         Expected: invariant_TheCopierIsNeverPaid fails (a copier who copied the finder's commit before it was mined
///         holds an older record of the same digest, reveals the finder's claim and is paid).
contract UnboundClaimantRace is BoardRaceInvariants {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(false, true, true, allowedJudges)));
    }
}

/// @notice The domain checks against a board whose commitment has no domain and no bounty id. Expected: the three
///         domain tests and the field-binding fuzz fail.
contract UndomainedBoardChecks is DomainChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(true, false, true, allowedJudges)));
    }
}

/// @notice R13: the allowlist checks against a board whose `open` ignores the judge allowlist. Expected: the tests that
///         open a judge outside the list fail (a judge that keeps the pool is opened, so its pool could be stranded).
contract UncheckedJudgesChecks is JudgeChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(true, true, false, allowedJudges)));
    }
}

/// @notice Reachability canaries on the REAL board: each asserts that the race never reaches a state, so each must fail,
///         proving the invariants of test/invariant/ were checked in that state.
contract ReachabilityCanaries is BoardRaceSetup {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }

    function invariant_Canary_TheCopierNeverLeads() public view {
        assertFalse(handler.copierLed(), "canary: the copier led the race at some point");
    }

    function invariant_Canary_TheFinderNeverTakesTheLeadFromTheCopier() public view {
        assertFalse(handler.finderTookTheLeadFromTheCopier(), "canary: the finder took the lead from the copier");
    }

    function invariant_Canary_NoRevealIsForcedIn() public view {
        assertEq(handler.forcedInclusions(), 0, "canary: a finder reveal was included at its last chance");
    }

    function invariant_Canary_NobodySettles() public view {
        assertEq(handler.settlements(), 0, "canary: a bounty was settled");
    }

    function invariant_Canary_TheGrieferIsNeverRefused() public view {
        assertEq(handler.grieferRejections(), 0, "canary: the judge refused the griefer's claim");
    }
}
