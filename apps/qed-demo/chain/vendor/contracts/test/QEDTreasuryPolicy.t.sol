// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDVault} from "../src/QEDVault.sol";
import {QEDLens} from "../src/QEDLens.sol";
import {QEDExecution} from "../src/QEDExecution.sol";
import {QEDTreasuryPolicy} from "../src/QEDTreasuryPolicy.sol";
import {CPMMPool} from "../src/venues/CPMMPool.sol";
import {TestToken} from "../src/venues/TestToken.sol";
import {ExecutionFixture as F} from "./fixtures/ExecutionFixture.sol";

/// @notice The owner's standing policy, enforced on-chain around a best-execution trade. The tranche is the
///         fixture's 20 tUSD honest route (18.086846 tEUR, 111.5 bps against the direct venues' mid).
contract QEDTreasuryPolicyTest is Test {
    TestUSD internal usd;
    TestToken internal eur;
    TestToken internal eth;
    QEDVault internal treasury;
    QEDVault internal reserve;
    QEDLens internal lens;
    QEDExecution internal exec;
    QEDTreasuryPolicy internal pol;
    CPMMPool[] internal pools;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal cosignerPk = 0xC051;
    uint256 internal agentPk = 0x0BE7;
    address internal owner;
    address internal cosigner;
    address internal agent;
    address internal guardian = address(0x6A2D);
    address internal creditor = address(0xC10D);
    address internal mallory = address(0xBAD);

    uint256 internal constant USD = 1e6;
    uint256 internal constant FREE0 = 20 * USD; // the reserve's free tEUR before each test

    function setUp() public {
        vm.warp(1_790_000_000);
        owner = vm.addr(ownerPk);
        cosigner = vm.addr(cosignerPk);
        agent = vm.addr(agentPk);

        usd = new TestUSD();
        eur = new TestToken("QED Test Euro", "tEUR", 6);
        eth = new TestToken("QED Test Ether", "tETH", 18);
        lens = new QEDLens();

        F.V[] memory vs = F.venues();
        address[] memory addrs = new address[](vs.length);
        uint16[] memory fees = new uint16[](vs.length);
        for (uint256 i; i < vs.length; ++i) {
            CPMMPool p = new CPMMPool(_tok(vs[i].a), _tok(vs[i].b), vs[i].feeBps);
            _mint(vs[i].a, address(p), vs[i].ra);
            _mint(vs[i].b, address(p), vs[i].rb);
            p.sync();
            pools.push(p);
            addrs[i] = address(p);
            fees[i] = vs[i].feeBps;
        }

        treasury = new QEDVault(IERC20(address(usd)), owner, agent, cosigner, guardian, 100 * USD);
        reserve = new QEDVault(IERC20(address(eur)), owner, address(0xDEAD), cosigner, guardian, 0);
        exec = new QEDExecution(treasury, agent);
        pol = new QEDTreasuryPolicy(exec, reserve, agent);
        vm.startPrank(owner);
        treasury.setAgent(address(exec));
        exec.setVenues(addrs, fees);
        exec.setOperator(address(pol)); // the agent's key can now trade only through the policy
        vm.stopPrank();
        usd.mint(address(treasury), 100 * USD);
        eur.mint(address(reserve), FREE0);
    }

    // ─────────────────────────── the policy holds, and an honest tranche passes ───────────────────────────

    function test_honestTranche_underThePolicy_isAccepted() public {
        _setPolicy(FREE0 + 25 * USD, 150, 10); // shortfall 25 > 18.09: the tranche does not over-convert
        uint256 mid = pol.midOut(F.AMOUNT_IN);
        (uint256 out, uint256 freeAfter) = _convert(1, "");
        assertEq(out, F.HONEST_OUT, "the same best-execution trade");
        assertEq(freeAfter, FREE0 + F.HONEST_OUT);
        assertGe(out * 10_000, mid * (10_000 - 150), "cost within 150 bps of mid");
        assertLt(out * 10_000, mid * (10_000 - 100), "and above 100 bps: the next test's limit bites");
        _assertModuleAndPolicyEmpty();
    }

    function test_trancheThatExactlyCoversTheNeed_isAccepted() public {
        // shortfall just above out·(1 − 0.1%): no smaller tranche provably covers it
        uint256 shortfall = F.HONEST_OUT - (F.HONEST_OUT * 10) / 10_000 + 1;
        _setPolicy(FREE0 + shortfall, 150, 10);
        (, uint256 freeAfter) = _convert(2, "");
        assertGe(freeAfter, FREE0 + shortfall, "target met with this tranche");
    }

    function test_midPriceReference_isTheDirectVenuesDepthWeightedMid() public view {
        // venues 0, 1 and 4 trade tUSD/tEUR directly: mid = ΣR_eur / ΣR_usd
        F.V[] memory vs = F.venues();
        uint256 depthIn;
        uint256 depthOut;
        for (uint256 i; i < vs.length; ++i) {
            if (vs[i].a == 0 && vs[i].b == 1) (depthIn, depthOut) = (depthIn + vs[i].ra, depthOut + vs[i].rb);
            if (vs[i].a == 1 && vs[i].b == 0) (depthIn, depthOut) = (depthIn + vs[i].rb, depthOut + vs[i].ra);
        }
        assertEq(pol.midOut(F.AMOUNT_IN), (F.AMOUNT_IN * depthOut) / depthIn);
    }

    // ─────────────────────────── what the chain now refuses, even with both hot keys stolen ───────────────────────────

    function test_noShortfall_noTrade() public {
        _setPolicy(FREE0, 150, 10);
        _convert(3, abi.encodeWithSelector(QEDTreasuryPolicy.NoShortfall.selector, FREE0, FREE0));
    }

    function test_overConversion_isRefused() public {
        // shortfall 15 tEUR: 99.9% of this tranche provably buys more than 15, so the agent converted too much
        _setPolicy(FREE0 + 15 * USD, 150, 10);
        _convert(4, abi.encodeWithSelector(QEDTreasuryPolicy.OverConversion.selector, FREE0, F.HONEST_OUT, FREE0 + 15 * USD));
    }

    function test_executionCostAboveTheLimit_isRefused() public {
        _setPolicy(FREE0 + 25 * USD, 100, 10);
        uint256 mid = pol.midOut(F.AMOUNT_IN);
        _convert(5, abi.encodeWithSelector(QEDTreasuryPolicy.ExecutionCostTooHigh.selector, F.HONEST_OUT, mid, uint16(100)));
    }

    function test_trancheOutsideTheOwnersBounds_isRefused() public {
        _setPolicyFull(FREE0 + 25 * USD, 2 * USD, 15 * USD, 150, 10, uint64(block.timestamp + 1 days));
        _convert(6, abi.encodeWithSelector(QEDTreasuryPolicy.TrancheOutOfBounds.selector, F.AMOUNT_IN, 2 * USD, 15 * USD));
    }

    function test_lapsedOrRevokedPolicy_isRefused() public {
        _setPolicy(FREE0 + 25 * USD, 150, 10);
        vm.warp(block.timestamp + 2 days);
        _convert(7, abi.encodeWithSelector(QEDTreasuryPolicy.PolicyLapsed.selector, uint64(1_790_000_000 + 1 days), block.timestamp));
        vm.warp(1_790_000_000);
        _setPolicy(FREE0 + 25 * USD, 150, 10);
        vm.prank(owner);
        pol.revoke();
        _convert(8, abi.encodeWithSelector(QEDTreasuryPolicy.PolicyLapsed.selector, uint64(0), block.timestamp));
    }

    function test_agentCannotBypassThePolicy() public {
        _setPolicy(FREE0, 150, 10); // no shortfall: the policy would refuse
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(9, address(reserve));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.NotOperator.selector, agent));
        exec.trade(m, ms, c, cs, o, r, p);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(QEDTreasuryPolicy.NotAgent.selector, mallory));
        pol.convert(m, ms, c, cs, o, r, p);
    }

    function test_orderMustPayTheReserve() public {
        _setPolicy(FREE0 + 25 * USD, 150, 10);
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(10, creditor);
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDTreasuryPolicy.WrongOrder.selector, address(eur), creditor));
        pol.convert(m, ms, c, cs, o, r, p);
    }

    function test_ringFencingCreatesTheShortfall() public {
        _setPolicy(FREE0 + 5 * USD, 150, 10);
        _convert(11, abi.encodeWithSelector(QEDTreasuryPolicy.OverConversion.selector, FREE0, F.HONEST_OUT, FREE0 + 5 * USD));
        // the owner ring-fences 15 tEUR for a creditor: free drops to 5, and a full tranche is now needed
        vm.prank(owner);
        reserve.ringFence(creditor, 15 * USD, uint64(block.timestamp + 7 days), keccak256("invoice"));
        assertEq(reserve.freeBalance(), FREE0 - 15 * USD);
        (, uint256 freeAfter) = _convert(12, "");
        assertEq(freeAfter, FREE0 - 15 * USD + F.HONEST_OUT);
    }

    function test_onlyTheOwnerSetsThePolicy() public {
        QEDTreasuryPolicy.Policy memory p = QEDTreasuryPolicy.Policy(FREE0, USD, 25 * USD, 150, 10, uint64(block.timestamp + 1 days));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDTreasuryPolicy.NotOwner.selector, agent));
        pol.setPolicy(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDTreasuryPolicy.NotOwner.selector, agent));
        pol.setAgent(mallory);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(QEDTreasuryPolicy.NotOwner.selector, agent));
        pol.revoke();
        p.maxImpactBps = 1_001;
        vm.prank(owner);
        vm.expectRevert(QEDTreasuryPolicy.InvalidPolicy.selector);
        pol.setPolicy(p);
        p.maxImpactBps = 150;
        p.minTranche = 30 * USD;
        vm.prank(owner);
        vm.expectRevert(QEDTreasuryPolicy.InvalidPolicy.selector);
        pol.setPolicy(p);
    }

    /// Whatever target the owner sets, a tranche either satisfies every clause of the policy or reverts with the
    /// clause it breaks; nothing in between, and nothing moves on a revert.
    function testFuzz_everyAcceptedTrancheSatisfiesThePolicy(uint256 target, uint16 kappa, uint16 slack) public {
        target = bound(target, 1, 80 * USD);
        kappa = uint16(bound(kappa, 0, 1_000));
        slack = uint16(bound(slack, 0, 1_000));
        _setPolicyFull(target, USD, 25 * USD, kappa, slack, uint64(block.timestamp + 1 days));
        uint256 mid = pol.midOut(F.AMOUNT_IN);
        uint256 treasuryBefore = usd.balanceOf(address(treasury));
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(13, address(reserve));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(agent);
        try pol.convert(m, ms, c, cs, o, r, p) returns (uint256 out) {
            assertLt(FREE0, target, "a shortfall existed");
            assertGe(out * 10_000, mid * (10_000 - kappa), "cost within the limit");
            uint256 smaller = F.AMOUNT_IN - (F.AMOUNT_IN * slack) / 10_000;
            assertLt(FREE0 * F.AMOUNT_IN + out * smaller, target * F.AMOUNT_IN, "no provable over-conversion");
            assertEq(reserve.freeBalance(), FREE0 + out);
        } catch {
            assertEq(usd.balanceOf(address(treasury)), treasuryBefore, "nothing moved");
            assertEq(reserve.freeBalance(), FREE0);
            bool shouldFail = FREE0 >= target || F.HONEST_OUT * 10_000 < mid * (10_000 - kappa)
                || FREE0 * F.AMOUNT_IN + F.HONEST_OUT * (F.AMOUNT_IN - (F.AMOUNT_IN * slack) / 10_000) >= target * F.AMOUNT_IN;
            assertTrue(shouldFail, "refused only when a clause is broken");
        }
        _assertModuleAndPolicyEmpty();
    }

    // ─────────────────────────── helpers ───────────────────────────

    function _setPolicy(uint256 target, uint16 kappa, uint16 slack) internal {
        _setPolicyFull(target, USD, 25 * USD, kappa, slack, uint64(block.timestamp + 1 days));
    }

    function _setPolicyFull(uint256 target, uint256 minT, uint256 maxT, uint16 kappa, uint16 slack, uint64 until) internal {
        vm.prank(owner);
        pol.setPolicy(QEDTreasuryPolicy.Policy(target, minT, maxT, kappa, slack, until));
    }

    function _convert(uint256 nonce, bytes memory err) internal returns (uint256 out, uint256 freeAfter) {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(nonce, address(reserve));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        uint256 treasuryBefore = usd.balanceOf(address(treasury));
        uint256 freeBefore = reserve.freeBalance();
        vm.prank(agent);
        if (err.length > 0) {
            vm.expectRevert(err);
            pol.convert(m, ms, c, cs, o, r, p);
            assertEq(usd.balanceOf(address(treasury)), treasuryBefore, "nothing moved");
            assertEq(reserve.freeBalance(), freeBefore);
            return (0, freeBefore);
        }
        out = pol.convert(m, ms, c, cs, o, r, p);
        freeAfter = reserve.freeBalance();
    }

    function _assertModuleAndPolicyEmpty() internal view {
        for (uint256 i; i < 3; ++i) {
            assertEq(IERC20(_tok(uint8(i))).balanceOf(address(exec)), 0);
            assertEq(IERC20(_tok(uint8(i))).balanceOf(address(pol)), 0);
        }
    }

    function _tok(uint8 s) internal view returns (address) {
        return s == 0 ? address(usd) : s == 1 ? address(eur) : address(eth);
    }

    function _mint(uint8 s, address to, uint256 amt) internal {
        if (s == 0) usd.mint(to, amt);
        else if (s == 1) eur.mint(to, amt);
        else eth.mint(to, amt);
    }

    function _route(F.H[] memory r) internal view returns (QEDExecution.Hop[] memory hops) {
        hops = new QEDExecution.Hop[](r.length);
        for (uint256 i; i < r.length; ++i) {
            hops[i] = QEDExecution.Hop(r[i].venue, pools[r[i].venue].token0() == _tok(r[i].sell), r[i].amountIn);
        }
    }

    function _prices(uint256[3] memory v) internal view returns (QEDExecution.Price[] memory p) {
        p = new QEDExecution.Price[](3);
        for (uint8 s; s < 3; ++s) p[s] = QEDExecution.Price(_tok(s), v[s]);
    }

    function _mandate() internal view returns (QEDVault.Mandate memory m) {
        address[] memory payees = new address[](3);
        (payees[0], payees[1], payees[2]) = (address(reserve), creditor, address(exec));
        m = QEDVault.Mandate({
            vault: address(treasury),
            agent: address(exec),
            payees: payees,
            maxPerPayment: 25 * USD,
            maxPerPeriod: 100 * USD,
            period: 1 days,
            maxTotal: 100 * USD,
            validFrom: uint64(vm.getBlockTimestamp()),
            validUntil: uint64(vm.getBlockTimestamp() + 7 days),
            epoch: treasury.epoch(),
            requireCosign: true,
            purpose: keccak256("Keep the euro reserve funded under a standing policy"),
            salt: bytes32(uint256(5))
        });
    }

    function _order(uint256 nonce, address recipient)
        internal
        view
        returns (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o)
    {
        m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, this.mandateDigestExt(m));
        ms = abi.encodePacked(r, s, v);
        o = QEDExecution.Order(address(eur), recipient, F.MIN_OUT, 1, exec.venueSetHash());
        c = QEDVault.Certificate({
            mandateHash: this.hashMandateExt(m),
            recipient: address(exec),
            amount: F.AMOUNT_IN,
            dueAt: 0,
            intentId: keccak256(abi.encode("policy-intent", nonce)),
            evidenceHash: keccak256(abi.encode("policy-record", nonce)),
            ref: exec.hashOrder(o),
            notBefore: uint64(vm.getBlockTimestamp()),
            expiresAt: uint64(vm.getBlockTimestamp() + 1 hours),
            epoch: treasury.epoch()
        });
        (v, r, s) = vm.sign(cosignerPk, lens.certificateDigest(treasury, c));
        cs = abi.encodePacked(r, s, v);
    }

    function hashMandateExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.hashMandate(m);
    }

    function mandateDigestExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.mandateDigest(treasury, m);
    }
}
