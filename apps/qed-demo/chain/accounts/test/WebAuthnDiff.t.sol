// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {WebAuthn} from "@oz-5.6.1/utils/cryptography/WebAuthn.sol";
import {PasskeyTest, AccountHarness} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// R13 differential test. Until R13 the account's assertion check was: authenticatorData of at least 37 bytes whose
/// first 32 are the relying-party hash, the origin member at `originIndex`, `P256.verifyNative`, then OpenZeppelin
/// 5.6.1 `WebAuthn.verify` (UV required). R13 reproduces WebAuthn.verify's checks inside the account and drops the
/// call (EIP-170). This test computes the old decision with OpenZeppelin's own, unmodified `WebAuthn.verify` and
/// requires the account to decide identically on fuzzed assertions: flags, the three indices, the type member, the
/// challenge signed, the key, high and random s, the relying party, the origin, extra JSON members and trailing
/// authenticatorData bytes.
contract WebAuthnDiffTest is PasskeyTest {
    AccountHarness internal h;
    Key internal alice;
    Key internal bob;

    function setUp() public {
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        h = new AccountHarness(
            RP_ID_HASH, ORIGIN, members(alice), 1, 1, DELAY, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false
        );
    }

    /// The pre-R13 decision, with OpenZeppelin's WebAuthn.verify itself.
    function _reference(bytes32 challenge, QEDOwnerAccount.Assertion memory a, uint256 x, uint256 y)
        internal
        view
        returns (bool)
    {
        bytes memory ad = a.authenticatorData;
        if (ad.length < 37) return false;
        bytes32 rp;
        assembly ("memory-safe") {
            rp := mload(add(ad, 0x20))
        }
        if (rp != RP_ID_HASH) return false;
        bytes memory field = abi.encodePacked('"origin":"', ORIGIN, '"');
        bytes memory json = bytes(a.clientDataJSON);
        if (a.originIndex > json.length || json.length - a.originIndex < field.length) return false;
        for (uint256 i; i < field.length; ++i) if (json[a.originIndex + i] != field[i]) return false;
        return WebAuthn.verify(
            abi.encodePacked(challenge),
            WebAuthn.WebAuthnAuth({
                r: a.r,
                s: a.s,
                challengeIndex: a.challengeIndex,
                typeIndex: a.typeIndex,
                authenticatorData: ad,
                clientDataJSON: a.clientDataJSON
            }),
            bytes32(x),
            bytes32(y),
            true
        );
    }

    function _shift(uint256 i, int256 d) internal pure returns (uint256) {
        return d < 0 ? (i >= uint256(-d) ? i - uint256(-d) : 0) : i + uint256(d);
    }

    struct Case {
        uint8 flagsMode; //  0-3: UP|UV (valid); otherwise a random flags byte
        uint8 flags;
        int8 dType;
        int8 dChallenge;
        int8 dOrigin;
        uint8 typ; //        0-3: "webauthn.get"; 4: "webauthn.create"; 5: "webauthn.gex"; 6: "WEBAUTHN.GET"; 7: ""
        bool otherChallenge;
        bool otherKey;
        bool highS;
        bool randomS;
        bool badRp;
        bool badOrigin;
        bool shortAuthData;
        uint8 tail; //       0: none; 1: crossOrigin false; 2: an extra member; 3: a topOrigin
        bytes4 adTail;
    }

    function testFuzz_the_account_decides_as_openzeppelin_webauthn_verify(bytes32 challenge, Case memory c, uint256 rs)
        public
        view
    {
        Opts memory o = opts();
        o.flags = c.flagsMode < 4 ? bytes1(0x05) : bytes1(c.flags);
        string[8] memory types =
            ["webauthn.get", "webauthn.get", "webauthn.get", "webauthn.get", "webauthn.create", "webauthn.gex", "WEBAUTHN.GET", ""];
        o.typ = types[c.typ % 8];
        if (c.badRp) o.rpIdHash = sha256("evil.example");
        if (c.badOrigin) o.origin = "http://localhost:5176";
        string[4] memory tails = ["", ',"crossOrigin":false', ',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template"', ',"topOrigin":"http://evil.example"'];
        o.tail = tails[c.tail % 4];
        o.highS = c.highS;
        QEDOwnerAccount.Assertion memory a =
            signAs(c.otherKey ? bob : alice, c.otherChallenge ? keccak256(abi.encode(challenge)) : challenge, o);
        if (c.randomS) a.s = bytes32(rs);
        if (c.adTail != bytes4(0)) a.authenticatorData = abi.encodePacked(a.authenticatorData, c.adTail);
        if (c.shortAuthData) a.authenticatorData = abi.encodePacked(bytes32(RP_ID_HASH), bytes4(0x05000000));
        a.typeIndex = _shift(a.typeIndex, int256(c.dType % 3));
        a.challengeIndex = _shift(a.challengeIndex, int256(c.dChallenge % 3));
        a.originIndex = _shift(a.originIndex, int256(c.dOrigin % 3));

        assertEq(
            h.verifyAssertion(challenge, a, alice.x, alice.y),
            _reference(challenge, a, alice.x, alice.y),
            "the account and WebAuthn.verify disagree"
        );
    }

    /// Not vacuous: valid assertions over random challenges are accepted by both.
    function testFuzz_valid_assertions_are_accepted_by_both(bytes32 challenge, bool crossOrigin) public view {
        Opts memory o = opts();
        o.tail = crossOrigin ? ',"crossOrigin":false' : "";
        QEDOwnerAccount.Assertion memory a = signAs(alice, challenge, o);
        assertTrue(h.verifyAssertion(challenge, a, alice.x, alice.y));
        assertTrue(_reference(challenge, a, alice.x, alice.y));
    }

    /// Flags, exhaustively: all 256 values of the flags byte, both decisions equal; exactly the values with UP and UV set
    /// and not BS-without-BE are accepted.
    function test_every_flags_byte_is_decided_alike() public view {
        bytes32 challenge = keccak256("flags");
        uint256 ok;
        for (uint256 f; f < 256; ++f) {
            Opts memory o = opts();
            o.flags = bytes1(uint8(f));
            QEDOwnerAccount.Assertion memory a = signAs(alice, challenge, o);
            bool ours = h.verifyAssertion(challenge, a, alice.x, alice.y);
            assertEq(ours, _reference(challenge, a, alice.x, alice.y));
            bool want = (f & 0x05) == 0x05 && (f & 0x18) != 0x10;
            assertEq(ours, want);
            if (ours) ++ok;
        }
        assertEq(ok, 48, "UP and UV fixed: 64 values, minus the 16 with BS set and BE clear");
    }
}
