// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {ReleaseSetup} from "./VaultIntegration.t.sol";
import {IQEDVault, ReleaseLockable, ReleaseProtective} from "./helpers/Release.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// R13: the optional time-lock, against the release's own vault (unmodified). withdraw, ringFence, unpause and the
/// vault's setGuardian run at once at the account's threshold unless the household chose the time-lock; then
/// `execute` refuses them and they wait the account's delay, during which any one Member can cancel. Turning the
/// time-lock on is immediate; turning it off waits the delay.
contract TimeLockTest is ReleaseSetup {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;

    // SCHEDULED_SIG comes from ReleaseSetup
    bytes32 internal constant CALLS_SCHEDULED_SIG =
        keccak256("CallsScheduled(bytes32,uint64,(address,uint256,bytes)[])");

    event TimeLockChanged(bool on);

    function _household(bool locked) internal {
        _deployRelease();
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        acct = deployFull(
            keys2(alice, bob),
            noKeys(),
            1,
            1,
            _guards(),
            ReleaseProtective.list(address(vault), address(policy)),
            address(0),
            ReleaseLockable.list(address(vault)),
            locked
        );
        _handOver(acct, keys1(alice));
    }

    function _moves() internal view returns (bytes[4] memory m) {
        m[0] = abi.encodeCall(IQEDVault.withdraw, (payee, 1e6));
        m[1] = abi.encodeCall(IQEDVault.ringFence, (payee, 1e6, uint64(vm.getBlockTimestamp() + 30 days), bytes32("memo")));
        m[2] = abi.encodeCall(IQEDVault.unpause, ());
        m[3] = abi.encodeCall(IQEDVault.setGuardian, (payee));
    }

    function _lastLog(bytes32 sig) internal returns (bytes32 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "event not found");
    }

    function test_the_lockable_list_is_the_release_vaults_four_calls_and_disjoint_from_the_other_lists() public {
        _household(true);
        QEDOwnerAccount.GuardKey[] memory l = acct.lockableCalls();
        assertEq(l.length, 4);
        bytes4[4] memory sels =
            [IQEDVault.withdraw.selector, IQEDVault.ringFence.selector, IQEDVault.unpause.selector, IQEDVault.setGuardian.selector];
        for (uint256 i; i < 4; ++i) {
            assertEq(l[i].target, address(vault));
            assertEq(l[i].selector, sels[i]);
            assertFalse(acct.isGuarded(address(vault), sels[i]));
            assertFalse(isProtectiveOf(acct, address(vault), sels[i]));
        }
        assertTrue(acct.timeLocked());
    }

    function test_time_locked_the_four_calls_are_refused_at_once_whatever_the_approvals_and_run_after_the_delay() public {
        _household(true);
        // pause first (protective, immediate even while time-locked), so that unpause has something to do
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.pause, ())), keys1(alice));
        bytes[4] memory m = _moves();
        for (uint256 i; i < 4; ++i) {
            Prepared memory p = prepare(acct, calls1(address(vault), 0, m[i]), keys2(alice, bob));
            vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(vault), bytes4(m[i])));
            run(acct, p);
        }
        assertEq(token.balanceOf(payee), 0);
        // the delayed path: one batch of all four, scheduled, applied by anyone after the delay
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](4);
        for (uint256 i; i < 4; ++i) c[i] = QEDOwnerAccount.Call(address(vault), 0, m[i]);
        Prepared memory s = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (c))), keys1(alice));
        vm.recordLogs();
        run(acct, s);
        bytes32 id = _lastLog(CALLS_SCHEDULED_SIG);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, uint64(vm.getBlockTimestamp()) + DELAY));
        acct.applyCalls(id, c);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(makeAddr("anyone"));
        acct.applyCalls(id, c);
        assertEq(token.balanceOf(payee), 1e6, "withdrawn after the delay");
        assertFalse(vault.paused(), "resumed after the delay");
    }

    function test_any_one_member_cancels_a_time_locked_withdrawal() public {
        _household(true);
        QEDOwnerAccount.Call[] memory c = calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 4_000e6)));
        Prepared memory s = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (c))), keys1(alice));
        vm.recordLogs();
        run(acct, s);
        bytes32 id = _lastLog(CALLS_SCHEDULED_SIG);
        acct.cancel(id, signAs(bob, acct.cancelDigest(id)));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyCalls(id, c);
        assertEq(token.balanceOf(payee), 0);
    }

    function test_without_the_time_lock_the_four_calls_run_at_once_as_before() public {
        _household(false);
        assertFalse(acct.timeLocked());
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.pause, ())), keys1(alice));
        bytes[4] memory m = _moves();
        for (uint256 i; i < 4; ++i) exec(acct, calls1(address(vault), 0, m[i]), keys1(alice));
        assertEq(token.balanceOf(payee), 1e6);
        assertFalse(vault.paused());
    }

    function test_turning_it_on_is_immediate_and_turning_it_off_waits_the_delay_and_can_be_cancelled() public {
        _household(false);
        vm.expectEmit(address(acct));
        emit TimeLockChanged(true);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (true))), keys1(alice));
        assertTrue(acct.timeLocked());
        Prepared memory p = prepare(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 1e6))), keys1(alice));
        vm.expectRevert(
            abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(vault), IQEDVault.withdraw.selector)
        );
        run(acct, p);
        // off: scheduled; one Member cancels it
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (false))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        bytes32 id = _lastLog(SCHEDULED_SIG);
        assertTrue(acct.timeLocked(), "still on until the delay passes");
        assertEq(uint8(acct.getChange(id).kind), uint8(QEDOwnerAccount.ChangeKind.SetTimeLock));
        acct.cancel(id, signAs(bob, acct.cancelDigest(id)));
        // off again, nobody cancels: applies after the delay, and only once
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (false))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        id = _lastLog(SCHEDULED_SIG);
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (false))), keys1(alice));
        vm.recordLogs();
        run(acct, p);
        bytes32 second = _lastLog(SCHEDULED_SIG);
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, uint64(vm.getBlockTimestamp()) + 1));
        acct.applyChange(id);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectEmit(address(acct));
        emit TimeLockChanged(false);
        acct.applyChange(id);
        assertFalse(acct.timeLocked());
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, second));
        acct.applyChange(second);
        // and the withdrawal runs at once again
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 1e6))), keys1(alice));
        assertEq(token.balanceOf(payee), 1e6);
        // turning it off while it is off changes nothing and schedules nothing
        vm.prank(address(acct));
        assertEq(acct.setTimeLock(false), bytes32(0));
    }

    function test_a_threshold_quorum_cannot_drain_free_funds_at_once_while_time_locked() public {
        // the business shape: threshold 1, admin threshold 2. One stolen passkey could withdraw at threshold before R13;
        // time-locked, it cannot even schedule (scheduling needs the admin threshold).
        _deployRelease();
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        acct = deployFull(
            keys2(alice, bob), noKeys(), 1, 2, _guards(), ReleaseProtective.list(address(vault), address(policy)), address(0), ReleaseLockable.list(address(vault)), true
        );
        _handOver(acct, keys2(alice, bob));
        Prepared memory p = prepare(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 5_000e6))), keys1(bob));
        vm.expectRevert(
            abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, address(vault), IQEDVault.withdraw.selector)
        );
        run(acct, p);
        QEDOwnerAccount.Call[] memory c = calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 5_000e6)));
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (c))), keys1(bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(acct, p);
        // turning the time-lock off is a change of the account: the admin threshold, then the delay
        p = prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setTimeLock, (false))), keys1(bob));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(acct, p);
        assertEq(token.balanceOf(payee), 0);
    }

    function test_construction_refuses_a_bad_lockable_list() public {
        _deployRelease();
        alice = newKey(0xA11CE);
        QEDOwnerAccount.Guard[] memory g = _guards();
        QEDOwnerAccount.Guard[] memory p = ReleaseProtective.list(address(vault), address(policy));
        QEDOwnerAccount.Guard[] memory l = new QEDOwnerAccount.Guard[](1);
        // zero target, zero selector, empty reason
        l[0] = QEDOwnerAccount.Guard(address(0), IQEDVault.withdraw.selector, "r");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 0));
        l[0] = QEDOwnerAccount.Guard(address(vault), bytes4(0), "r");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 0));
        l[0] = QEDOwnerAccount.Guard(address(vault), IQEDVault.withdraw.selector, "");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 0));
        // also guarded, or also protective (protect could then run it with one passkey)
        l[0] = QEDOwnerAccount.Guard(address(vault), IQEDVault.setAgent.selector, "r");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 0));
        l[0] = QEDOwnerAccount.Guard(address(vault), IQEDVault.pause.selector, "r");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 0));
        // twice
        l = new QEDOwnerAccount.Guard[](2);
        l[0] = QEDOwnerAccount.Guard(address(vault), IQEDVault.withdraw.selector, "r");
        l[1] = QEDOwnerAccount.Guard(address(vault), IQEDVault.withdraw.selector, "r");
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.InvalidLockable.selector, 1));
        // too many
        l = new QEDOwnerAccount.Guard[](33);
        _refused(g, p, l, abi.encodeWithSelector(QEDOwnerAccount.TooManyGuards.selector));
    }

    function _refused(
        QEDOwnerAccount.Guard[] memory g,
        QEDOwnerAccount.Guard[] memory p,
        QEDOwnerAccount.Guard[] memory l,
        bytes memory err
    ) internal {
        vm.expectRevert(err);
        new QEDOwnerAccount(
            RP_ID_HASH, ORIGIN, members(alice), 1, 1, DELAY, RECOVERY_DELAY, g, p, address(0), l, true
        );
    }
}
