// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {PasskeyTest} from "./helpers/PasskeyTest.sol";
import {ITestUSD, IQEDVault, IQEDExecution, IQEDTreasuryPolicy, ReleaseGuards} from "./helpers/Release.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// The release's vault set (QEDVault, QEDExecution, QEDTreasuryPolicy, TestUSD; unmodified, solc 0.8.26) deployed
/// with an EOA owner, then owned by a passkey account with the recommended guard list.
abstract contract ReleaseSetup is PasskeyTest {
    ITestUSD internal token;
    ITestUSD internal token2;
    IQEDVault internal vault;
    IQEDVault internal reserve;
    IQEDExecution internal execution;
    IQEDTreasuryPolicy internal policy;

    uint256 internal constant EOA_OWNER_PK = 0x0E0A;
    uint256 internal constant COSIGNER_PK = 0xC051;
    address internal eoaOwner;
    address internal cosigner;
    address internal agent;
    address internal guardian;
    address internal payee;
    address internal operator;
    address internal policyAgent;

    bytes4 internal constant NOT_OWNER = bytes4(keccak256("NotOwner(address)"));
    bytes4 internal constant NOT_OWNER_OR_GUARDIAN = bytes4(keccak256("NotOwnerOrGuardian(address)"));
    bytes4 internal constant NOT_PENDING_OWNER = bytes4(keccak256("NotPendingOwner(address)"));
    bytes4 internal constant BAD_OWNER_SIGNATURE = bytes4(keccak256("BadOwnerSignature()"));
    bytes32 internal constant SCHEDULED_SIG = keccak256("ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])");

    function _deployRelease() internal {
        vm.warp(1_800_000_000);
        eoaOwner = vm.addr(EOA_OWNER_PK);
        cosigner = vm.addr(COSIGNER_PK);
        agent = makeAddr("agent");
        guardian = makeAddr("guardian");
        payee = makeAddr("payee");
        operator = makeAddr("operator");
        policyAgent = makeAddr("policy agent");

        token = ITestUSD(deployCode("TestUSD.sol:TestUSD"));
        token2 = ITestUSD(deployCode("TestUSD.sol:TestUSD"));
        vault = IQEDVault(
            deployCode("QEDVault.sol:QEDVault", abi.encode(address(token), eoaOwner, agent, cosigner, guardian, 1_000e6))
        );
        reserve = IQEDVault(
            deployCode("QEDVault.sol:QEDVault", abi.encode(address(token2), eoaOwner, agent, cosigner, guardian, 1_000e6))
        );
        execution = IQEDExecution(deployCode("QEDExecution.sol:QEDExecution", abi.encode(address(vault), operator)));
        policy = IQEDTreasuryPolicy(
            deployCode(
                "QEDTreasuryPolicy.sol:QEDTreasuryPolicy", abi.encode(address(execution), address(reserve), policyAgent)
            )
        );
        token.mint(address(this), 10_000e6);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(5_000e6);
    }

    function _guards() internal view returns (QEDOwnerAccount.Guard[] memory) {
        return ReleaseGuards.list(address(vault), address(execution), address(policy));
    }

    /// The EOA starts the two-step transfer; the account accepts through execute with a passkey assertion.
    function _handOver(QEDOwnerAccount acct, Key[] memory approvers) internal {
        vm.prank(eoaOwner);
        vault.transferOwnership(address(acct));
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.acceptOwnership, ())), approvers);
        assertEq(vault.owner(), address(acct));
    }

    function _scheduleId(QEDOwnerAccount acct, Prepared memory p) internal returns (bytes32 id) {
        vm.recordLogs();
        run(acct, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SCHEDULED_SIG) id = logs[i].topics[1];
        }
        require(id != bytes32(0), "no ChangeScheduled");
    }

    function _policy() internal view returns (IQEDTreasuryPolicy.Policy memory) {
        return IQEDTreasuryPolicy.Policy({
            targetFree: 100e6,
            minTranche: 1e6,
            maxTranche: 50e6,
            maxImpactBps: 100,
            needSlackBps: 100,
            validUntil: uint64(block.timestamp + 30 days)
        });
    }

    /// One plausible call per guarded entry, in ReleaseGuards order.
    function _guardedCalls(address to) internal view returns (QEDOwnerAccount.Call[] memory c) {
        c = new QEDOwnerAccount.Call[](8);
        c[0] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.transferOwnership, (to)));
        c[1] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.setAgent, (to)));
        c[2] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.setCosigner, (to)));
        c[3] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.setDailyCap, (type(uint256).max)));
        c[4] = QEDOwnerAccount.Call(
            address(execution), 0, abi.encodeCall(IQEDExecution.setVenues, (new address[](0), new uint16[](0)))
        );
        c[5] = QEDOwnerAccount.Call(address(execution), 0, abi.encodeCall(IQEDExecution.setOperator, (to)));
        c[6] = QEDOwnerAccount.Call(address(policy), 0, abi.encodeCall(IQEDTreasuryPolicy.setPolicy, (_policy())));
        c[7] = QEDOwnerAccount.Call(address(policy), 0, abi.encodeCall(IQEDTreasuryPolicy.setAgent, (to)));
    }

    function _mandate() internal view returns (IQEDVault.Mandate memory m) {
        address[] memory payees = new address[](1);
        payees[0] = payee;
        m = IQEDVault.Mandate({
            vault: address(vault),
            agent: agent,
            payees: payees,
            maxPerPayment: 100e6,
            maxPerPeriod: 500e6,
            period: 1 days,
            maxTotal: 1_000e6,
            validFrom: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + 7 days),
            epoch: 0,
            requireCosign: true,
            purpose: keccak256("pay the approved payee for test services"),
            salt: keccak256("salt-1")
        });
    }

    function _mandateHash(IQEDVault.Mandate memory m) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                vault.MANDATE_TYPEHASH(),
                m.vault,
                m.agent,
                keccak256(abi.encodePacked(m.payees)),
                m.maxPerPayment,
                m.maxPerPeriod,
                m.period,
                m.maxTotal,
                m.validFrom,
                m.validUntil,
                m.epoch,
                m.requireCosign,
                m.purpose,
                m.salt
            )
        );
    }

    function _certificate(bytes32 mHash, uint256 amount) internal view returns (IQEDVault.Certificate memory) {
        return IQEDVault.Certificate({
            mandateHash: mHash,
            recipient: payee,
            amount: amount,
            dueAt: 0,
            intentId: keccak256(abi.encode("intent", amount, block.timestamp)),
            evidenceHash: keccak256("decision record"),
            ref: keccak256("invoice 1"),
            notBefore: uint64(block.timestamp - 1),
            expiresAt: uint64(block.timestamp + 1 hours),
            epoch: 0
        });
    }

    function _cosign(IQEDVault.Certificate memory c) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                vault.CERTIFICATE_TYPEHASH(),
                c.mandateHash,
                c.recipient,
                c.amount,
                c.dueAt,
                c.intentId,
                c.evidenceHash,
                c.ref,
                c.notBefore,
                c.expiresAt,
                c.epoch
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(COSIGNER_PK, _vaultDigest(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _vaultDigest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", vault.domainSeparator(), structHash));
    }
}

