// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ReleaseSetup} from "./VaultIntegration.t.sol";
import {IQEDVault, IQEDTreasuryPolicy, ReleaseProtective} from "./helpers/Release.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// R13 against the release's own vault set (unmodified): a frozen passkey moves no money from the real QEDVault and
/// its mandates stop paying; one passkey stops the agent through `protect` whatever the threshold; the protective list
/// holds only calls that move no money.
contract VaultContainmentTest is ReleaseSetup {
    QEDOwnerAccount internal acct;
    address internal sentinel;
    Key internal alice;
    Key internal bob;

    bytes4 internal constant FROZEN = QEDOwnerAccount.FrozenSigner.selector;

    function _protective() internal view returns (QEDOwnerAccount.Guard[] memory p) {
        QEDOwnerAccount.Guard[] memory a = ReleaseProtective.list(address(vault), address(policy));
        QEDOwnerAccount.Guard[] memory b = ReleaseProtective.list(address(reserve), address(0));
        p = new QEDOwnerAccount.Guard[](a.length + b.length);
        for (uint256 i; i < a.length; ++i) p[i] = a[i];
        for (uint256 i; i < b.length; ++i) p[a.length + i] = b[i];
    }

    function _deployHousehold(uint256 t) internal {
        _deployRelease();
        alice = newKey(0xA11CE);
        bob = newKey(0xB0B);
        sentinel = makeAddr("sentinel");
        acct = deployContained(keys2(alice, bob), noKeys(), t, t, _guards(), _protective(), sentinel);
        Key[] memory all = t == 1 ? keys1(alice) : keys2(alice, bob);
        _handOver(acct, all);
        vm.prank(eoaOwner);
        reserve.transferOwnership(address(acct));
        exec(acct, calls1(address(reserve), 0, abi.encodeCall(IQEDVault.acceptOwnership, ())), all);
    }

    function test_a_frozen_passkey_moves_no_money_and_its_mandate_stops_paying() public {
        _deployHousehold(1);
        // alice signs a mandate; the agent pays under it
        IQEDVault.Mandate memory m = _mandate();
        bytes32 mHash = _mandateHash(m);
        bytes memory ownerSig = abi.encode(one(signAs(alice, acct.replaySafeHash(_vaultDigest(mHash)))));
        IQEDVault.Certificate memory c = _certificate(mHash, 40e6);
        bytes memory first = _cosign(c);
        vm.prank(agent);
        vault.executePayment(m, ownerSig, c, first);
        assertEq(token.balanceOf(payee), 40e6);
        // QED suspends alice's passkey: the sentinel freezes it on the chain at once
        vm.prank(sentinel);
        acct.freeze(alice.id);
        // the same mandate no longer pays: the owner's ERC-1271 signature is no longer valid
        vm.warp(block.timestamp + 1);
        c = _certificate(mHash, 10e6);
        bytes memory cosig = _cosign(c);
        vm.prank(agent);
        vm.expectRevert(BAD_OWNER_SIGNATURE);
        vault.executePayment(m, ownerSig, c, cosig);
        // and alice cannot withdraw, ring-fence or resume
        bytes[3] memory moves = [
            abi.encodeCall(IQEDVault.withdraw, (payee, 1e6)),
            abi.encodeCall(IQEDVault.ringFence, (payee, 1e6, uint64(block.timestamp), bytes32(0))),
            abi.encodeCall(IQEDVault.unpause, ())
        ];
        for (uint256 i; i < moves.length; ++i) {
            Prepared memory p = prepare(acct, calls1(address(vault), 0, moves[i]), keys1(alice));
            vm.expectRevert(abi.encodeWithSelector(FROZEN, alice.id));
            run(acct, p);
        }
        assertEq(token.balanceOf(payee), 40e6);
        // the other passkey still can, and a mandate it signs pays
        bytes memory bobSig = abi.encode(one(signAs(bob, acct.replaySafeHash(_vaultDigest(mHash)))));
        vm.prank(agent);
        vault.executePayment(m, bobSig, c, cosig);
        assertEq(token.balanceOf(payee), 50e6);
    }

    function test_one_passkey_stops_the_agent_at_threshold_two_and_cannot_resume_or_spend() public {
        _deployHousehold(2);
        // one passkey alone can spend nothing
        Prepared memory p = prepare(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.withdraw, (payee, 1e6))), keys1(alice));
        vm.expectRevert(abi.encodeWithSelector(QEDOwnerAccount.NotEnoughApprovals.selector, 1, 2));
        run(acct, p);
        // but it pauses both vaults, invalidates every mandate and ends the standing policy at once
        QEDOwnerAccount.Call[] memory stop = new QEDOwnerAccount.Call[](4);
        stop[0] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.pause, ()));
        stop[1] = QEDOwnerAccount.Call(address(reserve), 0, abi.encodeCall(IQEDVault.pause, ()));
        stop[2] = QEDOwnerAccount.Call(address(vault), 0, abi.encodeCall(IQEDVault.bumpEpoch, ()));
        stop[3] = QEDOwnerAccount.Call(address(policy), 0, abi.encodeCall(IQEDTreasuryPolicy.revoke, ()));
        runProtect(acct, prepareProtect(acct, stop, alice));
        assertTrue(vault.paused());
        assertTrue(reserve.paused());
        assertEq(vault.epoch(), 1);
        QEDOwnerAccount.Call[] memory revoke =
            calls1(address(vault), 0, abi.encodeCall(IQEDVault.revokeMandate, (keccak256("a mandate"))));
        runProtect(acct, prepareProtect(acct, revoke, bob));
        // resuming, or anything that moves money, is not protective
        bytes[4] memory notProtective = [
            abi.encodeCall(IQEDVault.unpause, ()),
            abi.encodeCall(IQEDVault.withdraw, (payee, 1e6)),
            abi.encodeCall(IQEDVault.setDailyCap, (0)),
            abi.encodeCall(IQEDVault.setGuardian, (payee))
        ];
        for (uint256 i; i < notProtective.length; ++i) {
            ProtectPrepared memory q = prepareProtect(acct, calls1(address(vault), 0, notProtective[i]), alice);
            vm.expectRevert(
                abi.encodeWithSelector(QEDOwnerAccount.NotProtective.selector, 0, address(vault), bytes4(notProtective[i]))
            );
            runProtect(acct, q);
        }
        // both passkeys together resume
        exec(acct, calls1(address(vault), 0, abi.encodeCall(IQEDVault.unpause, ())), keys2(alice, bob));
        assertFalse(vault.paused());
        assertEq(token.balanceOf(payee), 0);
    }

    function test_the_release_protective_list_holds_only_calls_that_move_no_money() public {
        _deployRelease();
        QEDOwnerAccount.Guard[] memory p = _protective();
        assertEq(p.length, 7);
        QEDOwnerAccount.Guard[] memory g = _guards();
        for (uint256 i; i < p.length; ++i) {
            bytes4 sel = p[i].selector;
            assertTrue(
                sel == IQEDVault.pause.selector || sel == IQEDVault.bumpEpoch.selector
                    || sel == IQEDVault.revokeMandate.selector || sel == IQEDTreasuryPolicy.revoke.selector,
                "only stop, invalidate or revoke"
            );
            for (uint256 j; j < g.length; ++j) {
                assertFalse(g[j].target == p[i].target && g[j].selector == sel, "never also guarded");
            }
        }
    }
}
