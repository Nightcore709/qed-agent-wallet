// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Measurements for the README (logged; the asserts only keep them honest).
contract GasTest is PasskeyTest {
    function test_gas_precompile_and_erc1271() public {
        Key memory a = newKey(0xA11CE);
        Key memory b = newKey(0xB0B);
        bytes32 h = sha256("m");
        (bytes32 r, bytes32 s) = vm.signP256(a.pk, h);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(h, r, s, a.x, a.y));
        uint256 g1 = gasleft();
        assertTrue(ok && ret.length == 32);
        emit log_named_uint("P-256 precompile call, valid signature (incl. call overhead)", g0 - g1);

        QEDOwnerAccount acct1 = deployAccount(keys1(a), noKeys(), 1, 1);
        QEDOwnerAccount acct2 = deployAccount(keys2(a, b), noKeys(), 2, 2);
        bytes32 hash = keccak256("mandate digest");
        bytes memory sig1 = abi.encode(one(signAs(a, acct1.replaySafeHash(hash))));
        bytes32 c2 = acct2.replaySafeHash(hash);
        bytes memory sig2 = abi.encode(two(signAs(a, c2), signAs(b, c2)));
        g0 = gasleft();
        assertEq(acct1.isValidSignature(hash, sig1), bytes4(0x1626ba7e));
        g1 = gasleft();
        emit log_named_uint("isValidSignature, 1 assertion (cold account storage)", g0 - g1);
        g0 = gasleft();
        assertEq(acct2.isValidSignature(hash, sig2), bytes4(0x1626ba7e));
        g1 = gasleft();
        emit log_named_uint("isValidSignature, 2 assertions (cold account storage)", g0 - g1);
    }
}
