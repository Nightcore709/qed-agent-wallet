// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Constructor validation: relying party, origin, keys, thresholds, delays, bounds.
contract ConstructionTest is PasskeyTest {
    Key internal alice;
    Key internal bob;
    Key internal rec;

    event AccountConfigured(bytes32 rpIdHash, string origin);
    event SignerAdded(bytes32 indexed signerId, QEDOwnerAccount.Role role, uint256 x, uint256 y, uint64 serial);
    event ThresholdsChanged(uint256 threshold, uint256 adminThreshold);
    event DelaysChanged(uint64 delay, uint64 recoveryDelay);

    function setUp() public {
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        rec = newKey(0x5EC0);
    }

    function _deploy(string memory origin_, QEDOwnerAccount.SignerInit[] memory s, uint256 t, uint256 a)
        internal
        returns (QEDOwnerAccount)
    {
        return new QEDOwnerAccount(RP_ID_HASH, origin_, s, t, a, DELAY, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false);
    }

    function test_constructs_and_reports_its_configuration() public {
        vm.expectEmit();
        emit AccountConfigured(RP_ID_HASH, ORIGIN);
        vm.expectEmit();
        emit SignerAdded(alice.id, QEDOwnerAccount.Role.Member, alice.x, alice.y, 1);
        vm.expectEmit();
        emit SignerAdded(bob.id, QEDOwnerAccount.Role.Member, bob.x, bob.y, 2);
        vm.expectEmit();
        emit SignerAdded(rec.id, QEDOwnerAccount.Role.Recovery, rec.x, rec.y, 3);
        vm.expectEmit();
        emit DelaysChanged(DELAY, RECOVERY_DELAY);
        vm.expectEmit();
        emit ThresholdsChanged(1, 2);
        QEDOwnerAccount acct = deployAccount(keys2(alice, bob), keys1(rec), 1, 2);

        assertEq(acct.rpIdHash(), RP_ID_HASH);
        assertEq(acct.origin(), ORIGIN);
        assertEq(acct.threshold(), 1);
        assertEq(acct.adminThreshold(), 2);
        assertEq(acct.memberCount(), 2);
        assertEq(acct.delay(), DELAY);
        assertEq(acct.recoveryDelay(), RECOVERY_DELAY);
        assertEq(acct.nonce(), 0);
        assertEq(acct.signerIds().length, 3);
        QEDOwnerAccount.Signer memory s = acct.getSigner(rec.id);
        assertEq(s.x, rec.x);
        assertEq(s.y, rec.y);
        assertEq(uint8(s.role), uint8(QEDOwnerAccount.Role.Recovery));
        assertEq(acct.signerIdOf(alice.x, alice.y), alice.id);
    }

    function test_rejects_zero_rp_id_hash() public {
        QEDOwnerAccount.SignerInit[] memory s = members(alice);
        vm.expectRevert(QEDOwnerAccount.InvalidRpIdHash.selector);
        new QEDOwnerAccount(bytes32(0), ORIGIN, s, 1, 1, DELAY, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false);
    }

    function test_rejects_bad_origins() public {
        string[6] memory bad =
            ["", 'http://a"b', "http://a\\b", "http://a b", unicode"http://é.example", "http://a\x01b"];
        for (uint256 i; i < bad.length; ++i) {
            QEDOwnerAccount.SignerInit[] memory s = members(alice);
            vm.expectRevert(QEDOwnerAccount.InvalidOrigin.selector);
            _deploy(bad[i], s, 1, 1);
        }
    }

    function test_rejects_off_curve_and_duplicate_keys_and_role_none() public {
        QEDOwnerAccount.SignerInit[] memory s = new QEDOwnerAccount.SignerInit[](1);
        s[0] = QEDOwnerAccount.SignerInit(alice.x, alice.y ^ 1, QEDOwnerAccount.Role.Member);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidPublicKey.selector, alice.x, alice.y ^ 1));
        _deploy(ORIGIN, s, 1, 1);

        s = new QEDOwnerAccount.SignerInit[](2);
        s[0] = QEDOwnerAccount.SignerInit(alice.x, alice.y, QEDOwnerAccount.Role.Member);
        s[1] = QEDOwnerAccount.SignerInit(alice.x, alice.y, QEDOwnerAccount.Role.Recovery);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.SignerExists.selector, alice.id));
        _deploy(ORIGIN, s, 1, 1);

        s = new QEDOwnerAccount.SignerInit[](1);
        s[0] = QEDOwnerAccount.SignerInit(alice.x, alice.y, QEDOwnerAccount.Role.None);
        vm.expectRevert(QEDOwnerAccount.InvalidRole.selector);
        _deploy(ORIGIN, s, 1, 1);
    }

    function test_rejects_bad_thresholds() public {
        QEDOwnerAccount.SignerInit[] memory s = signersOf(keys2(alice, bob), keys1(rec));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 0, 1, 2));
        _deploy(ORIGIN, s, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 2, 1, 2));
        _deploy(ORIGIN, s, 2, 1); // adminThreshold below threshold
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 1, 3, 2));
        _deploy(ORIGIN, s, 1, 3); // more than the Members (the Recovery key does not count)
        QEDOwnerAccount.SignerInit[] memory onlyRecovery = signersOf(noKeys(), keys1(rec));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, 1, 1, 0));
        _deploy(ORIGIN, onlyRecovery, 1, 1);
    }

    function test_rejects_bad_delays() public {
        QEDOwnerAccount.SignerInit[] memory s = members(alice);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidDelay.selector, 59));
        new QEDOwnerAccount(RP_ID_HASH, ORIGIN, s, 1, 1, 59, RECOVERY_DELAY, noGuards(), noGuards(), address(0), noGuards(), false);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidDelay.selector, 30 days + 1));
        new QEDOwnerAccount(RP_ID_HASH, ORIGIN, s, 1, 1, DELAY, 30 days + 1, noGuards(), noGuards(), address(0), noGuards(), false);
    }

    function test_rejects_more_than_sixteen_signers() public {
        Key[] memory ms = new Key[](17);
        for (uint256 i; i < 17; ++i) ms[i] = newKey(0x3000 + i);
        QEDOwnerAccount.SignerInit[] memory s = signersOf(ms, noKeys());
        vm.expectRevert(QEDOwnerAccount.TooManySigners.selector);
        _deploy(ORIGIN, s, 1, 1);
    }

    function testFuzz_threshold_rule_at_construction(uint8 nMembers, uint8 t, uint8 a) public {
        nMembers = uint8(bound(nMembers, 0, 16));
        t = uint8(bound(t, 0, 17));
        a = uint8(bound(a, 0, 17));
        Key[] memory ms = new Key[](nMembers);
        for (uint256 i; i < nMembers; ++i) ms[i] = newKey(0x4000 + i);
        QEDOwnerAccount.SignerInit[] memory s = signersOf(ms, noKeys());
        bool valid = t >= 1 && t <= a && a <= nMembers;
        if (!valid) {
            vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.InvalidThresholds.selector, t, a, nMembers));
        }
        _deploy(ORIGIN, s, t, a);
    }
}
