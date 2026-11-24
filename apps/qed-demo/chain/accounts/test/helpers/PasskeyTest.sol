// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@oz-5.6.1/utils/Base64.sol";
import {QEDOwnerAccount} from "../../src/QEDOwnerAccount.sol";

/// @notice Exposes the internal assertion check so the verifier can be fuzzed directly.
contract AccountHarness is QEDOwnerAccount {
    constructor(
        bytes32 rpIdHash_,
        string memory origin_,
        SignerInit[] memory signers_,
        uint256 threshold_,
        uint256 adminThreshold_,
        uint64 delay_,
        uint64 recoveryDelay_,
        Guard[] memory guards_,
        Guard[] memory protective_,
        address sentinel_,
        Guard[] memory lockable_,
        bool timeLocked_
    )
        QEDOwnerAccount(
            rpIdHash_,
            origin_,
            signers_,
            threshold_,
            adminThreshold_,
            delay_,
            recoveryDelay_,
            guards_,
            protective_,
            sentinel_,
            lockable_,
            timeLocked_
        )
    {}

    function verifyAssertion(bytes32 challenge, Assertion memory a, uint256 x, uint256 y)
        external
        view
        returns (bool)
    {
        return _verifyAssertion(challenge, a, x, y);
    }
}

/// @notice A target the account calls in tests.
contract Target {
    uint256 public value;
    address public lastCaller;
    uint256 public received;

    error Nope();

    function set(uint256 v) external payable {
        value = v;
        lastCaller = msg.sender;
        received += msg.value;
    }

    function fail() external pure {
        revert Nope();
    }
}

