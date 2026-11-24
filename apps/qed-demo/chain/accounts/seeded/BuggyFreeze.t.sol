// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AccountInvariants} from "../test/helpers/AccountInvariants.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Seeded-bug twin: identical to QEDOwnerAccount except that a frozen Member's approval still counts for execute and
/// ERC-1271, so a freeze by the sentinel contains nothing.
contract BuggyFreezeAccount is QEDOwnerAccount {
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

    function _approvalCounts(Signer storage) internal pure override returns (bool) {
        return true;
    }
}

/// EXPECTED TO FAIL (invariant_frozen_member_never_approves). Proves the handler and invariants can see the bug the
/// real contract's frozen check prevents. Run: FOUNDRY_PROFILE=seeded forge test
contract BuggyFreezeInvariantTest is AccountInvariants {
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
        return new BuggyFreezeAccount(RP_ID_HASH, ORIGIN, s, t, a, DELAY, RECOVERY_DELAY, g, p, sentinel_, l, locked);
    }
}
