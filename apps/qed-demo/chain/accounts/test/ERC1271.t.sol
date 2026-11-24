// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// ERC-1271: threshold, replay-safe hash, cross-account and cross-chain replay, Recovery keys, malformed input.
contract ERC1271Test is PasskeyTest {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal bob;
    Key internal carol;
    Key internal rec;
    bytes32 internal constant H = keccak256("a mandate digest");

    function setUp() public {
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        carol = newKey(0xCA401);
        rec = newKey(0x5EC0);
        acct = deployAccount(keys3(alice, bob, carol), keys1(rec), 2, 3);
    }

    function _sig(QEDOwnerAccount a, bytes32 hash, Key memory k1, Key memory k2) internal view returns (bytes memory) {
        bytes32 c = a.replaySafeHash(hash);
        return abi.encode(two(signAs(k1, c), signAs(k2, c)));
    }

    function test_threshold_members_make_a_valid_signature() public view {
        assertEq(acct.isValidSignature(H, _sig(acct, H, alice, bob)), MAGIC);
        assertEq(acct.isValidSignature(H, _sig(acct, H, bob, carol)), MAGIC);
    }

    function test_below_threshold_is_invalid_and_check_names_the_reason() public {
        bytes memory sig = abi.encode(one(signAs(alice, acct.replaySafeHash(H))));
        assertEq(acct.isValidSignature(H, sig), INVALID);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        acct.checkSignature(H, sig);
    }

    function test_signature_over_raw_hash_is_invalid() public view {
        // Members must sign replaySafeHash(H), never H itself.
        bytes memory sig = abi.encode(two(signAs(alice, H), signAs(bob, H)));
        assertEq(acct.isValidSignature(H, sig), INVALID);
    }

    function test_signature_for_other_hash_is_invalid() public view {
        assertEq(acct.isValidSignature(keccak256("other"), _sig(acct, H, alice, bob)), INVALID);
    }

    function test_cross_account_replay_refused() public {
        // Same three passkeys, second account: a signature made for it must not verify on `acct`.
        QEDOwnerAccount other = deployAccount(keys3(alice, bob, carol), keys1(rec), 2, 3);
        bytes memory sigForOther = _sig(other, H, alice, bob);
        assertEq(other.isValidSignature(H, sigForOther), MAGIC);
        assertEq(acct.isValidSignature(H, sigForOther), INVALID);
        assertTrue(other.replaySafeHash(H) != acct.replaySafeHash(H));
    }

    function test_cross_chain_replay_refused() public {
        bytes memory sig = _sig(acct, H, alice, bob);
        bytes32 before = acct.replaySafeHash(H);
        vm.chainId(10);
        assertTrue(acct.replaySafeHash(H) != before);
        assertEq(acct.isValidSignature(H, sig), INVALID);
        vm.chainId(31337);
        assertEq(acct.isValidSignature(H, sig), MAGIC);
    }

    function test_recovery_key_cannot_sign_messages() public view {
        bytes32 c = acct.replaySafeHash(H);
        assertEq(acct.isValidSignature(H, abi.encode(two(signAs(alice, c), signAs(rec, c)))), INVALID);
    }

    function test_duplicate_member_does_not_reach_threshold() public view {
        QEDOwnerAccount.Assertion memory a = signAs(alice, acct.replaySafeHash(H));
        QEDOwnerAccount.Assertion[] memory as_ = new QEDOwnerAccount.Assertion[](2);
        as_[0] = a;
        as_[1] = a;
        assertEq(acct.isValidSignature(H, abi.encode(as_)), INVALID);
    }

    function test_malformed_signatures_return_invalid_without_reverting() public view {
        assertEq(acct.isValidSignature(H, ""), INVALID);
        assertEq(acct.isValidSignature(H, hex"00"), INVALID);
        assertEq(acct.isValidSignature(H, new bytes(65)), INVALID);
        assertEq(acct.isValidSignature(H, abi.encode(uint256(32), uint256(type(uint64).max))), INVALID);
        assertEq(acct.isValidSignature(H, abi.encode(new QEDOwnerAccount.Assertion[](0))), INVALID);
    }

    function test_replay_safe_hash_matches_eip712_by_hand() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("QEDOwnerAccount"),
                keccak256("1"),
                block.chainid,
                address(acct)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("QEDOwnerMessage(bytes32 hash)"), H));
        assertEq(acct.replaySafeHash(H), keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        // the domain (name "QEDOwnerAccount", version "1", this chain, this account) through domainSeparator(), computed
        // above from those four; the ERC-5267 view eip712Domain() was removed in the R13 H1 size trims (no reader in QED)
        assertEq(acct.domainSeparator(), domain);
    }

    function test_threshold_change_applies_to_old_signatures() public {
        // A 2-of-3 signature stops verifying once the threshold is 3: validity is evaluated against current state.
        bytes memory sig = _sig(acct, H, alice, bob);
        assertEq(acct.isValidSignature(H, sig), MAGIC);
        exec(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.setThresholds, (3, 3))), keys3(alice, bob, carol));
        assertEq(acct.isValidSignature(H, sig), INVALID);
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    function testFuzz_other_chain_ids_invalid(uint64 chainId) public {
        vm.assume(chainId != 31337 && chainId != 0);
        bytes memory sig = _sig(acct, H, alice, bob);
        vm.chainId(chainId);
        assertEq(acct.isValidSignature(H, sig), INVALID);
    }

    function testFuzz_random_bytes_never_valid_never_revert(bytes calldata junk) public view {
        assertEq(acct.isValidSignature(H, junk), INVALID);
    }

    function testFuzz_valid_for_any_hash(bytes32 hash) public view {
        assertEq(acct.isValidSignature(hash, _sig(acct, hash, alice, carol)), MAGIC);
    }
}
