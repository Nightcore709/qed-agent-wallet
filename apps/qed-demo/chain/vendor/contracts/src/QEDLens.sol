// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {QEDVault} from "./QEDVault.sol";

/// @title  QEDLens — read-only, stateless views over any QEDVault
/// @notice Keeps the enforcement contract minimal (Ethereum caps a transaction at 2^24 gas, which
///         bounds deployable code size under current state-creation pricing). Everything here is a
///         pure function of public vault state, so anyone can recompute it; it holds no funds and
///         has no privileges.
contract QEDLens {
    struct Snapshot {
        uint256 balance;
        uint256 protectedBalance;
        uint256 freeBalance;
        uint256 dailyCap;
        uint256 spentInWindow;
        uint256 windowStart;
        uint256 blastRadius24h;
        uint256 openLiabilities;
        uint256 liabilityCount;
        uint64 epoch;
        bool paused;
        address owner;
        address agent;
        address cosigner;
        address guardian;
    }

    /// @notice Provable worst-case loss within `horizon` seconds if the agent key AND the co-signer
    ///         key are both fully compromised (owner key safe).
    /// @dev    Every agent outflow is bounded by (a) the vault's free balance and (b) its global window
    ///         cap. Windows are fixed, length WINDOW, and a new one opens at the first spend after the
    ///         previous one closes; we add the remaining capacity of the current window to the full
    ///         capacity of every further window that can open within the horizon (inclusive — a
    ///         deliberately conservative bound). A paused vault can only be resumed by the owner: 0.
    ///         Compromised outflows can only reach payees the owner pre-approved in signed mandates,
    ///         so loss to addresses NOT approved by the owner is always exactly zero.
    function blastRadius(QEDVault v, uint256 horizon) public view returns (uint256) {
        if (v.paused()) return 0;
        uint256 free = v.freeBalance();
        uint256 cap = v.dailyCap();
        uint256 window = v.WINDOW();
        uint256 start = v.windowStart();
        uint256 capacity;
        uint256 currentEnd;
        if (block.timestamp >= start + window) {
            capacity = cap;
            currentEnd = block.timestamp + window;
        } else {
            uint256 spent = v.spentInWindow();
            capacity = cap > spent ? cap - spent : 0;
            currentEnd = start + window;
        }
        uint256 horizonEnd = block.timestamp + horizon;
        if (horizonEnd >= currentEnd) capacity += ((horizonEnd - currentEnd) / window + 1) * cap;
        return capacity < free ? capacity : free;
    }

    function snapshot(QEDVault v) external view returns (Snapshot memory s) {
        s.balance = IERC20(address(v.asset())).balanceOf(address(v));
        s.protectedBalance = v.totalProtected();
        s.freeBalance = v.freeBalance();
        s.dailyCap = v.dailyCap();
        s.windowStart = v.windowStart();
        s.spentInWindow = block.timestamp >= s.windowStart + v.WINDOW() ? 0 : v.spentInWindow();
        s.blastRadius24h = blastRadius(v, 1 days);
        s.openLiabilities = v.openLiabilities();
        s.liabilityCount = v.liabilityCount();
        s.epoch = v.epoch();
        s.paused = v.paused();
        s.owner = v.owner();
        s.agent = v.agent();
        s.cosigner = v.cosigner();
        s.guardian = v.guardian();
    }

    function hashMandate(QEDVault.Mandate calldata m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "Mandate(address vault,address agent,address[] payees,uint256 maxPerPayment,uint256 maxPerPeriod,uint64 period,uint256 maxTotal,uint64 validFrom,uint64 validUntil,uint64 epoch,bool requireCosign,bytes32 purpose,bytes32 salt)"
                ),
                m.vault,
                m.agent,
                keccak256(abi.encodePacked(m.payees)),
                m.maxPerPayment,
                m.maxPerPeriod,
                m.period,
                m.maxTotal,
                m.validFrom,
                m.validUntil,
                m.epoch,
                m.requireCosign,
                m.purpose,
                m.salt
            )
        );
    }

    function hashCertificate(QEDVault.Certificate calldata c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "Certificate(bytes32 mandateHash,address recipient,uint256 amount,uint64 dueAt,bytes32 intentId,bytes32 evidenceHash,bytes32 ref,uint64 notBefore,uint64 expiresAt,uint64 epoch)"
                ),
                c.mandateHash,
                c.recipient,
                c.amount,
                c.dueAt,
                c.intentId,
                c.evidenceHash,
                c.ref,
                c.notBefore,
                c.expiresAt,
                c.epoch
            )
        );
    }

    /// @notice The EIP-712 digest the owner signs for a mandate on vault `v`.
    function mandateDigest(QEDVault v, QEDVault.Mandate calldata m) external view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(v.domainSeparator(), hashMandate(m));
    }

    /// @notice The EIP-712 digest the co-signer signs for a certificate on vault `v`.
    function certificateDigest(QEDVault v, QEDVault.Certificate calldata c) external view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(v.domainSeparator(), hashCertificate(c));
    }
}
