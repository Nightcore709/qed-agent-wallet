// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The external surface of QEDBountyBoard, so that the same tests run against the real board and against the
///         seeded-bug twins (seeded/), which differ from it only where their comments say.
interface IBoard {
    function open(address judge, IERC20 token, bytes4 selector, uint64 revealDelay, uint64 revealWindow, uint64 contestWindow)
        external
        returns (uint256 bountyId);
    function fund(uint256 bountyId, uint256 amount) external returns (uint256 received);
    function commitmentOf(uint256 bountyId, address claimant, address recipient, bytes calldata claim, bytes32 salt)
        external
        view
        returns (bytes32);
    function commit(uint256 bountyId, bytes32 commitment) external returns (uint64 seq);
    function reveal(uint256 bountyId, address recipient, bytes calldata claim, bytes32 salt) external;
    function settle(uint256 bountyId) external returns (uint256 payout);
    function phase(uint256 bountyId) external view returns (uint8);
    function domainSeparator() external view returns (bytes32);
    function bountyCount() external view returns (uint256);
    function commitCount() external view returns (uint64);
    function bounties(uint256 bountyId)
        external
        view
        returns (
            address judge,
            uint64 revealDelay,
            IERC20 token,
            uint64 revealWindow,
            address winner,
            uint64 contestWindow,
            address recipient,
            uint64 winnerSeq,
            bytes4 selector,
            uint64 contestEndsAt,
            bool settled,
            uint256 pool,
            uint256 paid
        );
    function commitments(address claimant, bytes32 commitment)
        external
        view
        returns (uint64 seq, uint64 at, uint64 bountyId, bool revealed);
    // R13: the judge allowlist
    function deployer() external view returns (address);
    function judgeClaim(bytes32 codeHash) external view returns (bytes4);
    function setJudge(bytes32 codeHash, bytes4 claimSelector) external;
}
