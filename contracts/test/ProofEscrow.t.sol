// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {ProofEscrow} from "../src/ProofEscrow.sol";
import {MinVarianceVerifier} from "../src/verifiers/MinVarianceVerifier.sol";

/// @notice OUTCOME 2 — a paid-work lifecycle that settles on a proof of optimality.
contract ProofEscrowTest is Base {
    bytes internal spec;
    bytes32 internal specHash;
    bytes internal honest;
    ProofEscrow.Quote internal q;
    bytes internal qSig;

    uint256 internal constant PRICE = 15 * USD;

    function setUp() public override {
        super.setUp();
        spec = _fx("spec");
        specHash = keccak256(spec);
        honest = _fx("honest");
        q = _quote(specHash, PRICE, keccak256("Q-1"));
        qSig = _signQuote(agentPk, q);
        vm.prank(client);
        usd.approve(address(escrow), type(uint256).max);
    }

    function _open() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.open(q, qSig);
    }

    // ═══════════════════════════════ happy path ═══════════════════════════════

    function test_Lifecycle_QuoteOpenDeliverSettle_IntoAgentVault() public {
        uint256 vaultBefore = usd.balanceOf(address(vault));
        uint256 jobId = _open();
        assertEq(usd.balanceOf(address(escrow)), PRICE);

        vm.prank(agent);
        escrow.deliver(jobId, spec, honest);

        ProofEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(uint8(j.status), uint8(ProofEscrow.Status.Settled));
        assertEq(uint256(j.resultDigest), vm.parseJsonUint(_fixture(), ".variance"), "certified variance recorded");
        assertEq(j.solutionHash, keccak256(honest));
        assertEq(usd.balanceOf(address(vault)), vaultBefore + PRICE, "revenue lands in the agent's vault");
        assertEq(vault.freeBalance(), 30 * USD + PRICE, "earned revenue is free; ring-fence unchanged");
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function test_CheckIsAPureDryRun() public {
        uint256 jobId = _open();
        bytes32 d = escrow.check(jobId, spec, honest);
        assertEq(uint256(d), vm.parseJsonUint(_fixture(), ".variance"));
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ProofEscrow.Status.Open));
    }

    // ═══════════════════════════════ forged work is rejected by mathematics ═══════════════════════════════

    function test_Revert_LazyEqualWeightPortfolio() public {
        uint256 jobId = _open();
        bytes memory forged = _fx("equalWeight");
        vm.prank(agent);
        vm.expectPartialRevert(MinVarianceVerifier.DualityGapTooLarge.selector);
        escrow.deliver(jobId, spec, forged);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ProofEscrow.Status.Open));
    }

    function test_Revert_AlmostOptimalIsNotOptimal() public {
        uint256 jobId = _open();
        bytes memory forged = _fx("nudged1bp"); // optimum shifted by 0.01%
        vm.prank(agent);
        vm.expectPartialRevert(MinVarianceVerifier.StationarityViolated.selector);
        escrow.deliver(jobId, spec, forged);
    }

    function test_Revert_FakeConvexityWitness() public {
        uint256 jobId = _open();
        bytes memory forged = _fx("badPsd");
        vm.prank(agent);
        vm.expectPartialRevert(MinVarianceVerifier.NotPositiveSemidefinite.selector);
        escrow.deliver(jobId, spec, forged);
    }

    function test_Revert_SolvedADifferentProblem() public {
        uint256 jobId = _open();
        bytes memory otherSpec = abi.encode(uint256(2), new int256[](4), uint256(1e9), bytes32(0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.SpecMismatch.selector, specHash, keccak256(otherSpec)));
        escrow.deliver(jobId, otherSpec, honest);
    }

    // ═══════════════════════════════ signed terms cannot be tampered with ═══════════════════════════════

    function test_Revert_ClientTampersPrice() public {
        q.price = 1 * USD;
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(q, qSig);
    }

    function test_Revert_ClientTampersPayeeVerifierSpecOrDeadline() public {
        ProofEscrow.Quote memory t = q;
        t.payee = attacker;
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(t, qSig);

        t = q;
        t.verifier = address(0xdead);
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(t, qSig);

        t = q;
        t.specHash = keccak256("harder problem, same price");
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(t, qSig);

        t = q;
        t.deliverBy = uint64(vm.getBlockTimestamp() + 1 minutes);
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(t, qSig);
    }

    function test_Revert_QuoteReplayAndWrongClientAndExpiry() public {
        _open();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.QuoteAlreadyUsed.selector, q.quoteId));
        escrow.open(q, qSig);

        ProofEscrow.Quote memory q2 = _quote(specHash, PRICE, keccak256("Q-2"));
        bytes memory s2 = _signQuote(agentPk, q2);
        usd.mint(attacker, PRICE);
        vm.startPrank(attacker);
        usd.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.NotQuotedClient.selector, attacker, client));
        escrow.open(q2, s2);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.QuoteExpired.selector, q2.validUntil));
        escrow.open(q2, s2);
    }

    function test_Revert_QuoteSignedByImpostor() public {
        bytes memory fake = _signQuote(attackerPk, q);
        vm.prank(client);
        vm.expectRevert(ProofEscrow.BadProviderSignature.selector);
        escrow.open(q, fake);
    }

    // ═══════════════════════════════ delivery rules & refunds ═══════════════════════════════

    function test_Revert_OnlyProviderDelivers_AndOnlyOnce() public {
        uint256 jobId = _open();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.NotProvider.selector, attacker));
        escrow.deliver(jobId, spec, honest);
        vm.prank(agent);
        escrow.deliver(jobId, spec, honest);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.JobNotOpen.selector, jobId));
        escrow.deliver(jobId, spec, honest);
    }

    function test_RefundAfterDeadline_ByAnyone_ToClientOnly() public {
        uint256 jobId = _open();
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.NotRefundableYet.selector, q.deliverBy));
        escrow.refund(jobId);
        vm.warp(uint256(q.deliverBy) + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofEscrow.DeadlinePassed.selector, q.deliverBy));
        escrow.deliver(jobId, spec, honest);
        uint256 before = usd.balanceOf(client);
        vm.prank(attacker);
        escrow.refund(jobId);
        assertEq(usd.balanceOf(client), before + PRICE);
        assertEq(usd.balanceOf(attacker), 0);
    }

    function test_ProviderMayRefundEarly() public {
        uint256 jobId = _open();
        vm.prank(agent);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ProofEscrow.Status.Refunded));
    }
}
