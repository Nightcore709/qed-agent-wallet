// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {QEDOwnerAccount} from "../../src/QEDOwnerAccount.sol";

/// ABIs of the release contracts (vendor/contracts/src, unmodified, compiled with solc 0.8.26 and deployed in the
/// tests by artifact name, so these 0.8.38 files never import 0.8.26 sources).
interface ITestUSD {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IQEDVault {
    struct Mandate {
        address vault;
        address agent;
        address[] payees;
        uint256 maxPerPayment;
        uint256 maxPerPeriod;
        uint64 period;
        uint256 maxTotal;
        uint64 validFrom;
        uint64 validUntil;
        uint64 epoch;
        bool requireCosign;
        bytes32 purpose;
        bytes32 salt;
    }

    struct Certificate {
        bytes32 mandateHash;
        address recipient;
        uint256 amount;
        uint64 dueAt;
        bytes32 intentId;
        bytes32 evidenceHash;
        bytes32 ref;
        uint64 notBefore;
        uint64 expiresAt;
        uint64 epoch;
    }

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function agent() external view returns (address);
    function cosigner() external view returns (address);
    function paused() external view returns (bool);
    function epoch() external view returns (uint64);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function executePayment(Mandate calldata m, bytes calldata ownerSig, Certificate calldata c, bytes calldata cosig)
        external
        returns (uint256);
    function deposit(uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
    function ringFence(address creditor, uint256 amount, uint64 dueAt, bytes32 memo) external returns (uint256);
    function pause() external;
    function unpause() external;
    function bumpEpoch() external;
    function revokeMandate(bytes32 mandateHash) external;
    function setAgent(address a) external;
    function setCosigner(address c) external;
    function setGuardian(address g) external;
    function setDailyCap(uint256 cap) external;
    function dailyCap() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
    function MANDATE_TYPEHASH() external view returns (bytes32);
    function CERTIFICATE_TYPEHASH() external view returns (bytes32);
}

interface IQEDExecution {
    function setVenues(address[] calldata pools, uint16[] calldata fees) external;
    function setOperator(address operator_) external;
    function operator() external view returns (address);
    function venueSetHash() external view returns (bytes32);
}

interface IQEDTreasuryPolicy {
    struct Policy {
        uint256 targetFree;
        uint256 minTranche;
        uint256 maxTranche;
        uint16 maxImpactBps;
        uint16 needSlackBps;
        uint64 validUntil;
    }

    function setPolicy(Policy calldata p) external;
    function revoke() external;
    function setAgent(address agent_) external;
    function agent() external view returns (address);
    function policy()
        external
        view
        returns (
            uint256 targetFree,
            uint256 minTranche,
            uint256 maxTranche,
            uint16 maxImpactBps,
            uint16 needSlackBps,
            uint64 validUntil
        );
}

/// The recommended guarded set for one workspace's vault set. Same entries and reasons as webauthn.ts
/// `releaseGuards()` and README "Guarded calls".
library ReleaseGuards {
    function list(address vault, address execution, address policy)
        internal
        pure
        returns (QEDOwnerAccount.Guard[] memory g)
    {
        g = new QEDOwnerAccount.Guard[](8);
        g[0] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.transferOwnership.selector,
            "Moves every owner power over the vault, and through vault.owner() over its execution and policy contracts, to another address."
        );
        g[1] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.setAgent.selector,
            "The agent is the only key that can redeem the owner's mandates; replacing it changes who can move the vault's funds."
        );
        g[2] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.setCosigner.selector,
            "The co-signer certifies every payment independently; replacing it changes who approves the vault's outflows."
        );
        g[3] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.setDailyCap.selector,
            "The daily cap bounds all agent payments across every mandate; raising it lets the agent move more. Guarded by selector, so lowering also waits; pause, bumpEpoch and revokeMandate stay immediate."
        );
        g[4] = QEDOwnerAccount.Guard(
            execution,
            IQEDExecution.setVenues.selector,
            "The venue set decides where the agent's orders may trade the vault's funds; adding a venue widens where they can go."
        );
        g[5] = QEDOwnerAccount.Guard(
            execution,
            IQEDExecution.setOperator.selector,
            "The operator is the hot key that may call trade and pay against the vault; replacing it changes who can move the vault's funds."
        );
        g[6] = QEDOwnerAccount.Guard(
            policy,
            IQEDTreasuryPolicy.setPolicy.selector,
            "The standing conversion policy's limits bound automatic conversions; raising them lets more move. Guarded by selector, so any change waits; revoke() stays immediate."
        );
        g[7] = QEDOwnerAccount.Guard(
            policy,
            IQEDTreasuryPolicy.setAgent.selector,
            "The policy agent is the key allowed to run conversions under the policy; replacing it changes who can move the treasury's funds."
        );
    }
}

/// The recommended protective set for one vault (and its policy contract, if any): calls that only stop things and
/// move no money, which one Member may make through `protect` whatever the thresholds, even while frozen. Same entries
/// and reasons as webauthn.ts `releaseProtective()` and README "Protective calls".
library ReleaseProtective {
    function list(address vault, address policy) internal pure returns (QEDOwnerAccount.Guard[] memory p) {
        p = new QEDOwnerAccount.Guard[](policy == address(0) ? 3 : 4);
        p[0] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.pause.selector,
            "Halts the agent at once: no mandate can be used until the owner resumes; creditors are still paid. Moves no money."
        );
        p[1] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.bumpEpoch.selector,
            "Invalidates every outstanding mandate and certificate at once. Moves no money."
        );
        p[2] = QEDOwnerAccount.Guard(
            vault, IQEDVault.revokeMandate.selector, "Revokes one mandate at once. Moves no money."
        );
        if (policy != address(0)) {
            p[3] = QEDOwnerAccount.Guard(
                policy, IQEDTreasuryPolicy.revoke.selector, "Ends the standing conversion policy at once. Moves no money."
            );
        }
    }
}

/// The optional time-locked set for one vault (R13): the owner's own moves of free funds and the vault's emergency
/// settings. They run at once at the account's threshold unless the household turns the time-lock on; then they wait
/// the account's delay like guarded calls. Same entries and reasons as webauthn.ts `releaseLockable()` and README
/// R13: owner options.
library ReleaseLockable {
    function list(address vault) internal pure returns (QEDOwnerAccount.Guard[] memory l) {
        l = new QEDOwnerAccount.Guard[](4);
        l[0] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.withdraw.selector,
            "Moves the vault's free funds to any address. Time-locked, a withdrawal waits the account's delay, during which any one member can cancel it."
        );
        l[1] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.ringFence.selector,
            "Sets free funds aside for any creditor, irrevocably by the owner. Time-locked, it waits the account's delay, during which any one member can cancel it."
        );
        l[2] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.unpause.selector,
            "Lets the agent pay again after a pause. Time-locked, resuming waits the account's delay; pausing stays immediate."
        );
        l[3] = QEDOwnerAccount.Guard(
            vault,
            IQEDVault.setGuardian.selector,
            "Replaces the vault's guardian, the address that may pause it in an emergency. Time-locked, a new one waits the account's delay."
        );
    }
}
