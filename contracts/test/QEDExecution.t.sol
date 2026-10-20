// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDVault} from "../src/QEDVault.sol";
import {QEDLens} from "../src/QEDLens.sol";
import {QEDExecution} from "../src/QEDExecution.sol";
import {CPMMPool} from "../src/venues/CPMMPool.sol";
import {TestToken} from "../src/venues/TestToken.sol";
import {ExecutionFixture as F} from "./fixtures/ExecutionFixture.sol";

/// @notice Best execution, proved on-chain. The honest route, prices, bound and output come from the
///         TypeScript solver (fixtures/ExecutionFixture.sol, generated) and must match bit for bit.
contract QEDExecutionTest is Test {
    TestUSD internal usd;
    TestToken internal eur;
    TestToken internal eth;
    QEDVault internal vault;
    QEDLens internal lens;
    QEDExecution internal exec;
    CPMMPool[] internal pools;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal cosignerPk = 0xC051;
    uint256 internal operatorPk = 0x0BE7;
    address internal owner;
    address internal cosigner;
    address internal operator;
    address internal guardian = address(0x6A2D);
    address internal reserve = address(0xE0E0); // the owner's tEUR reserve
    address internal vendor = address(0xC10D);
    address internal mallory = address(0xBAD);

    uint256 internal constant USD = 1e6;

    function setUp() public {
        vm.warp(1_790_000_000);
        owner = vm.addr(ownerPk);
        cosigner = vm.addr(cosignerPk);
        operator = vm.addr(operatorPk);

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

        vault = new QEDVault(IERC20(address(usd)), owner, operator, cosigner, guardian, 100 * USD);
        exec = new QEDExecution(vault, operator);
        vm.startPrank(owner);
        vault.setAgent(address(exec));
        exec.setVenues(addrs, fees);
        vm.stopPrank();
        usd.mint(address(vault), 100 * USD);
    }

    // ─────────────────────────── the honest trade ───────────────────────────

    function test_honestRoute_isAccepted_andMatchesTheSolverBitForBit() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(1);
        uint256 vaultBefore = usd.balanceOf(address(vault));

        QEDExecution.Hop[] memory r = _route(F.honest());
        QEDExecution.Price[] memory p = _prices(F.honestPrices());
        vm.expectEmit(true, true, true, true, address(exec));
        emit QEDExecution.BestExecution(c.intentId, address(eur), reserve, F.AMOUNT_IN, F.AMOUNT_IN, F.HONEST_OUT, F.HONEST_BOUND, 4);
        vm.prank(operator);
        (uint256 out, uint256 bound) = exec.trade(m, ms, c, cs, o, r, p);

        assertEq(bound, F.HONEST_BOUND, "on-chain bound == TypeScript replica");
        assertEq(out, F.HONEST_OUT, "realised output == TypeScript simulation");
        assertGe(out * 1e6, bound * (1e6 - 1), "within 1 ppm of the optimum");
        assertEq(eur.balanceOf(reserve), out);
        assertEq(usd.balanceOf(address(vault)), vaultBefore - F.AMOUNT_IN);
        _assertModuleEmpty();
    }

    function test_quoteBound_equalsTypeScript() public view {
        assertEq(exec.quoteBound(F.AMOUNT_IN, address(eur), _prices(F.honestPrices())), F.HONEST_BOUND);
        assertEq(exec.quoteBound(F.AMOUNT_IN, address(eur), _prices(F.forgedPrices())), F.FORGED_BOUND);
    }

    // ─────────────────────────── a compromised agent, inside a genuine co-signed order ───────────────────────────

    /// The positive control: this route clears the co-signer's 1% slippage floor, so a minOut-only
    /// wallet would execute it. Only the proof stops it.
    function test_directOnlyRoute_passesSlippage_butIsRejected() public {
        assertGe(F.DIRECT_ONLY_OUT, F.MIN_OUT, "within the slippage floor");
        _expectTradeRevert(F.directOnly(), F.honestPrices(), abi.encodeWithSelector(QEDExecution.NotBestExecution.selector, F.DIRECT_ONLY_OUT, F.HONEST_BOUND));
    }

    function test_skimOf0_6bps_isRejected() public {
        assertGe(F.NUDGED_OUT, F.MIN_OUT);
        _expectTradeRevert(F.nudged(), F.honestPrices(), abi.encodeWithSelector(QEDExecution.NotBestExecution.selector, F.NUDGED_OUT, F.HONEST_BOUND));
    }

    function test_singleVenue_failsTheSlippageFloorFirst() public {
        _expectTradeRevert(F.single(), F.honestPrices(), abi.encodeWithSelector(QEDExecution.InsufficientOutput.selector, F.SINGLE_OUT, F.MIN_OUT));
    }

    function test_noPriceVectorRescuesABadRoute() public {
        // Weak duality: every ν ≥ 0 gives an upper bound ≥ OPT, so "forging" the proof only loosens it.
        _expectTradeRevert(F.directOnly(), F.forgedPrices(), abi.encodeWithSelector(QEDExecution.NotBestExecution.selector, F.DIRECT_ONLY_OUT, F.FORGED_BOUND));
        uint256[3] memory p = F.honestPrices();
        for (uint256 k; k < 6; ++k) {
            uint256[3] memory q = p;
            if (k == 0) q[0] = p[0] / 2;
            if (k == 1) q[0] = p[0] * 2;
            if (k == 2) q[2] = 0;
            if (k == 3) q[2] = p[2] * 10;
            if (k == 4) q[0] = 0;
            if (k == 5) (q[0], q[2]) = (p[0] - p[0] / 1000, p[2] - p[2] / 1000);
            assertGe(exec.quoteBound(F.AMOUNT_IN, address(eur), _prices(q)), F.HONEST_BOUND - 1, "no price vector beats the optimum");
        }
    }

    function test_badNormalization() public {
        uint256[3] memory p = F.honestPrices();
        p[1] = 2e36;
        _expectTradeRevert(F.honest(), p, abi.encodeWithSelector(QEDExecution.BadNormalization.selector, 2e36));
    }

    function test_leftoverIntermediate_isRejected() public {
        _expectTradeRevert(F.leftover(), F.honestPrices(), abi.encodeWithSelector(QEDExecution.Leftover.selector, address(eth), _ethFromHonestLeg()));
    }

    function test_unknownVenue_isRejected() public {
        F.H[] memory r = F.honest();
        r[0].venue = 9;
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(2);
        QEDExecution.Hop[] memory hops = new QEDExecution.Hop[](1);
        hops[0] = QEDExecution.Hop(9, true, F.AMOUNT_IN);
        QEDExecution.Price[] memory p = _prices(F.honestPrices());
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.UnknownVenue.selector, 9));
        exec.trade(m, ms, c, cs, o, hops, p);
    }

    // ─────────────────────────── the order is bound by the co-signer ───────────────────────────

    function test_tamperedOrder_isRejected() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(3);
        QEDExecution.Hop[] memory r = _route(F.honest());
        QEDExecution.Price[] memory p = _prices(F.honestPrices());
        QEDExecution.Order[4] memory bad = [o, o, o, o];
        bad[0].minOut = 0;
        bad[1].recipient = vendor;
        bad[2].tolerancePpm = 10_000;
        bad[3].tokenOut = address(eth);
        for (uint256 i; i < 4; ++i) {
            bytes memory err = abi.encodeWithSelector(QEDExecution.OrderMismatch.selector, c.ref, exec.hashOrder(bad[i]));
            vm.prank(operator);
            vm.expectRevert(err);
            exec.trade(m, ms, c, cs, bad[i], r, p);
        }
    }

    function test_recipientMustBeInTheOwnerMandate() public {
        // Even a co-signer that signs an order paying Mallory cannot widen the owner's payee list.
        QEDVault.Mandate memory m = _mandate();
        bytes memory ms = _signMandate(m);
        QEDExecution.Order memory o = QEDExecution.Order(address(eur), mallory, F.MIN_OUT, 1, exec.venueSetHash());
        QEDVault.Certificate memory c = _cert(m, o, 4);
        (bytes memory cs, QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_signCert(c), _route(F.honest()), _prices(F.honestPrices()));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.RecipientNotInMandate.selector, mallory));
        exec.trade(m, ms, c, cs, o, r, p);
    }

    function test_venueChangeInvalidatesOutstandingOrders() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(5);
        address[] memory one = new address[](1);
        uint16[] memory fee = new uint16[](1);
        (one[0], fee[0]) = (address(pools[0]), 30);
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(owner);
        exec.setVenues(one, fee);
        bytes memory err = abi.encodeWithSelector(QEDExecution.VenueSetChanged.selector, o.venueSetHash, exec.venueSetHash());
        vm.prank(operator);
        vm.expectRevert(err);
        exec.trade(m, ms, c, cs, o, r, p);
    }

    function test_toleranceIsCapped() public {
        QEDVault.Mandate memory m = _mandate();
        QEDExecution.Order memory o = QEDExecution.Order(address(eur), reserve, 0, 10_001, exec.venueSetHash());
        QEDVault.Certificate memory c = _cert(m, o, 6);
        (bytes memory ms, bytes memory cs) = (_signMandate(m), _signCert(c));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.ToleranceTooLoose.selector, 10_001));
        exec.trade(m, ms, c, cs, o, r, p);
    }

    // ─────────────────────────── roles and the vault's own guarantees ───────────────────────────

    function test_onlyOperatorTrades_onlyVaultOwnerConfigures() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(7);
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.NotOperator.selector, mallory));
        exec.trade(m, ms, c, cs, o, r, p);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.NotVaultOwner.selector, operator));
        exec.setOperator(operator);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.NotVaultOwner.selector, mallory));
        exec.setVenues(new address[](0), new uint16[](0));
    }

    function test_declaredFeeMustMatchThePool() public {
        address[] memory one = new address[](1);
        uint16[] memory fee = new uint16[](1);
        (one[0], fee[0]) = (address(pools[1]), 30); // pool 1 charges 5 bps
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QEDExecution.VenueFeeMismatch.selector, address(pools[1]), 30, 5));
        exec.setVenues(one, fee);
    }

    function test_vaultLimitsReplayAndPauseStillApply() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(8);
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(operator);
        exec.trade(m, ms, c, cs, o, r, p);
        // the same certificate cannot be used twice
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.IntentAlreadyUsed.selector, c.intentId));
        exec.trade(m, ms, c, cs, o, r, p);

        vm.prank(guardian);
        vault.pause();
        (m, ms, c, cs, o) = _order(9);
        vm.prank(operator);
        vm.expectRevert(QEDVault.VaultPaused.selector);
        exec.trade(m, ms, c, cs, o, r, p);
    }

    function test_perPaymentCapStillApplies() public {
        QEDVault.Mandate memory m = _mandate();
        m.maxPerPayment = 10 * USD;
        QEDExecution.Order memory o = QEDExecution.Order(address(eur), reserve, F.MIN_OUT, 1, exec.venueSetHash());
        QEDVault.Certificate memory c = _cert(m, o, 10);
        (bytes memory ms, bytes memory cs) = (_signMandate(m), _signCert(c));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(QEDVault.ExceedsPerPaymentCap.selector, F.AMOUNT_IN, 10 * USD));
        exec.trade(m, ms, c, cs, o, r, p);
    }

    function test_payPassesThrough_butNotWithATradeCertificate() public {
        QEDVault.Mandate memory m = _mandate();
        bytes memory ms = _signMandate(m);
        QEDVault.Certificate memory c = _plainCert(m, vendor, 3 * USD, 11);
        bytes memory cs = _signCert(c);
        vm.prank(operator);
        exec.pay(m, ms, c, cs);
        assertEq(usd.balanceOf(vendor), 3 * USD);

        (,, QEDVault.Certificate memory tc, bytes memory tcs,) = _order(12);
        vm.prank(operator);
        vm.expectRevert(QEDExecution.TradeCertificateMisuse.selector);
        exec.pay(m, ms, tc, tcs);
    }

    // ─────────────────────────── market risk: what the proof does NOT cover ───────────────────────────

    /// A front-runner moves the venues after the order was co-signed. The bound is computed on the
    /// moved state (the proof is about the present), so it is the co-signed minOut that stops the trade.
    function test_frontRun_isStoppedByTheCosignedFloor() public {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(13);
        usd.mint(mallory, 200 * USD);
        vm.startPrank(mallory);
        _rawSwap(pools[0], address(usd), 40 * USD, mallory);
        _rawSwap(pools[1], address(usd), 15 * USD, mallory);
        vm.stopPrank();
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(F.honest()), _prices(F.honestPrices()));
        vm.prank(operator);
        vm.expectRevert(); // InsufficientOutput (or NotBestExecution if the stale route is also suboptimal)
        exec.trade(m, ms, c, cs, o, r, p);
    }

    // ─────────────────────────── soundness: the bound is never beaten, by any route, at any prices ───────────────────────────

    /// For random price vectors ν ≥ 0 and random routes (up to 6 hops, any venue, any direction, any
    /// amounts, venues reused), the output obtained from A tUSD never exceeds B(ν) computed beforehand.
    /// This is weak duality plus path deficiency of fee-charging constant-product pools plus the
    /// rounding direction of every step of the on-chain bound.
    function testFuzz_boundIsNeverBeaten(uint256 seed) public {
        uint256[3] memory p = F.honestPrices();
        uint256[3] memory q;
        q[1] = 1e36;
        q[0] = _scale(p[0], uint256(keccak256(abi.encode(seed, 0))));
        q[2] = _scale(p[2], uint256(keccak256(abi.encode(seed, 2))));
        uint256 bound = exec.quoteBound(F.AMOUNT_IN, address(eur), _prices(q));

        address trader = address(0x7AD3);
        usd.mint(trader, F.AMOUNT_IN);
        uint256 hops = 1 + (seed % 6);
        vm.startPrank(trader);
        for (uint256 i; i < hops; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "hop", i)));
            CPMMPool pool = pools[r % pools.length];
            address tin = (r >> 8) % 2 == 0 ? pool.token0() : pool.token1();
            uint256 bal = IERC20(tin).balanceOf(trader);
            if (bal == 0) continue;
            uint256 amt = i == hops - 1 ? bal : 1 + ((r >> 16) % bal);
            _rawSwap(pool, tin, amt, trader);
        }
        vm.stopPrank();
        assertLe(eur.balanceOf(trader), bound, "a route beat the dual bound");
    }

    /// The hard case for soundness: routes within a few percent of the optimum and price vectors within
    /// ±0.1% of the optimal ν, where the bound and the output are only a few raw units apart.
    function testFuzz_nearOptimalRoutesNeverBeatTheBound(uint256 seed) public {
        uint256[3] memory p = F.honestPrices();
        uint256 j0 = 999_000 + (uint256(keccak256(abi.encode(seed, "p0"))) % 2001);
        uint256 j2 = 999_000 + (uint256(keccak256(abi.encode(seed, "p2"))) % 2001);
        (p[0], p[2]) = ((p[0] / 1e6) * j0, (p[2] / 1e6) * j2);
        uint256 bound = exec.quoteBound(F.AMOUNT_IN, address(eur), _prices(p));

        F.H[] memory h = F.honest();
        // move up to 8% between the three source legs (h[0..2]), keeping the total at AMOUNT_IN
        uint256 r = uint256(keccak256(abi.encode(seed, "shift")));
        uint256 from = r % 3;
        uint256 to = (from + 1 + ((r >> 8) % 2)) % 3;
        uint256 shift = (h[from].amountIn * ((r >> 16) % 80_001)) / 1_000_000;
        h[from].amountIn -= shift;
        h[to].amountIn += shift;

        address trader = address(0x7AD4);
        usd.mint(trader, F.AMOUNT_IN);
        vm.startPrank(trader);
        for (uint256 i; i < h.length; ++i) {
            CPMMPool pool = pools[h[i].venue];
            address tin = _tok(h[i].sell);
            uint256 amt = h[i].amountIn == 0 ? IERC20(tin).balanceOf(trader) : h[i].amountIn;
            _rawSwap(pool, tin, amt, trader);
        }
        vm.stopPrank();
        assertLe(eur.balanceOf(trader), bound, "a near-optimal route beat the dual bound");
    }

    /// The honest bound is tight: equal to the realised optimum within the 1 ppm tolerance.
    function test_honestBoundIsTight() public pure {
        assertLe(F.HONEST_BOUND - F.HONEST_OUT, F.HONEST_BOUND / 1e6);
    }

    // ─────────────────────────── helpers ───────────────────────────

    function _scale(uint256 base, uint256 r) internal pure returns (uint256) {
        uint256 mode = r % 5;
        if (mode == 0) return 0;
        uint256 f = 1 + ((r >> 8) % 4000); // × [0.001, 4]
        return (base / 1000) * f;
    }

    function _rawSwap(CPMMPool pool, address tin, uint256 amt, address to) internal {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        bool z = tin == pool.token0();
        (uint256 rin, uint256 rout) = z ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inFee = amt * (10_000 - pool.feeBps());
        uint256 out = (inFee * rout) / (rin * 10_000 + inFee);
        if (out == 0) return;
        IERC20(tin).transfer(address(pool), amt);
        pool.swap(z ? 0 : out, z ? out : 0, to, "");
    }

    function _expectTradeRevert(F.H[] memory route, uint256[3] memory prices, bytes memory err) internal {
        (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o) = _order(uint256(keccak256(err)));
        uint256 vaultBefore = usd.balanceOf(address(vault));
        (QEDExecution.Hop[] memory r, QEDExecution.Price[] memory p) = (_route(route), _prices(prices));
        vm.prank(operator);
        vm.expectRevert(err);
        exec.trade(m, ms, c, cs, o, r, p);
        assertEq(usd.balanceOf(address(vault)), vaultBefore, "nothing moved");
    }

    function _ethFromHonestLeg() internal view returns (uint256) {
        F.H[] memory r = F.honest();
        for (uint256 i; i < r.length; ++i) {
            if (r[i].sell == 0 && (F.venues()[r[i].venue].b == 2 || F.venues()[r[i].venue].a == 2)) {
                CPMMPool p = pools[r[i].venue];
                (uint112 r0, uint112 r1,) = p.getReserves();
                bool z = p.token0() == address(usd);
                (uint256 rin, uint256 rout) = z ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                uint256 inFee = r[i].amountIn * (10_000 - p.feeBps());
                return (inFee * rout) / (rin * 10_000 + inFee);
            }
        }
        return 0;
    }

    function _assertModuleEmpty() internal view {
        assertEq(usd.balanceOf(address(exec)), 0);
        assertEq(eur.balanceOf(address(exec)), 0);
        assertEq(eth.balanceOf(address(exec)), 0);
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
        (payees[0], payees[1], payees[2]) = (reserve, vendor, address(exec));
        m = QEDVault.Mandate({
            vault: address(vault),
            agent: address(exec),
            payees: payees,
            maxPerPayment: 25 * USD,
            maxPerPeriod: 100 * USD,
            period: 1 days,
            maxTotal: 100 * USD,
            validFrom: uint64(vm.getBlockTimestamp()),
            validUntil: uint64(vm.getBlockTimestamp() + 7 days),
            epoch: vault.epoch(),
            requireCosign: true,
            purpose: keccak256("Convert surplus tUSD into the tEUR operating reserve with proven best execution"),
            salt: bytes32(uint256(4))
        });
    }

    function _order(uint256 nonce)
        internal
        view
        returns (QEDVault.Mandate memory m, bytes memory ms, QEDVault.Certificate memory c, bytes memory cs, QEDExecution.Order memory o)
    {
        m = _mandate();
        ms = _signMandate(m);
        o = QEDExecution.Order(address(eur), reserve, F.MIN_OUT, 1, exec.venueSetHash());
        c = _cert(m, o, nonce);
        cs = _signCert(c);
    }

    function _cert(QEDVault.Mandate memory m, QEDExecution.Order memory o, uint256 nonce) internal view returns (QEDVault.Certificate memory c) {
        c = _plainCert(m, address(exec), F.AMOUNT_IN, nonce);
        c.ref = exec.hashOrder(o);
    }

    function _plainCert(QEDVault.Mandate memory m, address to, uint256 amount, uint256 nonce) internal view returns (QEDVault.Certificate memory c) {
        c = QEDVault.Certificate({
            mandateHash: this.hashMandateExt(m),
            recipient: to,
            amount: amount,
            dueAt: 0,
            intentId: keccak256(abi.encode("intent", nonce)),
            evidenceHash: keccak256(abi.encode("decision-record", nonce)),
            ref: bytes32(0),
            notBefore: uint64(vm.getBlockTimestamp()),
            expiresAt: uint64(vm.getBlockTimestamp() + 1 hours),
            epoch: vault.epoch()
        });
    }

    function hashMandateExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.hashMandate(m);
    }

    function mandateDigestExt(QEDVault.Mandate calldata m) external view returns (bytes32) {
        return lens.mandateDigest(vault, m);
    }

    function _signMandate(QEDVault.Mandate memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, this.mandateDigestExt(m));
        return abi.encodePacked(r, s, v);
    }

    function _signCert(QEDVault.Certificate memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerPk, lens.certificateDigest(vault, c));
        return abi.encodePacked(r, s, v);
    }
}
