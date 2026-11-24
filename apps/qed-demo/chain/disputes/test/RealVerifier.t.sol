// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {MinVarianceVerifier} from "qed/src/verifiers/MinVarianceVerifier.sol";
import {QEDDisputeEscrow} from "../src/QEDDisputeEscrow.sol";
import {DisputeBase} from "./DisputeBase.sol";

/// @notice The release's own verifier and fixture (vendor/contracts/test/fixtures/minvar.json): a counterfeit
///         certificate moves nothing; the certified one settles into the dispute escrow, not the provider, and the
///         money moves on only under the terms.
contract RealVerifierTest is DisputeBase {
    MinVarianceVerifier internal minvar;
    bytes internal spec;

    function _fx(string memory key) internal view returns (bytes memory) {
        return vm.parseJsonBytes(vm.readFile("../vendor/contracts/test/fixtures/minvar.json"), string.concat(".", key));
    }

    function setUp() public override {
        super.setUp();
        minvar = new MinVarianceVerifier();
        spec = _fx("spec");
    }

    function _openReal() internal returns (uint256 id) {
        QEDDisputeEscrow.Terms memory t = _terms();
        ProofEscrow.Quote memory q = _quote(t, PRICE);
        q.verifier = address(minvar);
        q.specHash = keccak256(spec);
        bytes memory sig = _sign(q);
        vm.prank(client);
        id = d.open(t, q, sig);
    }

    function test_TheReleaseVerifier_RefusesTheLazyPortfolioAndSettlesTheCertifiedOneIntoTheDisputeEscrow() public {
        uint256 id = _openReal();
        uint256 escrowJobId = _job(id).escrowJobId;
        bytes memory lazy = _fx("equalWeight");
        vm.prank(provider);
        vm.expectRevert();
        pe.deliver(escrowJobId, spec, lazy);
        assertEq(token.balanceOf(address(pe)), PRICE, "a counterfeit moves nothing");

        vm.prank(provider);
        pe.deliver(escrowJobId, spec, _fx("honest"));
        d.noteDelivered(id);
        assertEq(token.balanceOf(payee), 0, "verified, but not paid before the review");
        assertEq(token.balanceOf(address(d)), PRICE);
        assertEq(uint256(pe.getJob(escrowJobId).resultDigest), vm.parseJsonUint(vm.readFile("../vendor/contracts/test/fixtures/minvar.json"), ".variance"));

        // the client disputes; the decider splits after the evidence period
        _dispute(id);
        vm.warp(block.timestamp + EVIDENCE + 1);
        vm.prank(decider);
        d.decide(id, 20_000);
        assertEq(token.balanceOf(payee), 20_000);
        assertEq(token.balanceOf(address(d)), 0);
    }
}
