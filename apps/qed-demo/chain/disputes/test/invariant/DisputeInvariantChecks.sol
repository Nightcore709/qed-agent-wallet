// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../../src/QEDDisputeEscrow.sol";
import {MockToken, MockVerifier} from "../helpers/Mocks.sol";
import {DisputeHandler} from "./DisputeHandler.sol";

/// @notice The harness: the release's ProofEscrow, an escrow under test in front of it, and the handler as the only
///         target. The seeded twins (seeded/) reuse it with a faulty escrow.
abstract contract DisputeInvariantSetup is Test {
    DisputeHandler internal handler;
    QEDDisputeEscrow internal d;
    ProofEscrow internal pe;
    MockToken internal token;

    function _newEscrow(ProofEscrow escrow) internal virtual returns (QEDDisputeEscrow);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        token = new MockToken();
        pe = new ProofEscrow();
        d = _newEscrow(pe);
        handler = new DisputeHandler(d, pe, token, address(new MockVerifier()));
        bytes4[] memory s = new bytes4[](15);
        s[0] = DisputeHandler.open.selector;
        s[1] = DisputeHandler.open.selector; // twice: jobs to work on early in each run
        s[2] = DisputeHandler.deliver.selector;
        s[3] = DisputeHandler.noteDelivered.selector;
        s[4] = DisputeHandler.accept.selector;
        s[5] = DisputeHandler.dispute.selector;
        s[6] = DisputeHandler.addEvidence.selector;
        s[7] = DisputeHandler.giveWay.selector;
        s[8] = DisputeHandler.decide.selector;
        s[9] = DisputeHandler.finish.selector;
        s[10] = DisputeHandler.reclaim.selector;
        s[11] = DisputeHandler.warp.selector;
        s[12] = DisputeHandler.releaseEarly.selector;
        s[13] = DisputeHandler.disputeInReview.selector;
        s[14] = DisputeHandler.decideInWindow.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
        targetContract(address(handler));
    }
}

/// @notice The invariants of the dispute escrow, each checked after every step of every run.
abstract contract DisputeInvariantChecks is DisputeInvariantSetup {
    /// @notice No money is created or lost: what the two escrows hold is exactly the price of every job not yet closed.
    function invariant_MoneyIsConserved() public view {
        uint256 open;
        for (uint256 k; k < handler.jobCount(); k++) {
            QEDDisputeEscrow.Job memory j = d.getJob(handler.ids(k));
            if (j.status != QEDDisputeEscrow.Status.Closed) open += j.price;
        }
        assertEq(token.balanceOf(address(d)) + token.balanceOf(address(pe)), open, "escrowed money = open prices");
    }

    /// @notice The escrow's record of what it holds for delivered and disputed jobs is exact and always covered.
    function invariant_HeldIsExactAndCovered() public view {
        uint256 held;
        for (uint256 k; k < handler.jobCount(); k++) {
            QEDDisputeEscrow.Job memory j = d.getJob(handler.ids(k));
            if (j.status == QEDDisputeEscrow.Status.Delivered || j.status == QEDDisputeEscrow.Status.Disputed) held += j.price;
        }
        assertEq(d.held(address(token)), held);
        assertGe(token.balanceOf(address(d)), held);
    }

    /// @notice A closed job's two parts add up to its price, and a job never delivered pays its provider nothing.
    function invariant_EveryClosedJobAddsUpToItsPrice() public view {
        for (uint256 k; k < handler.jobCount(); k++) {
            QEDDisputeEscrow.Job memory j = d.getJob(handler.ids(k));
            if (j.status != QEDDisputeEscrow.Status.Closed) continue;
            assertEq(j.toProvider + j.toClient, j.price, "parts add up");
            if (j.outcome == QEDDisputeEscrow.Outcome.NotDelivered) assertEq(j.toProvider, 0);
            if (j.outcome == QEDDisputeEscrow.Outcome.Accepted) assertEq(j.toProvider, j.price);
            if (j.outcome == QEDDisputeEscrow.Outcome.ProviderGaveWay) assertEq(j.toClient, j.price);
        }
    }

    /// @notice Money reaches only a job's payee and its client: every balance is what its closed jobs paid it; the
    ///         deciders, the providers' signing accounts and the stranger never receive anything.
    function invariant_MoneyGoesOnlyToTheParties() public view {
        for (uint256 i; i < 2; i++) {
            assertEq(token.balanceOf(handler.clients(i)), handler.gotOut(handler.clients(i)), "client");
            assertEq(token.balanceOf(handler.payees(i)), handler.gotOut(handler.payees(i)), "payee");
            assertEq(token.balanceOf(handler.deciders(i)), 0, "decider");
            assertEq(token.balanceOf(handler.providers(i)), 0, "provider account");
        }
        assertEq(token.balanceOf(handler.stranger()), 0, "stranger");
    }

    /// @notice Each step belongs to one side: only the client accepts or disputes, only the provider gives way, only
    ///         the decider rules.
    function invariant_EachStepOnlyByItsSide() public view {
        assertEq(handler.acceptedByOther(), 0, "accepted by someone other than the client");
        assertEq(handler.disputedByOther(), 0, "disputed by someone other than the client");
        assertEq(handler.gaveWayByOther(), 0, "refunded by someone other than the provider");
        assertEq(handler.decidedByOther(), 0, "ruled by someone other than the decider");
    }

    /// @notice The deadlines hold: a dispute only within the review; a ruling only on a dispute, after its evidence
    ///         period and by its deadline; a timeout only after its period.
    function invariant_TheDeadlinesHold() public view {
        for (uint256 k; k < handler.jobCount(); k++) {
            uint256 id = handler.ids(k);
            QEDDisputeEscrow.Job memory j = d.getJob(id);
            if (j.disputedAt != 0) assertLe(j.disputedAt, j.deliveredAt + j.reviewPeriod, "dispute after the review");
            if (j.outcome == QEDDisputeEscrow.Outcome.Decided) {
                assertTrue(handler.disputedSeen(id), "ruling without a dispute");
                assertGt(j.closedAt, j.disputedAt + j.evidencePeriod, "ruling during the evidence period");
                assertLe(j.closedAt, j.disputedAt + j.decisionPeriod, "ruling after the deadline");
            }
            if (j.outcome == QEDDisputeEscrow.Outcome.ReviewTimeout) {
                assertEq(j.disputedAt, 0);
                assertGt(j.closedAt, j.deliveredAt + j.reviewPeriod, "review timeout too early");
            }
            if (j.outcome == QEDDisputeEscrow.Outcome.DecisionTimeout) {
                assertGt(j.closedAt, j.disputedAt + j.decisionPeriod, "decision timeout too early");
            }
        }
    }

    /// @notice A closed job never changes: once paid out, its outcome and amounts are final.
    function invariant_AClosedJobIsFinal() public view {
        for (uint256 k; k < handler.jobCount(); k++) {
            uint256 id = handler.ids(k);
            if (!handler.closedSeen(id)) continue;
            QEDDisputeEscrow.Job memory j = d.getJob(id);
            assertEq(uint8(j.status), uint8(QEDDisputeEscrow.Status.Closed));
            assertEq(j.toProvider, handler.closedToProvider(id));
            assertEq(j.toClient, handler.closedToClient(id));
            assertEq(uint8(j.outcome), handler.closedOutcome(id));
        }
    }
}