/// Personal workspace: one Member, threshold 1 = adminThreshold 1. (a), (b), (c) of the brief, plus the guard list.
contract VaultIntegrationTest is ReleaseSetup {
    QEDOwnerAccount internal acct;
    Key internal alice;
    Key internal rec;

    function setUp() public {
        _deployRelease();
        alice = newKey(0xA11CE);
        rec = newKey(0x5EC0);
        acct = deployAccountGuarded(keys1(alice), keys1(rec), 1, 1, _guards());
        _handOver(acct, keys1(alice));
        assertEq(vault.pendingOwner(), address(0));
    }

    // ── (a) the old EOA has no owner power left ───────────────────────────────────

    function test_a_old_eoa_can_no_longer_call_any_owner_function() public {
        bytes[10] memory ownerCalls = [
            abi.encodeCall(IQEDVault.ringFence, (payee, 1e6, uint64(block.timestamp + 1 days), bytes32(0))),
            abi.encodeCall(IQEDVault.withdraw, (eoaOwner, 1e6)),
            abi.encodeCall(IQEDVault.unpause, ()),
            abi.encodeCall(IQEDVault.bumpEpoch, ()),
            abi.encodeCall(IQEDVault.revokeMandate, (bytes32(uint256(1)))),
            abi.encodeCall(IQEDVault.setAgent, (eoaOwner)),
            abi.encodeCall(IQEDVault.setCosigner, (eoaOwner)),
            abi.encodeCall(IQEDVault.setGuardian, (eoaOwner)),
            abi.encodeCall(IQEDVault.setDailyCap, (type(uint256).max)),
            abi.encodeCall(IQEDVault.transferOwnership, (eoaOwner))
        ];
        for (uint256 i; i < ownerCalls.length; ++i) {
            vm.prank(eoaOwner);
            (bool ok, bytes memory ret) = address(vault).call(ownerCalls[i]);
            assertFalse(ok, "owner call must fail for the old EOA");
            assertEq(ret, abi.encodeWithSelector(NOT_OWNER, eoaOwner));
        }
        vm.prank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(NOT_OWNER_OR_GUARDIAN, eoaOwner));
        vault.pause();
        vm.prank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(NOT_PENDING_OWNER, eoaOwner));
        vault.acceptOwnership();
        // the execution and policy contracts follow vault.owner(): the EOA lost them too
        vm.prank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NotVaultOwner(address)")), eoaOwner));
        execution.setOperator(eoaOwner);
        vm.prank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(NOT_OWNER, eoaOwner));
        policy.setAgent(eoaOwner);
    }

    function test_a_unguarded_owner_calls_stay_immediate() public {
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 7e6))), keys1(alice));
        assertEq(token.balanceOf(payee), 7e6);
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.pause, ())), keys1(alice));
        assertTrue(vault.paused());
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.bumpEpoch, ())), keys1(alice));
        assertEq(vault.epoch(), 1);
        exec(acct, calls1(address(policy), 0, abi.encodeCall(IQEDTreasuryPolicy.revoke, ())), keys1(alice));
    }

    function test_a_nobody_but_the_account_could_accept() public {
        IQEDVault v2 = IQEDVault(
            deployCode("QEDVault.sol:QEDVault", abi.encode(address(token), eoaOwner, agent, cosigner, guardian, 1e6))
        );
        vm.prank(eoaOwner);
        v2.transferOwnership(address(acct));
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(NOT_PENDING_OWNER, relayer));
        v2.acceptOwnership();
        QEDOwnerAccount.Call[] memory c = calls1(address(v2), 0, abi.encodeCall(IQEDVault.acceptOwnership, ()));
        uint256 n = acct.nonce();
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 0, 1));
        acct.execute(c, n, uint64(block.timestamp + 60), new QEDOwnerAccount.Assertion[](0));
        assertEq(v2.owner(), eoaOwner);
    }

    // ── (b) an ERC-1271 mandate signature by the account pays out ─────────────────

    function _ownerSig(QEDOwnerAccount signerAccount, bytes32 vaultDigest, Key memory k)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(one(signAs(k, signerAccount.replaySafeHash(vaultDigest))));
    }

    function test_b_mandate_signed_through_erc1271_is_accepted_for_a_payment() public {
        IQEDVault.Mandate memory m = _mandate();
        bytes32 mHash = _mandateHash(m);
        bytes32 digest = _vaultDigest(mHash);
        bytes memory ownerSig = _ownerSig(acct, digest, alice);
        assertEq(acct.isValidSignature(digest, ownerSig), bytes4(0x1626ba7e));
        IQEDVault.Certificate memory c = _certificate(mHash, 40e6);
        bytes memory cosig = _cosign(c);
        uint256 before = token.balanceOf(payee);
        vm.prank(agent);
        vault.executePayment(m, ownerSig, c, cosig);
        assertEq(token.balanceOf(payee) - before, 40e6);
    }

    // ── (c) a mandate signature made for another account is refused ───────────────

    function test_c_mandate_signature_made_for_another_account_is_refused() public {
        QEDOwnerAccount other = deployAccountGuarded(keys1(alice), keys1(rec), 1, 1, _guards());
        IQEDVault.Mandate memory m = _mandate();
        bytes32 mHash = _mandateHash(m);
        bytes32 digest = _vaultDigest(mHash);
        bytes memory sigForOther = _ownerSig(other, digest, alice);
        assertEq(other.isValidSignature(digest, sigForOther), bytes4(0x1626ba7e));
        assertEq(acct.isValidSignature(digest, sigForOther), bytes4(0xffffffff));
        IQEDVault.Certificate memory c = _certificate(mHash, 40e6);
        bytes memory cosig = _cosign(c);
        vm.prank(agent);
        vm.expectRevert(BAD_OWNER_SIGNATURE);
        vault.executePayment(m, sigForOther, c, cosig);
    }

    function test_c_old_eoa_mandate_signature_is_refused() public {
        IQEDVault.Mandate memory m = _mandate();
        bytes32 mHash = _mandateHash(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_OWNER_PK, _vaultDigest(mHash));
        IQEDVault.Certificate memory c = _certificate(mHash, 40e6);
        bytes memory cosig = _cosign(c);
        vm.prank(agent);
        vm.expectRevert(BAD_OWNER_SIGNATURE);
        vault.executePayment(m, abi.encodePacked(r, s, v), c, cosig);
    }

    function test_c_mandate_signature_for_another_mandate_is_refused() public {
        IQEDVault.Mandate memory m = _mandate();
        bytes memory ownerSig = _ownerSig(acct, _vaultDigest(_mandateHash(m)), alice);
        m.maxPerPayment = 1_000e6; // the agent edits the signed terms
        bytes32 mHash = _mandateHash(m);
        IQEDVault.Certificate memory c = _certificate(mHash, 400e6);
        bytes memory cosig = _cosign(c);
        vm.prank(agent);
        vm.expectRevert(BAD_OWNER_SIGNATURE);
        vault.executePayment(m, ownerSig, c, cosig);
    }

    // ── guarded calls on the personal account ─────────────────────────────────────

    function test_even_the_only_member_cannot_make_a_guarded_call_immediately() public {
        QEDOwnerAccount.Call[] memory all = _guardedCalls(makeAddr("someone"));
        for (uint256 i; i < all.length; ++i) {
            Prepared memory p = prepare(acct, calls1(all[i].target, 0, all[i].data), keys1(alice));
            vm.expectRevert(
                abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, all[i].target, bytes4(all[i].data))
            );
            run(acct, p);
        }
    }

    function test_moving_the_vault_to_a_business_account_takes_the_delayed_path() public {
        Key memory bob = newKey(0xB0B);
        Key memory carol = newKey(0xCA401);
        QEDOwnerAccount biz = deployAccountGuarded(keys3(alice, bob, carol), keys1(rec), 2, 3, _guards());
        QEDOwnerAccount.Call[] memory move =
            calls1(address(vault), 0, abi.encodeCall(IQEDVault.transferOwnership, (address(biz))));
        bytes32 id = _scheduleId(
            acct, prepare(acct, selfCall(acct, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (move))), keys1(alice))
        );
        vm.warp(block.timestamp + DELAY);
        acct.applyCalls(id, move);
        exec(biz, calls1(address(vault), 0, abi.encodeCall(IQEDVault.acceptOwnership, ())), keys2(alice, bob));
        assertEq(vault.owner(), address(biz));

        // a 2-of-3 owner needs two passkeys for a mandate
        IQEDVault.Mandate memory m = _mandate();
        bytes32 mHash = _mandateHash(m);
        bytes32 challenge = biz.replaySafeHash(_vaultDigest(mHash));
        IQEDVault.Certificate memory c = _certificate(mHash, 40e6);
        bytes memory cosig = _cosign(c);
        bytes memory oneSig = abi.encode(one(signAs(alice, challenge)));
        vm.prank(agent);
        vm.expectRevert(BAD_OWNER_SIGNATURE);
        vault.executePayment(m, oneSig, c, cosig);
        bytes memory twoSigs = abi.encode(two(signAs(alice, challenge), signAs(carol, challenge)));
        vm.prank(agent);
        vault.executePayment(m, twoSigs, c, cosig);
        assertEq(token.balanceOf(payee), 40e6);
    }
}

