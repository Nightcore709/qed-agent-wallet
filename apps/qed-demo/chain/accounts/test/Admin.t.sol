// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Self-administration: immediate additions, scheduled protection-reducing changes, apply, cancel by one Member.
contract AdminTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;
    Key internal carol;
    Key internal dave;
    Key internal rec;
    Key internal erin;

    event SignerAdded(bytes32 indexed signerId, QEDOwnerAccount.Role role, uint256 x, uint256 y, uint64 serial);
    event SignerRemoved(bytes32 indexed signerId, QEDOwnerAccount.Role role);
    event ChangeScheduled(
        bytes32 indexed changeId,
        QEDOwnerAccount.ChangeKind kind,
        uint64 readyAt,
        uint256 toA,
        uint256 toB,
        bytes32[] targets
    );
    event ChangeApplied(bytes32 indexed changeId, QEDOwnerAccount.ChangeKind kind);
    event ChangeCancelled(bytes32 indexed changeId, bytes32 indexed bySignerId);
    event ThresholdsChanged(uint256 threshold, uint256 adminThreshold);
    event DelaysChanged(uint64 delay, uint64 recoveryDelay);

    bytes32 internal constant SCHEDULED_SIG = keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        carol = newKey(0xCA401);
        dave = newKey(0xDA7E);
        rec = newKey(0x5EC0);
        erin = newKey(0xE41);
        // threshold 2, adminThreshold 2: the "cancel by one member under threshold 2" setting
        acct = deployAccount(keys3(alice, bob, carol), keys1(rec), 2, 2);
    }

    /// R13 review fixes (F2): a removal that names an unfrozen Member is scheduled only if more Members it does not name
    /// than adminThreshold have been Members for `delay`. With three Members at 2 of 2, removing one leaves two: the
    /// approvers themselves, nobody else to cancel. The removal tests run with a fourth Member, erin.
    function _withErin() internal {
        Key[] memory ms = new Key[](4);
        (ms[0], ms[1], ms[2], ms[3]) = (alice, bob, carol, erin);
        acct = deployAccount(ms, keys1(rec), 2, 2);
    }

    function _prep(bytes memory data) internal view returns (Prepared memory) {
        return prepare(acct, selfCall(acct, data), keys2(alice, bob));
    }

    function _admin(bytes memory data) internal {
        run(acct, _prep(data));
    }

    /// Runs an admin call through execute and returns the ChangeScheduled id (zero if applied immediately).
    function _scheduleOrZero(bytes memory data) internal returns (bytes32 id) {
        Prepared memory p = _prep(data);
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
    }

    function _schedule(bytes memory data) internal returns (bytes32 id) {
        id = _scheduleOrZero(data);
        require(id != bytes32(0), "no ChangeScheduled");
    }

    function _expectAdminRevert(bytes memory data, bytes memory inner) internal {
        Prepared memory p = _prep(data);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CallFailed.selector, 0, inner));
        run(acct, p);
    }

    function _sortedPair(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](2);
        (r[0], r[1]) = uint256(a) < uint256(b) ? (a, b) : (b, a);
    }

    // ── immediate additions ───────────────────────────────────────────────────────

    function test_add_member_is_immediate_with_admin_threshold() public {
        Prepared memory p = _prep(abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member)));
        vm.expectEmit(address(acct));
        emit SignerAdded(dave.id, QEDOwnerAccount.Role.Member, dave.x, dave.y, 5);
        run(acct, p);
        assertEq(acct.memberCount(), 4);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
        assertEq(acct.signerIds().length, 5);
    }

    function test_admin_functions_only_through_execute() public {
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.addSigner(dave.x, dave.y, QEDOwnerAccount.Role.Member);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.removeSigners(ids1(carol.id));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.setThresholds(1, 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.OnlySelf.selector, address(this)));
        acct.setDelays(1 hours, 1 hours);
    }

    function test_add_invalid_or_duplicate_key_refused() public {
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.addSigner, (1, 2, QEDOwnerAccount.Role.Member)),
            abi.encodeWithSelector(QEDOwnerAccount.InvalidPublicKey.selector, 1, 2)
        );
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.addSigner, (carol.x, carol.y, QEDOwnerAccount.Role.Recovery)),
            abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, carol.id)
        );
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.None)),
            abi.encodeWithSelector(QEDOwnerAccount.InvalidRole.selector)
        );
    }

    function test_signer_set_is_bounded() public {
        for (uint256 i = 0; i < 12; ++i) {
            Key memory k = newKey(0x1000 + i);
            _admin(abi.encodeCall(QEDOwnerAccount.addSigner, (k.x, k.y, QEDOwnerAccount.Role.Recovery)));
        }
        assertEq(acct.signerIds().length, 16);
        Key memory extra = newKey(0x2000);
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.addSigner, (extra.x, extra.y, QEDOwnerAccount.Role.Member)),
            abi.encodeWithSelector(QEDOwnerAccount.TooManySigners.selector)
        );
    }

    // ── scheduled removal ─────────────────────────────────────────────────────────

    function test_remove_signer_is_scheduled_then_applied_after_delay() public {
        _withErin();
        uint64 readyAt = uint64(block.timestamp) + DELAY;
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        assertEq(acct.memberCount(), 4, "nothing removed yet");
        QEDOwnerAccount.PendingChange memory p = acct.getChange(id);
        assertEq(uint8(p.kind), uint8(QEDOwnerAccount.ChangeKind.RemoveSigners));
        assertEq(p.readyAt, readyAt);
        assertEq(p.targets.length, 1);
        assertEq(p.targets[0], carol.id);

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.applyChange(id); // change applied early: refused

        vm.warp(readyAt);
        address anyone = makeAddr("anyone");
        vm.expectEmit(address(acct));
        emit SignerRemoved(carol.id, QEDOwnerAccount.Role.Member);
        vm.expectEmit(address(acct));
        emit ChangeApplied(id, QEDOwnerAccount.ChangeKind.RemoveSigners);
        vm.prank(anyone);
        acct.applyChange(id);
        assertEq(acct.memberCount(), 3);
        assertEq(uint8(acct.getSigner(carol.id).role), uint8(QEDOwnerAccount.Role.None));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyChange(id);
    }

    function test_schedule_event_carries_the_terms() public {
        _withErin();
        Prepared memory p = _prep(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        vm.expectEmit(false, false, false, true, address(acct)); // id is derived on-chain; check the data
        emit ChangeScheduled(
            bytes32(0), QEDOwnerAccount.ChangeKind.RemoveSigners, uint64(block.timestamp) + DELAY, 0, 0, ids1(carol.id)
        );
        run(acct, p);
    }

    function test_cancel_by_one_member_under_threshold_two() public {
        _withErin();
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        assertEq(acct.threshold(), 2);
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.cancelDigest(id));
        address relayer = makeAddr("relayer");
        vm.expectEmit(address(acct));
        emit ChangeCancelled(id, alice.id);
        vm.prank(relayer);
        acct.cancel(id, a); // ONE assertion
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.applyChange(id);
        assertEq(acct.memberCount(), 4);
    }

    function test_member_cannot_cancel_its_own_removal() public {
        _withErin();
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        QEDOwnerAccount.Assertion memory a = signAs(carol, acct.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, carol.id));
        acct.cancel(id, a);
    }

    function test_two_compromised_members_removed_together_cannot_cancel() public {
        // Separate removals would let each stolen key cancel the other's removal; one joint removal cannot be.
        acct = deployAccount(keys3(alice, bob, carol), keys1(rec), 1, 1);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member))), keys1(alice));
        Prepared memory p = prepare(
            acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (_sortedPair(carol.id, dave.id)))), keys1(alice)
        );
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 id;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        bytes32 cd = acct.cancelDigest(id);
        QEDOwnerAccount.Assertion memory byCarol = signAs(carol, cd);
        QEDOwnerAccount.Assertion memory byDave = signAs(dave, cd);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, carol.id));
        acct.cancel(id, byCarol);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.CannotCancelOwnRemoval.selector, dave.id));
        acct.cancel(id, byDave);
        vm.warp(block.timestamp + DELAY);
        acct.applyChange(id);
        assertEq(acct.memberCount(), 2);
    }

    function test_recovery_key_cannot_cancel() public {
        _withErin();
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        QEDOwnerAccount.Assertion memory a = signAs(rec, acct.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec.id));
        acct.cancel(id, a);
    }

    function test_cancel_needs_assertion_over_that_id() public {
        _withErin();
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        QEDOwnerAccount.Assertion memory wrong = signAs(alice, acct.cancelDigest(keccak256("other id")));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.cancel(id, wrong);
        // an assertion over the raw id (not the EIP-712 cancel digest) is not accepted either
        QEDOwnerAccount.Assertion memory raw = signAs(alice, id);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.cancel(id, raw);
    }

    function test_cancel_of_unknown_id_refused() public {
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.cancelDigest(keccak256("nothing")));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, keccak256("nothing")));
        acct.cancel(keccak256("nothing"), a);
    }

    function test_cancel_assertion_cannot_be_replayed_on_a_later_change() public {
        _withErin();
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.cancelDigest(id));
        acct.cancel(id, a);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.cancel(id, a);
        // the same removal scheduled again gets a new id: the old cancel assertion does not fit it
        bytes32 id2 = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        assertTrue(id2 != id);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.cancel(id2, a);
    }

    function test_last_member_removal_refused() public {
        acct = deployAccount(keys1(alice), noKeys(), 1, 1);
        Prepared memory p =
            prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(alice.id)))), keys1(alice));
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 1, 1, 0)
            )
        );
        run(acct, p);
    }

    function test_removal_below_admin_threshold_refused_at_schedule() public {
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (_sortedPair(bob.id, carol.id))),
            abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 2, 2, 1)
        );
    }

    function test_removal_needs_more_settled_members_it_does_not_name_than_admin_threshold() public {
        // three Members at 2 of 2: naming carol (unfrozen) leaves only the two approvers, so it is refused (R13 F2)
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))),
            abi.encodeWithSelector(QEDOwnerAccount.NoCancellerLeft.selector)
        );
        // a fourth Member counts once it has been one for `delay`
        _admin(abi.encodeCall(QEDOwnerAccount.addSigner, (erin.x, erin.y, QEDOwnerAccount.Role.Member)));
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))),
            abi.encodeWithSelector(QEDOwnerAccount.NoCancellerLeft.selector)
        );
        vm.warp(block.timestamp + DELAY);
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        acct.cancel(id, signAs(erin, acct.cancelDigest(id)));
    }

    function test_quorum_is_rechecked_when_applying() public {
        _withErin();
        // Three removals each fine on their own; together they would leave 1 Member under adminThreshold 2.
        bytes32 id1 = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(erin.id))));
        bytes32 id2 = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(carol.id))));
        bytes32 id3 = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(bob.id))));
        vm.warp(block.timestamp + DELAY);
        acct.applyChange(id1);
        acct.applyChange(id2);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 2, 2, 1));
        acct.applyChange(id3);
        assertEq(acct.memberCount(), 2);
    }

    function test_removal_is_stale_after_target_was_re_added() public {
        Key memory r2 = newKey(0x5EC1);
        _admin(abi.encodeCall(QEDOwnerAccount.addSigner, (r2.x, r2.y, QEDOwnerAccount.Role.Member)));
        bytes32 oldRemoval = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(r2.id))));
        bytes32 otherRemoval = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(r2.id))));
        vm.warp(block.timestamp + DELAY);
        acct.applyChange(otherRemoval);
        _admin(abi.encodeCall(QEDOwnerAccount.addSigner, (r2.x, r2.y, QEDOwnerAccount.Role.Member)));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, oldRemoval));
        acct.applyChange(oldRemoval);
        assertEq(uint8(acct.getSigner(r2.id).role), uint8(QEDOwnerAccount.Role.Member));
    }

    function test_removal_input_validation() public {
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (new bytes32[](0))),
            abi.encodeWithSelector(QEDOwnerAccount.EmptyRemoval.selector)
        );
        bytes32[] memory pair = _sortedPair(bob.id, carol.id);
        (pair[0], pair[1]) = (pair[1], pair[0]);
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (pair)),
            abi.encodeWithSelector(QEDOwnerAccount.IdsNotStrictlyIncreasing.selector, 1)
        );
        _expectAdminRevert(
            abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(dave.id))),
            abi.encodeWithSelector(QEDOwnerAccount.UnknownSigner.selector, dave.id)
        );
    }

    // ── thresholds ────────────────────────────────────────────────────────────────

    function test_raising_thresholds_is_immediate() public {
        Prepared memory p = _prep(abi.encodeCall(QEDOwnerAccount.setThresholds, (2, 3)));
        vm.expectEmit(address(acct));
        emit ThresholdsChanged(2, 3);
        run(acct, p);
        assertEq(acct.adminThreshold(), 3);
    }

    function test_lowering_a_threshold_is_scheduled() public {
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.setThresholds, (1, 2)));
        assertEq(acct.threshold(), 2, "unchanged until applied");
        uint64 readyAt = acct.getChange(id).readyAt;
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.applyChange(id);
        vm.warp(readyAt);
        acct.applyChange(id);
        assertEq(acct.threshold(), 1);
        assertEq(acct.adminThreshold(), 2);
    }

    function test_lowering_change_is_stale_after_a_raise() public {
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.setThresholds, (1, 2)));
        assertEq(_scheduleOrZero(abi.encodeCall(QEDOwnerAccount.setThresholds, (2, 3))), bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.ChangeStale.selector, id));
        acct.applyChange(id);
        assertEq(acct.adminThreshold(), 3);
    }

    function test_invalid_thresholds_refused() public {
        uint256[2][4] memory bad = [[uint256(0), 1], [uint256(3), 2], [uint256(2), 4], [uint256(4), 4]];
        for (uint256 i; i < bad.length; ++i) {
            _expectAdminRevert(
                abi.encodeCall(QEDOwnerAccount.setThresholds, (bad[i][0], bad[i][1])),
                abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, bad[i][0], bad[i][1], 3)
            );
        }
    }

    // ── delays ────────────────────────────────────────────────────────────────────

    function test_lengthening_delays_is_immediate_shortening_is_scheduled() public {
        Prepared memory p = _prep(abi.encodeCall(QEDOwnerAccount.setDelays, (2 days, 4 days)));
        vm.expectEmit(address(acct));
        emit DelaysChanged(2 days, 4 days);
        run(acct, p);
        assertEq(acct.delay(), 2 days);

        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.setDelays, (1 hours, 4 days)));
        assertEq(acct.delay(), 2 days);
        // the shortening itself waits for the CURRENT (longer) delay
        uint64 readyAt = acct.getChange(id).readyAt;
        assertEq(readyAt, uint64(block.timestamp) + 2 days);
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.applyChange(id);
        vm.warp(readyAt);
        acct.applyChange(id);
        assertEq(acct.delay(), 1 hours);
    }

    function test_delay_bounds() public {
        uint64[2] memory bad = [uint64(59), uint64(30 days + 1)];
        for (uint256 i; i < 2; ++i) {
            _expectAdminRevert(
                abi.encodeCall(QEDOwnerAccount.setDelays, (bad[i], RECOVERY_DELAY)),
                abi.encodeWithSelector(QEDOwnerAccount.InvalidDelay.selector, bad[i])
            );
        }
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    function testFuzz_change_never_applies_early(uint256 wait) public {
        wait = bound(wait, 0, DELAY - 1);
        bytes32 id = _schedule(abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(rec.id))));
        uint64 readyAt = acct.getChange(id).readyAt;
        vm.warp(block.timestamp + wait);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.applyChange(id);
    }

    function testFuzz_thresholds_rule(uint256 t, uint256 a) public {
        t = bound(t, 0, 5);
        a = bound(a, 0, 5);
        bool valid = t >= 1 && t <= a && a <= 3;
        Prepared memory p = _prep(abi.encodeCall(QEDOwnerAccount.setThresholds, (t, a)));
        if (!valid) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    QEDOwnerAccount.CallFailed.selector,
                    0,
                    abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, t, a, 3)
                )
            );
        }
        run(acct, p);
        if (valid && t >= 2 && a >= 2) {
            assertEq(acct.threshold(), t); // raise or equal: immediate
            assertEq(acct.adminThreshold(), a);
        } else if (valid) {
            assertEq(acct.threshold(), 2); // a decrease: only scheduled
            assertEq(acct.adminThreshold(), 2);
        }
    }
}
