// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../src/QEDDisputeEscrow.sol";
import {DisputeInvariantChecks, DisputeInvariantSetup} from "dispute-test/invariant/DisputeInvariantChecks.sol";
import {SeededDisputeEscrow} from "./SeededDisputeEscrow.sol";

// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL, except the invariants each fault does not touch. They show that the real
// escrow's invariants can fail, and that the random lifecycles reach every outcome.

/// @notice The decider may rule during the evidence period. Expected: invariant_TheDeadlinesHold fails ("ruling during
///         the evidence period").
contract EarlyRulingTwin is DisputeInvariantChecks {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return QEDDisputeEscrow(address(new SeededDisputeEscrow(escrow, false, true, true)));
    }
}

/// @notice A timeout split rounds both parts down. Expected: invariant_EveryClosedJobAddsUpToItsPrice and
///         invariant_MoneyIsConserved fail (a unit stays behind in the escrow).
contract LossySplitTwin is DisputeInvariantChecks {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return QEDDisputeEscrow(address(new SeededDisputeEscrow(escrow, true, false, true)));
    }
}

/// @notice Anyone may accept for the client. Expected: invariant_EachStepOnlyByItsSide fails.
contract AnyoneAcceptsTwin is DisputeInvariantChecks {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return QEDDisputeEscrow(address(new SeededDisputeEscrow(escrow, true, true, false)));
    }
}

/// @notice Reachability canaries on the REAL escrow: each asserts that the random lifecycles never reach an outcome, so
///         each must fail, showing the invariants of test/invariant/ were checked after that outcome.
contract ReachabilityCanaries is DisputeInvariantSetup {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return new QEDDisputeEscrow(escrow);
    }

    function invariant_Canary_NeverAccepted() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.Accepted)), 0, "canary: a client accepted");
    }

    function invariant_Canary_NoReviewTimeout() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.ReviewTimeout)), 0, "canary: a review timed out");
    }

    function invariant_Canary_NoRuling() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.Decided)), 0, "canary: a decider ruled");
    }

    function invariant_Canary_NoSplitRuling() public view {
        assertEq(handler.decidedSplits(), 0, "canary: a decider split a price");
    }

    function invariant_Canary_NoDecisionTimeout() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.DecisionTimeout)), 0, "canary: a decision timed out");
    }

    function invariant_Canary_NoProviderGaveWay() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.ProviderGaveWay)), 0, "canary: a provider gave way");
    }

    function invariant_Canary_NeverReclaimed() public view {
        assertEq(handler.outcomes(uint8(QEDDisputeEscrow.Outcome.NotDelivered)), 0, "canary: a job was reclaimed");
    }
}
