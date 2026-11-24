// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest, AccountHarness} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// WebAuthn assertion checks: every rule of the brief (item 2) plus the origin binding, one test per rejection.
contract VerifierTest is PasskeyTest {
    AccountHarness internal h;
    Key internal alice;
    Key internal bob;
    bytes32 internal constant CH = keccak256("challenge");

    function setUp() public {
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        h = new AccountHarness(RP_ID_HASH, ORIGIN, members(alice), 1, 1, DELAY, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false);
    }

    function _ok(QEDOwnerAccount.Assertion memory a) internal view returns (bool) {
        return h.verifyAssertion(CH, a, alice.x, alice.y);
    }

    function test_valid_assertion_verifies() public view {
        assertTrue(_ok(signAs(alice, CH)));
    }

    function test_rejects_wrong_rpIdHash() public view {
        Opts memory o = opts();
        o.rpIdHash = sha256("evil.example");
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_missing_UV_flag() public view {
        Opts memory o = opts();
        o.flags = 0x01; // UP only
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_missing_UP_flag() public view {
        Opts memory o = opts();
        o.flags = 0x04; // UV only
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_backup_state_without_eligibility() public view {
        Opts memory o = opts();
        o.flags = 0x15; // UP | UV | BS without BE
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_accepts_synced_passkey_flags() public view {
        Opts memory o = opts();
        o.flags = 0x1d; // UP | UV | BE | BS (iCloud / Google synced passkeys)
        assertTrue(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_wrong_type() public view {
        Opts memory o = opts();
        o.typ = "webauthn.create";
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_wrong_challenge() public view {
        assertFalse(_ok(signAs(alice, keccak256("another challenge"))));
    }

    function test_rejects_wrong_origin() public view {
        Opts memory o = opts();
        o.origin = "http://localhost:8080"; // another local web server: same rpId "localhost", different origin
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_origin_prefix_extension() public view {
        Opts memory o = opts();
        o.origin = "http://localhost:51750";
        assertFalse(_ok(signAs(alice, CH, o)));
    }

    function test_rejects_origin_index_moved() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        a.originIndex += 1;
        assertFalse(_ok(a));
    }

    function test_rejects_high_s_but_accepts_low_s() public view {
        Opts memory o = opts();
        QEDOwnerAccount.Assertion memory low = signAs(alice, CH, o);
        o.highS = true;
        QEDOwnerAccount.Assertion memory high = signAs(alice, CH, o);
        assertEq(uint256(high.s), N - uint256(low.s));
        assertTrue(_ok(low));
        assertFalse(_ok(high));
    }

    function test_rejects_zero_r_and_zero_s() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        a.r = bytes32(0);
        assertFalse(_ok(a));
        a = signAs(alice, CH);
        a.s = bytes32(0);
        assertFalse(_ok(a));
    }

    function test_rejects_tampered_authenticator_data() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        a.authenticatorData[36] = bytes1(uint8(a.authenticatorData[36]) ^ 1); // signCount
        assertFalse(_ok(a));
    }

    function test_rejects_tampered_client_data() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        bytes memory j = bytes(a.clientDataJSON);
        j[j.length - 2] = "x"; // "crossOrigin":falsx
        a.clientDataJSON = string(j);
        assertFalse(_ok(a));
    }

    function test_rejects_signature_by_another_key() public view {
        QEDOwnerAccount.Assertion memory a = signAs(bob, CH);
        assertFalse(_ok(a)); // verified against alice's key
    }

    function test_rejects_short_authenticator_data() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        bytes memory ad = new bytes(36);
        for (uint256 i; i < 36; ++i) ad[i] = a.authenticatorData[i];
        a.authenticatorData = ad;
        assertFalse(_ok(a));
    }

    function test_out_of_range_indices_return_false_without_reverting() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        a.typeIndex = type(uint256).max;
        assertFalse(_ok(a));
        a = signAs(alice, CH);
        a.challengeIndex = type(uint256).max;
        assertFalse(_ok(a));
        a = signAs(alice, CH);
        a.originIndex = type(uint256).max;
        assertFalse(_ok(a));
    }

    function test_rejects_off_curve_key() public view {
        assertFalse(h.verifyAssertion(CH, signAs(alice, CH), alice.x, alice.y ^ 1));
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    function testFuzz_valid_assertions_verify(uint256 pk, bytes32 challenge) public view {
        pk = bound(pk, 1, N - 1);
        Key memory k = newKey(pk);
        assertTrue(h.verifyAssertion(challenge, signAs(k, challenge), k.x, k.y));
    }

    function testFuzz_high_s_always_rejected(uint256 pk, bytes32 challenge) public view {
        pk = bound(pk, 1, N - 1);
        Key memory k = newKey(pk);
        Opts memory o = opts();
        o.highS = true;
        assertFalse(h.verifyAssertion(challenge, signAs(k, challenge, o), k.x, k.y));
    }

    function testFuzz_any_bit_flip_in_authenticator_data_rejected(uint256 index, uint8 bit) public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        index = bound(index, 0, a.authenticatorData.length - 1);
        a.authenticatorData[index] = bytes1(uint8(a.authenticatorData[index]) ^ uint8(1 << (bit % 8)));
        assertFalse(_ok(a));
    }

    function testFuzz_any_bit_flip_in_client_data_rejected(uint256 index, uint8 bit) public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        bytes memory j = bytes(a.clientDataJSON);
        index = bound(index, 0, j.length - 1);
        j[index] = bytes1(uint8(j[index]) ^ uint8(1 << (bit % 8)));
        a.clientDataJSON = string(j);
        assertFalse(_ok(a));
    }

    function testFuzz_signature_for_other_challenge_rejected(bytes32 signed, bytes32 checked) public view {
        vm.assume(signed != checked);
        assertFalse(h.verifyAssertion(checked, signAs(alice, signed), alice.x, alice.y));
    }

    function testFuzz_only_exact_indices_accepted(uint256 ti, uint256 ci, uint256 oi) public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, CH);
        bool exact = ti == a.typeIndex && ci == a.challengeIndex && oi == a.originIndex;
        a.typeIndex = ti;
        a.challengeIndex = ci;
        a.originIndex = oi;
        assertEq(_ok(a), exact);
    }

    function testFuzz_flags(uint8 flags) public view {
        Opts memory o = opts();
        o.flags = bytes1(flags);
        bool up = flags & 0x01 != 0;
        bool uv = flags & 0x04 != 0;
        bool be = flags & 0x08 != 0;
        bool bs = flags & 0x10 != 0;
        assertEq(_ok(signAs(alice, CH, o)), up && uv && (be || !bs));
    }
}
