// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest, Target} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";
import {ReentrancyGuardTransient} from "@oz-5.6.1/utils/ReentrancyGuardTransient.sol";

/// Calls back into the account while it is executing.
contract Reenter {
    function poke(QEDOwnerAccount acct) external {
        acct.execute(new QEDOwnerAccount.Call[](0), acct.nonce(), type(uint64).max, new QEDOwnerAccount.Assertion[](0));
    }
}

/// execute: nonce, deadline, thresholds, admin threshold, distinct Members, relaying, atomicity, reentrancy.
contract ExecuteTest is PasskeyTest {
    QEDOwnerAccount internal acct;
    Target internal target;
    Key internal alice;
    Key internal bob;
    Key internal carol;
    Key internal rec;
    Key internal mallory;

    event Executed(uint256 indexed nonce, bytes32 indexed digest, bytes32[] approvers, uint256 callCount);

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        carol = newKey(0xCA401);
        rec = newKey(0x5EC0);
        mallory = newKey(0xBAD);
        acct = deployAccount(keys3(alice, bob, carol), keys1(rec), 2, 3);
        target = new Target();
    }

    function _setCall(uint256 v) internal view returns (QEDOwnerAccount.Call[] memory) {
        return calls1(address(target), 0, abi.encodeCall(Target.set, (v)));
    }

    function _sign2(QEDOwnerAccount.Call[] memory c, uint256 n, uint64 d, Key memory k1, Key memory k2)
        internal
        view
        returns (QEDOwnerAccount.Assertion[] memory)
    {
        bytes32 digest = acct.executeDigest(c, n, d);
        return two(signAs(k1, digest), signAs(k2, digest));
    }

    function test_two_of_three_executes_and_emits() public {
        QEDOwnerAccount.Call[] memory c = _setCall(42);
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digest = acct.executeDigest(c, 0, d);
        QEDOwnerAccount.Assertion[] memory as_ = two(signAs(alice, digest), signAs(bob, digest));
        bytes32[] memory approvers = new bytes32[](2);
        approvers[0] = as_[0].signerId;
        approvers[1] = as_[1].signerId;
        vm.expectEmit(address(acct));
        emit Executed(0, digest, approvers, 1);
        acct.execute(c, 0, d, as_);
        assertEq(target.value(), 42);
        assertEq(target.lastCaller(), address(acct));
        assertEq(acct.nonce(), 1);
    }

    function test_anyone_may_relay() public {
        QEDOwnerAccount.Call[] memory c = _setCall(7);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, carol);
        address relayer = makeAddr("any relayer");
        vm.prank(relayer);
        acct.execute(c, 0, d, as_);
        assertEq(target.value(), 7);
    }

    function test_one_approval_is_not_enough_under_threshold_two() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = one(signAs(alice, acct.executeDigest(c, 0, d)));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        acct.execute(c, 0, d, as_);
    }

    function test_duplicate_signer_is_not_counted_twice() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.executeDigest(c, 0, d));
        QEDOwnerAccount.Assertion[] memory as_ = new QEDOwnerAccount.Assertion[](2);
        as_[0] = a;
        as_[1] = a;
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.AssertionsNotStrictlyIncreasing.selector, 1));
        acct.execute(c, 0, d, as_);
    }

    function test_unsorted_assertions_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        (as_[0], as_[1]) = (as_[1], as_[0]);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.AssertionsNotStrictlyIncreasing.selector, 1));
        acct.execute(c, 0, d, as_);
    }

    function test_reused_nonce_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(5);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        acct.execute(c, 0, d, as_);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.BadNonce.selector, 0, 1));
        acct.execute(c, 0, d, as_);
    }

    function test_future_nonce_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(5);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 1, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.BadNonce.selector, 1, 0));
        acct.execute(c, 1, d, as_);
    }

    function test_expired_deadline_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(5);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.warp(d + 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.Expired.selector, d, d + 1));
        acct.execute(c, 0, d, as_);
    }

    function test_deadline_equal_to_now_accepted() public {
        QEDOwnerAccount.Call[] memory c = _setCall(5);
        uint64 d = uint64(block.timestamp);
        acct.execute(c, 0, d, _sign2(c, 0, d, alice, bob));
        assertEq(target.value(), 5);
    }

    function test_relayer_cannot_change_calls_or_deadline() public {
        QEDOwnerAccount.Call[] memory c = _setCall(42);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(_setCall(43), 0, d, as_);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(calls1(address(target), 1, abi.encodeCall(Target.set, (42))), 0, d, as_);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(c, 0, d + 1, as_);
    }

    function test_recovery_signer_cannot_approve_execute() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digest = acct.executeDigest(c, 0, d);
        // Even a perfectly formed WebAuthn assertion made with the Recovery key is refused.
        QEDOwnerAccount.Assertion[] memory as_ = two(signAs(alice, digest), signAs(rec, digest));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, rec.id));
        acct.execute(c, 0, d, as_);
    }

    function test_non_signer_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digest = acct.executeDigest(c, 0, d);
        QEDOwnerAccount.Assertion[] memory as_ = two(signAs(alice, digest), signAs(mallory, digest));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotAMember.selector, mallory.id));
        acct.execute(c, 0, d, as_);
    }

    function test_member_id_with_other_key_signature_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digest = acct.executeDigest(c, 0, d);
        QEDOwnerAccount.Assertion memory forged = signAs(mallory, digest);
        forged.signerId = bob.id; // claims to be bob
        QEDOwnerAccount.Assertion[] memory as_ = two(signAs(alice, digest), forged);
        uint256 idx = as_[0].signerId == bob.id ? 0 : 1;
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, idx));
        acct.execute(c, 0, d, as_);
        assertEq(acct.nonce(), 0);
    }

    function test_call_to_account_needs_admin_threshold() public {
        Key memory dave = newKey(0xDA7E);
        QEDOwnerAccount.Call[] memory c =
            selfCall(acct, abi.encodeCall(QEDOwnerAccount.addSigner, (dave.x, dave.y, QEDOwnerAccount.Role.Member)));
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 2, 3));
        acct.execute(c, 0, d, as_);
        exec(acct, c, keys3(alice, bob, carol));
        assertEq(acct.memberCount(), 4);
    }

    function test_mixed_batch_with_one_self_call_needs_admin_threshold() public {
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(address(target), 0, abi.encodeCall(Target.set, (9)));
        c[1] = QEDOwnerAccount.Call(address(acct), 0, abi.encodeCall(QEDOwnerAccount.setThresholds, (2, 3)));
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 2, 3));
        acct.execute(c, 0, d, as_);
    }

    function test_failing_call_reverts_whole_batch_and_keeps_nonce() public {
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(address(target), 0, abi.encodeCall(Target.set, (1)));
        c[1] = QEDOwnerAccount.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector, 1, abi.encodeWithSelector(Target.Nope.selector)
            )
        );
        acct.execute(c, 0, d, as_);
        assertEq(acct.nonce(), 0);
        assertEq(target.value(), 0);
    }

    function test_reentrancy_into_execute_blocked() public {
        Reenter r = new Reenter();
        QEDOwnerAccount.Call[] memory c = calls1(address(r), 0, abi.encodeCall(Reenter.poke, (acct)));
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
            )
        );
        acct.execute(c, 0, d, as_);
    }

    function test_reentrancy_into_admin_paths_blocked() public {
        // applyChange / cancel / startRecovery / finishRecovery are nonReentrant: a batch cannot reach them.
        QEDOwnerAccount.Call[] memory c = selfCall(acct, abi.encodeCall(QEDOwnerAccount.applyChange, (bytes32(0))));
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digest = acct.executeDigest(c, 0, d);
        QEDOwnerAccount.Assertion[] memory as_ = new QEDOwnerAccount.Assertion[](3);
        as_[0] = signAs(alice, digest);
        as_[1] = signAs(bob, digest);
        as_[2] = signAs(carol, digest);
        vm.expectRevert(
            abi.encodeWithSelector(
                QEDOwnerAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
            )
        );
        acct.execute(c, 0, d, sorted(as_));
    }

    function test_empty_batch_consumes_nonce() public {
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](0);
        uint64 d = uint64(block.timestamp + 600);
        acct.execute(c, 0, d, _sign2(c, 0, d, alice, bob));
        assertEq(acct.nonce(), 1);
    }

    function test_value_transfer_from_account() public {
        vm.deal(address(acct), 2 ether);
        QEDOwnerAccount.Call[] memory c = calls1(address(target), 1 ether, abi.encodeCall(Target.set, (3)));
        uint64 d = uint64(block.timestamp + 600);
        acct.execute(c, 0, d, _sign2(c, 0, d, alice, bob));
        assertEq(target.received(), 1 ether);
        assertEq(address(acct).balance, 1 ether);
    }

    function test_execute_approvals_for_another_account_rejected() public {
        QEDOwnerAccount other = deployAccount(keys3(alice, bob, carol), keys1(rec), 2, 3);
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        bytes32 digestOther = other.executeDigest(c, 0, d);
        assertTrue(digestOther != acct.executeDigest(c, 0, d));
        QEDOwnerAccount.Assertion[] memory as_ = two(signAs(alice, digestOther), signAs(bob, digestOther));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(c, 0, d, as_);
        other.execute(c, 0, d, as_); // valid where it was made for
    }

    function test_execute_approvals_from_another_chain_rejected() public {
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(c, 0, d, as_);
    }

    function test_execute_digest_matches_eip712_by_hand() public view {
        QEDOwnerAccount.Call[] memory c = new QEDOwnerAccount.Call[](2);
        c[0] = QEDOwnerAccount.Call(address(target), 3, hex"c0ffee");
        c[1] = QEDOwnerAccount.Call(address(0xBEEF), 0, "");
        bytes32 callType = keccak256("Call(address target,uint256 value,bytes data)");
        bytes32 h0 = keccak256(abi.encode(callType, c[0].target, c[0].value, keccak256(c[0].data)));
        bytes32 h1 = keccak256(abi.encode(callType, c[1].target, c[1].value, keccak256(c[1].data)));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Execute(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)"
                ),
                keccak256(abi.encodePacked(h0, h1)),
                uint256(9),
                uint64(1234)
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("QEDOwnerAccount"),
                keccak256("1"),
                block.chainid,
                address(acct)
            )
        );
        assertEq(acct.executeDigest(c, 9, 1234), keccak256(abi.encodePacked(hex"1901", domain, structHash)));
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    function testFuzz_any_nonce_but_current_rejected(uint256 n) public {
        vm.assume(n != 0);
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, n, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.BadNonce.selector, n, 0));
        acct.execute(c, n, d, as_);
    }

    function testFuzz_past_deadline_rejected(uint64 d) public {
        d = uint64(bound(d, 0, block.timestamp - 1));
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.Expired.selector, d, block.timestamp));
        acct.execute(c, 0, d, as_);
    }

    function testFuzz_other_chain_ids_rejected(uint64 chainId) public {
        vm.assume(chainId != block.chainid && chainId != 0);
        QEDOwnerAccount.Call[] memory c = _setCall(1);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(c, 0, d, as_);
    }

    function testFuzz_relayer_tampering_with_value_rejected(uint256 v, uint256 tampered) public {
        vm.assume(v != tampered);
        QEDOwnerAccount.Call[] memory c = _setCall(v);
        uint64 d = uint64(block.timestamp + 600);
        QEDOwnerAccount.Assertion[] memory as_ = _sign2(c, 0, d, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidAssertion.selector, 0));
        acct.execute(_setCall(tampered), 0, d, as_);
    }
}
