// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {ProofEscrow} from "../src/ProofEscrow.sol";
import {Groth16Verifier} from "../src/verifiers/zk/Groth16Verifier.sol";
import {
    PrivateMinVarianceVerifier,
    IGroth16PrivateMinVariance
} from "../src/verifiers/PrivateMinVarianceVerifier.sol";

/// @notice A real Groth16 proof of private optimality (contracts/test/fixtures/private.json, made by
///         `npm run fixtures:private`), checked by the generated verifier and attacked every way we know.
contract PrivateMinVarianceVerifierTest is Test {
    PrivateMinVarianceVerifier internal v;
    string internal fx;
    bytes internal spec;
    bytes internal solution;
    uint256 internal dataCommitment;
    uint256 internal weightsCommitment;
    uint256 internal variance;
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function setUp() public {
        fx = vm.readFile("contracts/test/fixtures/private.json");
        Groth16Verifier g = new Groth16Verifier();
        v = new PrivateMinVarianceVerifier(IGroth16PrivateMinVariance(address(g)), vm.parseJsonAddress(fx, ".vendor"));
        spec = vm.parseJsonBytes(fx, ".spec");
        solution = vm.parseJsonBytes(fx, ".solution");
        dataCommitment = vm.parseJsonUint(fx, ".dataCommitment");
        weightsCommitment = vm.parseJsonUint(fx, ".weightsCommitment");
        variance = vm.parseJsonUint(fx, ".variance");
        uint256[] memory pa = vm.parseJsonUintArray(fx, ".proof.a");
        uint256[] memory pb0 = vm.parseJsonUintArray(fx, ".proof.b[0]");
        uint256[] memory pb1 = vm.parseJsonUintArray(fx, ".proof.b[1]");
        uint256[] memory pc = vm.parseJsonUintArray(fx, ".proof.c");
        a = [pa[0], pa[1]];
        b = [[pb0[0], pb0[1]], [pb1[0], pb1[1]]];
        c = [pc[0], pc[1]];
    }

    function _solution(uint256 wc, uint256 var_) internal view returns (bytes memory) {
        return abi.encode(a, b, c, wc, var_);
    }

    // ═══════════════════════════ acceptance ═══════════════════════════

    function test_ValidProofAccepted() public view {
        bytes32 d = v.verify(spec, solution);
        assertEq(d, keccak256(abi.encode(weightsCommitment, variance)));
        assertEq(d, vm.parseJsonBytes32(fx, ".resultDigest"));
    }

    function test_CertifiedVarianceIsTheTrueOptimum() public view {
        // the off-chain witness, never published on-chain: w·Σ·w at scale 1e36 equals the public signal
        assertEq(variance, 1570268872480973219535505240000000);
        assertApproxEqRel(variance, 0.00157026887248e36, 1e9);
    }

    function test_GasOfPrivateVerification() public {
        uint256 g0 = gasleft();
        v.verify(spec, solution);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas: attestation + Groth16 verification", used);
        assertLt(used, 400_000);
    }

    // ═══════════════════════════ attacks ═══════════════════════════

    function test_RejectsUnderstatedVariance() public {
        vm.expectRevert(PrivateMinVarianceVerifier.ProofRejected.selector);
        v.verify(spec, _solution(weightsCommitment, variance - 1));
    }

    function test_RejectsSwappedPortfolioCommitment() public {
        vm.expectRevert(PrivateMinVarianceVerifier.ProofRejected.selector);
        v.verify(spec, _solution(weightsCommitment ^ 1, variance));
    }

    function test_StolenProofIsUselessToAnotherProvider() public {
        bytes memory malloryspec = vm.parseJsonBytes(fx, ".specForMallory");
        vm.expectRevert(PrivateMinVarianceVerifier.ProofRejected.selector);
        v.verify(malloryspec, solution);
    }

    function test_RejectsDataNotAttestedByTheVendor() public {
        bytes memory s = vm.parseJsonBytes(fx, ".specImpostor");
        vm.expectRevert(
            abi.encodeWithSelector(
                PrivateMinVarianceVerifier.UntrustedDataAttestation.selector, vm.parseJsonAddress(fx, ".impostor")
            )
        );
        v.verify(s, solution);
    }

    function test_AttestationDoesNotTransferAcrossChains() public {
        vm.chainId(11155111);
        vm.expectPartialRevert(PrivateMinVarianceVerifier.UntrustedDataAttestation.selector);
        v.verify(spec, solution);
    }

    function test_RejectsNonCanonicalFieldElement() public {
        vm.expectRevert(PrivateMinVarianceVerifier.NotAFieldElement.selector);
        v.verify(spec, _solution(weightsCommitment, variance + FIELD));
    }

    function testFuzz_AnyCorruptedProofCoordinateIsRejected(uint8 which, uint256 delta) public {
        delta = bound(delta, 1, type(uint128).max);
        uint256 k = uint256(which) % 8;
        if (k < 2) a[k] = addmod(a[k], delta, FIELD);
        else if (k < 6) b[(k - 2) / 2][(k - 2) % 2] = addmod(b[(k - 2) / 2][(k - 2) % 2], delta, FIELD);
        else c[k - 6] = addmod(c[k - 6], delta, FIELD);
        vm.expectRevert(PrivateMinVarianceVerifier.ProofRejected.selector);
        v.verify(spec, _solution(weightsCommitment, variance));
    }

    // ═══════════════════════════ through the escrow ═══════════════════════════

    function _quote(address token, address provider, address payee, bytes memory s, bytes32 id)
        internal
        view
        returns (ProofEscrow.Quote memory q)
    {
        q = ProofEscrow.Quote({
            provider: provider,
            payee: payee,
            client: address(0),
            token: token,
            price: 12e6,
            verifier: address(v),
            specHash: keccak256(s),
            deliverBy: uint64(block.timestamp + 1 days),
            validUntil: uint64(block.timestamp + 1 hours),
            quoteId: id
        });
    }

    function test_EscrowPaysOnlyForThePrivateProof() public {
        TestUSD usd = new TestUSD();
        ProofEscrow esc = new ProofEscrow();
        uint256 qpk = vm.parseJsonUint(fx, ".providerPk");
        uint256 mpk = vm.parseJsonUint(fx, ".malloryPk");
        address qed = vm.addr(qpk);
        address mal = vm.addr(mpk);
        address vault = makeAddr("qed-vault");
        address client = makeAddr("client");
        usd.mint(client, 100e6);
        vm.prank(client);
        usd.approve(address(esc), type(uint256).max);

        // QED's job: spec names QED; Mallory's job: spec names Mallory (a client accepts nothing else)
        ProofEscrow.Quote memory q1 = _quote(address(usd), qed, vault, spec, "qed-1");
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(qpk, esc.quoteDigest(q1));
        bytes memory mspec = vm.parseJsonBytes(fx, ".specForMallory");
        ProofEscrow.Quote memory q2 = _quote(address(usd), mal, mal, mspec, "mal-1");
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(mpk, esc.quoteDigest(q2));
        vm.startPrank(client);
        uint256 job1 = esc.open(q1, abi.encodePacked(r1, s1, v1));
        uint256 job2 = esc.open(q2, abi.encodePacked(r2, s2, v2));
        vm.stopPrank();

        // Mallory copies QED's proof from the mempool into her own job: refused, because it is bound to QED.
        vm.prank(mal);
        vm.expectRevert(PrivateMinVarianceVerifier.ProofRejected.selector);
        esc.deliver(job2, mspec, solution);

        // QED delivers: the escrow pays the vault for a proof about data it never sees.
        vm.prank(qed);
        esc.deliver(job1, spec, solution);
        assertEq(usd.balanceOf(vault), 12e6);
    }
}
