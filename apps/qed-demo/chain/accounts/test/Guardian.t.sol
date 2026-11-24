// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest, Target} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// R13: the guardian (design D-m). The person's recovery contact's passkey co-signs recoveries. It is set, replaced and
/// removed only behind `delay`; while it is set a recovery code alone starts nothing; a frozen Member cannot cancel a
/// recovery it co-signed; it approves, cancels and protects nothing.
contract GuardianTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;
    Key internal rec;
    Key internal rec2;
    Key internal contact; // the recovery contact's passkey
    Key internal other; // another contact's passkey
    Key internal dave; // the passkey a recovery adds
    Target internal brake;
    address internal sentinel;

    bytes32 internal constant SCHEDULED_SIG =
        keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    event RecoveryCosigned(bytes32 indexed recoveryId, bytes32 indexed guardianId);
    event SignerAdded(bytes32 indexed signerId, QEDOwnerAccount.Role role, uint256 x, uint256 y, uint64 serial);
    event SignerRemoved(bytes32 indexed signerId, QEDOwnerAccount.Role role);

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        rec = newKey(0xEC0);
        rec2 = newKey(0xEC1);
        contact = newKey(0xC0C0);
        other = newKey(0x07E2);
        dave = newKey(0xDA7E);
        brake = new Target();
        sentinel = makeAddr("sentinel");
        QEDOwnerAccount.Guard[] memory p = new QEDOwnerAccount.Guard[](1);
        p[0] = QEDOwnerAccount.Guard(address(brake), Target.set.selector, "test: a protective call");
        // the two-of-two household of design D-l: two passkeys, both needed, two recovery codes
        acct = deployContained(keys2(alice, bob), keys2(rec, rec2), 2, 2, noGuards(), p, sentinel);
    }

    // ── helpers ───────────────────────────────────────────────────────────────────

    function _scheduled() internal returns (bytes32 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "no ChangeScheduled");
    }

    function _scheduleGuardian(Key memory g, Key[] memory approvers) internal returns (bytes32 id) {
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setGuardian, (g.x, g.y))), approvers);
        vm.recordLogs();
        run(acct, p);
        id = _scheduled();
    }

    function _installGuardian(Key memory g) internal {
        bytes32 id = _scheduleGuardian(g, keys2(alice, bob));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(id);
        assertEq(acct.guardian(), g.id);
    }

    function _recoverySig(Key memory r, Key memory newKey_, uint64 deadline) internal view returns (bytes32, bytes32) {
        return recoverySign(r, acct.recoveryDigest(r.id, newKey_.x, newKey_.y, deadline));
    }

    function _cosigned(Key memory r, Key memory newKey_, Key memory g) internal returns (bytes32) {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (bytes32 sr, bytes32 ss) = _recoverySig(r, newKey_, deadline);
        QEDOwnerAccount.Assertion memory a = signAs(g, acct.recoveryDigest(r.id, newKey_.x, newKey_.y, deadline));
        return acct.startCosignedRecovery(r.id, newKey_.x, newKey_.y, deadline, sr, ss, a);
    }

    // ── setting, replacing and removing the guardian ─────────────────────────────

    function test_setting_a_guardian_waits_the_delay_and_any_member_can_cancel_it() public {
        bytes32 id = _scheduleGuardian(contact, keys2(alice, bob));
        assertEq(acct.guardian(), bytes32(0), "nothing at once");
        QEDOwnerAccount.PendingChange memory c = acct.getChange(id);
        assertEq(uint8(c.kind), uint8(QEDOwnerAccount.ChangeKind.SetGuardian));
        assertEq(c.readyAt, uint64(vm.getBlockTimestamp()) + DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, c.readyAt));
        acct.applyChange(id);
        // one Member cancels it, whatever the thresholds (2 of 2 here)
        acct.cancel(id, signAs(bob, acct.cancelDigest(id)));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyChange(id);
        assertEq(acct.guardian(), bytes32(0));
        // scheduled again, nobody cancels: anyone applies it once due
        id = _scheduleGuardian(contact, keys2(alice, bob));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(acct));
        emit SignerAdded(contact.id, QEDOwnerAccount.Role.Guardian, contact.x, contact.y, 7);
        vm.prank(makeAddr("anyone"));
        acct.applyChange(id);
        assertEq(acct.guardian(), contact.id);
        assertEq(uint8(acct.getSigner(contact.id).role), uint8(QEDOwnerAccount.Role.Guardian));
        assertEq(acct.memberCount(), 2, "a guardian is not a Member");
        assertEq(acct.threshold(), 2);
    }

    function test_the_guardian_is_set_only_through_setGuardian_and_never_at_once() public {
        // not by addSigner (immediate), not at construction, not removed by removeSigners
        Prepared memory p = prepare(
            acct,
            selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (contact.x, contact.y, QEDOwnerAccount.Role.Guardian))),
            keys2(alice, bob)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector, 0, abi.encodeWithSelector(QEDOwnerAccount.InvalidRole.selector)
            )
        );
        run(acct, p);
        QEDOwnerAccount.SignerInit[] memory s = new QEDOwnerAccount.SignerInit[](2);
        s[0] = QEDOwnerAccount.SignerInit(alice.x, alice.y, QEDOwnerAccount.Role.Member);
        s[1] = QEDOwnerAccount.SignerInit(contact.x, contact.y, QEDOwnerAccount.Role.Guardian);
        vm.expectRevert(QEDOwnerAccount.InvalidRole.selector);
        new QEDOwnerAccount(
            RP_ID_HASH, ORIGIN, s, 1, 1, DELAY, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false
        );
        // only the account itself may schedule it
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.setGuardian(contact.x, contact.y);
        // a key that is already a signer, or not on the curve, is refused when scheduled
        vm.startPrank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, alice.id));
        acct.setGuardian(alice.x, alice.y);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, rec.id));
        acct.setGuardian(rec.x, rec.y);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidPublicKey.selector, 1, 2));
        acct.setGuardian(1, 2);
        vm.stopPrank();
        _installGuardian(contact);
        vm.prank(address(acct));
        vm.expectRevert(QEDOwnerAccount.InvalidRole.selector);
        acct.removeSigners(ids1(contact.id));
        // nor can the guardian's key be added as a Member or Recovery key while it is the guardian
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, contact.id));
        acct.addSigner(contact.x, contact.y, QEDOwnerAccount.Role.Member);
    }

    function test_replacing_and_removing_the_guardian_wait_the_delay_and_a_stale_change_is_refused() public {
        _installGuardian(contact);
        // two changes scheduled against the same guardian: the first applied makes the second stale
        bytes32 replace = _scheduleGuardian(other, keys2(alice, bob));
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setGuardian, (0, 0))), keys2(alice, bob));
        vm.recordLogs();
        run(acct, p);
        bytes32 remove = _scheduled();
        assertEq(acct.guardian(), contact.id, "neither applies at once");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(acct));
        emit SignerRemoved(contact.id, QEDOwnerAccount.Role.Guardian);
        acct.applyChange(replace);
        assertEq(acct.guardian(), other.id);
        assertEq(uint8(acct.getSigner(contact.id).role), uint8(QEDOwnerAccount.Role.None));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, remove));
        acct.applyChange(remove);
        // removing it waits too; afterwards a code alone starts a recovery again
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setGuardian, (0, 0))), keys2(alice, bob));
        vm.recordLogs();
        run(acct, p);
        remove = _scheduled();
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (bytes32 sr, bytes32 ss) = _recoverySig(rec, dave, deadline);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardianRequired.selector, other.id));
        acct.startRecovery(rec.id, dave.x, dave.y, deadline, sr, ss);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(remove);
        assertEq(acct.guardian(), bytes32(0));
        assertEq(acct.signerIds().length, 4, "two Members and two Recovery keys");
        deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (sr, ss) = _recoverySig(rec, dave, deadline);
        bytes32 rid = acct.startRecovery(rec.id, dave.x, dave.y, deadline, sr, ss);
        assertFalse(acct.getRecovery(rid).cosigned);
    }

    // ── recovery with a guardian ──────────────────────────────────────────────────

    function test_with_a_guardian_a_recovery_code_alone_starts_nothing() public {
        _installGuardian(contact);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (bytes32 sr, bytes32 ss) = _recoverySig(rec, dave, deadline);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardianRequired.selector, contact.id));
        acct.startRecovery(rec.id, dave.x, dave.y, deadline, sr, ss);
        assertFalse(acct.spentRecoveryKey(rec.id), "the code is not spent by a refused attempt");
        assertEq(acct.pendingRecoveryOf(rec.id), bytes32(0));
    }

    function test_the_guardian_cosigns_exactly_one_recovery() public {
        _installGuardian(contact);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 digest = acct.recoveryDigest(rec.id, dave.x, dave.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(rec, digest);
        // a Member's assertion is not the guardian's
        QEDOwnerAccount.Assertion memory a = signAs(alice, digest);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotGuardian.selector, alice.id));
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
        // the guardian's assertion over another recovery (another new key) does not stand for this one
        a = signAs(contact, acct.recoveryDigest(rec.id, other.x, other.y, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
        // nor one made on another origin, or without user verification
        Opts memory o = opts();
        o.origin = "http://localhost:8080";
        a = signAs(contact, digest, o);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
        o = opts();
        o.flags = 0x01;
        a = signAs(contact, digest, o);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
        // the guardian's own assertion and a bad code signature: still refused
        (bytes32 br, bytes32 bs) = recoverySign(rec2, digest);
        a = signAs(contact, digest);
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, br, bs, a);
        // both right: it starts, co-signed
        vm.expectEmit(false, true, false, false, address(acct));
        emit RecoveryCosigned(bytes32(0), contact.id);
        bytes32 rid = acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
        QEDOwnerAccount.PendingRecovery memory pr = acct.getRecovery(rid);
        assertTrue(pr.cosigned);
        assertEq(pr.readyAt, uint64(vm.getBlockTimestamp()) + RECOVERY_DELAY);
        assertTrue(acct.spentRecoveryKey(rec.id));
        vm.warp(pr.readyAt);
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
        assertEq(acct.memberCount(), 3);
    }

    function test_without_a_guardian_the_cosigned_path_is_refused() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 digest = acct.recoveryDigest(rec.id, dave.x, dave.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(rec, digest);
        QEDOwnerAccount.Assertion memory a = signAs(contact, digest);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotGuardian.selector, contact.id));
        acct.startCosignedRecovery(rec.id, dave.x, dave.y, deadline, sr, ss, a);
    }

    function test_a_frozen_member_cannot_cancel_a_cosigned_recovery_but_an_unfrozen_one_can() public {
        _installGuardian(contact);
        vm.prank(sentinel);
        acct.freeze(bob.id);
        bytes32 rid = _cosigned(rec, dave, contact);
        QEDOwnerAccount.Assertion memory byBob = signAs(bob, acct.cancelDigest(rid));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, bob.id));
        acct.cancel(rid, byBob);
        // the unfrozen Member keeps the veto; cancelling spends the code
        acct.cancel(rid, signAs(alice, acct.cancelDigest(rid)));
        assertEq(acct.getRecovery(rid).readyAt, 0);
        assertEq(uint8(acct.getSigner(rec.id).role), uint8(QEDOwnerAccount.Role.None));
    }

    function test_a_frozen_member_keeps_its_veto_over_a_recovery_without_the_guardian() public {
        vm.prank(sentinel);
        acct.freeze(bob.id);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (bytes32 sr, bytes32 ss) = _recoverySig(rec, dave, deadline);
        bytes32 rid = acct.startRecovery(rec.id, dave.x, dave.y, deadline, sr, ss);
        acct.cancel(rid, signAs(bob, acct.cancelDigest(rid)));
        assertEq(acct.getRecovery(rid).readyAt, 0);
    }

    function test_the_guardian_approves_cancels_and_protects_nothing() public {
        _installGuardian(contact);
        Target t = new Target();
        // execute: not a Member (with alice, so that the count is met and the guardian's assertion is examined)
        Prepared memory p = prepare(acct, calls1(address(t), 0, abi.encodeCall(Target.set, (1))), keys2(alice, contact));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        run(acct, p);
        // ERC-1271: invalid
        bytes32 h = keccak256("a mandate");
        assertEq(acct.isValidSignature(h, abi.encode(one(signAs(contact, acct.replaySafeHash(h))))), bytes4(0xffffffff));
        // cancel: not a Member
        bytes32 id = _scheduleGuardian(other, keys2(alice, bob));
        QEDOwnerAccount.Assertion memory byContact = signAs(contact, acct.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        acct.cancel(id, byContact);
        // protect: not a Member
        ProtectPrepared memory pp = prepareProtect(acct, calls1(address(brake), 0, abi.encodeCall(Target.set, (7))), contact);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        runProtect(acct, pp);
        // the sentinel cannot freeze it either (it has nothing to freeze)
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        acct.freeze(contact.id);
        assertEq(t.value(), 0);
        assertEq(brake.value(), 0);
    }

    /// Design D-l's weak point, closed: with two passkeys at threshold 2, a stolen one is frozen by QED; before R13 it
    /// could still cancel every recovery (spending each code) and hold the household hostage. With a guardian, the
    /// recovery the contact co-signs cannot be cancelled by the frozen key; the household then removes it.
    function test_the_two_of_two_hostage_case_ends_with_a_guardian() public {
        _installGuardian(contact);
        // bob's passkey is stolen; QED suspends it and the sentinel freezes it at once
        vm.prank(sentinel);
        acct.freeze(bob.id);
        // alice alone can neither spend nor change anything (threshold 2), and bob's approval no longer counts
        Target t = new Target();
        Prepared memory p = prepare(acct, calls1(address(t), 0, abi.encodeCall(Target.set, (1))), keys2(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, bob.id));
        run(acct, p);
        // alice recovers a new passkey (dave) with a code, co-signed by her contact; the thief cannot cancel it
        bytes32 rid = _cosigned(rec, dave, contact);
        QEDOwnerAccount.Assertion memory byThief = signAs(bob, acct.cancelDigest(rid));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, bob.id));
        acct.cancel(rid, byThief);
        vm.warp(vm.getBlockTimestamp() + RECOVERY_DELAY);
        acct.finishRecovery(rid);
        // alice and dave reach threshold 2: they schedule the thief's removal, which it cannot cancel
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id)))), keys2(alice, dave));
        vm.recordLogs();
        run(acct, p);
        bytes32 removal = _scheduled();
        byThief = signAs(bob, acct.cancelDigest(removal));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, bob.id));
        acct.cancel(removal, byThief);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(removal);
        assertEq(uint8(acct.getSigner(bob.id).role), uint8(QEDOwnerAccount.Role.None));
        assertEq(acct.memberCount(), 2);
        // and they spend again, two devices
        exec(acct, calls1(address(t), 0, abi.encodeCall(Target.set, (9))), keys2(alice, dave));
        assertEq(t.value(), 9);
    }

    /// The limit of D-m, recorded: a guardian who colludes with a code thief gets the thief a seat if no unfrozen Member
    /// cancels in time. An unfrozen Member still can.
    function test_a_colluding_guardian_and_code_thief_are_stopped_by_any_unfrozen_member() public {
        _installGuardian(contact);
        Key memory thief = newKey(0x7E1F);
        bytes32 rid = _cosigned(rec2, thief, contact);
        acct.cancel(rid, signAs(alice, acct.cancelDigest(rid)));
        assertEq(acct.getRecovery(rid).readyAt, 0);
        assertEq(uint8(acct.getSigner(rec2.id).role), uint8(QEDOwnerAccount.Role.None), "the code is spent");
    }
}
