// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OptimalityBounty} from "qed/src/bounties/OptimalityBounty.sol";
import {MaximalityBounty} from "qed/src/bounties/MaximalityBounty.sol";
import {QEDBountyBoard} from "../src/QEDBountyBoard.sol";
import {BoardCase} from "./BoardCase.sol";
import {IBoard} from "./IBoard.sol";

/// @notice Differential: for any claim, the board's ruling is the judge's. Each case builds one claim (accepted or
///         rejected, against a sound original or a positive control), asks the unmodified judge directly (it holds
///         nothing, so a valid claim pays 0 and an invalid one reverts), then commits and reveals the same bytes on the
///         board. Both must succeed or both revert with identical revert data; a success on the board makes the
///         finder the provisional winner with the pool intact.
contract DifferentialTest is BoardCase {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }

    function _compare(uint256 id, bytes memory claim) internal {
        (bool direct, bytes memory dret) = _tx(stranger, _judgeOf(id), claim);
        _commit(finder, id, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        (bool viaBoard, bytes memory bret) = _tryReveal(finder, id, finderVault, claim, SALT);
        assertEq(viaBoard, direct, "the board and the judge disagree on acceptance");
        if (!direct) assertEq(bret, dret, "the board changed the judge's error");
        else assertEq(_winnerOf(id), finder);
        assertEq(_poolOf(id), POOL, "the pool changed during a reveal");
        assertEq(usd.balanceOf(_judgeOf(id)), 0);
    }

    /// Portfolios: feasible ones from random weights, and infeasible ones (a negative weight, a budget off by one unit,
    /// the wrong length), against the sound original (honest certificate) and the positive control (the forged one).
    function testFuzz_Differential_Optimality(uint64[6] memory raw, uint8 fault, bool control) public {
        int256[] memory x = new int256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += raw[i];
        }
        vm.assume(total > 0);
        int256 s;
        for (uint256 i; i < n; ++i) {
            x[i] = int256((uint256(raw[i]) * uint256(W)) / total);
            s += x[i];
        }
        x[0] += W - s;
        fault = fault % 4;
        if (fault == 1) {
            x[0] += x[1] + 1; // a negative weight, with the budget kept at exactly W
            x[1] = -1;
        } else if (fault == 2) {
            x[2] += 1; // budget off by one unit
        }
        if (fault == 3) x = new int256[](n + 1); // wrong length
        bytes memory certificate;
        if (control) {
            int256[] memory worst = new int256[](n);
            worst[3] = W;
            certificate = abi.encode(worst, int256(0), new int256[](n), new int256[]((n * (n + 1)) / 2));
        } else {
            certificate = honest;
        }
        _compare(control ? optControl : optimality, abi.encodeCall(OptimalityBounty.claim, (spec, certificate, x)));
    }

    /// Nettings: circulations inside the debts (valid), and broken ones (a net position moved, a debt exceeded, the
    /// wrong length), against the sound original and the positive control (which under-reports by 7 tUSD).
    function testFuzz_Differential_Maximality(uint256 seed, uint8 fault, bool control) public {
        MaximalityBounty.Economy memory e = _economy();
        uint256 m = e.d.length;
        uint256[] memory x = new uint256[](m);
        for (uint256 k; k < 11; ++k) {
            uint256[] memory cyc = vm.parseJsonUintArray(cfx, string.concat(".cycles[", vm.toString(k), "]"));
            uint256 cap = type(uint256).max;
            for (uint256 t; t < cyc.length; ++t) {
                uint256 room = e.d[cyc[t]] - x[cyc[t]];
                if (room < cap) cap = room;
            }
            uint256 alpha = cap == 0 ? 0 : uint256(keccak256(abi.encode(seed, k))) % (cap + 1);
            for (uint256 t; t < cyc.length; ++t) {
                x[cyc[t]] += alpha;
            }
        }
        fault = fault % 4;
        uint256 at = seed % m;
        if (fault == 1) x[at] = x[at] == 0 ? 1 : x[at] - 1; // one net position moves
        else if (fault == 2) x[at] = e.d[at] + 1; // more than the debt
        else if (fault == 3) x = new uint256[](m + 1); // wrong length
        _compare(control ? maxControl : maximality, abi.encodeCall(MaximalityBounty.claim, (e, _optimal(), x)));
    }

    /// The five recorded claims and the two positive-control claims, against every bounty they could be sent to.
    function test_Differential_EveryKnownClaimAgainstEveryMatchingBounty() public {
        bytes[7] memory claims = [_ba1(), _ba2(), _ba3(), _optimalityClaim(), _bm1(), _bm2(), _maximalityClaim()];
        for (uint256 i; i < 7; ++i) {
            uint256[2] memory ids = i < 4 ? [optimality, optControl] : [maximality, maxControl];
            for (uint256 j; j < 2; ++j) {
                uint256 snap = vm.snapshotState();
                _compare(ids[j], claims[i]);
                vm.revertToState(snap);
            }
        }
    }
}
