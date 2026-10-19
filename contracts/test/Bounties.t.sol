// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDClearing} from "../src/QEDClearing.sol";
import {IProofVerifier} from "../src/interfaces/IProofVerifier.sol";
import {MinVarianceVerifier} from "../src/verifiers/MinVarianceVerifier.sol";
import {OptimalityBounty} from "../src/bounties/OptimalityBounty.sol";
import {MaximalityBounty} from "../src/bounties/MaximalityBounty.sol";

/// @dev An unsound verifier that accepts anything: the positive control showing a bounty really pays.
contract AcceptAnything is IProofVerifier {
    function verify(bytes calldata, bytes calldata) external pure returns (bytes32) {
        return bytes32(0);
    }

    function problemClass() external pure returns (string memory) {
        return "unsound";
    }
}

/// @dev An acceptance rule that under-reports what it cleared by 7 tUSD: the positive control for netting.
contract UnsoundMaximality is MaximalityBounty {
    constructor(IERC20 t) MaximalityBounty(t) {}

    function accepts(Economy calldata e, Certified calldata p) public pure override returns (uint256) {
        return super.accepts(e, p) - 7e6;
    }
}

/// @notice Theorems with money on them. Each bounty holds 1 000 tUSD and pays it to anyone who refutes
///         the theorem it guards; these tests try hard, and check the payout path against unsound rules.
contract BountiesTest is Test {
    TestUSD internal usd;
    MinVarianceVerifier internal verifier;
    OptimalityBounty internal ob;
    MaximalityBounty internal mb;
    address internal hunter = makeAddr("bounty-hunter");

    string internal mfx;
    string internal cfx;
    bytes internal spec;
    bytes internal honest;
    uint256 internal n;
    uint256[][] internal cycles;

    int256 internal constant W = 1e18;
    uint256 internal constant POOL = 1_000e6;

    function setUp() public {
        usd = new TestUSD();
        verifier = new MinVarianceVerifier();
        ob = new OptimalityBounty(IProofVerifier(address(verifier)), IERC20(address(usd)));
        mb = new MaximalityBounty(IERC20(address(usd)));
        usd.mint(address(ob), POOL);
        usd.mint(address(mb), POOL);
        mfx = vm.readFile("contracts/test/fixtures/minvar.json");
        cfx = vm.readFile("contracts/test/fixtures/clearing.json");
        spec = vm.parseJsonBytes(mfx, ".spec");
        honest = vm.parseJsonBytes(mfx, ".honest");
        n = vm.parseJsonUint(mfx, ".n");
        for (uint256 k; k < 11; ++k) cycles.push(vm.parseJsonUintArray(cfx, string.concat(".cycles[", vm.toString(k), "]")));
    }

    // ═══════════════════════════ OptimalityBounty ═══════════════════════════

    function _equalWeight() internal view returns (int256[] memory x) {
        x = new int256[](n);
        int256 s;
        for (uint256 i; i < n; ++i) {
            x[i] = W / int256(n);
            s += x[i];
        }
        x[0] += W - s;
    }

    function test_Optimality_EqualWeightPortfolioCannotRefute() public {
        vm.expectPartialRevert(OptimalityBounty.TheoremHolds.selector);
        vm.prank(hunter);
        ob.claim(spec, honest, _equalWeight());
        assertEq(usd.balanceOf(address(ob)), POOL);
    }

    function test_Optimality_TheCertifiedPortfolioItselfHasZeroAdvantage() public {
        (int256[] memory w,,,) = abi.decode(honest, (int256[], int256, int256[], int256[]));
        int256 s;
        for (uint256 i; i < n; ++i) s += w[i];
        w[0] += W - s; // the certificate's budget may deviate by ≤ τ; a challenger must be exactly feasible
        vm.expectPartialRevert(OptimalityBounty.TheoremHolds.selector);
        ob.claim(spec, honest, w);
    }

    /// Any feasible portfolio at all: the theorem says none beats the certificate by more than the bound.
    function testFuzz_Optimality_NoFeasiblePortfolioRefutesTheTheorem(uint64[6] memory raw) public {
        int256[] memory x = new int256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) total += raw[i % 6];
        vm.assume(total > 0);
        int256 s;
        for (uint256 i; i < n; ++i) {
            x[i] = int256((uint256(raw[i % 6]) * uint256(W)) / total);
            s += x[i];
        }
        x[0] += W - s;
        vm.expectPartialRevert(OptimalityBounty.TheoremHolds.selector);
        ob.claim(spec, honest, x);
    }

    function test_Optimality_ForgedCertificateCannotEvenEnter() public {
        bytes memory forged = vm.parseJsonBytes(mfx, ".equalWeight");
        vm.expectPartialRevert(MinVarianceVerifier.DualityGapTooLarge.selector);
        ob.claim(spec, forged, _equalWeight());
    }

    function test_Optimality_ChallengerMustBeFeasible() public {
        int256[] memory x = _equalWeight();
        x[1] += 1;
        vm.expectRevert(OptimalityBounty.NotFeasible.selector);
        ob.claim(spec, honest, x);
        x[1] -= 1;
        x[0] += 5e17;
        x[2] -= 5e17; // budget still 1, but a negative weight
        vm.expectRevert(OptimalityBounty.NotFeasible.selector);
        ob.claim(spec, honest, x);
    }

    /// Positive control: against a verifier that accepts anything, the bounty pays the first real refutation.
    function test_Optimality_PaysOutAgainstAnUnsoundVerifier() public {
        OptimalityBounty bad = new OptimalityBounty(IProofVerifier(address(new AcceptAnything())), IERC20(address(usd)));
        usd.mint(address(bad), POOL);
        (int256[] memory w,,,) = abi.decode(honest, (int256[], int256, int256[], int256[]));
        int256[] memory worst = new int256[](n);
        worst[3] = W; // all in the most volatile asset, "certified" by the unsound verifier
        bytes memory lie = abi.encode(worst, int256(0), new int256[](n), new int256[]((n * (n + 1)) / 2));
        int256 s;
        for (uint256 i; i < n; ++i) s += w[i];
        w[0] += W - s;
        vm.prank(hunter);
        uint256 paid = bad.claim(spec, lie, w);
        assertEq(paid, POOL);
        assertEq(usd.balanceOf(hunter), POOL);
    }

    // ═══════════════════════════ MaximalityBounty ═══════════════════════════

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

    function test_Maximality_DemoEconomyAcceptedAt169() public view {
        assertEq(mb.accepts(_economy(), _optimal()), 169e6);
    }

    function test_Maximality_GreedyNettingCannotRefute() public {
        vm.expectRevert(abi.encodeWithSelector(MaximalityBounty.TheoremHolds.selector, 169e6, 162e6));
        mb.claim(_economy(), _optimal(), vm.parseJsonUintArray(cfx, ".greedy.x"));
    }

    /// Random circulations assembled from the economy's simple cycles: none clears more than the certificate.
    function testFuzz_Maximality_NoCirculationBeatsTheCertificate(uint256 seed) public {
        MaximalityBounty.Economy memory e = _economy();
        uint256 m = e.d.length;
        uint256[] memory x = new uint256[](m);
        for (uint256 k; k < cycles.length; ++k) {
            uint256[] memory cyc = cycles[k];
            uint256 cap = type(uint256).max;
            for (uint256 t; t < cyc.length; ++t) {
                uint256 room = e.d[cyc[t]] - x[cyc[t]];
                if (room < cap) cap = room;
            }
            uint256 alpha = cap == 0 ? 0 : uint256(keccak256(abi.encode(seed, k))) % (cap + 1);
            for (uint256 t; t < cyc.length; ++t) x[cyc[t]] += alpha;
        }
        uint256 total = mb.validNetting(e, x); // a genuine circulation within the debts
        assertLe(total, 169e6);
        vm.expectPartialRevert(MaximalityBounty.TheoremHolds.selector);
        mb.claim(e, _optimal(), x);
    }

    /// The bounty's acceptance rule agrees with the deployed QEDClearing on every generated economy.
    function test_Maximality_AgreesWithQEDClearingOnSixtyEconomies() public {
        bytes[] memory cases = vm.parseJsonBytesArray(cfx, ".randomCases");
        for (uint256 cIdx; cIdx < cases.length; ++cIdx) {
            (
                uint256 m,
                uint256[] memory d,
                uint256[] memory cr,
                uint128[] memory a,
                uint128[] memory x,
                int256[] memory pot,
                uint128[] memory y,
                uint256 cleared,
                uint128[] memory gx,
            ) = abi.decode(
                cases[cIdx], (uint256, uint256[], uint256[], uint128[], uint128[], int256[], uint128[], uint256, uint128[], uint256)
            );
            MaximalityBounty.Economy memory e = MaximalityBounty.Economy(m, d, cr, _u(a));
            MaximalityBounty.Certified memory p = MaximalityBounty.Certified(_u(x), pot, _u(y));
            assertEq(mb.accepts(e, p), cleared, "bounty rule");

            QEDClearing h = new QEDClearing(IERC20(address(usd)));
            address[] memory who = new address[](m);
            for (uint256 k; k < m; ++k) {
                who[k] = address(uint160(0x20000 + cIdx * 100 + k));
                vm.prank(who[k]);
                h.join();
            }
            uint256[] memory ids = new uint256[](d.length);
            for (uint256 i; i < d.length; ++i) {
                vm.prank(who[d[i]]);
                h.issue(who[cr[i]], a[i], 0, 0);
                ids[i] = i + 1;
            }
            assertEq(h.net(QEDClearing.Netting(ids, a, x, pot, y)), cleared, "deployed rule");

            vm.expectPartialRevert(MaximalityBounty.TheoremHolds.selector);
            mb.claim(e, p, _u(gx));
        }
    }

    /// Positive control: an acceptance rule that under-reports gets refuted and pays out.
    function test_Maximality_PaysOutAgainstAnUnsoundRule() public {
        UnsoundMaximality bad = new UnsoundMaximality(IERC20(address(usd)));
        usd.mint(address(bad), POOL);
        vm.prank(hunter);
        uint256 paid = bad.claim(_economy(), _optimal(), _optimal().x);
        assertEq(paid, POOL);
        assertEq(usd.balanceOf(hunter), POOL);
    }

    function _u(uint128[] memory a) internal pure returns (uint256[] memory b) {
        b = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) b[i] = a[i];
    }
}
