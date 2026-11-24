// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QEDBountyBoard} from "../src/QEDBountyBoard.sol";
import {IBoard} from "./IBoard.sol";
import {JudgeChecks} from "./JudgeChecks.sol";

/// @notice R13: the judge allowlist against the real board.
contract JudgeAllowlistTest is JudgeChecks {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }
}
