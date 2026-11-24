// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AccountInvariants} from "../test/helpers/AccountInvariants.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Seeded-bug twin (R13 H1): identical to QEDOwnerAccount except that, with every Member frozen, a co-signed recovery
///         finishes whenever some sentinel is set, even one that changed during its wait (the epoch not checked), so QED
///         could not have stopped it throughout.
contract BuggySentinelEpochAccount is QEDOwnerAccount {
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

    function _sentinelWatched(uint64) internal view override returns (bool) {
        return sentinel != address(0);
    }
}

/// EXPECTED TO FAIL (invariant_cosigned_recovery_needs_a_whole_unfrozen_window). Proves the handler and invariants can see the bug the real contract prevents. Run: FOUNDRY_PROFILE=seeded forge test
contract BuggySentinelEpochInvariantTest is AccountInvariants {
    function _deploy(
        QEDOwnerAccount.SignerInit[] memory s,
        uint256 t,
        uint256 a,
        QEDOwnerAccount.Guard[] memory g,
        QEDOwnerAccount.Guard[] memory p,
        address sentinel_,
        QEDOwnerAccount.Guard[] memory l,
        bool locked
    ) internal override returns (QEDOwnerAccount) {
        return new BuggySentinelEpochAccount(RP_ID_HASH, ORIGIN, s, t, a, DELAY, RECOVERY_DELAY, g, p, sentinel_, l, locked);
    }
}
