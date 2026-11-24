// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../src/QEDDisputeEscrow.sol";
import {DisputeBase} from "./DisputeBase.sol";
import {FeeToken, MockVerifier} from "./helpers/Mocks.sol";

/// @notice Unit and fuzz tests: who may do what, when, and where the money goes.
contract QEDDisputeEscrowTest is DisputeBase {
    // ═══════════════════════════════ opening: the terms bind both sides ═══════════════════════════════

    function test_Open_MovesThePriceToTheProofEscrowAndRecordsTheTerms() public {
        uint256 before = token.balanceOf(client);
        uint256 id = _open();
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.status), uint8(QEDDisputeEscrow.Status.Funded));
        assertEq(token.balanceOf(client), before - PRICE, "the client paid the price");
        assertEq(token.balanceOf(address(pe)), PRICE, "the proof escrow holds it");
        assertEq(token.balanceOf(address(d)), 0, "nothing stays here while the job is open");
        assertEq(token.allowance(address(d), address(pe)), 0, "no allowance left behind");
        assertEq(j.escrowJobId, 1);
        assertEq(d.jobOfEscrowJob(1), id);
        assertEq(j.termsHash, d.termsHash(_terms()));
        ProofEscrow.Job memory e = pe.getJob(1);
        assertEq(e.client, address(d));
        assertEq(e.payee, address(d));
        assertEq(e.provider, provider);
        assertEq(j.client, client);
        assertEq(j.payee, payee);
        assertEq(j.decider, decider);
        assertEq(j.provider, provider);
    }

    function test_Open_OnlyTheNamedClient() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        bytes memory sig = _sign(q);
        token.mint(stranger, PRICE);
        vm.startPrank(stranger);
        token.approve(address(d), PRICE);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotClient.selector, stranger));
        d.open(t, q, sig);
        vm.stopPrank();
    }

    function test_Open_AlteredTermsAreRefused() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        bytes memory sig = _sign(q);
        // the client changes the decider, a period, a timeout outcome or the payee after the provider signed
        for (uint256 i; i < 4; i++) {
            QEDDisputeEscrow.Terms memory c = _terms();
            if (i == 0) c.decider = stranger;
            if (i == 1) c.reviewPeriod = REVIEW + 1;
            if (i == 2) c.decisionTimeoutBps = 0;
            if (i == 3) c.payee = makeAddr("someone else");
            bytes32 cHash = d.termsHash(c);
            vm.prank(client);
            vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.TermsMismatch.selector, q.quoteId, cHash));
            d.open(c, q, sig);
        }
    }

    function test_Open_TheProviderSignatureCoversTheTermsThroughTheQuoteId() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        bytes memory sig = _sign(q);
        // terms changed AND the quoteId recomputed to match: the provider never signed that quote
        t.decisionTimeoutBps = 0;
        q.quoteId = d.termsHash(t);
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        d.open(t, q, sig);
    }

    function test_Open_TheQuoteMustNameThisEscrowAsClientAndPayee() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        q.payee = payee; // paid straight to the provider: there would be nothing to dispute
        bytes memory sig = _sign(q);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.QuoteNotForThisEscrow.selector, address(d), payee));
        d.open(t, q, sig);
        q = _quote(t, PRICE);
        q.client = client;
        sig = _sign(q);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.QuoteNotForThisEscrow.selector, client, address(d)));
        d.open(t, q, sig);
    }

    function test_Open_ThreeDistinctSides() public {
        QEDDisputeEscrow.Terms memory t;
        for (uint256 i; i < 6; i++) {
            t = _terms();
            if (i == 0) t.decider = client; //     the client judging its own case
            if (i == 1) t.decider = provider; //   the provider judging its own case
            if (i == 2) t.decider = payee; //      the decider paid as the provider
            if (i == 3) t.payee = client; //       the client paying itself
            if (i == 4) t.payee = address(d); //   money that would stay here
            if (i == 5) t.payee = address(pe); //  money that would go back into the proof escrow
            ProofEscrow.Quote memory q = _quote(t, PRICE);
            bytes memory sig = _sign(q);
            vm.prank(client);
            vm.expectRevert(QEDDisputeEscrow.BadParties.selector);
            d.open(t, q, sig);
        }
    }

    function test_Open_PowersPeriodsAndSharesWithinBounds() public {
        QEDDisputeEscrow.Terms memory t;
        for (uint256 i; i < 9; i++) {
            t = _terms();
            bytes4 want = QEDDisputeEscrow.BadPeriods.selector;
            if (i == 0) { t.deciderMay = 0; want = QEDDisputeEscrow.BadPowers.selector; }
            if (i == 1) { t.deciderMay = 8; want = QEDDisputeEscrow.BadPowers.selector; }
            if (i == 2) t.reviewPeriod = 59 seconds;
            if (i == 3) t.reviewPeriod = 60 days + 1;
            if (i == 4) t.evidencePeriod = 59 seconds;
            if (i == 5) t.decisionPeriod = t.evidencePeriod + 59 seconds; // the decider would have under a minute
            if (i == 6) { t.evidencePeriod = 60 days; t.decisionPeriod = 60 days; }
            if (i == 7) { t.reviewTimeoutBps = 10_001; want = QEDDisputeEscrow.BadShares.selector; }
            if (i == 8) { t.decisionTimeoutBps = 10_001; want = QEDDisputeEscrow.BadShares.selector; }
            ProofEscrow.Quote memory q = _quote(t, PRICE);
            bytes memory sig = _sign(q);
            vm.prank(client);
            if (want == QEDDisputeEscrow.BadPowers.selector) vm.expectRevert(abi.encodeWithSelector(want, t.deciderMay));
            else vm.expectRevert(want);
            d.open(t, q, sig);
        }
    }

    function test_Open_AQuoteOpensOneJobOnly() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        bytes memory sig = _sign(q);
        vm.prank(client);
        d.open(t, q, sig);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.QuoteAlreadyUsed.selector, q.quoteId));
        d.open(t, q, sig);
    }

    function test_Open_RefusesATokenThatChargesOnTransfer() public {
        FeeToken fee = new FeeToken();
        fee.mint(client, 1_000_000);
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, 10_000);
        q.token = address(fee);
        bytes memory sig = _sign(q);
        vm.startPrank(client);
        fee.approve(address(d), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.UnsupportedToken.selector, address(fee)));
        d.open(t, q, sig);
        vm.stopPrank();
    }

    // ═══════════════════════════════ delivery and review ═══════════════════════════════

    function test_Delivery_IsHeldHereNotPaidToTheProvider() public {
        uint256 id = _open();
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotDeliveredYet.selector, id));
        d.noteDelivered(id);
        _deliver(id);
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.status), uint8(QEDDisputeEscrow.Status.Delivered));
        assertEq(j.deliveredAt, block.timestamp);
        assertEq(token.balanceOf(payee), 0, "verified work is not paid before the review");
        assertEq(token.balanceOf(address(d)), PRICE);
        assertEq(d.held(address(token)), PRICE);
        (uint64 reviewEnds,,) = d.deadlines(id);
        assertEq(reviewEnds, block.timestamp + REVIEW);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.WrongStatus.selector, id, QEDDisputeEscrow.Status.Delivered));
        d.noteDelivered(id);
    }

    function test_Delivery_ACounterfeitIsRefusedByTheVerifier() public {
        uint256 id = _open();
        uint256 escrowJobId = _job(id).escrowJobId;
        vm.prank(provider);
        vm.expectRevert(MockVerifier.Counterfeit.selector);
        pe.deliver(escrowJobId, SPEC, "not ok");
        assertEq(token.balanceOf(address(pe)), PRICE, "nothing moved");
    }

    function test_Accept_PaysTheProviderInFullAtOnce() public {
        uint256 id = _open();
        _deliver(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotClient.selector, stranger));
        d.accept(id);
        vm.prank(client);
        d.accept(id);
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.outcome), uint8(QEDDisputeEscrow.Outcome.Accepted));
        assertEq(token.balanceOf(payee), PRICE);
        assertEq(d.held(address(token)), 0);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.WrongStatus.selector, id, QEDDisputeEscrow.Status.Closed));
        d.accept(id);
    }

    function test_ReviewTimeout_AppliesOnlyAfterTheReviewEnds() public {
        uint256 id = _open();
        _deliver(id);
        uint64 ends = uint64(block.timestamp) + REVIEW;
        vm.warp(ends);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.ReviewNotOver.selector, ends));
        d.finish(id);
        vm.warp(ends + 1);
        vm.prank(stranger); // anyone
        d.finish(id);
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.outcome), uint8(QEDDisputeEscrow.Outcome.ReviewTimeout));
        assertEq(j.toProvider, PRICE, "the default: silence pays the provider");
        assertEq(token.balanceOf(payee), PRICE);
    }

    function test_ReviewTimeout_CanBeASplitTheTermsChose() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        t.reviewTimeoutBps = 3_333;
        uint256 id = _open(t, 101);
        _deliver(id);
        vm.warp(block.timestamp + REVIEW + 1);
        d.finish(id);
        // client: floor(101 * 6667 / 10000) = 67; provider: the rest, 34
        assertEq(token.balanceOf(payee), 34);
        assertEq(_job(id).toClient, 67);
    }

    // ═══════════════════════════════ dispute, evidence and decision ═══════════════════════════════

    function test_Dispute_OnlyTheClientAndOnlyDuringTheReview() public {
        uint256 id = _open();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.WrongStatus.selector, id, QEDDisputeEscrow.Status.Funded));
        d.dispute(id, bytes32(0));
        _deliver(id);
        for (uint256 i; i < 3; i++) {
            address who = [provider, decider, stranger][i];
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotClient.selector, who));
            d.dispute(id, bytes32(0));
        }
        uint64 ends = uint64(block.timestamp) + REVIEW;
        vm.warp(ends + 1);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.ReviewOver.selector, ends));
        d.dispute(id, bytes32(0));
    }

    function test_Dispute_AtTheLastSecondOfTheReview() public {
        uint256 id = _open();
        _deliver(id);
        vm.warp(block.timestamp + REVIEW);
        _dispute(id);
        assertEq(uint8(_job(id).status), uint8(QEDDisputeEscrow.Status.Disputed));
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.DecisionNotOver.selector, uint64(block.timestamp) + DECISION));
        d.finish(id);
    }

    function test_Evidence_FromEitherSideUntilTheEvidencePeriodEnds() public {
        uint256 id = _open();
        _deliver(id);
        _dispute(id);
        vm.prank(provider);
        d.addEvidence(id, keccak256("the certificate checks: duality gap 3e-12"));
        vm.prank(client);
        d.addEvidence(id, keccak256("we asked for six assets, not three"));
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotAParty.selector, decider));
        d.addEvidence(id, bytes32(0));
        uint64 ends = uint64(block.timestamp) + EVIDENCE;
        vm.warp(ends + 1);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.EvidenceClosed.selector, ends));
        d.addEvidence(id, bytes32(0));
    }

    function test_Decide_OnlyTheDeciderAfterTheEvidenceAndByTheDeadline() public {
        uint256 id = _open();
        _deliver(id);
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.WrongStatus.selector, id, QEDDisputeEscrow.Status.Delivered));
        d.decide(id, PRICE);
        _dispute(id);
        uint64 evidenceEnds = uint64(block.timestamp) + EVIDENCE;
        uint64 decideBy = uint64(block.timestamp) + DECISION;
        vm.warp(evidenceEnds);
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.EvidenceStillOpen.selector, evidenceEnds));
        d.decide(id, 0);
        vm.warp(evidenceEnds + 1);
        for (uint256 i; i < 3; i++) {
            address who = [client, provider, stranger][i];
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotDecider.selector, who));
            d.decide(id, 0);
        }
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.ShareTooLarge.selector, PRICE + 1, PRICE));
        d.decide(id, PRICE + 1);
        vm.warp(decideBy + 1);
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.DecisionOver.selector, decideBy));
        d.decide(id, 0);
    }

    function test_Decide_ASplitPaysBothAndTheDeciderNothing() public {
        uint256 id = _open();
        _deliver(id);
        _dispute(id);
        vm.warp(block.timestamp + EVIDENCE + 1);
        uint256 clientBefore = token.balanceOf(client);
        vm.prank(decider);
        d.decide(id, 15_000);
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.outcome), uint8(QEDDisputeEscrow.Outcome.Decided));
        assertEq(token.balanceOf(payee), 15_000);
        assertEq(token.balanceOf(client) - clientBefore, PRICE - 15_000);
        assertEq(token.balanceOf(decider), 0);
        assertEq(token.balanceOf(address(d)), 0);
    }

    function test_Decide_OnlyWithAnOutcomeTheTermsAllow() public {
        QEDDisputeEscrow.Terms memory t = _terms();
        t.deciderMay = 1 | 2; // pay the provider or refund the client; no split
        uint256 id = _open(t, PRICE);
        _deliver(id);
        _dispute(id);
        vm.warp(block.timestamp + EVIDENCE + 1);
        vm.prank(decider);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.OutcomeNotAllowed.selector, 1, uint8(3)));
        d.decide(id, 1);
        vm.prank(decider);
        d.decide(id, 0);
        assertEq(_job(id).toClient, PRICE);
    }

    function test_DecisionTimeout_HalfEachByDefaultWithTheClientRoundedDown() public {
        uint256 id = _open(_terms(), 25_051);
        _deliver(id);
        _dispute(id);
        uint64 decideBy = uint64(block.timestamp) + DECISION;
        vm.warp(decideBy);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.DecisionNotOver.selector, decideBy));
        d.finish(id);
        vm.warp(decideBy + 1);
        d.finish(id);
        QEDDisputeEscrow.Job memory j = _job(id);
        assertEq(uint8(j.outcome), uint8(QEDDisputeEscrow.Outcome.DecisionTimeout));
        assertEq(j.toClient, 12_525, "floor(25051 / 2)");
        assertEq(j.toProvider, 12_526, "the rest");
    }

    function test_GiveWay_EitherSideDuringADispute() public {
        uint256 a = _open();
        uint256 b = _open(_salted(2), PRICE);
        _deliver(a);
        _deliver(b);
        _dispute(a);
        _dispute(b);
        uint256 clientBefore = token.balanceOf(client);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.NotProvider.selector, client));
        d.giveWay(a);
        vm.prank(provider);
        d.giveWay(a); // the provider refunds the client in full
        vm.prank(client);
        d.accept(b); // the client withdraws its dispute and pays in full
        assertEq(token.balanceOf(client) - clientBefore, PRICE);
        assertEq(token.balanceOf(payee), PRICE);
        assertEq(uint8(_job(a).outcome), uint8(QEDDisputeEscrow.Outcome.ProviderGaveWay));
        assertEq(uint8(_job(b).outcome), uint8(QEDDisputeEscrow.Outcome.Accepted));
    }

    // ═══════════════════════════════ no delivery ═══════════════════════════════

    function test_Reclaim_OnlyAfterTheDeadlineThenAnyone() public {
        uint256 id = _open();
        uint64 deliverBy = uint64(block.timestamp) + DELIVER_WITHIN;
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.NotRefundableYet.selector, deliverBy));
        d.reclaim(id);
        vm.warp(deliverBy + 1);
        uint256 escrowJobId = _job(id).escrowJobId;
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.DeadlinePassed.selector, deliverBy));
        pe.deliver(escrowJobId, SPEC, OK);
        uint256 clientBefore = token.balanceOf(client);
        vm.prank(stranger);
        d.reclaim(id);
        assertEq(token.balanceOf(client) - clientBefore, PRICE);
        assertEq(uint8(_job(id).outcome), uint8(QEDDisputeEscrow.Outcome.NotDelivered));
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.WrongStatus.selector, id, QEDDisputeEscrow.Status.Closed));
        d.reclaim(id);
    }

    function test_Reclaim_AfterTheProviderReleasedTheClientEarly() public {
        uint256 id = _open();
        uint256 escrowJobId = _job(id).escrowJobId;
        vm.prank(provider);
        pe.refund(escrowJobId); // the proof escrow refunds its client: this contract
        assertEq(token.balanceOf(address(d)), PRICE);
        uint256 clientBefore = token.balanceOf(client);
        d.reclaim(id);
        assertEq(token.balanceOf(client) - clientBefore, PRICE);
        assertEq(token.balanceOf(address(d)), 0);
    }

    function test_Reclaim_ADeliveredJobCannotBeReclaimed() public {
        uint256 id = _open();
        uint256 escrowJobId = _job(id).escrowJobId;
        vm.prank(provider);
        pe.deliver(escrowJobId, SPEC, OK); // settled into this contract, not yet noted
        vm.warp(block.timestamp + DELIVER_WITHIN + 1);
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.AlreadyDelivered.selector, id));
        d.reclaim(id);
        d.noteDelivered(id); // the review starts late, which can only favour the client
        assertEq(uint8(_job(id).status), uint8(QEDDisputeEscrow.Status.Delivered));
    }

    function test_Jobs_AreIsolated_APayoutNeverReachesAnotherJobsMoney() public {
        uint256 a = _open();
        uint256 b = _open(_salted(2), 7_000);
        _deliver(a);
        _deliver(b);
        assertEq(d.held(address(token)), PRICE + 7_000);
        vm.prank(client);
        d.accept(b);
        assertEq(token.balanceOf(address(d)), PRICE, "job a's money is untouched");
        assertEq(d.held(address(token)), PRICE);
    }

    function test_UnknownJob() public {
        vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.UnknownJob.selector, 9));
        d.finish(9);
    }

    // ═══════════════════════════════ fuzz ═══════════════════════════════

    /// @notice Every split adds up to the price; the client's part is the floor; more basis points never pay less.
    function testFuzz_SplitAddsUpAndRoundsTheClientDown(uint256 price, uint16 bps, uint16 bps2) public view {
        price = bound(price, 0, type(uint256).max / 2);
        bps = uint16(bound(bps, 0, 10_000));
        bps2 = uint16(bound(bps2, bps, 10_000));
        (uint256 p, uint256 c) = d.split(price, bps);
        assertEq(p + c, price);
        assertEq(c, (price / 10_000) * (10_000 - bps) + ((price % 10_000) * (10_000 - bps)) / 10_000);
        (uint256 p2,) = d.split(price, bps2);
        assertGe(p2, p);
    }

    /// @notice A ruling pays exactly what the decider named, to the two parties only, when the terms allow it.
    function testFuzz_DecideAnyAmountWithinThePowers(uint256 price, uint256 toProvider, uint8 may) public {
        price = bound(price, 1, 1e15);
        toProvider = bound(toProvider, 0, price);
        may = uint8(bound(may, 1, 7));
        QEDDisputeEscrow.Terms memory t = _terms();
        t.deciderMay = may;
        token.mint(client, price);
        uint256 id = _open(t, price);
        _deliver(id);
        _dispute(id);
        vm.warp(block.timestamp + EVIDENCE + 1);
        uint8 needed = toProvider == price ? 1 : toProvider == 0 ? 2 : 4;
        uint256 clientBefore = token.balanceOf(client);
        vm.prank(decider);
        if (may & needed == 0) {
            vm.expectRevert(abi.encodeWithSelector(QEDDisputeEscrow.OutcomeNotAllowed.selector, toProvider, may));
            d.decide(id, toProvider);
            return;
        }
        d.decide(id, toProvider);
        assertEq(token.balanceOf(payee), toProvider);
        assertEq(token.balanceOf(client) - clientBefore, price - toProvider);
        assertEq(token.balanceOf(decider), 0);
        assertEq(token.balanceOf(address(d)), 0);
    }

    /// @notice At any moment after delivery exactly one of "dispute" and "finish" is open: the review has no gap and no
    ///         overlap, so neither side can race the other at its end.
    function testFuzz_TheReviewHasNoGapAndNoOverlap(uint256 wait) public {
        wait = bound(wait, 0, 2 * uint256(REVIEW));
        uint256 id = _open();
        _deliver(id);
        vm.warp(block.timestamp + wait);
        uint256 snap = vm.snapshotState();
        vm.prank(client);
        (bool disputed,) = address(d).call(abi.encodeCall(QEDDisputeEscrow.dispute, (id, bytes32(0))));
        vm.revertToState(snap);
        (bool finished,) = address(d).call(abi.encodeCall(QEDDisputeEscrow.finish, (id)));
        assertTrue(disputed != finished, "exactly one of dispute and finish");
        assertEq(disputed, wait <= REVIEW);
    }

    /// @notice The same for a dispute: before the evidence ends only evidence; then only the decider; then only finish.
    function testFuzz_TheDisputeWindowsDoNotOverlap(uint256 wait) public {
        wait = bound(wait, 0, 2 * uint256(DECISION));
        uint256 id = _open();
        _deliver(id);
        _dispute(id);
        vm.warp(block.timestamp + wait);
        uint256 snap = vm.snapshotState();
        vm.prank(provider);
        (bool evidence,) = address(d).call(abi.encodeCall(QEDDisputeEscrow.addEvidence, (id, bytes32(0))));
        vm.revertToState(snap);
        vm.prank(decider);
        (bool decided,) = address(d).call(abi.encodeCall(QEDDisputeEscrow.decide, (id, PRICE)));
        vm.revertToState(snap);
        (bool finished,) = address(d).call(abi.encodeCall(QEDDisputeEscrow.finish, (id)));
        assertEq(evidence, wait <= EVIDENCE);
        assertEq(decided, wait > EVIDENCE && wait <= DECISION);
        assertEq(finished, wait > DECISION);
    }

    /// @notice Every job ends, and nobody's silence can stop it: once the delivery deadline, the review and the decision
    ///         periods have passed, anyone can close a job by reclaim or finish. A delivery nobody recorded is recorded
    ///         by anyone, and its review then runs from that moment (later, which only gives the client more time).
    function testFuzz_EveryJobCanBeClosedInTime(uint8 path, uint256 at) public {
        uint256 id = _open();
        path = uint8(bound(path, 0, 3));
        if (path >= 1) {
            uint256 escrowJobId = _job(id).escrowJobId;
            vm.prank(provider);
            pe.deliver(escrowJobId, SPEC, OK);
        }
        if (path >= 2) d.noteDelivered(id);
        if (path == 3) _dispute(id);
        vm.warp(block.timestamp + DELIVER_WITHIN + REVIEW + DECISION + 1 + bound(at, 0, 365 days));
        vm.startPrank(stranger);
        if (path == 0) d.reclaim(id);
        if (path == 1) {
            d.noteDelivered(id);
            vm.warp(block.timestamp + REVIEW + 1);
        }
        if (path >= 1) d.finish(id);
        vm.stopPrank();
        assertEq(uint8(_job(id).status), uint8(QEDDisputeEscrow.Status.Closed));
        assertEq(token.balanceOf(address(d)) + token.balanceOf(address(pe)), 0);
    }

    function _salted(uint256 n) internal view returns (QEDDisputeEscrow.Terms memory t) {
        t = _terms();
        t.salt = keccak256(abi.encode("salt", n));
    }
}
