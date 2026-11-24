// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoard} from "board-test/IBoard.sol";
import {DomainChecks} from "board-test/DomainChecks.sol";
import {JudgeChecks} from "board-test/JudgeChecks.sol";
import {BoardRaceInvariants} from "board-test/invariant/BoardRace.sol";
import {SeededBoard} from "./SeededBoard.sol";

// EXPECTED TO PASS: the twin with both bindings on behaves as the real board, so the failures in SeededTwins.t.sol come
// from the switched-off binding and from nothing else in the copy.

contract SanityRace is BoardRaceInvariants {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(true, true, true, allowedJudges)));
    }
}

contract SanityDomain is DomainChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(true, true, true, allowedJudges)));
    }
}

contract SanityJudges is JudgeChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new SeededBoard(true, true, true, allowedJudges)));
    }
}
