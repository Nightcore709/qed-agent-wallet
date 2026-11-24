// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "qed/src/TestUSD.sol";
import {IProofVerifier} from "qed/src/interfaces/IProofVerifier.sol";
import {MinVarianceVerifier} from "qed/src/verifiers/MinVarianceVerifier.sol";
import {OptimalityBounty} from "qed/src/bounties/OptimalityBounty.sol";
import {MaximalityBounty} from "qed/src/bounties/MaximalityBounty.sol";
// The release's own positive controls, imported unmodified from the vendored suite (Bounties.t.sol:13-31).
import {AcceptAnything, UnsoundMaximality} from "qed/test/Bounties.t.sol";
import {IBoard} from "./IBoard.sol";
import {Judge} from "../src/QEDBountyBoard.sol";

/// @notice The release's fixtures, positive controls and recorded challenges, built exactly as the release builds them:
///         its test suite (vendor/contracts/test/Bounties.t.sol, setUp :52-65, positive controls :129-144 and :232-240)
///         and, for the five claims recorded on Sepolia on 19 Oct 2026 (BA1-BA3, BM1-BM2), its script
///         (R/agent/scripts/private.ts:226-246; read-only). minvar.json is job #1's certificate: its bound equals the
///         recorded one (30005320910997774926000000000000000000000000000).
abstract contract BoardFixtures is Test {
    string internal constant FIXTURES = "../vendor/contracts/test/fixtures/";
    int256 internal constant W = 1e18;
    uint256 internal constant POOL = 1_000e6; // 1,000 tUSD: TestUSD has 6 decimals (TestUSD.sol:12,25-27)
    uint64 internal constant DELAY = 60; //       seconds a commitment ages before it may be revealed
    uint64 internal constant WINDOW = 86_400; //  seconds after that during which it may be revealed
    uint64 internal constant CONTEST = 300; //    seconds after the first valid reveal

    TestUSD internal usd;
    MinVarianceVerifier internal verifier;
    string internal mfx;
    string internal cfx;
    bytes internal spec;
    bytes internal honest;
    uint256 internal n;

    function _loadFixtures() internal {
        usd = new TestUSD();
        verifier = new MinVarianceVerifier();
        mfx = vm.readFile(string.concat(FIXTURES, "minvar.json"));
        cfx = vm.readFile(string.concat(FIXTURES, "clearing.json"));
        spec = vm.parseJsonBytes(mfx, ".spec");
        honest = vm.parseJsonBytes(mfx, ".honest");
        n = vm.parseJsonUint(mfx, ".n");
    }

    // ───────────────────────────── judges ─────────────────────────────

    /// @dev The sound pool as deployed on Sepolia: the unmodified OptimalityBounty over MinVarianceVerifier.
    function _soundOptimality() internal returns (address) {
        return address(new OptimalityBounty(IProofVerifier(address(verifier)), IERC20(address(usd))));
    }

    /// @dev The sound pool as deployed on Sepolia: the unmodified MaximalityBounty.
    function _soundMaximality() internal returns (address) {
        return address(new MaximalityBounty(IERC20(address(usd))));
    }

    /// @dev The release's positive control: the unmodified OptimalityBounty over a verifier that accepts anything.
    function _unsoundOptimality() internal returns (address) {
        return address(new OptimalityBounty(IProofVerifier(address(new AcceptAnything())), IERC20(address(usd))));
    }

    /// @dev The release's positive control: an acceptance rule that under-reports what it cleared by 7 tUSD.
    function _unsoundMaximality() internal returns (address) {
        return address(new UnsoundMaximality(IERC20(address(usd))));
    }

    function _optimalitySelector() internal pure returns (bytes4) {
        return OptimalityBounty.claim.selector;
    }

    function _maximalitySelector() internal pure returns (bytes4) {
        return MaximalityBounty.claim.selector;
    }

    // ───────────────────────────── claims ─────────────────────────────

    /// @dev The release's optimality positive-control claim (Bounties.t.sol:133-141): a "certificate" for everything in
    ///      the most volatile asset, beaten by the honest optimum. Valid against the unsound pool only.
    function _optimalityClaim() internal view returns (bytes memory) {
        (int256[] memory w,,,) = abi.decode(honest, (int256[], int256, int256[], int256[]));
        int256[] memory worst = new int256[](n);
        worst[3] = W;
        bytes memory lie = abi.encode(worst, int256(0), new int256[](n), new int256[]((n * (n + 1)) / 2));
        int256 s;
        for (uint256 i; i < n; ++i) {
            s += w[i];
        }
        w[0] += W - s;
        return abi.encodeCall(OptimalityBounty.claim, (spec, lie, w));
    }

    /// @dev The release's netting positive-control claim (Bounties.t.sol:237): the certified netting itself (169 tUSD)
    ///      as the "larger" netting against the under-reported 162. Valid against the unsound rule only.
    function _maximalityClaim() internal view returns (bytes memory) {
        MaximalityBounty.Certified memory p = _optimal();
        return abi.encodeCall(MaximalityBounty.claim, (_economy(), p, p.x));
    }

    /// @dev BA1 (private.ts:228-231): the equal-weight portfolio against job #1's certificate.
    function _ba1() internal view returns (bytes memory) {
        return abi.encodeCall(OptimalityBounty.claim, (spec, honest, _equalWeight()));
    }

    /// @dev BA2 (private.ts:232-236, 275-280): job #1's own weights with 0.1% (W / 1000) moved from the largest
    ///      position to the second largest.
    function _ba2() internal view returns (bytes memory) {
        (int256[] memory w,,,) = abi.decode(honest, (int256[], int256, int256[], int256[]));
        (uint256 top, uint256 second) = _twoLargest(w);
        w[top] -= W / 1000;
        w[second] += W / 1000;
        return abi.encodeCall(OptimalityBounty.claim, (spec, honest, w));
    }

    /// @dev BA3 (private.ts:237): the forged 1/N certificate (the fixture's `equalWeight` solution) with job #1's weights.
    function _ba3() internal view returns (bytes memory) {
        (int256[] memory w,,,) = abi.decode(honest, (int256[], int256, int256[], int256[]));
        return abi.encodeCall(OptimalityBounty.claim, (spec, vm.parseJsonBytes(mfx, ".equalWeight"), w));
    }

    /// @dev BM1 (private.ts:239-242): the greedy netting (162 tUSD) against the certified 169.
    function _bm1() internal view returns (bytes memory) {
        return abi.encodeCall(MaximalityBounty.claim, (_economy(), _optimal(), vm.parseJsonUintArray(cfx, ".greedy.x")));
    }

    /// @dev BM2 (private.ts:243-245): the certified netting with 1 tUSD more cancelled on debt 0 (170 tUSD).
    function _bm2() internal view returns (bytes memory) {
        MaximalityBounty.Certified memory p = _optimal();
        uint256[] memory bigger = new uint256[](p.x.length);
        for (uint256 i; i < p.x.length; ++i) {
            bigger[i] = p.x[i];
        }
        bigger[0] += 1e6;
        return abi.encodeCall(MaximalityBounty.claim, (_economy(), p, bigger));
    }

    function _equalWeight() internal view returns (int256[] memory x) {
        x = new int256[](n);
        int256 s;
        for (uint256 i; i < n; ++i) {
            x[i] = W / int256(n);
            s += x[i];
        }
        x[0] += W - s;
    }

    function _twoLargest(int256[] memory w) internal pure returns (uint256 top, uint256 second) {
        top = w[0] >= w[1] ? 0 : 1;
        second = 1 - top;
        for (uint256 i = 2; i < w.length; ++i) {
            if (w[i] > w[top]) {
                second = top;
                top = i;
            } else if (w[i] > w[second]) {
                second = i;
            }
        }
    }

    function _economy() internal view returns (MaximalityBounty.Economy memory e) {
        e.members = vm.parseJsonUint(cfx, ".members");
        e.debtor = vm.parseJsonUintArray(cfx, ".debtors");
        e.creditor = vm.parseJsonUintArray(cfx, ".creditors");
        e.d = vm.parseJsonUintArray(cfx, ".amounts");
    }

    function _optimal() internal view returns (MaximalityBounty.Certified memory p) {
        p.x = vm.parseJsonUintArray(cfx, ".optimal.x");
        p.potential = vm.parseJsonIntArray(cfx, ".optimal.potential");
        p.y = vm.parseJsonUintArray(cfx, ".optimal.y");
    }

    // ───────────────────────────── the board ─────────────────────────────

    /// @dev The judges a board allows from its construction (R13), each with its claim function (review fix F7);
    ///      `_newBoard()` implementations pass this list.
    Judge[] internal allowedJudges;

    /// @dev Opens a bounty on `board` with the default periods and funds it with `amount` minted for the purpose. A
    ///      judge the board does not allow yet is allowed first by this test contract, the board's deployer (R13): the
    ///      tests that use this helper are about the claim path, not the allowlist (test/JudgeAllowlist.t.sol is).
    function _openFunded(IBoard board, address judge, bytes4 selector, uint256 amount) internal returns (uint256 id) {
        if (board.judgeClaim(judge.codehash) == bytes4(0)) board.setJudge(judge.codehash, selector);
        id = board.open(judge, IERC20(address(usd)), selector, DELAY, WINDOW, CONTEST);
        if (amount > 0) _fund(board, id, amount);
    }

    function _fund(IBoard board, uint256 id, uint256 amount) internal {
        address funder = makeAddr("funder");
        usd.mint(funder, amount);
        vm.startPrank(funder);
        usd.approve(address(board), amount);
        board.fund(id, amount);
        vm.stopPrank();
    }

    /// @dev Sends `data` to `to` from `from` as one call; returns success and the return or revert data.
    function _tx(address from, address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = to.call(data);
    }
}