/// Business workspace: three Members; one meets `threshold`, two meet `adminThreshold`.
contract BusinessGuardsTest is ReleaseSetup {
    QEDOwnerAccount internal biz;
    Key internal alice;
    Key internal bob;
    Key internal carol;

    event GuardConfigured(address indexed target, bytes4 indexed selector, string reason);

    function setUp() public {
        _deployRelease();
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        carol = newKey(0xCA401);
        biz = deployAccountGuarded(keys3(alice, bob, carol), noKeys(), 1, 2, _guards());
        _handOver(biz, keys1(alice));
    }

    function test_the_guard_list_is_recorded_with_its_reasons() public {
        QEDOwnerAccount.Guard[] memory g = _guards();
        vm.recordLogs();
        QEDOwnerAccount fresh = deployAccountGuarded(keys1(alice), noKeys(), 1, 1, g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("GuardConfigured(address,bytes4,string)")) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), g[seen].target);
            assertEq(bytes4(logs[i].topics[2]), g[seen].selector);
            assertEq(abi.decode(logs[i].data, (string)), g[seen].reason);
            assertGt(bytes(g[seen].reason).length, 40);
            ++seen;
        }
        assertEq(seen, 8);
        assertEq(fresh.guardedCalls().length, 8);
    }

    function test_threshold_member_cannot_make_any_guarded_call_immediately() public {
        QEDOwnerAccount.Call[] memory all = _guardedCalls(makeAddr("attacker"));
        for (uint256 i; i < all.length; ++i) {
            Prepared memory p = prepare(biz, calls1(all[i].target, 0, all[i].data), keys1(alice));
            vm.expectRevert(
                abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, all[i].target, bytes4(all[i].data))
            );
            run(biz, p);
            // nor with the admin quorum: the immediate path is closed for everyone
            p = prepare(biz, calls1(all[i].target, 0, all[i].data), keys2(alice, bob));
            vm.expectRevert(
                abi.encodeWithSelector(QEDOwnerAccount.GuardedCall.selector, 0, all[i].target, bytes4(all[i].data))
            );
            run(biz, p);
        }
        assertEq(vault.agent(), agent);
        assertEq(vault.cosigner(), cosigner);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(execution.operator(), operator);
        assertEq(policy.agent(), policyAgent);
    }

    function test_threshold_member_cannot_schedule_a_guarded_call() public {
        QEDOwnerAccount.Call[] memory all = _guardedCalls(makeAddr("attacker"));
        Prepared memory p =
            prepare(biz, selfCall(biz, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (all))), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(biz, p);
    }

    function test_pause_and_other_protective_calls_stay_immediate_for_one_member() public {
        exec(biz, calls1(address(vault), 0, abi.encodeCall(IQEDVault.pause, ())), keys1(carol));
        assertTrue(vault.paused());
        exec(biz, calls1(address(vault), 0, abi.encodeCall(IQEDVault.revokeMandate, (keccak256("m")))), keys1(carol));
        exec(biz, calls1(address(vault), 0, abi.encodeCall(IQEDVault.bumpEpoch, ())), keys1(carol));
        exec(biz, calls1(address(policy), 0, abi.encodeCall(IQEDTreasuryPolicy.revoke, ())), keys1(carol));
        assertEq(vault.epoch(), 1);
    }

    function test_the_delayed_path_applies_every_guarded_call() public {
        address next = makeAddr("next key");
        QEDOwnerAccount.Call[] memory all = _guardedCalls(next);
        bytes32 id = _scheduleId(
            biz, prepare(biz, selfCall(biz, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (all))), keys2(alice, bob))
        );
        uint64 readyAt = biz.getChange(id).readyAt;
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotReady.selector, id, readyAt));
        biz.applyCalls(id, all);
        vm.warp(readyAt);
        vm.prank(makeAddr("relayer"));
        biz.applyCalls(id, all);
        assertEq(vault.pendingOwner(), next);
        assertEq(vault.agent(), next);
        assertEq(vault.cosigner(), next);
        assertEq(vault.dailyCap(), type(uint256).max);
        assertEq(execution.venueSetHash(), keccak256(abi.encode(new address[](0))));
        assertEq(execution.operator(), next);
        (, , uint256 maxTranche,,,) = policy.policy();
        assertEq(maxTranche, 50e6);
        assertEq(policy.agent(), next);
    }

    function test_a_scheduled_guarded_call_is_cancelled_by_any_one_member() public {
        address attacker = makeAddr("attacker");
        QEDOwnerAccount.Call[] memory take =
            calls1(address(vault), 0, abi.encodeCall(IQEDVault.transferOwnership, (attacker)));
        bytes32 id = _scheduleId(
            biz, prepare(biz, selfCall(biz, abi.encodeCall(QEDOwnerAccount.scheduleCalls, (take))), keys2(alice, bob))
        );
        QEDOwnerAccount.Assertion memory a = signAs(carol, biz.cancelDigest(id));
        biz.cancel(id, a);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NothingPending.selector, id));
        biz.applyCalls(id, take);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.owner(), address(biz));
    }
}
