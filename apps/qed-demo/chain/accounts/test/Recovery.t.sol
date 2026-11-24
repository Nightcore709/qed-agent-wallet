// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Recovery: raw P-256 signature from a recovery-code key, delay, cancel by any one Member, single use.
contract RecoveryTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;
    Key internal rec1;
    Key internal rec2;
    Key internal dave; // the new passkey of someone who lost theirs

    event RecoveryStarted(
        bytes32 indexed recoveryId,
        bytes32 indexed recoverySignerId,
        bytes32 newSignerId,
        uint256 newX,
        uint256 newY,
        uint64 readyAt
    );
    event RecoveryCancelled(bytes32 indexed recoveryId, bytes32 indexed bySignerId);
    event RecoveryFinished(bytes32 indexed recoveryId, bytes32 indexed newSignerId);
    event SignerRemoved(bytes32 indexed signerId, QEDOwnerAccount.Role role);

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        rec1 = newKey(0x5EC1);
        rec2 = newKey(0x5EC2);
        dave = newKey(0xDA7E);
        acct = deployAccount(keys1(alice), keys2(rec1, rec2), 1, 1);
    }

    function _start(QEDOwnerAccount a, Key memory r, Key memory newMember) internal returns (bytes32 id) {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(r, a.recoveryDigest(r.id, newMember.x, newMember.y, deadline));
        id = a.startRecovery(r.id, newMember.x, newMember.y, deadline, sr, ss);
    }

    function test_full_recovery_flow() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        uint64 readyAt = uint64(block.timestamp) + RECOVERY_DELAY;
        address relayer = makeAddr("relayer");
        vm.expectEmit(false, true, false, true, address(acct));
        emit RecoveryStarted(bytes32(0), rec1.id, dave.id, dave.x, dave.y, readyAt);
        vm.prank(relayer);
        bytes32 id = acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);

        assertEq(acct.pendingRecoveryOf(rec1.id), id);
        assertTrue(acct.spentRecoveryKey(rec1.id));
        assertEq(acct.getRecovery(id).readyAt, readyAt);
        assertEq(acct.memberCount(), 1, "no authority yet");

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.finishRecovery(id);

        vm.warp(readyAt);
        address anyone = makeAddr("anyone");
        vm.expectEmit(address(acct));
        emit SignerRemoved(rec1.id, QEDOwnerAccount.Role.Recovery);
        vm.expectEmit(address(acct));
        emit RecoveryFinished(id, dave.id);
        vm.prank(anyone);
        acct.finishRecovery(id);

        assertEq(acct.memberCount(), 2);
        assertEq(uint8(acct.getSigner(dave.id).role), uint8(QEDOwnerAccount.Role.Member));
        assertEq(uint8(acct.getSigner(rec1.id).role), uint8(QEDOwnerAccount.Role.None), "single use");
        assertEq(acct.pendingRecoveryOf(rec1.id), bytes32(0));

        // the recovered passkey now approves an execute on its own (threshold 1)
        exec(acct, new QEDOwnerAccount.Call[](0), keys1(dave));
        assertEq(acct.nonce(), 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.finishRecovery(id);
    }

    function test_any_member_cancels_during_delay_and_the_code_is_burnt() public {
        bytes32 id = _start(acct, rec1, dave);
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.cancelDigest(id));
        vm.expectEmit(address(acct));
        emit RecoveryCancelled(id, alice.id);
        vm.expectEmit(address(acct));
        emit SignerRemoved(rec1.id, QEDOwnerAccount.Role.Recovery);
        acct.cancel(id, a);

        vm.warp(block.timestamp + RECOVERY_DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.finishRecovery(id);
        assertEq(acct.memberCount(), 1);
        // a used code can never come back as a Recovery key
        Prepared memory p = prepare(
            acct,
            selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (rec1.x, rec1.y, QEDOwnerAccount.Role.Recovery))),
            keys1(alice)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(QEDOwnerAccount.RecoveryKeySpent.selector, rec1.id)
            )
        );
        run(acct, p);
    }

    function test_recovery_key_cannot_cancel_another_recovery() public {
        bytes32 id = _start(acct, rec1, dave);
        QEDOwnerAccount.Assertion memory a = signAs(rec2, acct.cancelDigest(id));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec2.id));
        acct.cancel(id, a);
    }

    function test_invalid_recovery_signature_refused() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(rec2, digest); // wrong key
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);

        (sr, ss) = vm.signP256(rec1.pk, digest); // signed the digest without the SHA-256 step
        if (uint256(ss) > N / 2) ss = bytes32(N - uint256(ss));
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);
    }

    function test_recovery_signature_binds_the_new_key_and_deadline() public {
        Key memory eve = newKey(0xE5E);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, eve.x, eve.y, deadline, sr, ss); // relayer swaps in its own key
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline + 1, sr, ss);
    }

    function test_high_s_recovery_signature_refused() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, bytes32(N - uint256(ss)));
    }

    function test_expired_recovery_request_refused() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.Expired.selector, deadline, deadline + 1));
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);
    }

    function test_member_key_cannot_start_recovery() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(alice, acct.recoveryDigest(alice.id, dave.x, dave.y, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotARecoverySigner.selector, alice.id));
        acct.startRecovery(alice.id, dave.x, dave.y, deadline, sr, ss);
    }

    function test_one_pending_recovery_per_code() public {
        bytes32 id = _start(acct, rec1, dave);
        Key memory eve = newKey(0xE5E);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, eve.x, eve.y, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.RecoveryAlreadyPending.selector, rec1.id, id));
        acct.startRecovery(rec1.id, eve.x, eve.y, deadline, sr, ss);
    }

    function test_new_key_must_be_new_and_on_the_curve() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, alice.x, alice.y, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, alice.id));
        acct.startRecovery(rec1.id, alice.x, alice.y, deadline, sr, ss);

        (sr, ss) = recoverySign(rec1, acct.recoveryDigest(rec1.id, 1, 2, deadline));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidPublicKey.selector, 1, 2));
        acct.startRecovery(rec1.id, 1, 2, deadline, sr, ss);
    }

    function test_recovery_signature_for_another_account_refused() public {
        QEDOwnerAccount other = deployAccount(keys1(alice), keys2(rec1, rec2), 1, 1);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(rec1, other.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);
        other.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss); // valid where it was made for
    }

    function test_recovery_key_signatures_accepted_nowhere_else() public {
        // ERC-1271: a WebAuthn-shaped assertion by the Recovery key is not a Member approval.
        bytes32 h = keccak256("mandate");
        bytes32 c = acct.replaySafeHash(h);
        assertEq(acct.isValidSignature(h, abi.encode(one(signAs(rec1, c)))), bytes4(0xffffffff));
        // execute: refused as a non-Member
        QEDOwnerAccount.Call[] memory calls = new QEDOwnerAccount.Call[](0);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = one(signAs(rec1, acct.executeDigest(calls, 0, d)));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec1.id));
        acct.execute(calls, 0, d, as_);
    }

    function test_removing_a_recovery_key_drops_its_pending_recovery() public {
        bytes32 id = _start(acct, rec1, dave);
        Prepared memory p = prepare(
            acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.removeSigners, (ids1(rec1.id)))), keys1(alice)
        );
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 changeId;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])")) {
                changeId = logs[i].topics[1];
            }
        }
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(acct));
        emit RecoveryCancelled(id, bytes32(0));
        acct.applyChange(changeId);
        vm.warp(block.timestamp + RECOVERY_DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        acct.finishRecovery(id);
    }

    function test_finish_refused_if_the_new_key_was_added_meanwhile() public {
        bytes32 id = _start(acct, rec1, dave);
        exec(
            acct,
            selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member))),
            keys1(alice)
        );
        vm.warp(block.timestamp + RECOVERY_DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, dave.id));
        acct.finishRecovery(id);
        // still cancellable by a Member
        acct.cancel(id, signAs(alice, acct.cancelDigest(id)));
    }

    function test_recovery_restores_one_member_it_does_not_lower_thresholds() public {
        // 2-of-2 account: one recovered passkey alone does not reach the threshold.
        acct = deployAccount(keys2(alice, bob), keys1(rec1), 2, 2);
        bytes32 id = _start(acct, rec1, dave);
        vm.warp(block.timestamp + RECOVERY_DELAY);
        acct.finishRecovery(id);
        assertEq(acct.threshold(), 2);
        Prepared memory p = prepare(acct, new QEDOwnerAccount.Call[](0), keys1(dave));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(acct, p);
        exec(acct, new QEDOwnerAccount.Call[](0), keys2(alice, dave));
    }

    function testFuzz_finish_never_before_delay(uint256 wait) public {
        wait = bound(wait, 0, RECOVERY_DELAY - 1);
        bytes32 id = _start(acct, rec1, dave);
        uint64 readyAt = acct.getRecovery(id).readyAt;
        vm.warp(block.timestamp + wait);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        acct.finishRecovery(id);
    }

    function testFuzz_recovery_signature_by_any_other_key_refused(uint256 pk) public {
        pk = bound(pk, 1, N - 1);
        vm.assume(pk != rec1.pk);
        Key memory k = newKey(pk);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(k, acct.recoveryDigest(rec1.id, dave.x, dave.y, deadline));
        vm.expectRevert(QEDOwnerAccount.InvalidRecoverySignature.selector);
        acct.startRecovery(rec1.id, dave.x, dave.y, deadline, sr, ss);
    }
}