/// @notice Software passkey for Foundry tests: P-256 keys from forge's vm.signP256 / vm.publicKeyP256, WebAuthn
///         authenticatorData and clientDataJSON built the way a browser serialises them.
abstract contract PasskeyTest is Test {
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    /// sha256("localhost"), checked with node:crypto.
    bytes32 internal constant RP_ID_HASH = 0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763;
    string internal constant ORIGIN = "http://localhost:5175";
    uint64 internal constant DELAY = 1 days;
    uint64 internal constant RECOVERY_DELAY = 3 days;

    struct Key {
        uint256 pk;
        uint256 x;
        uint256 y;
        bytes32 id;
    }

    struct Opts {
        bytes32 rpIdHash;
        bytes1 flags;
        string typ;
        string origin;
        bool highS;
        uint32 counter;
        string tail;
    }

    function newKey(uint256 pk) internal pure returns (Key memory k) {
        (k.x, k.y) = vm.publicKeyP256(pk);
        k.pk = pk;
        k.id = keccak256(abi.encode(k.x, k.y));
    }

    function opts() internal pure returns (Opts memory o) {
        o.rpIdHash = RP_ID_HASH;
        o.flags = 0x05; // UP | UV
        o.typ = "webauthn.get";
        o.origin = ORIGIN;
        o.counter = 0;
        o.tail = ',"crossOrigin":false';
    }

    function clientData(bytes32 challenge, Opts memory o)
        internal
        pure
        returns (string memory json, uint256 typeIndex, uint256 challengeIndex, uint256 originIndex)
    {
        string memory typePart = string.concat('"type":"', o.typ, '"');
        string memory challengePart =
            string.concat('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        string memory originPart = string.concat('"origin":"', o.origin, '"');
        typeIndex = 1;
        challengeIndex = typeIndex + bytes(typePart).length + 1;
        originIndex = challengeIndex + bytes(challengePart).length + 1;
        json = string.concat("{", typePart, ",", challengePart, ",", originPart, o.tail, "}");
    }

    function signAs(Key memory k, bytes32 challenge, Opts memory o)
        internal
        pure
        returns (QEDOwnerAccount.Assertion memory a)
    {
        (string memory json, uint256 ti, uint256 ci, uint256 oi) = clientData(challenge, o);
        bytes memory ad = abi.encodePacked(o.rpIdHash, o.flags, o.counter);
        bytes32 h = sha256(abi.encodePacked(ad, sha256(bytes(json))));
        (bytes32 r, bytes32 s) = vm.signP256(k.pk, h);
        uint256 sv = uint256(s);
        if (sv > N / 2) sv = N - sv;
        if (o.highS) sv = N - sv;
        a = QEDOwnerAccount.Assertion({
            signerId: k.id,
            r: r,
            s: bytes32(sv),
            challengeIndex: ci,
            typeIndex: ti,
            originIndex: oi,
            authenticatorData: ad,
            clientDataJSON: json
        });
    }

    function signAs(Key memory k, bytes32 challenge) internal pure returns (QEDOwnerAccount.Assertion memory) {
        return signAs(k, challenge, opts());
    }

    /// Raw P-256 signature as a recovery-code key makes it: ECDSA/SHA-256 over the 32-byte digest, low-s.
    function recoverySign(Key memory k, bytes32 digest) internal pure returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(k.pk, sha256(abi.encodePacked(digest)));
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
    }

    function sorted(QEDOwnerAccount.Assertion[] memory a) internal pure returns (QEDOwnerAccount.Assertion[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            QEDOwnerAccount.Assertion memory cur = a[i];
            uint256 j = i;
            while (j > 0 && uint256(a[j - 1].signerId) > uint256(cur.signerId)) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = cur;
        }
        return a;
    }

    function one(QEDOwnerAccount.Assertion memory a) internal pure returns (QEDOwnerAccount.Assertion[] memory arr) {
        arr = new QEDOwnerAccount.Assertion[](1);
        arr[0] = a;
    }

    function two(QEDOwnerAccount.Assertion memory a, QEDOwnerAccount.Assertion memory b)
        internal
        pure
        returns (QEDOwnerAccount.Assertion[] memory arr)
    {
        arr = new QEDOwnerAccount.Assertion[](2);
        arr[0] = a;
        arr[1] = b;
        arr = sorted(arr);
    }

    function members(Key memory a) internal pure returns (QEDOwnerAccount.SignerInit[] memory s) {
        s = new QEDOwnerAccount.SignerInit[](1);
        s[0] = QEDOwnerAccount.SignerInit(a.x, a.y, QEDOwnerAccount.Role.Member);
    }

    function signersOf(Key[] memory ms, Key[] memory rs)
        internal
        pure
        returns (QEDOwnerAccount.SignerInit[] memory s)
    {
        s = new QEDOwnerAccount.SignerInit[](ms.length + rs.length);
        for (uint256 i; i < ms.length; ++i) {
            s[i] = QEDOwnerAccount.SignerInit(ms[i].x, ms[i].y, QEDOwnerAccount.Role.Member);
        }
        for (uint256 i; i < rs.length; ++i) {
            s[ms.length + i] = QEDOwnerAccount.SignerInit(rs[i].x, rs[i].y, QEDOwnerAccount.Role.Recovery);
        }
    }

    function deployAccount(Key[] memory ms, Key[] memory rs, uint256 t, uint256 adminT)
        internal
        returns (QEDOwnerAccount)
    {
        return new QEDOwnerAccount(
            RP_ID_HASH,
            ORIGIN,
            signersOf(ms, rs),
            t,
            adminT,
            DELAY,
            RECOVERY_DELAY,
            noGuards(),
            noGuards(),
            address(0),
            noGuards(),
            false
        );
    }

    function deployAccountGuarded(
        Key[] memory ms,
        Key[] memory rs,
        uint256 t,
        uint256 adminT,
        QEDOwnerAccount.Guard[] memory guards
    ) internal returns (QEDOwnerAccount) {
        return new QEDOwnerAccount(
            RP_ID_HASH, ORIGIN, signersOf(ms, rs), t, adminT, DELAY, RECOVERY_DELAY, guards, noGuards(), address(0), noGuards(), false
        );
    }

    /// An account with guarded calls, protective calls (one Member, frozen or not, may make them through `protect`)
    /// and a sentinel (the only address that may freeze a Member).
    function deployContained(
        Key[] memory ms,
        Key[] memory rs,
        uint256 t,
        uint256 adminT,
        QEDOwnerAccount.Guard[] memory guards,
        QEDOwnerAccount.Guard[] memory protective,
        address sentinel_
    ) internal returns (QEDOwnerAccount) {
        return new QEDOwnerAccount(
            RP_ID_HASH, ORIGIN, signersOf(ms, rs), t, adminT, DELAY, RECOVERY_DELAY, guards, protective, sentinel_, noGuards(), false
        );
    }

    /// An account with every R13 option: guarded, protective and lockable calls, a sentinel, and the time-lock's
    /// starting state.
    function deployFull(
        Key[] memory ms,
        Key[] memory rs,
        uint256 t,
        uint256 adminT,
        QEDOwnerAccount.Guard[] memory guards,
        QEDOwnerAccount.Guard[] memory protective,
        address sentinel_,
        QEDOwnerAccount.Guard[] memory lockable,
        bool timeLocked_
    ) internal returns (QEDOwnerAccount) {
        return new QEDOwnerAccount(
            RP_ID_HASH,
            ORIGIN,
            signersOf(ms, rs),
            t,
            adminT,
            DELAY,
            RECOVERY_DELAY,
            guards,
            protective,
            sentinel_,
            lockable,
            timeLocked_
        );
    }

    function noGuards() internal pure returns (QEDOwnerAccount.Guard[] memory g) {
        g = new QEDOwnerAccount.Guard[](0);
    }

    function calls1(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (QEDOwnerAccount.Call[] memory c)
    {
        c = new QEDOwnerAccount.Call[](1);
        c[0] = QEDOwnerAccount.Call(target, value, data);
    }

    function selfCall(QEDOwnerAccount acct, bytes memory data) internal pure returns (QEDOwnerAccount.Call[] memory) {
        return calls1(address(acct), 0, data);
    }

    struct Prepared {
        QEDOwnerAccount.Call[] calls;
        uint256 nonce;
        uint64 deadline;
        QEDOwnerAccount.Assertion[] assertions;
    }

    /// Signs `c` with the given Member keys at the account's current nonce. Makes view calls only, so that
    /// vm.expectRevert / vm.expectEmit / vm.prank can be placed right before `run`.
    function prepare(QEDOwnerAccount acct, QEDOwnerAccount.Call[] memory c, Key[] memory signers_)
        internal
        view
        returns (Prepared memory p)
    {
        p.calls = c;
        p.nonce = acct.nonce();
        p.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 digest = acct.executeDigest(c, p.nonce, p.deadline);
        p.assertions = new QEDOwnerAccount.Assertion[](signers_.length);
        for (uint256 i; i < signers_.length; ++i) {
            p.assertions[i] = signAs(signers_[i], digest);
        }
        p.assertions = sorted(p.assertions);
    }

    struct ProtectPrepared {
        QEDOwnerAccount.Call[] calls;
        uint256 nonce;
        uint64 deadline;
        QEDOwnerAccount.Assertion assertion;
    }

    /// The challenge `protect` checks, computed here from its EIP-712 definition (the account has no view of it since the
    /// R13 H1 size trims): Protect(Call[] calls,uint256 nonce,uint64 deadline) under the account's domain.
    function protectDigestOf(QEDOwnerAccount acct, QEDOwnerAccount.Call[] memory c, uint256 nonce_, uint64 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 typehash = keccak256(
            "Protect(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)"
        );
        bytes32[] memory h = new bytes32[](c.length);
        for (uint256 i; i < c.length; ++i) {
            h[i] = keccak256(
                abi.encode(keccak256("Call(address target,uint256 value,bytes data)"), c[i].target, c[i].value, keccak256(c[i].data))
            );
        }
        bytes32 structHash = keccak256(abi.encode(typehash, keccak256(abi.encodePacked(h)), nonce_, deadline));
        return keccak256(abi.encodePacked(hex"1901", acct.domainSeparator(), structHash));
    }

    /// Whether (target, selector) is on the account's protective list (read through `protectiveCalls`).
    function isProtectiveOf(QEDOwnerAccount acct, address target, bytes4 selector) internal view returns (bool) {
        QEDOwnerAccount.GuardKey[] memory l = acct.protectiveCalls();
        for (uint256 i; i < l.length; ++i) {
            if (l[i].target == target && l[i].selector == selector) return true;
        }
        return false;
    }

    /// Signs `c` for `protect` with one Member key at the account's current protect nonce (view calls only).
    function prepareProtect(QEDOwnerAccount acct, QEDOwnerAccount.Call[] memory c, Key memory k)
        internal
        view
        returns (ProtectPrepared memory p)
    {
        p.calls = c;
        p.nonce = acct.protectNonce();
        p.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        p.assertion = signAs(k, protectDigestOf(acct, c, p.nonce, p.deadline));
    }

    /// Exactly one external call: protect.
    function runProtect(QEDOwnerAccount acct, ProtectPrepared memory p) internal {
        acct.protect(p.calls, p.nonce, p.deadline, p.assertion);
    }

    /// Exactly one external call: execute.
    function run(QEDOwnerAccount acct, Prepared memory p) internal {
        acct.execute(p.calls, p.nonce, p.deadline, p.assertions);
    }

    /// Signs and executes `c` with the given Member keys at the account's current nonce.
    function exec(QEDOwnerAccount acct, QEDOwnerAccount.Call[] memory c, Key[] memory signers_) internal {
        run(acct, prepare(acct, c, signers_));
    }

    function keys1(Key memory a) internal pure returns (Key[] memory k) {
        k = new Key[](1);
        k[0] = a;
    }

    function keys2(Key memory a, Key memory b) internal pure returns (Key[] memory k) {
        k = new Key[](2);
        k[0] = a;
        k[1] = b;
    }

    function keys3(Key memory a, Key memory b, Key memory c) internal pure returns (Key[] memory k) {
        k = new Key[](3);
        k[0] = a;
        k[1] = b;
        k[2] = c;
    }

    function noKeys() internal pure returns (Key[] memory k) {
        k = new Key[](0);
    }

    function ids1(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }
}
