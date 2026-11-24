// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoardCase} from "./BoardCase.sol";
import {IBoard} from "./IBoard.sol";

/// @notice Domain separation and replay: a commitment is good only for the chain, the board and the bounty it names,
///         and only once. Abstract so that the same checks run against the twin without a domain (seeded/), where they
///         must fail.
abstract contract DomainChecks is BoardCase {
    /// @dev A commitment recorded for bounty `from`, revealed against bounty `to` with the same claim and salt. Both are
    ///      the release's optimality positive control (two pools with the same judge type), so the claim is valid on
    ///      both and only the binding can stop it.
    function test_Domain_ACommitmentForOneBountyNeverRevealsOnAnother() public {
        uint256 other = _openFunded(board, _unsoundOptimality(), _optimalitySelector(), POOL);
        bytes memory claim = _optimalityClaim();
        // the finder records, for bounty `other`, the digest it computed for optControl
        bytes32 h = board.commitmentOf(optControl, finder, finderVault, claim, SALT);
        vm.prank(finder);
        board.commit(other, h);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok,) = _tryReveal(finder, other, finderVault, claim, SALT);
        assertFalse(ok, "a digest computed for one bounty revealed on another");
        (ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT);
        assertFalse(ok, "a commitment recorded for one bounty revealed on another");
        assertEq(usd.balanceOf(finderVault), 0);
    }

    /// @dev A digest computed for another board (another verifying contract) does not reveal here.
    function test_Domain_ACommitmentForAnotherBoardNeverRevealsHere() public {
        IBoard second = _newBoard();
        bytes memory claim = _optimalityClaim();
        bytes32 there = second.commitmentOf(optControl, finder, finderVault, claim, SALT);
        assertTrue(there != board.commitmentOf(optControl, finder, finderVault, claim, SALT), "two boards share a digest");
        vm.prank(finder);
        board.commit(optControl, there);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT);
        assertFalse(ok, "another board's digest revealed here");
    }

    /// @dev After a fork that changes the chain id, a commitment recorded before it does not reveal on the new chain.
    function test_Domain_AfterTheChainIdChanges_ACommitmentFromBeforeDoesNotReveal() public {
        bytes memory claim = _optimalityClaim();
        _commit(finder, optControl, finderVault, claim, SALT);
        vm.chainId(block.chainid + 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT);
        assertFalse(ok, "a commitment from before the fork revealed on the forked chain");
    }

    /// @dev Changing any one field of the commitment changes the digest (bounty, claimant, recipient, claim, salt).
    function testFuzz_Domain_EveryFieldIsBound(uint8 which, uint256 tweak) public view {
        tweak = bound(tweak, 1, type(uint160).max);
        bytes memory claim = _optimalityClaim();
        bytes32 base = board.commitmentOf(optControl, finder, finderVault, claim, SALT);
        uint256 id = optControl;
        address who = finder;
        address to = finderVault;
        bytes32 salt = SALT;
        which = which % 5;
        if (which == 0) id = optControl + tweak;
        else if (which == 1) who = address(uint160(uint256(uint160(finder)) ^ tweak));
        else if (which == 2) to = address(uint160(uint256(uint160(finderVault)) ^ tweak));
        else if (which == 3) claim = abi.encodePacked(claim, bytes1(uint8(tweak)));
        else salt = bytes32(uint256(SALT) ^ tweak);
        assertTrue(board.commitmentOf(id, who, to, claim, salt) != base, "a field is not bound into the digest");
    }

    /// @dev Replay: a commitment is revealed at most once, and a settled bounty takes nothing more.
    function test_Replay_ACommitmentIsRevealedOnce_AndASettledBountyIsClosed() public {
        bytes memory claim = _optimalityClaim();
        bytes32 h = _commit(finder, optControl, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _reveal(finder, optControl, finderVault, claim, SALT);
        (bool ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT);
        assertFalse(ok, "a commitment revealed twice");
        vm.warp(vm.getBlockTimestamp() + CONTEST);
        board.settle(optControl);
        assertEq(usd.balanceOf(finderVault), POOL);
        (ok,) = _tryReveal(finder, optControl, finderVault, claim, SALT);
        assertFalse(ok, "a reveal after settlement");
        (ok,) = _tx(finder, address(board), abi.encodeCall(IBoard.commit, (optControl, keccak256("again"))));
        assertFalse(ok, "a commit after settlement");
        (ok,) = _tx(stranger, address(board), abi.encodeCall(IBoard.settle, (optControl)));
        assertFalse(ok, "a second settlement");
        assertEq(usd.balanceOf(finderVault), POOL);
        h;
    }
}
