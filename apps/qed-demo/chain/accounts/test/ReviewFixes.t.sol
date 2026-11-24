// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest, Target} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// R13 review fixes (25 Nov 2026), test-first. F1: with every Member frozen a co-signed recovery stays pending (the
/// owner's rule), its wait restarts in full once a Member is unfrozen, the guardian can withdraw its co-signature, and a
/// recovery deadline is at most one day ahead. F2: a removal leaves a settled Member able to cancel it. F4: turning the
/// time-lock on (and any change of the sentinel or the guardian) voids pending changes scheduled before it. F5: a
/// recovery started before the guardian took effect does not finish while one is set.
contract ReviewFixesTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;
    Key internal rec;
    Key internal rec2;
    Key internal contact; // the guardian's passkey
    Key internal other; // another contact's passkey
    Key internal dave; // the passkey a recovery adds
    Key internal puppet; // a Member a recovered seat adds at once
    Target internal brake;
    Target internal lockTarget;
    address internal sentinel;

    bytes32 internal constant SCHEDULED_SIG =
        keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    event RecoveryCancelled(bytes32 indexed recoveryId, bytes32 indexed bySignerId);
    event RecoveryRestarted(bytes32 indexed recoveryId, uint64 readyAt);

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        rec = newKey(0xEC0);
        rec2 = newKey(0xEC1);
        contact = newKey(0xC0C0);
        other = newKey(0x07E2);
        dave = newKey(0xDA7E);
        puppet = newKey(0x9099E7);
        brake = new Target();
        lockTarget = new Target();
        sentinel = makeAddr("sentinel");
    }

    // ── helpers ───────────────────────────────────────────────────────────────────

    function _deploy(uint256 t, uint256 a, bool locked) internal {
        QEDOwnerAccount.Guard[] memory p = new QEDOwnerAccount.Guard[](1);
        p[0] = QEDOwnerAccount.Guard(address(brake), Target.set.selector, "test: a protective call");
        QEDOwnerAccount.Guard[] memory l = new QEDOwnerAccount.Guard[](1);
        l[0] = QEDOwnerAccount.Guard(address(lockTarget), Target.set.selector, "test: a lockable call");
        acct = deployFull(keys2(alice, bob), keys2(rec, rec2), t, a, noGuards(), p, sentinel, l, locked);
    }

    function _scheduled() internal returns (bytes32 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "no ChangeScheduled");
    }

    function _selfScheduled(bytes memory data, Key[] memory approvers) internal returns (bytes32) {
        Prepared memory p = prepare(acct, selfCall(acct, data), approvers);
        vm.recordLogs();
        run(acct, p);
        return _scheduled();
    }

    function _installGuardian(Key memory g) internal {
        bytes32 id = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (g.x, g.y)), keys2(alice, bob));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(id);
        assertEq(acct.guardian(), g.id);
    }

    function _cosigned(Key memory r, Key memory newKey_, Key memory g) internal returns (bytes32) {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 digest = acct.recoveryDigest(r.id, newKey_.x, newKey_.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(r, digest);
        return acct.startCosignedRecovery(r.id, newKey_.x, newKey_.y, deadline, sr, ss, signAs(g, digest));
    }

    function _codeOnly(Key memory r, Key memory newKey_) internal returns (bytes32) {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(r, acct.recoveryDigest(r.id, newKey_.x, newKey_.y, deadline));
        return acct.startRecovery(r.id, newKey_.x, newKey_.y, deadline, sr, ss);
    }

    function _freeze(Key memory k) internal {
        vm.prank(sentinel);
        acct.freeze(k.id);
    }

    /// The admin quorum's self-call (as `execute` makes it); used where every Member is frozen, so that no quorum of
    /// unfrozen Members exists to sign it.
    function _unfreezeAsAccount(Key memory k) internal {
        vm.prank(address(acct));
        acct.unfreeze(k.id);
    }

    function _failed(uint256 index, bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            QEDOwnerAccount.CallFailed.selector, index, abi.encodeWithSelector(selector)
        );
    }

    // ── F1 and H1, the owner's rule: a co-signed recovery finishes only if someone independent could stop it for its
    //    whole wait: an unfrozen Member, or the sentinel (QED) set and unchanged since its wait began ───────────────

    function _sentinelId() internal view returns (bytes32) {
        return bytes32(uint256(uint160(sentinel)));
    }

    function test_with_every_member_frozen_and_the_sentinel_watching_a_cosigned_recovery_finishes_after_its_whole_delay()
        public
    {
        _deploy(2, 2, false);
        _installGuardian(contact);
        _freeze(alice);
        _freeze(bob);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        bytes32 rid = _cosigned(rec, dave, contact);
        // no passkey can cancel it, but the owner could have stopped it through QED (the sentinel) for its whole wait
        QEDOwnerAccount.Assertion memory byBob = signAs(bob, acct.cancelDigest(rid));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, bob.id));
        acct.cancel(rid, byBob);
        vm.warp(t0 + RECOVERY_DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, rid, t0 + RECOVERY_DELAY));
        acct.finishRecovery(rid);
        vm.warp(t0 + RECOVERY_DELAY);
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
    }

    function test_the_sentinel_stops_a_pending_cosigned_recovery_and_nothing_else() public {
        _deploy(2, 2, false);
        bytes32 before = _codeOnly(rec2, other); // started before the guardian: not co-signed
        _installGuardian(contact);
        bytes32 change = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (0, 0)), keys2(alice, bob));
        _freeze(alice);
        _freeze(bob);
        bytes32 rid = _cosigned(rec, dave, contact);
        uint256 nonce = acct.nonce();
        // nobody but the sentinel, not even a key the account knows
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, address(this)));
        acct.stopRecovery(rid);
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, address(acct)));
        acct.stopRecovery(rid);
        // and the sentinel stops nothing else: not a recovery started without the guardian, a scheduled change or nothing
        vm.startPrank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, before));
        acct.stopRecovery(before);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, change));
        acct.stopRecovery(change);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, keccak256("nothing")));
        acct.stopRecovery(keccak256("nothing"));
        // the co-signed recovery: stopped, its recovery key spent, nothing else changed
        vm.expectEmit(address(acct));
        emit RecoveryCancelled(rid, _sentinelId());
        acct.stopRecovery(rid);
        vm.stopPrank();
        assertEq(acct.getRecovery(rid).readyAt, 0);
        assertEq(uint8(acct.getSigner(rec.id).role), uint8(QEDOwnerAccount.Role.None), "the code is spent");
        assertTrue(acct.getRecovery(before).readyAt != 0, "the other recovery is untouched");
        assertEq(uint8(acct.getChange(change).kind), uint8(QEDOwnerAccount.ChangeKind.SetGuardian));
        assertEq(acct.nonce(), nonce);
        assertEq(acct.memberCount(), 2);
        assertEq(acct.threshold(), 2);
        assertTrue(acct.getSigner(alice.id).frozen && acct.getSigner(bob.id).frozen, "it unfreezes nothing");
        // not twice (a dropped sentinel stops nothing: the no-sentinel test below)
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, rid));
        acct.stopRecovery(rid);
    }

    function test_with_every_member_frozen_and_the_sentinel_changed_mid_wait_it_stays_pending() public {
        _deploy(2, 2, false);
        _installGuardian(contact);
        address next = makeAddr("next sentinel");
        // a change of the sentinel scheduled while the passkeys were unfrozen, applied (by anyone) after the freezes
        bytes32 change = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setSentinel, (next)), keys2(alice, bob));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        bytes32 rid = _cosigned(rec, dave, contact);
        _freeze(alice);
        _freeze(bob);
        vm.warp(t0 + DELAY);
        acct.applyChange(change);
        assertEq(acct.sentinel(), next);
        // the watch was broken mid-wait: with every passkey frozen it does not finish, however long
        vm.warp(t0 + RECOVERY_DELAY);
        vm.expectRevert(QEDOwnerAccount.NoUnfrozenMember.selector);
        acct.finishRecovery(rid);
        vm.warp(t0 + 365 days);
        vm.expectRevert(QEDOwnerAccount.NoUnfrozenMember.selector);
        acct.finishRecovery(rid);
        // the old sentinel can no longer stop it; the new one can
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, sentinel));
        acct.stopRecovery(rid);
        vm.prank(next);
        acct.stopRecovery(rid);
        assertEq(acct.getRecovery(rid).readyAt, 0);
    }

    function test_with_every_member_frozen_and_no_sentinel_it_waits_and_restarts_in_full_when_a_member_is_unfrozen() public {
        _deploy(2, 2, false);
        _installGuardian(contact);
        _freeze(alice);
        _freeze(bob);
        bytes32 rid = _cosigned(rec, dave, contact);
        // the sentinel dropped (the account's own call, as its unfrozen quorum would make it): no independent challenger
        vm.prank(address(acct));
        acct.setSentinel(address(0));
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, sentinel));
        acct.stopRecovery(rid);
        vm.warp(vm.getBlockTimestamp() + RECOVERY_DELAY + 5 days);
        vm.expectRevert(QEDOwnerAccount.NoUnfrozenMember.selector);
        acct.finishRecovery(rid);
        // once a passkey is unfrozen, a whole recoveryDelay again
        uint64 t1 = uint64(vm.getBlockTimestamp());
        vm.expectEmit(address(acct));
        emit RecoveryRestarted(rid, t1 + RECOVERY_DELAY);
        _unfreezeAsAccount(alice);
        vm.warp(t1 + RECOVERY_DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, rid, t1 + RECOVERY_DELAY));
        acct.finishRecovery(rid);
        vm.warp(t1 + RECOVERY_DELAY);
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
    }

    function test_a_restart_never_moves_the_wait_earlier() public {
        // independent review L1: the recovery delay lowered after the start must not bring a restarted recovery forward
        _deploy(2, 2, false);
        _installGuardian(contact);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setDelays, (DELAY, 10 days))), keys2(alice, bob));
        uint64 t0 = uint64(vm.getBlockTimestamp());
        bytes32 rid = _cosigned(rec, dave, contact);
        assertEq(acct.getRecovery(rid).readyAt, t0 + 10 days);
        bytes32 lower = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setDelays, (DELAY, RECOVERY_DELAY)), keys2(alice, bob));
        vm.warp(t0 + DELAY);
        acct.applyChange(lower);
        assertEq(acct.recoveryDelay(), RECOVERY_DELAY);
        _freeze(alice);
        _freeze(bob);
        _unfreezeAsAccount(alice); // a thaw at t0 + 1 day: now + 3 days would be earlier than t0 + 10 days
        assertEq(acct.getRecovery(rid).readyAt, t0 + 10 days, "not earlier than it was");
        vm.warp(t0 + 10 days - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, rid, t0 + 10 days));
        acct.finishRecovery(rid);
    }

    function test_a_recovery_without_the_guardian_is_not_held_by_freezes_frozen_members_can_cancel_it() public {
        // no guardian: a code alone starts a recovery, any Member (frozen or not) can cancel it, so it is not held back
        _deploy(2, 2, false);
        _freeze(alice);
        _freeze(bob);
        bytes32 rid = _codeOnly(rec, dave);
        vm.warp(vm.getBlockTimestamp() + RECOVERY_DELAY);
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
    }

    function test_every_member_frozen_a_colluding_guardian_and_a_stolen_code_the_owner_stops_it_through_qed() public {
        // all passkeys frozen, the guardian colludes, a code is stolen: no passkey can cancel the thief's recovery, but the
        // owner can stop it through QED (the sentinel) throughout its wait; left alone, it would finish after its delay
        _deploy(1, 1, false);
        _installGuardian(contact);
        _freeze(alice);
        _freeze(bob);
        Key memory thief = newKey(0x7E1F);
        bytes32 rid = _cosigned(rec2, thief, contact);
        vm.warp(vm.getBlockTimestamp() + RECOVERY_DELAY - 1);
        vm.prank(sentinel);
        acct.stopRecovery(rid);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, rid));
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(thief.id).role), uint8(QEDOwnerAccount.Role.None));
    }

    // ── F1: the guardian withdraws its co-signature ───────────────────────────────

    function test_the_guardian_withdraws_its_cosignature_and_nothing_else() public {
        _deploy(2, 2, false);
        // a recovery started before the guardian took effect: not co-signed
        bytes32 before = _codeOnly(rec2, other);
        _installGuardian(contact);
        _freeze(alice);
        _freeze(bob);
        bytes32 rid = _cosigned(rec, dave, contact);
        // with every Member frozen the guardian is the one left who can stop it: it withdraws its co-signature
        vm.expectEmit(address(acct));
        emit RecoveryCancelled(rid, contact.id);
        acct.cancel(rid, signAs(contact, acct.cancelDigest(rid)));
        assertEq(acct.getRecovery(rid).readyAt, 0);
        assertEq(uint8(acct.getSigner(rec.id).role), uint8(QEDOwnerAccount.Role.None), "the code is spent");
        // not a recovery it did not co-sign, and not twice
        QEDOwnerAccount.Assertion memory a = signAs(contact, acct.cancelDigest(before));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        acct.cancel(before, a);
        a = signAs(contact, acct.cancelDigest(rid));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, contact.id));
        acct.cancel(rid, a);
    }

    // ── F1: the deadline cap ──────────────────────────────────────────────────────

    function test_a_recovery_deadline_is_at_most_one_day_ahead() public {
        _deploy(2, 2, false);
        uint64 far = uint64(vm.getBlockTimestamp() + 1 days + 1);
        (bytes32 sr, bytes32 ss) = recoverySign(rec, acct.recoveryDigest(rec.id, dave.x, dave.y, far));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.DeadlineTooFar.selector, far));
        acct.startRecovery(rec.id, dave.x, dave.y, far, sr, ss);
        assertFalse(acct.spentRecoveryKey(rec.id), "a refused attempt spends nothing");
        // the same signature becomes usable only within the last day before its deadline
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 rid = acct.startRecovery(rec.id, dave.x, dave.y, far, sr, ss);
        assertTrue(acct.getRecovery(rid).readyAt != 0);
        // and the co-signed path is capped the same way
        _installGuardian(contact);
        far = uint64(vm.getBlockTimestamp() + 2 days);
        bytes32 digest = acct.recoveryDigest(rec2.id, other.x, other.y, far);
        (sr, ss) = recoverySign(rec2, digest);
        QEDOwnerAccount.Assertion memory g = signAs(contact, digest);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.DeadlineTooFar.selector, far));
        acct.startCosignedRecovery(rec2.id, other.x, other.y, far, sr, ss, g);
    }

    // ── F5: a recovery started before the guardian took effect ─────────────────────────

    function test_a_recovery_started_before_the_guardian_took_effect_does_not_finish_while_one_is_set() public {
        _deploy(2, 2, false);
        bytes32 rid = _codeOnly(rec, dave); // recoveryDelay 3 days
        _installGuardian(contact); // takes effect after delay, 1 day
        vm.warp(acct.getRecovery(rid).readyAt);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardianRequired.selector, contact.id));
        acct.finishRecovery(rid);
        // removing the guardian waits the delay; until then it stays refused, and any Member can cancel it
        bytes32 removal = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (0, 0)), keys2(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardianRequired.selector, contact.id));
        acct.finishRecovery(rid);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(removal);
        acct.finishRecovery(rid);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
    }

    // ── F2: a removal leaves someone able to cancel it ────────────────────────────────

    function test_at_admin_threshold_one_a_recovered_seat_cannot_name_every_other_member() public {
        _deploy(1, 1, false);
        // a recovery code is stolen and nobody cancels in time: the thief's passkey (dave) is a Member
        bytes32 rid = _codeOnly(rec, dave);
        vm.warp(vm.getBlockTimestamp() + RECOVERY_DELAY);
        acct.finishRecovery(rid);
        bytes32[] memory both = new bytes32[](2);
        (both[0], both[1]) = uint256(alice.id) < uint256(bob.id) ? (alice.id, bob.id) : (bob.id, alice.id);
        // alone, it cannot name every other Member
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (both))), keys1(dave));
        vm.expectRevert(_failed(0, QEDOwnerAccount.NoCancellerLeft.selector));
        run(acct, p);
        // nor with a Member it adds in the same batch
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(
            address(acct), 0, abi.encodeCall(QEDOwnerAccount.addSigner, (puppet.x, puppet.y, QEDOwnerAccount.Role.Member))
        );
        c[1] = QEDOwnerAccount.Call(address(acct), 0, abi.encodeCall(QEDOwnerAccount.removeSigners, (both)));
        p = prepare(acct, c, keys1(dave));
        vm.expectRevert(_failed(1, QEDOwnerAccount.NoCancellerLeft.selector));
        run(acct, p);
        // nor with one it added earlier, until both seats have been Members for `delay`
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (puppet.x, puppet.y, QEDOwnerAccount.Role.Member))), keys1(dave));
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (both))), keys1(dave));
        vm.expectRevert(_failed(0, QEDOwnerAccount.NoCancellerLeft.selector));
        run(acct, p);
        // meanwhile the household removes both seats; they cannot cancel their own removal
        bytes32[] memory theirs = new bytes32[](2);
        (theirs[0], theirs[1]) = uint256(dave.id) < uint256(puppet.id) ? (dave.id, puppet.id) : (puppet.id, dave.id);
        bytes32 evict = _selfScheduled(abi.encodeCall(QEDOwnerAccount.removeSigners, (theirs)), keys1(alice));
        QEDOwnerAccount.Assertion memory byDave = signAs(dave, acct.cancelDigest(evict));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, dave.id));
        acct.cancel(evict, byDave);
        // a `delay` later the two seats could name every other Member, but the household's removal is due first
        vm.warp(vm.getBlockTimestamp() + DELAY);
        bytes32 takeover = _selfScheduled(abi.encodeCall(QEDOwnerAccount.removeSigners, (both)), keys1(dave));
        acct.applyChange(evict);
        assertEq(acct.memberCount(), 2);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.None));
        // the thief's late removal cannot leave the account without Members; a Member it does not name can cancel it
        // (alice and bob cannot: they are named), so it stays pending until one is added
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 1, 1, 0));
        acct.applyChange(takeover);
    }

    function test_a_two_member_household_removes_an_unfrozen_member_after_a_freeze_or_with_a_settled_third() public {
        _deploy(1, 1, false);
        // alone with bob, alice cannot name bob while bob is unfrozen: nobody else could cancel it
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id)))), keys1(alice));
        vm.expectRevert(_failed(0, QEDOwnerAccount.NoCancellerLeft.selector));
        run(acct, p);
        // removing recovery keys needs no witness
        _selfScheduled(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(rec2.id))), keys1(alice));
        // a lost or stolen passkey is frozen first (QED suspends it): then it can be named
        _freeze(bob);
        bytes32 id = _selfScheduled(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id))), keys1(alice));
        assertEq(uint8(acct.getChange(id).kind), uint8(QEDOwnerAccount.ChangeKind.RemoveSigners));
        acct.cancel(id, signAs(alice, acct.cancelDigest(id)));
        _unfreezeAsAccount(bob);
        // or a third passkey, once it has been a Member for `delay`
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member))), keys1(alice));
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id)))), keys1(alice));
        vm.expectRevert(_failed(0, QEDOwnerAccount.NoCancellerLeft.selector));
        run(acct, p);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        id = _selfScheduled(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id))), keys1(alice));
        // the settled third Member, not named, can cancel it
        acct.cancel(id, signAs(dave, acct.cancelDigest(id)));
    }

    // ── F4: no stale change of the time-lock, the sentinel or the guardian ─────────────────

    function test_turning_the_time_lock_on_voids_pending_off_changes() public {
        _deploy(1, 1, true);
        bytes32 first = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setTimeLock, (false)), keys1(alice));
        bytes32 second = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setTimeLock, (false)), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(first);
        assertFalse(acct.timeLocked());
        // the household turns it back on: the matured second off-change must not switch it off at once
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (true))), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, second));
        acct.applyChange(second);
        assertTrue(acct.timeLocked());
        // turning it on while it is on voids pending off-changes too
        bytes32 third = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setTimeLock, (false)), keys1(alice));
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (true))), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, third));
        acct.applyChange(third);
        assertTrue(acct.timeLocked());
        // a fresh off-change still waits the full delay and then applies
        bytes32 fourth = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setTimeLock, (false)), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, fourth, uint64(vm.getBlockTimestamp() + 1))
        );
        acct.applyChange(fourth);
        vm.warp(vm.getBlockTimestamp() + 1);
        acct.applyChange(fourth);
        assertFalse(acct.timeLocked());
    }

    function test_dropping_the_sentinel_voids_pending_sentinel_changes() public {
        _deploy(1, 1, false);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0)))), keys1(alice));
        address x = makeAddr("x");
        address y = makeAddr("y");
        bytes32 toX = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setSentinel, (x)), keys1(alice));
        bytes32 toY = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setSentinel, (y)), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(toX);
        assertEq(acct.sentinel(), x);
        // the household drops it at once; the matured change to y must not install a new freezer at once
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0)))), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, toY));
        acct.applyChange(toY);
        assertEq(acct.sentinel(), address(0));
    }

    function test_a_guardian_change_voids_every_earlier_pending_one() public {
        _deploy(1, 1, false);
        bytes32 toContact = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (contact.x, contact.y)), keys1(alice));
        bytes32 toOther = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (other.x, other.y)), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(toContact);
        bytes32 removal = _selfScheduled(abi.encodeCall(QEDOwnerAccount.setGuardian, (0, 0)), keys1(alice));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        acct.applyChange(removal);
        assertEq(acct.guardian(), bytes32(0));
        // back to no guardian, as when it was scheduled: still stale, it never applies
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, toOther));
        acct.applyChange(toOther);
        assertEq(acct.guardian(), bytes32(0));
    }
}
