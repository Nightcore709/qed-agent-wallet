// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest, Target} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Accepts any call (a fallback), so that any selector can be tried against a guarded target.
contract Sink {
    uint256 public hits;

    fallback() external payable {
        ++hits;
    }
}

/// Guarded calls: the immediate path is closed whatever the approvals; the delayed path needs adminThreshold,
/// waits `delay`, can be cancelled by any one Member, and runs exactly the scheduled calls.
contract GuardsTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Target internal target;
    Sink internal sink;
    Key internal alice;
    Key internal bob;
    Key internal carol;

    bytes4 internal constant SET = Target.set.selector;
    bytes4 internal constant GUARDED_SINK_SELECTOR = 0x12345678;
    bytes32 internal constant SCHEDULED_SIG = keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    event GuardConfigured(address indexed target, bytes4 indexed selector, string reason);
    event CallsScheduled(bytes32 indexed changeId, uint64 readyAt, QEDOwnerAccount.Call[] calls);
    event ChangeApplied(bytes32 indexed changeId, QEDOwnerAccount.ChangeKind kind);
    event ChangeCancelled(bytes32 indexed changeId, bytes32 indexed bySignerId);

    function _guards(address t, address s) internal pure returns (QEDOwnerAccount.Guard[] memory g) {
        g = new QEDOwnerAccount.Guard[](2);
        g[0] = QEDOwnerAccount.Guard(t, SET, "test: Target.set stands for a call that widens authority");
        g[1] = QEDOwnerAccount.Guard(s, GUARDED_SINK_SELECTOR, "test: one guarded selector on a fallback contract");
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        carol = newKey(0xCA401);
        target = new Target();
        sink = new Sink();
        // business setting: one Member meets `threshold`, two meet `adminThreshold`
        acct = deployAccountGuarded(keys3(alice, bob, carol), noKeys(), 1, 2, _guards(address(target), address(sink)));
    }

    function _setCall(uint256 v) internal view returns (QEDOwnerAccount.Call[] memory) {
        return calls1(address(target), 0, abi.encodeCall(Target.set, (v)));
    }

    function _schedulePrepared(QEDOwnerAccount.Call[] memory batch, Key[] memory approvers)
        internal
        view
        returns (Prepared memory)
    {
        return prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (batch))), approvers);
    }

    function _schedule(QEDOwnerAccount.Call[] memory batch) internal returns (bytes32 id) {
        Prepared memory p = _schedulePrepared(batch, keys2(alice, bob));
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "no ChangeScheduled");
    }

    // ── the immediate path is closed ──────────────────────────────────────────────

    function test_threshold_member_cannot_make_a_guarded_call() public {
        Prepared memory p = prepare(acct, _setCall(1), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(target), SET));
        run(acct, p);
    }

    function test_not_even_every_member_together_can_make_it_immediately() public {
        Prepared memory p = prepare(acct, _setCall(1), keys3(alice, bob, carol));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(target), SET));
        run(acct, p);
    }

    function test_a_guarded_call_hidden_in_a_batch_is_refused() public {
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(address(target), 0, abi.encodeWithSignature("value()"));
        c[1] = QEDOwnerAccount.Call(address(target), 0, abi.encodeCall(Target.set, (7)));
        Prepared memory p = prepare(acct, c, keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 1, address(target), SET));
        run(acct, p);
    }

    function test_other_selectors_on_a_guarded_target_stay_immediate() public {
        exec(acct, calls1(address(target), 0, abi.encodeWithSignature("value()")), keys1(alice));
        assertEq(acct.nonce(), 1);
    }

    function test_threshold_member_cannot_schedule() public {
        Prepared memory p = _schedulePrepared(_setCall(1), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(acct, p);
    }

    // ── the delayed path ──────────────────────────────────────────────────────────

    function test_delayed_path_runs_the_guarded_call_after_the_delay() public {
        QEDOwnerAccount.Call[] memory batch = _setCall(42);
        Prepared memory p = _schedulePrepared(batch, keys2(alice, bob));
        vm.expectEmit(false, false, false, true, address(acct));
        emit CallsScheduled(bytes32(0), uint64(block.timestamp) + DELAY, batch);
        vm.recordLogs();
        run(acct, p);
        bytes32 id;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        QEDOwnerAccount.PendingChange memory pc = acct.getChange(id);
        assertEq(uint8(pc.kind), uint8(QEDOwnerAccount.ChangeKind.GuardedCalls));
        assertEq(pc.callsHash, acct.callsHash(batch));
        assertEq(target.value(), 0, "nothing ran yet");

        vm.warp(pc.readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, pc.readyAt));
        acct.applyCalls(id, batch);

        vm.warp(pc.readyAt);
        address anyone = makeAddr("anyone");
        vm.expectEmit(address(acct));
        emit ChangeApplied(id, QEDOwnerAccount.ChangeKind.GuardedCalls);
        vm.prank(anyone);
        acct.applyCalls(id, batch);
        assertEq(target.value(), 42);
        assertEq(target.lastCaller(), address(acct));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyCalls(id, batch);
    }

    function test_apply_must_present_exactly_the_scheduled_calls() public {
        bytes32 id = _schedule(_setCall(42));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CallsMismatch.selector, id));
        acct.applyCalls(id, _setCall(43));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CallsMismatch.selector, id));
        acct.applyCalls(id, calls1(address(target), 1, abi.encodeCall(Target.set, (42))));
    }

    function test_any_one_member_cancels_a_scheduled_guarded_batch() public {
        bytes32 id = _schedule(_setCall(42));
        QEDOwnerAccount.Assertion memory a = signAs(carol, acct.cancelDigest(id)); // carol approved nothing
        vm.expectEmit(address(acct));
        emit ChangeCancelled(id, carol.id);
        acct.cancel(id, a);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyCalls(id, _setCall(42));
        assertEq(target.value(), 0);
    }

    function test_a_failing_scheduled_batch_stays_pending_and_cancellable() public {
        QEDOwnerAccount.Call[] memory batch = calls1(address(target), 0, abi.encodeCall(Target.fail, ()));
        bytes32 id = _schedule(batch);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector, 0, abi.encodeWithSelector(Target.Nope.selector)
            )
        );
        acct.applyCalls(id, batch);
        assertEq(uint8(acct.getChange(id).kind), uint8(QEDOwnerAccount.ChangeKind.GuardedCalls));
        acct.cancel(id, signAs(alice, acct.cancelDigest(id)));
        assertEq(uint8(acct.getChange(id).kind), uint8(QEDOwnerAccount.ChangeKind.None));
    }

    function test_kinds_are_not_interchangeable() public {
        bytes32 batchId = _schedule(_setCall(1));
        Prepared memory p = prepare(
            acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setDelays, (DELAY - 1 hours, RECOVERY_DELAY))), keys2(alice, bob)
        );
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 delayId;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) delayId = logs[i].topics[1];
        }
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.WrongChangeKind.selector, batchId));
        acct.applyChange(batchId);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.WrongChangeKind.selector, delayId));
        acct.applyCalls(delayId, _setCall(1));
    }

    function test_schedule_refuses_empty_batches_and_calls_to_the_account() public {
        Prepared memory p = _schedulePrepared(new QEDOwnerAccount.Call[](0), keys2(alice, bob));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector, 0, abi.encodeWithSelector(QEDOwnerAccount.EmptyCalls.selector)
            )
        );
        run(acct, p);
        p = _schedulePrepared(selfCall(acct, abi.encodeCall(QEDOwnerAccount.setThresholds, (1, 1))), keys2(alice, bob));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(QEDOwnerAccount.SelfCallNotAllowed.selector, 0)
            )
        );
        run(acct, p);
    }

    function test_schedule_only_through_execute() public {
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.scheduleCalls(_setCall(1));
    }

    // ── construction ──────────────────────────────────────────────────────────────

    function test_guard_list_views_and_reasons() public {
        QEDOwnerAccount.Guard[] memory g = _guards(address(target), address(sink));
        vm.expectEmit();
        emit GuardConfigured(address(target), SET, g[0].reason);
        vm.expectEmit();
        emit GuardConfigured(address(sink), GUARDED_SINK_SELECTOR, g[1].reason);
        QEDOwnerAccount a2 = deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);
        assertTrue(a2.isGuarded(address(target), SET));
        assertFalse(a2.isGuarded(address(target), bytes4(keccak256("value()"))));
        QEDOwnerAccount.GuardKey[] memory list = a2.guardedCalls();
        assertEq(list.length, 2);
        assertEq(list[0].target, address(target));
        assertEq(list[0].selector, SET);
        assertEq(list[1].target, address(sink));
    }

    function test_invalid_guard_lists_refused() public {
        QEDOwnerAccount.Guard[] memory g = new QEDOwnerAccount.Guard[](1);
        g[0] = QEDOwnerAccount.Guard(address(0), SET, "x");
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidGuard.selector, 0));
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);

        g[0] = QEDOwnerAccount.Guard(address(target), bytes4(0), "x");
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidGuard.selector, 0));
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);

        g[0] = QEDOwnerAccount.Guard(address(target), SET, "");
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidGuard.selector, 0));
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);

        // the account being deployed cannot guard itself (its own calls have their own rules)
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        g[0] = QEDOwnerAccount.Guard(next, SET, "x");
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidGuard.selector, 0));
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);

        QEDOwnerAccount.Guard[] memory dup = new QEDOwnerAccount.Guard[](2);
        dup[0] = QEDOwnerAccount.Guard(address(target), SET, "x");
        dup[1] = QEDOwnerAccount.Guard(address(target), SET, "y");
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidGuard.selector, 1));
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, dup);

        QEDOwnerAccount.Guard[] memory many = new QEDOwnerAccount.Guard[](33);
        for (uint256 i; i < 33; ++i) many[i] = QEDOwnerAccount.Guard(address(target), bytes4(uint32(i + 1)), "x");
        vm.expectRevert(QEDOwnerAccount.TooManyGuards.selector);
        deployAccountGuarded(keys1(alice), noKeys(), 1, 1, many);
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    function testFuzz_exactly_the_listed_selectors_are_refused(bytes4 sel, bytes calldata args) public {
        vm.assume(sel != bytes4(0) && sel != bytes4(keccak256("hits()")));
        QEDOwnerAccount.Call[] memory c = calls1(address(sink), 0, bytes.concat(sel, args));
        Prepared memory p = prepare(acct, c, keys1(alice));
        if (sel == GUARDED_SINK_SELECTOR) {
            vm.expectRevert(
                abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(sink), GUARDED_SINK_SELECTOR)
            );
            run(acct, p);
        } else {
            run(acct, p);
            assertEq(sink.hits(), 1);
        }
    }

    function testFuzz_guarded_call_never_immediate_whatever_the_approvals(uint8 n, uint256 v) public {
        n = uint8(bound(n, 1, 3));
        Key[] memory ks = n == 1 ? keys1(alice) : n == 2 ? keys2(alice, bob) : keys3(alice, bob, carol);
        Prepared memory p = prepare(acct, _setCall(v), ks);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(target), SET));
        run(acct, p);
    }
}
