// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../../src/QEDDisputeEscrow.sol";
import {DisputeInvariantChecks} from "./DisputeInvariantChecks.sol";

/// @notice The real escrow.
contract DisputeInvariants is DisputeInvariantChecks {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return new QEDDisputeEscrow(escrow);
    }
}
