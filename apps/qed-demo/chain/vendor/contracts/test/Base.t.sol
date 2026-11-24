// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDVault} from "../src/QEDVault.sol";
import {QEDLens} from "../src/QEDLens.sol";
import {ProofEscrow} from "../src/ProofEscrow.sol";
import {MinVarianceVerifier} from "../src/verifiers/MinVarianceVerifier.sol";

/// @dev Shared fixture: the exact economic scenario of the live demo.
///      Vault holds 100 tUSD, 70 tUSD ring-fenced for the compute bill, 30 tUSD free.
abstract contract Base is Test {
    TestUSD internal usd;
    QEDVault internal vault;
    QEDLens internal lens;
    ProofEscrow internal escrow;
    MinVarianceVerifier internal verifier;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E7;
    uint256 internal cosignerPk = 0xC051;
    uint256 internal guardianPk = 0x6A2D;
    uint256 internal clientPk = 0xC11E;
    uint256 internal vendorPk = 0xD474;
    uint256 internal creditorPk = 0xC2ED;
    uint256 internal attackerPk = 0xBAD;

    address internal owner;
    address internal agent;
    address internal cosigner;
    address internal guardian;
    address internal client;
    address internal vendor;
    address internal creditor;
    address internal attacker;

    uint256 internal constant USD = 1e6;
    uint256 internal constant DAILY_CAP = 25 * USD;
    uint256 internal liabilityId;

    function setUp() public virtual {
        vm.warp(1_790_000_000); // Oct 2026
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        cosigner = vm.addr(cosignerPk);
        guardian = vm.addr(guardianPk);
        client = vm.addr(clientPk);
        vendor = vm.addr(vendorPk);
        creditor = vm.addr(creditorPk);
        attacker = vm.addr(attackerPk);
        vm.label(owner, "owner");
        vm.label(agent, "agent");
        vm.label(cosigner, "cosigner");
        vm.label(guardian, "guardian");
        vm.label(client, "client");
        vm.label(vendor, "vendor");
        vm.label(creditor, "creditor");
        vm.label(attacker, "attacker");

        usd = new TestUSD();
        lens = new QEDLens();
        vault = new QEDVault(IERC20(address(usd)), owner, agent, cosigner, guardian, DAILY_CAP);
        escrow = new ProofEscrow();
        verifier = new MinVarianceVerifier();

        usd.mint(owner, 100 * USD);
        usd.mint(client, 100 * USD);
        vm.startPrank(owner);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100 * USD);
        liabilityId = vault.ringFence(creditor, 70 * USD, uint64(vm.getBlockTimestamp() + 7 days), keccak256("compute bill"));
        vm.stopPrank();
    }

    // ─────────────────────────── mandate / certificate helpers ───────────────────────────

    function _payees(address a) internal pure returns (address[] memory p) {
        p = new address[](1);
        p[0] = a;
    }

    function _mandate(address[] memory payees) internal view returns (QEDVault.Mandate memory m) {
        m = QEDVault.Mandate({
            vault: address(vault),
            agent: agent,
            payees: payees,
            maxPerPayment: 10 * USD,
            maxPerPeriod: 20 * USD,
            period: 1 days,
            maxTotal: 60 * USD,
            validFrom: uint64(vm.getBlockTimestamp()),
            validUntil: uint64(vm.getBlockTimestamp() + 7 days),
            epoch: vault.epoch(),
            requireCosign: true,
            purpose: keccak256("Buy licensed market data for certified portfolio jobs"),
            salt: bytes32(uint256(1))
        });
    }

    function _cert(QEDVault.Mandate memory m, address to, uint256 amount, bytes32 intentId)
        internal
        view
        returns (QEDVault.Certificate memory c)
    {
        c = QEDVault.Certificate({
            mandateHash: _hashMandate(m),
            recipient: to,
            amount: amount,
            dueAt: 0,
            intentId: intentId,
            evidenceHash: keccak256(abi.encode("decision-record", intentId)),
            ref: keccak256("INV-0001"),
            notBefore: uint64(vm.getBlockTimestamp()),
            expiresAt: uint64(vm.getBlockTimestamp() + 1 hours),
            epoch: vault.epoch()
        });
    }

    function _hashMandate(QEDVault.Mandate memory m) internal view returns (bytes32) {
        return this.hashMandateExt(m);
    }

    function hashMandateExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.hashMandate(m);
    }

    function _signMandate(uint256 pk, QEDVault.Mandate memory m) internal view returns (bytes memory) {
        bytes32 digest = this.mandateDigestExt(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function mandateDigestExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.mandateDigest(vault, m);
    }

    function _signCert(uint256 pk, QEDVault.Certificate memory c) internal view returns (bytes memory) {
        bytes32 digest = lens.certificateDigest(vault, c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pay(QEDVault.Mandate memory m, bytes memory mSig, QEDVault.Certificate memory c, bytes memory cSig)
        internal
        returns (uint256)
    {
        vm.prank(agent);
        return vault.executePayment(m, mSig, c, cSig);
    }

    // ─────────────────────────── escrow helpers ───────────────────────────

    function _quote(bytes32 specHash, uint256 price, bytes32 quoteId) internal view returns (ProofEscrow.Quote memory q) {
        q = ProofEscrow.Quote({
            provider: agent,
            payee: address(vault),
            client: client,
            token: address(usd),
            price: price,
            verifier: address(verifier),
            specHash: specHash,
            deliverBy: uint64(vm.getBlockTimestamp() + 1 days),
            validUntil: uint64(vm.getBlockTimestamp() + 1 hours),
            quoteId: quoteId
        });
    }

    function _signQuote(uint256 pk, ProofEscrow.Quote memory q) internal view returns (bytes memory) {
        bytes32 digest = escrow.quoteDigest(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─────────────────────────── fixtures ───────────────────────────

    function _fixture() internal view returns (string memory) {
        return vm.readFile("contracts/test/fixtures/minvar.json");
    }

    function _fx(string memory key) internal view returns (bytes memory) {
        return vm.parseJsonBytes(_fixture(), string.concat(".", key));
    }
}
