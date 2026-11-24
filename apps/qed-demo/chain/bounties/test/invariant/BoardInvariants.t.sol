// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QEDBountyBoard} from "../../src/QEDBountyBoard.sol";
import {IBoard} from "../IBoard.sol";
import {BoardRaceInvariants} from "./BoardRace.sol";

/// @notice The race invariants against the real board.
contract BoardInvariantsTest is BoardRaceInvariants {
    function _newBoard() internal override returns (IBoard) {
        return IBoard(address(new QEDBountyBoard(allowedJudges)));
    }
}
