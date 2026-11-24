// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest, Target} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Stands for the vault's protective setters: records who called and what.
contract Brake {
    uint256 public pauses;
    uint256 public resumes;
    bytes32 public lastRevoked;
    address public lastCaller;

    function pause() external {
        ++pauses;
        lastCaller = msg.sender;
    }

    /// Not protective: resuming re-enables the agent.
    function unpause() external {
        ++resumes;
        lastCaller = msg.sender;
    }

    function revokeMandate(bytes32 h) external {
        lastRevoked = h;
        lastCaller = msg.sender;
    }
}

/// Finishes a recovery and, in the same transaction, runs the new Member's first execute. A household whose every
/// Member the sentinel froze ends the abuse this way: the sentinel cannot act between the two calls.
contract RecoveryBundle {
    function finishAndExecute(
        QEDOwnerAccount acct,
        bytes32 recoveryId,
        QEDOwnerAccount.Call[] calldata calls,
        uint256 nonce_,
        uint64 deadline,
        QEDOwnerAccount.Assertion[] calldata assertions
    ) external {
        acct.finishRecovery(recoveryId);
        acct.execute(calls, nonce_, deadline, assertions);
    }
}

/// R13: containing a passkey QED has suspended. The sentinel (QED's service key) can only freeze a Member; a frozen
/// Member's approval no longer counts for execute or ERC-1271, so it moves no money and changes nothing, but it keeps
/// its veto (cancel) and may still stop things through `protect`. Unfreezing takes the admin quorum of unfrozen Members.
contract ContainmentTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Target internal target;
    Brake internal brake;
    address internal sentinel;
    Key internal alice;
    Key internal bob;
    Key internal rec;
    Key internal dave;

    event SignerFrozen(bytes32 indexed signerId, address indexed by);
    event SignerUnfrozen(bytes32 indexed signerId);
    event SentinelChanged(address indexed sentinel);
    event Protected(uint256 indexed nonce, bytes32 indexed digest, bytes32 indexed signerId, uint256 callCount);
    event ProtectiveCallConfigured(address indexed target, bytes4 indexed selector, string reason);

    function _protective(address b) internal pure returns (QEDOwnerAccount.Guard[] memory p) {
        p = new QEDOwnerAccount.Guard[](2);
        p[0] = QEDOwnerAccount.Guard(b, Brake.pause.selector, "test: stops the agent, moves no money");
        p[1] = QEDOwnerAccount.Guard(b, Brake.revokeMandate.selector, "test: revokes one mandate, moves no money");
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        rec = newKey(0x5EC0);
        dave = newKey(0xDA7E);
        target = new Target();
        brake = new Brake();
        sentinel = makeAddr("sentinel");
        // a household with two passkeys and a recovery key, one signature enough (as QED sets them up)
        acct = deployContained(keys2(alice, bob), keys1(rec), 1, 1, noGuards(), _protective(address(brake)), sentinel);
    }

    function _set(uint256 v) internal view returns (QEDOwnerAccount.Call[] memory) {
        return calls1(address(target), 0, abi.encodeCall(Target.set, (v)));
    }

    function _pause() internal view returns (QEDOwnerAccount.Call[] memory) {
        return calls1(address(brake), 0, abi.encodeCall(Brake.pause, ()));
    }

    function _freeze(bytes32 id) internal {
        vm.prank(sentinel);
        acct.freeze(id);
    }

    // ── freezing ──────────────────────────────────────────────────────────────────

    function test_the_sentinel_freezes_a_member_at_once_and_its_approval_stops_counting() public {
        exec(acct, _set(1), keys1(alice));
        vm.expectEmit(true, true, false, false, address(acct));
        emit SignerFrozen(alice.id, sentinel);
        _freeze(alice.id);
        assertTrue(acct.getSigner(alice.id).frozen);
        assertFalse(acct.getSigner(bob.id).frozen);
        Prepared memory p = prepare(acct, _set(2), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id));
        run(acct, p);
        assertEq(target.value(), 1);
        // the other passkey is untouched
        exec(acct, _set(3), keys1(bob));
        assertEq(target.value(), 3);
    }

    function test_a_frozen_assertion_spoils_a_batch_even_beside_enough_others() public {
        _freeze(alice.id);
        Prepared memory p = prepare(acct, _set(7), keys2(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id));
        run(acct, p);
    }

    function test_a_frozen_member_signs_no_erc1271_message() public {
        bytes32 h = keccak256("a mandate digest");
        bytes memory sig = abi.encode(one(signAs(alice, acct.replaySafeHash(h))));
        assertEq(acct.isValidSignature(h, sig), bytes4(0x1626ba7e));
        _freeze(alice.id);
        assertEq(acct.isValidSignature(h, sig), bytes4(0xffffffff));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id));
        acct.checkSignature(h, sig);
    }

    function test_a_frozen_member_changes_nothing_about_the_account() public {
        _freeze(alice.id);
        bytes[5] memory changes = [
            abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member)),
            abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id))),
            abi.encodeCall(QEDOwnerAccount.setDelays, (DELAY / 2, RECOVERY_DELAY)),
            abi.encodeCall(QEDOwnerAccount.unfreeze, (alice.id)),
            abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0)))
        ];
        for (uint256 i; i < changes.length; ++i) {
            Prepared memory p = prepare(acct, selfCall(acct, changes[i]), keys1(alice));
            vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id));
            run(acct, p);
        }
        assertEq(acct.memberCount(), 2);
        assertEq(acct.sentinel(), sentinel);
        assertTrue(acct.getSigner(alice.id).frozen);
    }

    function test_a_frozen_member_keeps_its_veto_over_changes_and_recoveries() public {
        // bob schedules a shorter delay; frozen alice can still cancel it
        bytes32 changeId = _scheduleShorterDelay(bob);
        _freeze(alice.id);
        acct.cancel(changeId, signAs(alice, acct.cancelDigest(changeId)));
        assertEq(uint8(acct.getChange(changeId).kind), uint8(QEDOwnerAccount.ChangeKind.None));
        // a recovery started with the code: frozen alice can cancel it too (it is not hers to keep)
        bytes32 rid = _startRecovery(dave);
        acct.cancel(rid, signAs(alice, acct.cancelDigest(rid)));
        assertEq(acct.getRecovery(rid).readyAt, 0);
    }

    function test_a_frozen_member_still_cannot_cancel_its_own_removal() public {
        _freeze(alice.id);
        Prepared memory p =
            prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(alice.id)))), keys1(bob));
        vm.recordLogs();
        run(acct, p);
        bytes32 changeId = _scheduled();
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.cancelDigest(changeId));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, alice.id));
        acct.cancel(changeId, a);
        vm.warp(block.timestamp + DELAY);
        acct.applyChange(changeId);
        assertEq(uint8(acct.getSigner(alice.id).role), uint8(QEDOwnerAccount.Role.None));
        // added again later, the same key is a new signer: not frozen
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (alice.x, alice.y, QEDOwnerAccount.Role.Member))), keys1(bob));
        assertFalse(acct.getSigner(alice.id).frozen);
        exec(acct, _set(9), keys1(alice));
        assertEq(target.value(), 9);
    }

    function test_only_the_sentinel_can_freeze_and_never_anything_but_a_member() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, stranger));
        acct.freeze(alice.id);
        // not even the account itself (its Members through execute)
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.freeze, (alice.id))), keys1(bob));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, address(acct))
            )
        );
        run(acct, p);
        vm.startPrank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec.id));
        acct.freeze(rec.id);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, dave.id));
        acct.freeze(dave.id);
        acct.freeze(alice.id);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.AlreadyFrozen.selector, alice.id));
        acct.freeze(alice.id);
        vm.stopPrank();
    }

    function test_an_account_without_a_sentinel_cannot_be_frozen_by_anyone() public {
        QEDOwnerAccount plain =
            deployContained(keys1(alice), noKeys(), 1, 1, noGuards(), _protective(address(brake)), address(0));
        assertEq(plain.sentinel(), address(0));
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, address(0)));
        plain.freeze(alice.id);
    }

    function test_the_sentinel_has_no_other_power() public {
        uint256 n = acct.nonce();
        QEDOwnerAccount.Call[] memory c = _set(5);
        vm.startPrank(sentinel);
        // no signature of its own counts anywhere: it holds an address, not a Member key
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 0, 1));
        acct.execute(c, n, uint64(block.timestamp + 60), new QEDOwnerAccount.Assertion[](0));
        assertEq(acct.isValidSignature(bytes32(0), abi.encode(new QEDOwnerAccount.Assertion[](0))), bytes4(0xffffffff));
        bytes4 onlySelf = QEDOwnerAccount.OnlySelf.selector;
        vm.expectRevert(abi.encodeWithSelector(onlySelf, sentinel));
        acct.unfreeze(alice.id);
        vm.expectRevert(abi.encodeWithSelector(onlySelf, sentinel));
        acct.setSentinel(address(0));
        vm.expectRevert(abi.encodeWithSelector(onlySelf, sentinel));
        acct.addSigner(dave.x, dave.y, QEDOwnerAccount.Role.Member);
        vm.expectRevert(abi.encodeWithSelector(onlySelf, sentinel));
        acct.removeSigners(ids1(alice.id));
        vm.stopPrank();
        assertEq(target.value(), 0);
        assertEq(brake.pauses(), 0);
        assertEq(acct.nonce(), 0);
        assertEq(acct.protectNonce(), 0);
    }

    // ── unfreezing and the sentinel's own rules ───────────────────────────────────

    function test_unfreezing_takes_the_unfrozen_admin_quorum_and_applies_at_once() public {
        _freeze(alice.id);
        vm.expectEmit(true, false, false, false, address(acct));
        emit SignerUnfrozen(alice.id);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.unfreeze, (alice.id))), keys1(bob));
        assertFalse(acct.getSigner(alice.id).frozen);
        exec(acct, _set(4), keys1(alice));
        assertEq(target.value(), 4);
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.unfreeze, (bob.id))), keys1(alice));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector, 0, abi.encodeWithSelector(QEDOwnerAccount.NotFrozen.selector, bob.id)
            )
        );
        run(acct, p);
    }

    function test_dropping_the_sentinel_is_immediate_and_a_new_one_waits_the_delay() public {
        vm.expectEmit(true, false, false, false, address(acct));
        emit SentinelChanged(address(0));
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0)))), keys1(alice));
        assertEq(acct.sentinel(), address(0));
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotSentinel.selector, sentinel));
        acct.freeze(alice.id);
        // a new sentinel is a new power: scheduled behind the delay, cancellable by any Member
        Prepared memory p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (sentinel))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        bytes32 changeId = _scheduled();
        QEDOwnerAccount.PendingChange memory c = acct.getChange(changeId);
        assertEq(uint8(c.kind), uint8(QEDOwnerAccount.ChangeKind.SetSentinel));
        assertEq(acct.sentinel(), address(0));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, changeId, c.readyAt));
        acct.applyChange(changeId);
        vm.warp(c.readyAt);
        acct.applyChange(changeId);
        assertEq(acct.sentinel(), sentinel);
        _freeze(alice.id);
        assertTrue(acct.getSigner(alice.id).frozen);
    }

    function test_a_scheduled_sentinel_is_cancelled_by_one_member_and_refused_when_stale() public {
        Prepared memory p =
            prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (makeAddr("other")))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        bytes32 changeId = _scheduled();
        // dropped meanwhile: the scheduled replacement no longer matches what it replaces
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0)))), keys1(bob));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, changeId));
        acct.applyChange(changeId);
        // another one, cancelled by a frozen Member's veto
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (makeAddr("other")))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        bytes32 second = _scheduled();
        acct.cancel(second, signAs(bob, acct.cancelDigest(second)));
        assertEq(uint8(acct.getChange(second).kind), uint8(QEDOwnerAccount.ChangeKind.None));
        // the account itself can never be its sentinel
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(acct)))), keys1(alice));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(QEDOwnerAccount.InvalidSentinel.selector, address(acct))
            )
        );
        run(acct, p);
    }

    /// The abuse case: the sentinel freezes every Member. No money moves and every veto and protective call still
    /// works; the household ends it with its recovery key, finishing the recovery and dropping the sentinel in one
    /// transaction, so that the sentinel cannot freeze the new passkey in between.
    function test_sentinel_abuse_freezes_everyone_moves_nothing_and_a_recovery_ends_it() public {
        _freeze(alice.id);
        _freeze(bob.id);
        Prepared memory p = prepare(acct, _set(1), keys2(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id < bob.id ? alice.id : bob.id));
        run(acct, p);
        runProtect(acct, prepareProtect(acct, _pause(), alice));
        assertEq(brake.pauses(), 1);
        bytes32 rid = _startRecovery(dave);
        vm.warp(block.timestamp + RECOVERY_DELAY);
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](3);
        c[0] = QEDOwnerAccount.Call(address(acct), 0, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0))));
        c[1] = QEDOwnerAccount.Call(address(acct), 0, abi.encodeCall(QEDOwnerAccount.unfreeze, (alice.id)));
        c[2] = QEDOwnerAccount.Call(address(acct), 0, abi.encodeCall(QEDOwnerAccount.unfreeze, (bob.id)));
        uint256 n = acct.nonce();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        QEDOwnerAccount.Assertion[] memory as_ = one(signAs(dave, acct.executeDigest(c, n, deadline)));
        RecoveryBundle bundle = new RecoveryBundle();
        bundle.finishAndExecute(acct, rid, c, n, deadline, as_);
        assertEq(acct.sentinel(), address(0));
        assertFalse(acct.getSigner(alice.id).frozen);
        assertFalse(acct.getSigner(bob.id).frozen);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
        exec(acct, _set(2), keys1(alice));
        assertEq(target.value(), 2);
    }

    function test_two_of_two_with_one_frozen_moves_nothing() public {
        QEDOwnerAccount two_ =
            deployContained(keys2(alice, bob), keys1(rec), 2, 2, noGuards(), _protective(address(brake)), sentinel);
        vm.prank(sentinel);
        two_.freeze(alice.id);
        Prepared memory p = prepare(two_, _set(1), keys2(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.FrozenSigner.selector, alice.id));
        run(two_, p);
        p = prepare(two_, _set(1), keys1(bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(two_, p);
        assertEq(target.value(), 0);
    }

    // ── protective calls ──────────────────────────────────────────────────────────

    function test_one_passkey_stops_things_whatever_the_threshold() public {
        QEDOwnerAccount two_ =
            deployContained(keys2(alice, bob), noKeys(), 2, 2, noGuards(), _protective(address(brake)), sentinel);
        // one passkey alone cannot execute at threshold 2 ...
        Prepared memory p = prepare(two_, _pause(), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(two_, p);
        // ... but can stop the agent through protect, which has its own nonce
        ProtectPrepared memory q = prepareProtect(two_, _pause(), alice);
        vm.expectEmit(true, true, true, true, address(two_));
        emit Protected(0, protectDigestOf(two_, q.calls, q.nonce, q.deadline), alice.id, 1);
        runProtect(two_, q);
        assertEq(brake.pauses(), 1);
        assertEq(brake.lastCaller(), address(two_));
        assertEq(two_.protectNonce(), 1);
        assertEq(two_.nonce(), 0, "stopping things never uses up an execute approval");
        QEDOwnerAccount.Call[] memory c = calls1(address(brake), 0, abi.encodeCall(Brake.revokeMandate, (keccak256("m"))));
        runProtect(two_, prepareProtect(two_, c, bob));
        assertEq(brake.lastRevoked(), keccak256("m"));
    }

    function test_a_frozen_member_can_still_stop_things() public {
        _freeze(alice.id);
        runProtect(acct, prepareProtect(acct, _pause(), alice));
        assertEq(brake.pauses(), 1);
    }

    function test_protect_refuses_every_call_outside_the_list() public {
        QEDOwnerAccount.Call[] memory c;
        // a call that moves value, resumes, has no selector, targets the account or another contract
        c = calls1(address(brake), 1, abi.encodeCall(Brake.pause, ()));
        _protectRefused(c, 0, address(brake), Brake.pause.selector);
        c = calls1(address(brake), 0, abi.encodeCall(Brake.unpause, ()));
        _protectRefused(c, 0, address(brake), Brake.unpause.selector);
        c = calls1(address(brake), 0, hex"aabbcc");
        _protectRefused(c, 0, address(brake), bytes4(0));
        c = calls1(address(acct), 0, abi.encodeCall(QEDOwnerAccount.setSentinel, (address(0))));
        _protectRefused(c, 0, address(acct), QEDOwnerAccount.setSentinel.selector);
        c = calls1(address(target), 0, abi.encodeCall(Target.set, (1)));
        _protectRefused(c, 0, address(target), Target.set.selector);
        // one stray call spoils the batch
        c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(address(brake), 0, abi.encodeCall(Brake.pause, ()));
        c[1] = QEDOwnerAccount.Call(address(target), 0, abi.encodeCall(Target.set, (1)));
        _protectRefused(c, 1, address(target), Target.set.selector);
        ProtectPrepared memory p = prepareProtect(acct, new QEDOwnerAccount.Call[](0), alice);
        vm.expectRevert(QEDOwnerAccount.EmptyCalls.selector);
        runProtect(acct, p);
        assertEq(brake.pauses(), 0);
        assertEq(brake.resumes(), 0);
        assertEq(target.value(), 0);
    }

    function _protectRefused(QEDOwnerAccount.Call[] memory c, uint256 i, address t, bytes4 sel) internal {
        ProtectPrepared memory p = prepareProtect(acct, c, alice);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotProtective.selector, i, t, sel));
        runProtect(acct, p);
    }

    function test_protect_is_bound_to_its_calls_nonce_deadline_and_a_member() public {
        ProtectPrepared memory p = prepareProtect(acct, _pause(), alice);
        runProtect(acct, p);
        // replay
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.BadNonce.selector, 0, 1));
        runProtect(acct, p);
        // expired
        p = prepareProtect(acct, _pause(), alice);
        vm.warp(p.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.Expired.selector, p.deadline, p.deadline + 1));
        runProtect(acct, p);
        // signed for other calls
        p = prepareProtect(acct, _pause(), alice);
        p.calls = calls1(address(brake), 0, abi.encodeCall(Brake.revokeMandate, (bytes32(uint256(1)))));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        runProtect(acct, p);
        // an execute approval of the same calls is not a protect approval (and the other way round)
        uint256 n = acct.protectNonce();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        assertTrue(protectDigestOf(acct, _pause(), n, deadline) != acct.executeDigest(_pause(), n, deadline));
        QEDOwnerAccount.Assertion memory viaExecute = signAs(alice, acct.executeDigest(_pause(), n, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.protect(_pause(), n, deadline, viaExecute);
        // a recovery key, or a key that is no signer, cannot protect
        p = prepareProtect(acct, _pause(), rec);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec.id));
        runProtect(acct, p);
        p = prepareProtect(acct, _pause(), dave);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, dave.id));
        runProtect(acct, p);
        assertEq(brake.pauses(), 1);
    }

    // ── construction ──────────────────────────────────────────────────────────────

    function test_construction_lists_the_protective_calls_and_the_sentinel() public {
        QEDOwnerAccount.Guard[] memory p = _protective(address(brake));
        vm.expectEmit(true, true, false, true);
        emit ProtectiveCallConfigured(address(brake), Brake.pause.selector, p[0].reason);
        vm.expectEmit(true, true, false, true);
        emit ProtectiveCallConfigured(address(brake), Brake.revokeMandate.selector, p[1].reason);
        vm.expectEmit(true, false, false, false);
        emit SentinelChanged(sentinel);
        QEDOwnerAccount a2 = deployContained(keys1(alice), noKeys(), 1, 1, noGuards(), p, sentinel);
        assertTrue(isProtectiveOf(a2, address(brake), Brake.pause.selector));
        assertFalse(isProtectiveOf(a2, address(brake), Brake.unpause.selector));
        QEDOwnerAccount.GuardKey[] memory list = a2.protectiveCalls();
        assertEq(list.length, 2);
        assertEq(list[1].selector, Brake.revokeMandate.selector);
    }

    function test_construction_refuses_a_bad_protective_list_or_sentinel() public {
        QEDOwnerAccount.Guard[] memory g = new QEDOwnerAccount.Guard[](1);
        g[0] = QEDOwnerAccount.Guard(address(brake), Brake.pause.selector, "guarded and protective at once");
        QEDOwnerAccount.Guard[] memory p = new QEDOwnerAccount.Guard[](1);
        p[0] = g[0];
        _refusedProtective(g, p, 0);
        _refusedProtective(noGuards(), _one(address(0), Brake.pause.selector, "zero target"), 0);
        _refusedProtective(noGuards(), _one(address(brake), bytes4(0), "zero selector"), 0);
        _refusedProtective(noGuards(), _one(address(brake), Brake.pause.selector, ""), 0);
        p = new QEDOwnerAccount.Guard[](2);
        p[0] = QEDOwnerAccount.Guard(address(brake), Brake.pause.selector, "once");
        p[1] = QEDOwnerAccount.Guard(address(brake), Brake.pause.selector, "twice");
        _refusedProtective(noGuards(), p, 1);
        p = new QEDOwnerAccount.Guard[](17);
        for (uint256 i; i < p.length; ++i) p[i] = QEDOwnerAccount.Guard(address(brake), bytes4(uint32(i + 1)), "many");
        vm.expectRevert(QEDOwnerAccount.TooManyProtective.selector);
        deployContained(keys1(alice), noKeys(), 1, 1, noGuards(), p, sentinel);
    }

    function _one(address t, bytes4 sel, string memory why) internal pure returns (QEDOwnerAccount.Guard[] memory p) {
        p = new QEDOwnerAccount.Guard[](1);
        p[0] = QEDOwnerAccount.Guard(t, sel, why);
    }

    function _refusedProtective(QEDOwnerAccount.Guard[] memory g, QEDOwnerAccount.Guard[] memory p, uint256 i)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidProtective.selector, i));
        deployContained(keys1(alice), noKeys(), 1, 1, g, p, sentinel);
    }

    // ── helpers ───────────────────────────────────────────────────────────────────

    bytes32 internal constant SCHEDULED_SIG = keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    /// The change id of the ChangeScheduled event among the recorded logs.
    function _scheduled() internal returns (bytes32 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "no ChangeScheduled");
    }

    function _scheduleShorterDelay(Key memory by) internal returns (bytes32 changeId) {
        Prepared memory p =
            prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setDelays, (DELAY / 2, RECOVERY_DELAY))), keys1(by));
        vm.recordLogs();
        run(acct, p);
        changeId = _scheduled();
    }

    function _startRecovery(Key memory newKey_) internal returns (bytes32) {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 r, bytes32 s) = recoverySign(rec, acct.recoveryDigest(rec.id, newKey_.x, newKey_.y, deadline));
        return acct.startRecovery(rec.id, newKey_.x, newKey_.y, deadline, r, s);
    }
}
