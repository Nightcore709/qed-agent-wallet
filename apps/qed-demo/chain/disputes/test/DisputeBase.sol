// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../src/QEDDisputeEscrow.sol";
import {MockToken, MockVerifier} from "./helpers/Mocks.sol";

/// @notice The release's ProofEscrow (unmodified, from the vendored tree), the dispute escrow in front of it, a test
///         token and a mock verifier; a provider with a signing key, its payee, a client, a decider and a stranger.
abstract contract DisputeBase is Test {
    ProofEscrow internal pe;
    QEDDisputeEscrow internal d;
    MockToken internal token;
    MockVerifier internal verifier;

    uint256 internal providerPk = 0xA11CE;
    address internal provider;
    address internal payee = makeAddr("payee (the provider's vault)");
    address internal client = makeAddr("client");
    address internal decider = makeAddr("decider");
    address internal stranger = makeAddr("stranger");

    bytes internal constant SPEC = hex"5bec";
    bytes internal constant OK = "ok";
    uint256 internal constant PRICE = 25_051; // 250.51 tINR
    uint32 internal constant REVIEW = 3 days;
    uint32 internal constant EVIDENCE = 2 days;
    uint32 internal constant DECISION = 5 days;
    uint64 internal constant DELIVER_WITHIN = 2 days;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        provider = vm.addr(providerPk);
        token = new MockToken();
        verifier = new MockVerifier();
        pe = new ProofEscrow();
        d = _newEscrow(pe);
        token.mint(client, 1_000_000_000);
        vm.prank(client);
        token.approve(address(d), type(uint256).max);
    }

    /// @dev The escrow under test; the seeded twins override it.
    function _newEscrow(ProofEscrow escrow) internal virtual returns (QEDDisputeEscrow) {
        return new QEDDisputeEscrow(escrow);
    }

    function _terms() internal view returns (QEDDisputeEscrow.Terms memory) {
        return QEDDisputeEscrow.Terms({
            client: client,
            payee: payee,
            decider: decider,
            deciderMay: 7,
            reviewPeriod: REVIEW,
            evidencePeriod: EVIDENCE,
            decisionPeriod: DECISION,
            reviewTimeoutBps: 10_000,
            decisionTimeoutBps: 5_000,
            salt: keccak256("salt-1")
        });
    }

    function _quote(QEDDisputeEscrow.Terms memory t, uint256 price) internal view returns (ProofEscrow.Quote memory) {
        return ProofEscrow.Quote({
            provider: provider,
            payee: address(d),
            client: address(d),
            token: address(token),
            price: price,
            verifier: address(verifier),
            specHash: keccak256(SPEC),
            deliverBy: uint64(block.timestamp + DELIVER_WITHIN),
            validUntil: uint64(block.timestamp + 1 days),
            quoteId: d.termsHash(t)
        });
    }

    function _sign(ProofEscrow.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPk, pe.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _open(QEDDisputeEscrow.Terms memory t, uint256 price) internal returns (uint256 id) {
        ProofEscrow.Quote memory q = _quote(t, price);
        bytes memory sig = _sign(q);
        vm.prank(t.client);
        id = d.open(t, q, sig);
    }

    function _open() internal returns (uint256) {
        return _open(_terms(), PRICE);
    }

    /// @dev The provider's delivery as QED sends it: ProofEscrow.deliver, then noteDelivered, in one transaction.
    function _deliver(uint256 id) internal {
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        vm.prank(provider);
        pe.deliver(j.escrowJobId, SPEC, OK);
        d.noteDelivered(id);
    }

    function _dispute(uint256 id) internal {
        vm.prank(client);
        d.dispute(id, keccak256("the weights do not sum as agreed"));
    }

    function _job(uint256 id) internal view returns (QEDDisputeEscrow.Job memory) {
        return d.getJob(id);
    }
}
