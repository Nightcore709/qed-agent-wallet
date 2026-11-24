// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {console} from "forge-std/console.sol";
import {AccountInvariants} from "./helpers/AccountInvariants.sol";
import {QEDOwnerAccount} from "../src/QEDOwnerAccount.sol";

/// Stateful fuzzing of the real contract. Its seeded-bug twin is in ../seeded (FOUNDRY_PROFILE=seeded).
contract AccountInvariantTest is AccountInvariants {
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
        return new QEDOwnerAccount(RP_ID_HASH, ORIGIN, s, t, a, DELAY, RECOVERY_DELAY, g, p, sentinel_, l, locked);
    }

    /// Shows the campaign is not vacuous: per run, how many scheduled changes were applied, how many changes or
    /// recoveries were cancelled, how many recoveries finished, how many immediate guarded calls were attempted, how
    /// many freezes the sentinel made, how many attempts frozen Members made to approve, and how many protective calls
    /// ran (by frozen Members among them); since the R13 review fixes also how often every Member was frozen, how many
    /// finishes of a co-signed recovery were tried then, how many co-signed recoveries finished, how many the guardian
    /// withdrew, how many far-deadline starts were tried and how many off-changes were followed by turning the lock on
    /// (summed into evidence/<folder>/invariant-ghosts-summary.txt).
    function afterInvariant() external {
        string memory line = string.concat(
            vm.toString(handler.applied()),
            " ",
            vm.toString(handler.cancelled()),
            " ",
            vm.toString(handler.recovered()),
            " ",
            vm.toString(handler.guardedAttempts()),
            " ",
            vm.toString(handler.freezes()),
            " ",
            vm.toString(handler.frozenAttempts()),
            " ",
            vm.toString(handler.protectRuns()),
            " ",
            vm.toString(handler.frozenProtectRuns()),
            " ",
            vm.toString(handler.guardiansInstalled()),
            " ",
            vm.toString(handler.cosignedStarts()),
            " ",
            vm.toString(handler.guardianAttempts()),
            " ",
            vm.toString(handler.frozenCancelAttempts()),
            " ",
            vm.toString(handler.lockedAttempts()),
            " ",
            vm.toString(handler.unlockedRuns()),
            " ",
            string.concat(
                vm.toString(handler.allFrozenObserved()),
                " ",
                vm.toString(handler.allFrozenFinishAttempts()),
                " ",
                vm.toString(handler.cosignedFinishes()),
                " ",
                vm.toString(handler.guardianWithdrawals()),
                " ",
                vm.toString(handler.farDeadlineAttempts()),
                " ",
                vm.toString(handler.staleAttempts()),
                " ",
                vm.toString(handler.sentinelStops()),
                " ",
                vm.toString(handler.sentinelPathFinishes())
            )
        );
        if (vm.envOr("QED_GHOSTS", false)) {
            vm.writeLine(vm.envOr("QED_GHOSTS_FILE", string("evidence/invariant-ghosts.txt")), line);
        }
        console.log(
            "ghost applied/cancelled/recovered/guardedAttempts/freezes/frozenAttempts/protects/frozenProtects/guardiansInstalled/cosignedStarts/guardianAttempts/frozenCancelAttempts/lockedAttempts/unlockedRuns/allFrozenObserved/allFrozenFinishAttempts/cosignedFinishes/guardianWithdrawals/farDeadlineAttempts/lockCycles/sentinelStops/sentinelPathFinishes",
            line
        );
    }
}
