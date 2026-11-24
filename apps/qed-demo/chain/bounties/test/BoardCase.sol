// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoardFixtures} from "./BoardFixtures.sol";
import {IBoard} from "./IBoard.sol";
import {Judge} from "../src/QEDBountyBoard.sol";

/// @notice One board with four funded bounties, as the wallet's local chain opens them (rail/bounties.ts), plus the
///         actors of a race. Bounties 1 and 2 are the release's positive controls (claimable); 3 and 4 are the two
///         original bounties as deployed on Sepolia (sound: nothing should ever claim them).
abstract contract BoardCase is BoardFixtures {
    uint8 internal constant P_NONE = 0;
    uint8 internal constant P_OPEN = 1;
    uint8 internal constant P_CONTEST = 2;
    uint8 internal constant P_SETTLEABLE = 3;
    uint8 internal constant P_SETTLED = 4;

    IBoard internal board;
    uint256 internal optControl; //  1: OptimalityBounty over AcceptAnything
    uint256 internal maxControl; //  2: UnsoundMaximality
    uint256 internal optimality; //  3: the original OptimalityBounty, sound
    uint256 internal maximality; //  4: the original MaximalityBounty, sound
    address internal finder = makeAddr("finder");
    address internal copier = makeAddr("copier");
    address internal finderVault = makeAddr("finder's vault");
    address internal copierVault = makeAddr("copier's vault");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant SALT = keccak256("the finder's secret salt");
    bytes32 internal constant COPIER_SALT = keccak256("the copier's salt");

    /// @dev The board under test: the real one in test/, a seeded twin in seeded/.
    function _newBoard() internal virtual returns (IBoard);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        _loadFixtures();
        // R13: the four judges first, so that the board allows exactly them from its construction (rail/bounties.ts)
        address[4] memory judges = [_unsoundOptimality(), _unsoundMaximality(), _soundOptimality(), _soundMaximality()];
        for (uint256 i; i < 4; ++i) {
            allowedJudges.push(Judge(judges[i].codehash, i % 2 == 0 ? _optimalitySelector() : _maximalitySelector()));
        }
        board = _newBoard();
        optControl = _openFunded(board, judges[0], _optimalitySelector(), POOL);
        maxControl = _openFunded(board, judges[1], _maximalitySelector(), POOL);
        optimality = _openFunded(board, judges[2], _optimalitySelector(), POOL);
        maximality = _openFunded(board, judges[3], _maximalitySelector(), POOL);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _commit(address who, uint256 id, address recipient, bytes memory claim, bytes32 salt) internal returns (bytes32 h) {
        h = board.commitmentOf(id, who, recipient, claim, salt);
        vm.prank(who);
        board.commit(id, h);
    }

    function _reveal(address who, uint256 id, address recipient, bytes memory claim, bytes32 salt) internal {
        vm.prank(who);
        board.reveal(id, recipient, claim, salt);
    }

    function _tryReveal(address who, uint256 id, address recipient, bytes memory claim, bytes32 salt)
        internal
        returns (bool ok, bytes memory err)
    {
        return _tx(who, address(board), abi.encodeCall(IBoard.reveal, (id, recipient, claim, salt)));
    }

    function _judgeOf(uint256 id) internal view returns (address judge) {
        (judge,,,,,,,,,,,,) = board.bounties(id);
    }

    function _winnerOf(uint256 id) internal view returns (address winner) {
        (,,,, winner,,,,,,,,) = board.bounties(id);
    }

    function _recipientOf(uint256 id) internal view returns (address recipient) {
        (,,,,,, recipient,,,,,,) = board.bounties(id);
    }

    function _contestEndsAt(uint256 id) internal view returns (uint64 t) {
        (,,,,,,,,, t,,,) = board.bounties(id);
    }

    function _poolOf(uint256 id) internal view returns (uint256 pool) {
        (,,,,,,,,,,, pool,) = board.bounties(id);
    }

    function _settledOf(uint256 id) internal view returns (bool settled) {
        (,,,,,,,,,, settled,,) = board.bounties(id);
    }

    function _claimFor(uint256 id) internal view returns (bytes memory) {
        return id == optControl || id == optimality ? _optimalityClaim() : _maximalityClaim();
    }
}
