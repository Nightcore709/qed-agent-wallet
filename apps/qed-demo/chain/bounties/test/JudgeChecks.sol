// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OptimalityBounty} from "qed/src/bounties/OptimalityBounty.sol";
import {IProofVerifier} from "qed/src/interfaces/IProofVerifier.sol";
import {TestUSD} from "qed/src/TestUSD.sol";
import {Judge} from "../src/QEDBountyBoard.sol";
import {BoardFixtures} from "./BoardFixtures.sol";
import {IBoard} from "./IBoard.sol";

/// @dev A judge that accepts any claim and keeps the loan: if it could be opened and funded, its pool would be stranded.
contract KeepsTheLoan {
    function claim(bytes calldata, bytes calldata, int256[] calldata) external pure returns (uint256) {
        return 0;
    }
}

/// @notice R13: the judge allowlist. Shared by the real board (test/JudgeAllowlist.t.sol, expected to pass) and the
///         seeded twin whose `open` ignores the list (seeded/SeededTwins.t.sol, expected to fail).
abstract contract JudgeChecks is BoardFixtures {
    address internal stranger = makeAddr("stranger");
    address internal finder = makeAddr("finder");
    address internal finderVault = makeAddr("finder's vault");
    bytes32 internal constant SALT = keccak256("the finder's secret salt");
    bytes4 internal constant JUDGE_NOT_ALLOWED = bytes4(keccak256("JudgeNotAllowed(address,bytes32)"));
    bytes4 internal constant NOT_DEPLOYER = bytes4(keccak256("NotDeployer(address)"));
    bytes4 internal constant BAD_CONFIG = bytes4(keccak256("BadConfig()"));
    bytes4 internal constant WRONG_SELECTOR = bytes4(keccak256("WrongSelector(bytes4)"));
    bytes4 internal constant WRONG_TOKEN = bytes4(keccak256("WrongToken(address)"));

    function _newBoard() internal virtual returns (IBoard);

    IBoard internal board;
    address[4] internal judges;

    function setUp() public {
        vm.warp(1_800_000_000);
        _loadFixtures();
        // the four judges the wallet's chain opens (rail/bounties.ts): the two originals and the two positive controls
        judges = [_soundOptimality(), _soundMaximality(), _unsoundOptimality(), _unsoundMaximality()];
        for (uint256 i; i < 4; ++i) allowedJudges.push(Judge(judges[i].codehash, _selectorOf(i)));
        board = _newBoard();
    }

    /// The claim function of judges[i]: optimality for 0 and 2, maximality for 1 and 3.
    function _selectorOf(uint256 i) internal pure returns (bytes4) {
        return i % 2 == 0 ? _optimalitySelector() : _maximalitySelector();
    }

    function _open(address judge, address by) internal returns (bool ok, bytes memory ret) {
        return _openWith(judge, IERC20(address(usd)), _optimalitySelector(), by);
    }

    function _openWith(address judge, IERC20 token, bytes4 selector, address by) internal returns (bool ok, bytes memory ret) {
        return _tx(by, address(board), abi.encodeCall(IBoard.open, (judge, token, selector, DELAY, WINDOW, CONTEST)));
    }

    function test_Allowlist_TheFourJudgesAreAllowedFromConstruction_AndAnyoneOpensWithThem() public {
        assertEq(board.deployer(), address(this));
        for (uint256 i; i < 4; ++i) {
            assertEq(board.judgeClaim(judges[i].codehash), _selectorOf(i));
            (bool ok,) = _openWith(judges[i], IERC20(address(usd)), _selectorOf(i), stranger);
            assertTrue(ok, "an allowed judge opens");
        }
        assertEq(board.bountyCount(), 4);
        // the same code over the same verifier and token is the same judge
        address again = address(new OptimalityBounty(IProofVerifier(address(verifier)), IERC20(address(usd))));
        assertEq(again.codehash, judges[0].codehash);
        (bool ok2,) = _open(again, stranger);
        assertTrue(ok2);
    }

    function test_Allowlist_AJudgeThatKeepsThePoolCannotBeOpened_SoNoPoolIsStranded() public {
        address bad = address(new KeepsTheLoan());
        (bool ok, bytes memory ret) = _open(bad, stranger);
        assertFalse(ok, "a judge outside the allowlist was opened");
        assertEq(ret, abi.encodeWithSelector(JUDGE_NOT_ALLOWED, bad, bad.codehash));
        assertEq(board.bountyCount(), 0);
    }

    function test_Allowlist_TheSameCodeOverAnotherTokenOrVerifierIsAnotherJudge() public {
        TestUSD other = new TestUSD();
        address otherToken = address(new OptimalityBounty(IProofVerifier(address(verifier)), IERC20(address(other))));
        assertTrue(otherToken.codehash != judges[0].codehash);
        (bool ok,) = _open(otherToken, stranger);
        assertFalse(ok, "the same code over another token was opened");
    }

    function test_Allowlist_OnlyTheDeployerChangesIt_AndOnlyForBountiesOpenedLater() public {
        bytes32 h = judges[2].codehash; // the optimality positive control: claimable
        (bool ok, bytes memory ret) = _tx(stranger, address(board), abi.encodeCall(IBoard.setJudge, (h, bytes4(0))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(NOT_DEPLOYER, stranger));
        uint256 id = _openFunded(board, judges[2], _optimalitySelector(), POOL);
        board.setJudge(h, bytes4(0));
        assertEq(board.judgeClaim(h), bytes4(0));
        (ok,) = _open(judges[2], stranger);
        assertFalse(ok, "a disallowed judge opens no new bounty");
        // the bounty already open is untouched: its finder commits, reveals and is paid
        bytes memory claim = _optimalityClaim();
        bytes32 c = board.commitmentOf(id, finder, finderVault, claim, SALT);
        vm.prank(finder);
        board.commit(id, c);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(finder);
        board.reveal(id, finderVault, claim, SALT);
        vm.warp(vm.getBlockTimestamp() + CONTEST);
        board.settle(id);
        assertEq(usd.balanceOf(finderVault), POOL);
    }

    function test_Allowlist_RefusesTheHashesOfNoAccountAndOfAnAccountWithoutCode() public {
        vm.expectRevert(BAD_CONFIG);
        board.setJudge(bytes32(0), _optimalitySelector());
        vm.expectRevert(BAD_CONFIG);
        board.setJudge(keccak256(""), _optimalitySelector());
    }

    /// Review fix F7: an allowed judge opens only with its own claim function and its own token. Before, either could be
    /// the opener's choice: every reveal then failed (PoolNotReturned) and the pool, which nobody can withdraw, stayed.
    function test_Binding_AnAllowedJudgeOpensOnlyWithItsOwnClaimFunctionAndToken() public {
        // the optimality judge with the maximality claim function
        (bool ok, bytes memory ret) = _openWith(judges[0], IERC20(address(usd)), _maximalitySelector(), stranger);
        assertFalse(ok, "opened with another claim function");
        assertEq(ret, abi.encodeWithSelector(WRONG_SELECTOR, _optimalitySelector()));
        // the optimality judge over another token than the one it pays
        TestUSD other = new TestUSD();
        (ok, ret) = _openWith(judges[0], IERC20(address(other)), _optimalitySelector(), stranger);
        assertFalse(ok, "opened over another token");
        assertEq(ret, abi.encodeWithSelector(WRONG_TOKEN, address(usd)));
        assertEq(board.bountyCount(), 0);
        // its own claim function and token: it opens
        (ok,) = _openWith(judges[0], IERC20(address(usd)), _optimalitySelector(), stranger);
        assertTrue(ok);
    }

    function testFuzz_Allowlist_OpenAcceptsExactlyTheAllowedCodeHashes(bool allow, uint8 extra) public {
        // a judge contract whose code differs from the four (extra immutables via another token)
        TestUSD t = new TestUSD();
        address j = address(new OptimalityBounty(IProofVerifier(address(uint160(uint256(keccak256(abi.encode(extra)))))), IERC20(address(t))));
        if (allow) board.setJudge(j.codehash, _optimalitySelector());
        (bool ok,) = _openWith(j, IERC20(address(t)), _optimalitySelector(), stranger);
        assertEq(ok, allow);
    }
}
