// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {QEDVault} from "../src/QEDVault.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal ERC-1271 smart-account owner (e.g. a Safe): signatures are valid iff signed by `signer`.
contract SmartAccountOwner is IERC1271 {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        return ECDSA.recover(hash, sig) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract QEDVaultTest is Base {
    QEDVault.Mandate internal m;
    bytes internal mSig;

    function setUp() public override {
        super.setUp();
        m = _mandate(_payees(vendor));
        mSig = _signMandate(ownerPk, m);
    }

    // ═══════════════════════════════ OUTCOME 1: agent key + independent certificate ═══════════════════════════════

    function test_AgentPaysUnderOwnerMandateAndCosignerCertificate() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("intent-1"));
        bytes memory cSig = _signCert(cosignerPk, c);

        vm.expectEmit(true, true, true, true, address(vault));
        emit QEDVault.PaymentExecuted(c.intentId, c.mandateHash, vendor, 6 * USD, 0, c.evidenceHash, c.ref);
        uint256 id = _pay(m, mSig, c, cSig);

        assertEq(id, 0, "spot payment creates no liability");
        assertEq(usd.balanceOf(vendor), 6 * USD);
        assertEq(usd.balanceOf(address(vault)), 94 * USD);
        assertEq(vault.totalProtected(), 70 * USD, "ring-fence untouched");
        assertEq(vault.freeBalance(), 24 * USD);
        assertTrue(vault.intentUsed(c.intentId));
        assertEq(vault.spentInWindow(), 6 * USD);
    }

    function test_MandateWithoutCosignLetsAgentActAloneWithinScope() public {
        m.requireCosign = false;
        mSig = _signMandate(ownerPk, m);
        QEDVault.Certificate memory c = _cert(m, vendor, 5 * USD, keccak256("solo"));
        _pay(m, mSig, c, "");
        assertEq(usd.balanceOf(vendor), 5 * USD);
    }

    function test_ForwardPaymentCreatesRingFencedPromise() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 8 * USD, keccak256("promise-1"));
        c.dueAt = uint64(block.timestamp + 2 days);
        uint256 id = _pay(m, mSig, c, _signCert(cosignerPk, c));

        assertEq(id, 2);
        assertEq(vault.totalProtected(), 78 * USD);
        assertEq(vault.freeBalance(), 22 * USD);
        QEDVault.Liability memory l = vault.getLiability(id);
        assertEq(l.creditor, vendor);
        assertEq(l.createdBy, agent);

        // The agent cannot take its promise back: the vendor is paid at maturity by anyone.
        vm.warp(block.timestamp + 2 days);
        vm.prank(attacker);
        vault.settle(id);
        assertEq(usd.balanceOf(vendor), 8 * USD);
    }

    function test_SmartAccountOwner_ERC1271() public {
        SmartAccountOwner safe = new SmartAccountOwner(owner);
        QEDVault v2 = new QEDVault(IERC20(address(usd)), address(safe), agent, cosigner, guardian, DAILY_CAP);
        usd.mint(address(v2), 50 * USD);
        QEDVault.Mandate memory m2 = _mandate(_payees(vendor));
        m2.vault = address(v2);
        bytes32 digest = v2.mandateDigest(m2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        QEDVault.Certificate memory c = _cert(m2, vendor, 3 * USD, keccak256("1271"));
        c.mandateHash = v2.hashMandate(m2);
        (uint8 v2_, bytes32 r2, bytes32 s2) = vm.sign(cosignerPk, v2.certificateDigest(c));
        vm.prank(agent);
        v2.executePayment(m2, abi.encodePacked(r, s, v), c, abi.encodePacked(r2, s2, v2_));
        assertEq(usd.balanceOf(vendor), 3 * USD);
    }

    // ═══════════════════════════════ OUTCOME 3: tamper resistance ═══════════════════════════════

    function test_Revert_TamperedAmount() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("t1"));
        bytes memory cSig = _signCert(cosignerPk, c);
        c.amount = 9 * USD; // within every cap — only the signature stands in the way
        vm.expectRevert(QEDVault.BadCosignerSignature.selector);
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_TamperedRecipient() public {
        address[] memory two = new address[](2);
        two[0] = vendor;
        two[1] = attacker; // even if the attacker were an approved payee...
        m = _mandate(two);
        mSig = _signMandate(ownerPk, m);
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("t2"));
        bytes memory cSig = _signCert(cosignerPk, c);
        c.recipient = attacker; // ...redirecting a signed certificate fails
        vm.expectRevert(QEDVault.BadCosignerSignature.selector);
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_TamperedDueDateOrEvidence() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("t3"));
        bytes memory cSig = _signCert(cosignerPk, c);
        c.dueAt = uint64(block.timestamp + 1 days);
        vm.expectRevert(QEDVault.BadCosignerSignature.selector);
        _pay(m, mSig, c, cSig);
        c.dueAt = 0;
        c.evidenceHash = keccak256("rewritten history");
        vm.expectRevert(QEDVault.BadCosignerSignature.selector);
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_TamperedMandateScope() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("t4"));
        m.maxPerPayment = 1_000 * USD; // agent inflates its own authority
        c.mandateHash = vault.hashMandate(m);
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(QEDVault.BadOwnerSignature.selector);
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_Replay() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("r1"));
        bytes memory cSig = _signCert(cosignerPk, c);
        _pay(m, mSig, c, cSig);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.IntentAlreadyUsed.selector, c.intentId));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_ForgedCosignerSignature() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 6 * USD, keccak256("f1"));
        bytes memory selfSigned = _signCert(agentPk, c); // agent signs its own certificate
        vm.expectRevert(QEDVault.BadCosignerSignature.selector);
        _pay(m, mSig, c, selfSigned);
    }

    function test_Revert_MandateSignedByAttacker() public {
        QEDVault.Mandate memory evil = _mandate(_payees(attacker));
        bytes memory evilSig = _signMandate(attackerPk, evil);
        QEDVault.Certificate memory c = _cert(evil, attacker, 6 * USD, keccak256("f2"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(QEDVault.BadOwnerSignature.selector);
        _pay(evil, evilSig, c, cSig);
    }

    // ═══════════════════════════════ OUTCOME 3: protected liabilities ═══════════════════════════════

    function test_Revert_SolvencyViolation_EvenWithBothKeysCompromised() public {
        // Agent and co-signer collude. Payments are within every cap, but the 3rd would touch rent.
        for (uint256 i; i < 3; ++i) {
            QEDVault.Certificate memory c = _cert(m, vendor, 9 * USD, keccak256(abi.encode("drain", i)));
            if (i < 2) {
                _pay(m, mSig, c, _signCert(cosignerPk, c));
            }
        }
        // free is now 30 - 18 = 12; window remaining 25 - 18 = 7. Lift caps to isolate solvency:
        vm.prank(owner);
        vault.setDailyCap(1_000 * USD);
        QEDVault.Mandate memory big = _mandate(_payees(vendor));
        big.maxPerPayment = 100 * USD;
        big.maxPerPeriod = 100 * USD;
        big.maxTotal = 100 * USD;
        big.salt = bytes32(uint256(2));
        bytes memory bigSig = _signMandate(ownerPk, big);
        QEDVault.Certificate memory drain = _cert(big, vendor, 13 * USD, keccak256("drain-rent"));
        bytes memory dSig = _signCert(cosignerPk, drain);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.SolvencyViolation.selector, 13 * USD, 12 * USD));
        _pay(big, bigSig, drain, dSig);
        assertEq(vault.totalProtected(), 70 * USD);
        assertGe(usd.balanceOf(address(vault)), vault.totalProtected());
    }

    function test_Revert_PayeeNotInMandate_EvenIfCosignerCompromised() public {
        QEDVault.Certificate memory c = _cert(m, attacker, 1 * USD, keccak256("p1"));
        bytes memory cSig = _signCert(cosignerPk, c); // the co-signer is compromised too
        vm.expectRevert(abi.encodeWithSelector(QEDVault.PayeeNotInMandate.selector, attacker));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_PromiseCannotOverCommit() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 10 * USD, keccak256("oc"));
        c.dueAt = uint64(block.timestamp + 1 days);
        vm.prank(owner);
        vault.withdraw(owner, 25 * USD); // free: 5
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.SolvencyViolation.selector, 10 * USD, 5 * USD));
        _pay(m, mSig, c, cSig);
    }

    function test_OwnerCannotWithdrawRingFencedFunds() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.SolvencyViolation.selector, 31 * USD, 30 * USD));
        vault.withdraw(owner, 31 * USD);
        vm.prank(owner);
        vault.withdraw(owner, 30 * USD);
        assertEq(usd.balanceOf(address(vault)), 70 * USD);
    }

    function test_OnlyCreditorCanReleaseOrAssign() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotCreditor.selector, owner));
        vault.release(liabilityId);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotCreditor.selector, agent));
        vault.assign(liabilityId, agent);

        address factor = makeAddr("factor");
        vm.prank(creditor);
        vault.assign(liabilityId, factor); // receivable sold to a factor
        vm.warp(block.timestamp + 7 days);
        vault.settle(liabilityId);
        assertEq(usd.balanceOf(factor), 70 * USD);
    }

    function test_CreditorRelease() public {
        vm.prank(creditor);
        vault.release(liabilityId);
        assertEq(vault.totalProtected(), 0);
        assertEq(vault.freeBalance(), 100 * USD);
    }

    function test_SettleOnlyWhenDue_ByAnyone() public {
        vm.expectRevert(
            abi.encodeWithSelector(QEDVault.NotDueYet.selector, liabilityId, uint64(block.timestamp + 7 days))
        );
        vault.settle(liabilityId);
        vm.warp(block.timestamp + 7 days);
        vm.prank(attacker); // a stranger triggering settlement only ever pays the creditor
        vault.settle(liabilityId);
        assertEq(usd.balanceOf(creditor), 70 * USD);
        assertEq(usd.balanceOf(attacker), 0);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.LiabilityNotOpen.selector, liabilityId));
        vault.settle(liabilityId);
    }

    // ═══════════════════════════════ caps & windows ═══════════════════════════════

    function test_Revert_PerPaymentCap() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 11 * USD, keccak256("cap1"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.ExceedsPerPaymentCap.selector, 11 * USD, 10 * USD));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_MandatePeriodCap_ThenResetsNextPeriod() public {
        for (uint256 i; i < 2; ++i) {
            QEDVault.Certificate memory c = _cert(m, vendor, 10 * USD, keccak256(abi.encode("pc", i)));
            _pay(m, mSig, c, _signCert(cosignerPk, c));
        }
        QEDVault.Certificate memory c3 = _cert(m, vendor, 1 * USD, keccak256("pc3"));
        bytes memory c3Sig = _signCert(cosignerPk, c3);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.ExceedsMandatePeriodCap.selector, 1 * USD, 0));
        _pay(m, mSig, c3, c3Sig);

        vm.warp(block.timestamp + 1 days);
        usd.mint(address(vault), 10 * USD);
        c3 = _cert(m, vendor, 1 * USD, keccak256("pc4"));
        _pay(m, mSig, c3, _signCert(cosignerPk, c3));
    }

    function test_Revert_MandateTotalCap() public {
        m.maxTotal = 12 * USD;
        mSig = _signMandate(ownerPk, m);
        QEDVault.Certificate memory c = _cert(m, vendor, 10 * USD, keccak256("tc1"));
        _pay(m, mSig, c, _signCert(cosignerPk, c));
        c = _cert(m, vendor, 3 * USD, keccak256("tc2"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.ExceedsMandateTotalCap.selector, 3 * USD, 2 * USD));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_GlobalDailyCapAcrossMandates() public {
        QEDVault.Mandate memory m2 = _mandate(_payees(vendor));
        m2.salt = bytes32(uint256(99));
        bytes memory m2Sig = _signMandate(ownerPk, m2);
        QEDVault.Certificate memory a = _cert(m, vendor, 10 * USD, keccak256("d1"));
        _pay(m, mSig, a, _signCert(cosignerPk, a));
        QEDVault.Certificate memory b = _cert(m2, vendor, 10 * USD, keccak256("d2"));
        _pay(m2, m2Sig, b, _signCert(cosignerPk, b));
        QEDVault.Certificate memory d = _cert(m2, vendor, 6 * USD, keccak256("d3"));
        bytes memory dSig = _signCert(cosignerPk, d);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.ExceedsDailyCap.selector, 6 * USD, 5 * USD));
        _pay(m2, m2Sig, d, dSig);
    }

    // ═══════════════════════════════ validity windows, epochs, revocation ═══════════════════════════════

    function test_Revert_MandateExpiredOrNotYetValid() public {
        vm.warp(block.timestamp + 8 days);
        usd.mint(address(vault), 1); // keep state irrelevant
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("e1"));
        c.mandateHash = vault.hashMandate(m);
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(
            abi.encodeWithSelector(QEDVault.MandateNotActive.selector, m.validFrom, m.validUntil, block.timestamp)
        );
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_CertificateExpired() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("ce"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(
            abi.encodeWithSelector(QEDVault.CertificateNotActive.selector, c.notBefore, c.expiresAt, block.timestamp)
        );
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_EpochBumpRevokesEverything() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("ep"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.prank(owner);
        vault.bumpEpoch();
        vm.expectRevert(abi.encodeWithSelector(QEDVault.StaleEpoch.selector, 0, 1));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_RevokedMandate() public {
        bytes32 h = vault.hashMandate(m);
        vm.prank(owner);
        vault.revokeMandate(h);
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("rv"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.MandateIsRevoked.selector, h));
        _pay(m, mSig, c, cSig);
    }

    function test_Revert_KeyRotationInvalidatesOldAgentAndOldMandates() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        vault.setAgent(newAgent);
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("rot"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotAgent.selector, agent));
        vault.executePayment(m, mSig, c, cSig);
        vm.prank(newAgent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.MandateAgentMismatch.selector, agent, newAgent));
        vault.executePayment(m, mSig, c, cSig);
    }

    function test_Revert_MandateForAnotherVault() public {
        QEDVault other = new QEDVault(IERC20(address(usd)), owner, agent, cosigner, guardian, DAILY_CAP);
        QEDVault.Mandate memory mo = _mandate(_payees(vendor));
        mo.vault = address(other);
        bytes32 d = other.mandateDigest(mo);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, d);
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("xv"));
        bytes memory cSig = _signCert(cosignerPk, c);
        bytes memory moSig = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.WrongVault.selector, address(other)));
        _pay(mo, moSig, c, cSig);
    }

    // ═══════════════════════════════ permission tiers ═══════════════════════════════

    function test_AgentKeyHasNoAdminPowers() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.withdraw(agent, 1);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.ringFence(agent, 1, uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.setDailyCap(type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.setCosigner(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.setAgent(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.transferOwnership(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, agent));
        vault.unpause();
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwnerOrGuardian.selector, agent));
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotCreditor.selector, agent));
        vault.release(liabilityId);
        vm.stopPrank();
    }

    function test_NonAgentCannotExecute() public {
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("na"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotAgent.selector, owner));
        vault.executePayment(m, mSig, c, cSig);
    }

    function test_GuardianPausesButCannotUnpause_CreditorsStillPaid() public {
        vm.prank(guardian);
        vault.pause();
        QEDVault.Certificate memory c = _cert(m, vendor, 1 * USD, keccak256("gp"));
        bytes memory cSig = _signCert(cosignerPk, c);
        vm.expectRevert(QEDVault.VaultPaused.selector);
        _pay(m, mSig, c, cSig);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotOwner.selector, guardian));
        vault.unpause();
        assertEq(vault.blastRadius(30 days), 0, "paused vault has zero blast radius");

        vm.warp(block.timestamp + 7 days);
        vault.settle(liabilityId); // pausing stops the AI, never the creditors
        assertEq(usd.balanceOf(creditor), 70 * USD);

        vm.prank(owner);
        vault.unpause();
        QEDVault.Certificate memory fresh = _cert(m, vendor, 1 * USD, keccak256("gp"));
        _pay(m, mSig, fresh, _signCert(cosignerPk, fresh));
    }

    function test_TwoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.owner(), owner);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.NotPendingOwner.selector, attacker));
        vault.acceptOwnership();
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
    }

    // ═══════════════════════════════ blast radius (compromise-bounded loss) ═══════════════════════════════

    function test_BlastRadius() public {
        assertEq(vault.blastRadius(1 hours), 25 * USD, "min(free=30, cap=25)");
        assertEq(vault.blastRadius(1 days), 30 * USD, "a 2nd window can open at +24h: min(30, 50)");
        assertEq(vault.blastRadius(3 days), 30 * USD, "capped by free balance");

        QEDVault.Certificate memory c = _cert(m, vendor, 10 * USD, keccak256("br"));
        _pay(m, mSig, c, _signCert(cosignerPk, c));
        // free 20, window remaining 15 now; a further full window opens inside 24h
        assertEq(vault.blastRadius(1 hours), 15 * USD);
        assertEq(vault.blastRadius(1 days), 20 * USD);

        vm.prank(owner);
        vault.setDailyCap(2 * USD);
        assertEq(vault.blastRadius(1 hours), 0, "already spent above new cap");
        assertEq(vault.blastRadius(1 days), 2 * USD);
        assertEq(vault.blastRadius(5 days), 10 * USD);

        QEDVault.Snapshot memory s = vault.snapshot();
        assertEq(s.protectedBalance, 70 * USD);
        assertEq(s.freeBalance, 20 * USD);
        assertEq(s.blastRadius24h, 2 * USD);
    }

    /// @dev Fuzz: whatever the compromised agent does in one window, outflow ≤ blastRadius computed before.
    function testFuzz_BlastRadiusIsAnUpperBound(uint8 n, uint256 seed) public {
        vm.prank(owner);
        vault.setDailyCap(1_000 * USD);
        QEDVault.Mandate memory wide = _mandate(_payees(vendor));
        wide.maxPerPayment = 1_000 * USD;
        wide.maxPerPeriod = 1_000 * USD;
        wide.maxTotal = 1_000 * USD;
        bytes memory wSig = _signMandate(ownerPk, wide);
        uint256 bound = vault.blastRadius(1 hours);
        uint256 before = usd.balanceOf(address(vault)) - vault.totalProtected();
        for (uint256 i; i < uint256(n) % 12; ++i) {
            uint256 amt = (uint256(keccak256(abi.encode(seed, i))) % (40 * USD)) + 1;
            QEDVault.Certificate memory c = _cert(wide, vendor, amt, keccak256(abi.encode(seed, "i", i)));
            if (i % 3 == 0) c.dueAt = uint64(block.timestamp + 1 days);
            bytes memory cSig = _signCert(cosignerPk, c);
            vm.prank(agent);
            try vault.executePayment(wide, wSig, c, cSig) {} catch {}
        }
        uint256 afterFree = vault.freeBalance();
        assertLe(before - afterFree, bound);
        assertGe(usd.balanceOf(address(vault)), vault.totalProtected());
    }
}
