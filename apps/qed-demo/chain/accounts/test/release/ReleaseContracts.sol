// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Compiles the approved release's contracts, unmodified, from the read-only vendor tree (../vendor) with the
// release's own compiler (0.8.26). Tests deploy them by artifact name (vm.deployCode / the Anvil test) so that
// 0.8.38 test files never import 0.8.26 sources.
// Only the entry points are imported: QEDTreasuryPolicy reaches QEDExecution and QEDVault through its own relative
// imports. Importing those two here as well made the compiler see each file under two source-unit names
// (absolute and ../vendor/...), which produced duplicate artifacts.
import {TestUSD} from "qed-release/TestUSD.sol";
import {QEDTreasuryPolicy} from "qed-release/QEDTreasuryPolicy.sol";
