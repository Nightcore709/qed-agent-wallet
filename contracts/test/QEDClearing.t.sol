// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDClearing} from "../src/QEDClearing.sol";

/// @notice Proof-gated multilateral netting: five AI businesses, 200 tUSD of mutual debt, 28 tUSD of cash.
contract QEDClearingTest is Test {
    TestUSD internal usd;
    QEDClearing internal clr;
    address[] internal agents;
    address internal prover = makeAddr("qed-prover");
    address internal mallory = makeAddr("mallory");

    string internal fx;
    uint256 internal M;
    uint256[] internal debtors;
    uint256[] internal creditors;
    uint256[] internal amounts;
    uint256 internal constant USD = 1e6;

    function setUp() public {
        fx = vm.readFile("contracts/test/fixtures/clearing.json");
        M = vm.parseJsonUint(fx, ".members");
        debtors = vm.parseJsonUintArray(fx, ".debtors");
        creditors = vm.parseJsonUintArray(fx, ".creditors");
        amounts = vm.parseJsonUintArray(fx, ".amounts");

        usd = new TestUSD();
        clr = new QEDClearing(IERC20(address(usd)));
        string[5] memory names = ["northwind", "qed", "cloudco", "helix", "atlas"];
        for (uint256 k; k < M; ++k) {
            address a = makeAddr(names[k]);
            agents.push(a);
            vm.prank(a);
            clr.join();
        }
        for (uint256 i; i < debtors.length; ++i) {
            vm.prank(agents[debtors[i]]);
            clr.issue(agents[creditors[i]], uint128(amounts[i]), uint64(block.timestamp + 30 days), bytes32(i));
        }
    }

    // ─────────────────────────── helpers ───────────────────────────

    function _u128(uint256[] memory a) internal pure returns (uint128[] memory b) {
        b = new uint128[](a.length);
        for (uint256 i; i < a.length; ++i) b[i] = uint128(a[i]);
    }

    function _ids(uint256 n) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = i + 1;
    }

    function _optimal() internal view returns (QEDClearing.Netting memory p) {
        p.ids = _ids(debtors.length);
        p.amounts = _u128(amounts);
        p.x = _u128(vm.parseJsonUintArray(fx, ".optimal.x"));
        p.potential = vm.parseJsonIntArray(fx, ".optimal.potential");
        p.y = _u128(vm.parseJsonUintArray(fx, ".optimal.y"));
    }

    function _netPositions() internal view returns (int256[] memory pos) {
        (, uint256[] memory rec, uint256[] memory pay) = clr.positions();
        pos = new int256[](rec.length);
        for (uint256 k; k < rec.length; ++k) pos[k] = int256(rec[k]) - int256(pay[k]);
    }

    // ═══════════════════════════ the happy path ═══════════════════════════

    function test_OptimalNettingExecutes_PositionsUnchanged() public {
        int256[] memory before = _netPositions();
        assertEq(clr.grossOpen(), 200 * USD);
        vm.prank(prover);
        uint256 cleared = clr.net(_optimal());
        assertEq(cleared, 169 * USD, "maximal netting");
        assertEq(clr.grossOpen(), 31 * USD);
        assertEq(clr.openCount(), 4);
        int256[] memory afterPos = _netPositions();
        for (uint256 k; k < M; ++k) assertEq(afterPos[k], before[k], "net position unchanged");
        assertEq(vm.parseJsonUint(fx, ".optimal.cleared"), cleared);
    }

    function test_GridlockThenSettlementWithExactCash() public {
        // Each agent holds only its net debit: 28 tUSD in total against 200 tUSD of gross debt.
        string[] memory np = vm.parseJsonStringArray(fx, ".netPositions");
        for (uint256 k; k < M; ++k) {
            int256 p = vm.parseInt(np[k]);
            if (p < 0) usd.mint(agents[k], uint256(-p));
            vm.prank(agents[k]);
            usd.approve(address(clr), type(uint256).max);
        }
        // Gross settlement is impossible: Northwind owes 40 and holds 18.
        vm.prank(agents[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, agents[0], 18 * USD, 40 * USD));
        clr.pay(1);

        vm.prank(prover);
        clr.net(_optimal());

        uint256[] memory order = vm.parseJsonUintArray(fx, ".settlementOrder");
        for (uint256 j; j < order.length; ++j) {
            uint256 id = order[j] + 1;
            vm.prank(clr.getObligation(id).debtor);
            clr.pay(id);
        }
        assertEq(clr.openCount(), 0, "every obligation settled");
        assertEq(clr.grossOpen(), 0);
        for (uint256 k; k < M; ++k) {
            int256 p = vm.parseInt(np[k]);
            assertEq(usd.balanceOf(agents[k]), p > 0 ? uint256(p) : 0, "everyone ends at exactly their net position");
        }
    }

    // ═══════════════════════════ a lazy or dishonest prover is rejected ═══════════════════════════

    function test_Revert_GreedyNettingIsNotProvablyMaximal() public {
        QEDClearing.Netting memory p = _optimal();
        p.x = _u128(vm.parseJsonUintArray(fx, ".greedy.x"));
        vm.prank(prover);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.NotProvablyMaximal.selector, 162 * USD, 169 * USD));
        clr.net(p);
    }

    function test_Revert_ShiftingValueBetweenMembers() public {
        QEDClearing.Netting memory p = _optimal();
        p.x[0] += uint128(1 * USD); // cancel one more tUSD of Northwind's debt to QED, nothing else
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.NetPositionChanged.selector, agents[0], int256(1 * USD)));
        clr.net(p);
    }

    function test_Revert_CancellingMoreThanOwed() public {
        QEDClearing.Netting memory p = _optimal();
        p.x[1] = p.amounts[1] + 1;
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.ExceedsObligation.selector, 2, p.amounts[1] + 1, p.amounts[1]));
        clr.net(p);
    }

    function test_Revert_HidingAnObligation() public {
        QEDClearing.Netting memory p = _optimal();
        QEDClearing.Netting memory q;
        uint256 n = p.ids.length - 1;
        q.ids = new uint256[](n);
        q.amounts = new uint128[](n);
        q.x = new uint128[](n);
        q.y = new uint128[](n);
        q.potential = p.potential;
        for (uint256 i; i < n; ++i) {
            q.ids[i] = p.ids[i];
            q.amounts[i] = p.amounts[i];
            q.x[i] = p.x[i];
            q.y[i] = p.y[i];
        }
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.IncompleteSnapshot.selector, n, n + 1));
        clr.net(q);
    }

    function test_Revert_StaleAmounts_AndReplayAfterNetting() public {
        QEDClearing.Netting memory p = _optimal();
        p.amounts[3] -= 1;
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.StaleAmount.selector, 4, p.amounts[3], p.amounts[3] + 1));
        clr.net(p);

        clr.net(_optimal());
        QEDClearing.Netting memory replay = _optimal();
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.IncompleteSnapshot.selector, 11, 4));
        clr.net(replay);
    }

    function test_Revert_ForgedDualCertificate() public {
        QEDClearing.Netting memory p = _optimal();
        p.y[1] = 0; // pretend the bound is smaller
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.DualInfeasible.selector, 2));
        clr.net(p);
    }

    function test_Revert_IdsNotIncreasing() public {
        QEDClearing.Netting memory p = _optimal();
        (p.ids[0], p.ids[1]) = (p.ids[1], p.ids[0]);
        (p.amounts[0], p.amounts[1]) = (p.amounts[1], p.amounts[0]);
        (p.x[0], p.x[1]) = (p.x[1], p.x[0]);
        (p.y[0], p.y[1]) = (p.y[1], p.y[0]);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.IdsNotIncreasing.selector, 1));
        clr.net(p);
    }

    function test_Revert_NothingToNet() public {
        QEDClearing.Netting memory p = _optimal();
        for (uint256 i; i < p.x.length; ++i) p.x[i] = 0;
        vm.expectRevert(QEDClearing.NothingToNet.selector);
        clr.net(p);
    }

    function test_Revert_PotentialOverflowGames() public {
        QEDClearing.Netting memory p = _optimal();
        p.potential[0] = type(int256).max;
        vm.expectRevert(QEDClearing.ValueOutOfRange.selector);
        clr.net(p);
    }

    // ═══════════════════════════ membership & debts ═══════════════════════════

    function test_Revert_MembershipAndDebtRules() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.NotMember.selector, mallory));
        clr.issue(agents[0], 1, 0, 0);

        vm.prank(agents[0]);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.NotMember.selector, mallory));
        clr.issue(mallory, 1, 0, 0);

        vm.prank(agents[0]);
        vm.expectRevert(QEDClearing.SelfObligation.selector);
        clr.issue(agents[0], 1, 0, 0);

        vm.prank(agents[0]);
        vm.expectRevert(QEDClearing.ZeroAmount.selector);
        clr.issue(agents[1], 0, 0, 0);

        vm.prank(agents[0]);
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.AlreadyMember.selector, agents[0]));
        clr.join();

        vm.prank(agents[1]); // the creditor cannot "pay" (move) the debtor's money
        vm.expectRevert(abi.encodeWithSelector(QEDClearing.NotDebtor.selector, agents[1]));
        clr.pay(1);
    }

    function test_OpenObligationsView() public view {
        (uint256[] memory ids, QEDClearing.Obligation[] memory obs) = clr.openObligations();
        assertEq(ids.length, 11);
        assertEq(obs[0].debtor, agents[0]);
        assertEq(obs[0].amount, 40 * USD);
    }

    // ═══════════════════════════ soundness: accepted ⇒ maximal and value-preserving ═══════════════════════════

    /// @dev Push any amount of debt around any simple cycle of the demo economy. Conservation still holds,
    ///      so the only way such a proposal can pass is to be exactly the optimum again.
    function testFuzz_AnyCirculationAroundTheOptimumIsRejected(uint256 cycleSeed, int256 t) public {
        QEDClearing.Netting memory p = _optimal();
        uint256[] memory cyc = vm.parseJsonUintArray(fx, string.concat(".cycles[", vm.toString(cycleSeed % 11), "]"));
        t = bound(t, -40e6, 40e6);
        vm.assume(t != 0);
        for (uint256 j; j < cyc.length; ++j) {
            int256 nx = int256(uint256(p.x[cyc[j]])) + t;
            vm.assume(nx >= 0);
            p.x[cyc[j]] = uint128(uint256(nx));
        }
        vm.expectRevert();
        clr.net(p);
    }

    /// @dev 60 random economies (3–7 agents, 3–16 debts): every optimal certificate is accepted with the
    ///      exact cleared amount, and wherever the greedy agent falls short it is rejected.
    function test_SixtyRandomEconomies() public {
        bytes[] memory cases = vm.parseJsonBytesArray(fx, ".randomCases");
        uint256 rejectedGreedy;
        for (uint256 c; c < cases.length; ++c) {
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
                uint256 gcleared
            ) = abi.decode(
                cases[c], (uint256, uint256[], uint256[], uint128[], uint128[], int256[], uint128[], uint256, uint128[], uint256)
            );
            QEDClearing h = new QEDClearing(IERC20(address(usd)));
            address[] memory who = new address[](m);
            for (uint256 k; k < m; ++k) {
                who[k] = address(uint160(0x10000 + c * 100 + k));
                vm.prank(who[k]);
                h.join();
            }
            for (uint256 i; i < d.length; ++i) {
                vm.prank(who[d[i]]);
                h.issue(who[cr[i]], a[i], 0, 0);
            }
            QEDClearing.Netting memory p = QEDClearing.Netting(_ids(d.length), a, x, pot, y);
            if (gcleared < cleared) {
                QEDClearing.Netting memory g = QEDClearing.Netting(_ids(d.length), a, gx, pot, y);
                vm.expectRevert(abi.encodeWithSelector(QEDClearing.NotProvablyMaximal.selector, gcleared, cleared));
                h.net(g);
                ++rejectedGreedy;
            }
            assertEq(h.net(p), cleared);
        }
        assertGt(rejectedGreedy, 0, "non-vacuous: greedy is strictly worse somewhere");
    }
}
