// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../src/QEDDisputeEscrow.sol";
import {DisputeInvariantChecks} from "dispute-test/invariant/DisputeInvariantChecks.sol";
import {SeededDisputeEscrow} from "./SeededDisputeEscrow.sol";

/// @notice EXPECTED TO PASS: the seeded copy with every binding on satisfies the same invariants as the real escrow, so
///         the twins' failures come from the one binding each removes, not from the copy.
contract SeededCopyWithEveryBinding is DisputeInvariantChecks {
    function _newEscrow(ProofEscrow escrow) internal override returns (QEDDisputeEscrow) {
        return QEDDisputeEscrow(address(new SeededDisputeEscrow(escrow, true, true, true)));
    }
}
