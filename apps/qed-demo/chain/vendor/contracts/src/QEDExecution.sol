// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {QEDVault} from "./QEDVault.sol";

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title  QEDExecution — trades by an AI agent that must prove best execution, atomically
/// @author QED team (FinTechathon 2026, Topic F)
/// @notice Lets the agent of a {QEDVault} convert the vault's asset into another token, under one rule:
///         the output it actually receives must be within `tolerancePpm` of the best output ANY route
///         could have obtained through the owner's venues, from the state the trade executes against.
///
///         The agent proves this with a price vector ν — one number per token (ν_out = 1). By weak
///         Lagrangian duality for routing through constant-product markets (Angeris et al., 2022),
///         for every ν ≥ 0 the best achievable output from spending A of the input token is at most
///
///             B(ν) = ν_in · A + Σ_venues Σ_directions ( √(ν_b R_b) − √(ν_a R_a / γ) )₊²
///
///         where a venue with reserves (R_a, R_b) and fee 1 − γ sells b for a. Each term is the closed-form
///         value of the venue's best trade at prices ν. The bound is computed here, in O(venues), from
///         live reserves, rounded so that it never understates; the swaps then run; and the realised
///         output — measured as a balance change, not reported — must satisfy
///
///             out ≥ (1 − τ) · B(ν)     ⟹     out ≥ (1 − τ) · OPT.
///
///         The route is unconstrained: any split, any number of hops, through any of the owner's venues.
///         The price vector cannot be forged into acceptance: every ν gives a valid upper bound, so a
///         dishonest agent can only fail to prove. An honest agent passes because strong duality holds
///         (the routing problem is convex), and its solver finds the ν where B(ν) = OPT.
///
///         Composition with the vault: this module is the vault's `agent`. Funds reach it only through
///         `QEDVault.executePayment` (owner mandate, co-signer certificate, caps, solvency), within the
///         same transaction, and the certificate's `ref` binds the order (output token, recipient,
///         minimum output, tolerance, venue set). The AI's hot key is `operator` here. Nothing is ever
///         left in this contract between transactions.
contract QEDExecution is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Venue {
        address pool;
        address token0;
        address token1;
        uint16 feeBps;
    }

    /// @notice What the co-signer approves. Its EIP-712 hash is the certificate's `ref`.
    struct Order {
        address tokenOut;
        address recipient; //      must be a payee in the owner-signed mandate
        uint256 minOut; //         market-risk floor, set by the co-signer's independent quote
        uint32 tolerancePpm; //    best-execution tolerance τ in parts per million
        bytes32 venueSetHash; //   the venue set the bound ranges over
    }

    /// @notice One swap. `amountIn == 0` spends everything this trade has received of the input token.
    struct Hop {
        uint8 venue;
        bool zeroForOne;
        uint256 amountIn;
    }

    /// @notice ν for one token: output-token units per unit of `token`, scaled by PRICE_ONE.
    struct Price {
        address token;
        uint256 value;
    }

    bytes32 public constant ORDER_TYPEHASH =
        keccak256("Order(address tokenOut,address recipient,uint256 minOut,uint32 tolerancePpm,bytes32 venueSetHash)");
    uint256 public constant PRICE_ONE = 1e36;
    uint256 public constant PPM = 1_000_000;
    uint32 public constant MAX_TOLERANCE_PPM = 10_000;
    uint256 public constant MAX_VENUES = 16;
    uint256 public constant MAX_HOPS = 32;

    QEDVault public immutable vault;
    IERC20 public immutable asset;
    address public operator;
    bytes32 public venueSetHash;
    Venue[] private _venues;

    event BestExecution(
        bytes32 indexed intentId,
        address indexed tokenOut,
        address indexed recipient,
        uint256 amountIn,
        uint256 spent,
        uint256 amountOut,
        uint256 bound,
        uint256 hops
    );
    event VenuesSet(bytes32 indexed venueSetHash, uint256 count);
    event OperatorSet(address indexed operator);

    error NotVaultOwner(address caller);
    error NotOperator(address caller);
    error ZeroAddress();
    error TooManyVenues(uint256 count);
    error VenueFeeMismatch(address pool, uint16 declared, uint16 actual);
    error InvalidFee(uint16 feeBps);
    error NotATradeCertificate();
    error OrderMismatch(bytes32 certified, bytes32 provided);
    error InvalidTokenOut(address tokenOut);
    error RecipientNotInMandate(address recipient);
    error VenueSetChanged(bytes32 ordered, bytes32 current);
    error ToleranceTooLoose(uint32 tolerancePpm);
    error InvalidRoute(uint256 hops);
    error UnknownVenue(uint8 venue);
    error ZeroOutputHop(uint256 hop);
    error FundingMismatch(uint256 received, uint256 certified);
    error Leftover(address token, uint256 amount);
    error BadNormalization(uint256 priceOfOutput);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error NotBestExecution(uint256 amountOut, uint256 bound);
    error TradeCertificateMisuse();

    constructor(QEDVault vault_, address operator_) {
        if (address(vault_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        vault = vault_;
        asset = vault_.asset();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    modifier onlyVaultOwner() {
        if (msg.sender != vault.owner()) revert NotVaultOwner(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Owner configuration
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice The vault owner names the venues the agent may trade on. Changing them invalidates every
    ///         outstanding order (orders commit to the venue-set hash).
    function setVenues(address[] calldata pools, uint16[] calldata fees) external onlyVaultOwner {
        if (pools.length > MAX_VENUES || pools.length != fees.length) revert TooManyVenues(pools.length);
        delete _venues;
        for (uint256 i; i < pools.length; ++i) {
            if (pools[i] == address(0)) revert ZeroAddress();
            if (fees[i] >= 10_000) revert InvalidFee(fees[i]);
            // A pool that reports its own fee must agree with the declared one (Uniswap V2 pairs do not
            // report it: their fee is the protocol constant 30 bps, declared by the owner).
            (bool ok, bytes memory ret) = pools[i].staticcall(abi.encodeWithSignature("feeBps()"));
            if (ok && ret.length == 32) {
                uint16 actual = abi.decode(ret, (uint16));
                if (actual != fees[i]) revert VenueFeeMismatch(pools[i], fees[i], actual);
            }
            _venues.push(Venue(pools[i], IV2Pair(pools[i]).token0(), IV2Pair(pools[i]).token1(), fees[i]));
        }
        venueSetHash = keccak256(abi.encode(_venues));
        emit VenuesSet(venueSetHash, pools.length);
    }

    function setOperator(address operator_) external onlyVaultOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Agent entry points (operator = the AI's hot key)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Converts `c.amount` of the vault's asset into `order.tokenOut` for `order.recipient`
    ///         along `route`, and proves best execution with `prices`.
    /// @return amountOut  realised output, delivered to the recipient
    /// @return bound      the on-chain upper bound on the best achievable output
    function trade(
        QEDVault.Mandate calldata m,
        bytes calldata ownerSig,
        QEDVault.Certificate calldata c,
        bytes calldata cosignerSig,
        Order calldata order,
        Hop[] calldata route,
        Price[] calldata prices
    ) external nonReentrant returns (uint256 amountOut, uint256 bound) {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _checkOrder(m, c, order);
        if (route.length == 0 || route.length > MAX_HOPS) revert InvalidRoute(route.length);

        // 1 · The bound, from the exact reserves the swaps below will execute against.
        bound = _dualBound(c.amount, order.tokenOut, prices);

        // 2 · Snapshot this contract's balances so that only this trade's flows are counted.
        (address[] memory tokens, uint256[] memory pre) = _snapshot(order.tokenOut);

        // 3 · Funding through the vault: mandate, co-signature, caps and solvency all apply.
        vault.executePayment(m, ownerSig, c, cosignerSig);
        uint256 received = asset.balanceOf(address(this)) - pre[0];
        if (received != c.amount) revert FundingMismatch(received, c.amount);

        // 4 · The agent's route, unconstrained.
        for (uint256 i; i < route.length; ++i) {
            _swap(route[i], i, tokens, pre);
        }

        // 5 · Nothing may be left behind; unspent input returns to the vault.
        for (uint256 k = 2; k < tokens.length; ++k) {
            uint256 bal = IERC20(tokens[k]).balanceOf(address(this));
            if (bal != pre[k]) revert Leftover(tokens[k], bal - pre[k]);
        }
        uint256 rest = asset.balanceOf(address(this)) - pre[0];
        if (rest > 0) asset.safeTransfer(address(vault), rest);

        // 6 · The two output checks: market risk (co-signed floor) and best execution (proof).
        amountOut = IERC20(order.tokenOut).balanceOf(address(this)) - pre[1];
        if (amountOut < order.minOut) revert InsufficientOutput(amountOut, order.minOut);
        if (amountOut * PPM < bound * (PPM - order.tolerancePpm)) revert NotBestExecution(amountOut, bound);

        IERC20(order.tokenOut).safeTransfer(order.recipient, amountOut);
        emit BestExecution(c.intentId, order.tokenOut, order.recipient, c.amount, c.amount - rest, amountOut, bound, route.length);
    }

    /// @notice Ordinary payments still work: the module forwards them to the vault unchanged.
    function pay(
        QEDVault.Mandate calldata m,
        bytes calldata ownerSig,
        QEDVault.Certificate calldata c,
        bytes calldata cosignerSig
    ) external nonReentrant returns (uint256 liabilityId) {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (c.recipient == address(this)) revert TradeCertificateMisuse();
        return vault.executePayment(m, ownerSig, c, cosignerSig);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice The upper bound B(ν) the trade would be held to right now (pre-flight and dashboards).
    function quoteBound(uint256 amountIn, address tokenOut, Price[] calldata prices) external view returns (uint256) {
        return _dualBound(amountIn, tokenOut, prices);
    }

    function venues() external view returns (Venue[] memory) {
        return _venues;
    }

    function hashOrder(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(ORDER_TYPEHASH, o.tokenOut, o.recipient, o.minOut, o.tolerancePpm, o.venueSetHash));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    function _checkOrder(QEDVault.Mandate calldata m, QEDVault.Certificate calldata c, Order calldata order) private view {
        if (c.recipient != address(this) || c.dueAt != 0) revert NotATradeCertificate();
        bytes32 h = hashOrder(order);
        if (c.ref != h) revert OrderMismatch(c.ref, h);
        if (order.tokenOut == address(asset) || order.tokenOut == address(0)) revert InvalidTokenOut(order.tokenOut);
        // `m` is authenticated by the vault (owner signature) inside this same transaction.
        bool listed;
        for (uint256 i; i < m.payees.length; ++i) {
            if (m.payees[i] == order.recipient) {
                listed = true;
                break;
            }
        }
        if (!listed || order.recipient == address(this)) revert RecipientNotInMandate(order.recipient);
        if (order.venueSetHash != venueSetHash) revert VenueSetChanged(order.venueSetHash, venueSetHash);
        if (order.tolerancePpm > MAX_TOLERANCE_PPM) revert ToleranceTooLoose(order.tolerancePpm);
    }

    /// @dev B(ν)·PRICE_ONE accumulated exactly, every rounding step in the direction that enlarges B.
    function _dualBound(uint256 amountIn, address tokenOut, Price[] calldata prices) private view returns (uint256) {
        uint256 nuOut = _price(prices, tokenOut);
        if (nuOut != PRICE_ONE) revert BadNormalization(nuOut);
        uint256 acc = _price(prices, address(asset)) * amountIn;
        uint256 n = _venues.length;
        for (uint256 i; i < n; ++i) {
            Venue memory v = _venues[i];
            (uint112 r0, uint112 r1,) = IV2Pair(v.pool).getReserves();
            uint256 w0 = _price(prices, v.token0) * r0; // ν₀R₀
            uint256 w1 = _price(prices, v.token1) * r1; // ν₁R₁
            acc += _venueValue(w1, w0, v.feeBps) + _venueValue(w0, w1, v.feeBps);
        }
        return Math.ceilDiv(acc, PRICE_ONE);
    }

    /// @dev max over trades selling a for b of  ν_b·out − ν_a·in  =  (√(ν_b R_b) − √(ν_a R_a / γ))₊².
    ///      Upper-rounded: ceil √ of the first term, floor √ of the (floor-divided) second.
    function _venueValue(uint256 wBuy, uint256 wSell, uint16 feeBps) private pure returns (uint256) {
        uint256 s = Math.sqrt(wBuy, Math.Rounding.Ceil);
        uint256 t = Math.sqrt(Math.mulDiv(wSell, 10_000, 10_000 - feeBps), Math.Rounding.Floor);
        return s > t ? (s - t) * (s - t) : 0;
    }

    function _price(Price[] calldata prices, address token) private pure returns (uint256) {
        for (uint256 i; i < prices.length; ++i) {
            if (prices[i].token == token) return prices[i].value;
        }
        return 0; // ν = 0 is a valid (if loose) dual price: missing prices only weaken the agent's proof
    }

    /// @dev tokens[0] = asset, tokens[1] = tokenOut, then every other venue token once.
    function _snapshot(address tokenOut) private view returns (address[] memory tokens, uint256[] memory pre) {
        uint256 n = _venues.length;
        address[] memory buf = new address[](2 * n + 2);
        buf[0] = address(asset);
        buf[1] = tokenOut;
        uint256 len = 2;
        for (uint256 i; i < n; ++i) {
            len = _push(buf, len, _venues[i].token0);
            len = _push(buf, len, _venues[i].token1);
        }
        tokens = new address[](len);
        pre = new uint256[](len);
        for (uint256 k; k < len; ++k) {
            tokens[k] = buf[k];
            pre[k] = IERC20(buf[k]).balanceOf(address(this));
        }
    }

    function _push(address[] memory buf, uint256 len, address t) private pure returns (uint256) {
        for (uint256 k; k < len; ++k) {
            if (buf[k] == t) return len;
        }
        buf[len] = t;
        return len + 1;
    }

    function _swap(Hop calldata h, uint256 index, address[] memory tokens, uint256[] memory pre) private {
        if (h.venue >= _venues.length) revert UnknownVenue(h.venue);
        Venue memory v = _venues[h.venue];
        (address tokenIn) = h.zeroForOne ? v.token0 : v.token1;
        uint256 amountIn = h.amountIn;
        if (amountIn == 0) {
            uint256 base;
            for (uint256 k; k < tokens.length; ++k) {
                if (tokens[k] == tokenIn) base = pre[k];
            }
            amountIn = IERC20(tokenIn).balanceOf(address(this)) - base;
        }
        (uint112 r0, uint112 r1,) = IV2Pair(v.pool).getReserves();
        (uint256 rIn, uint256 rOut) = h.zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = amountIn * (10_000 - v.feeBps);
        uint256 out = (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
        if (out == 0) revert ZeroOutputHop(index);
        IERC20(tokenIn).safeTransfer(v.pool, amountIn);
        (uint256 out0, uint256 out1) = h.zeroForOne ? (uint256(0), out) : (out, uint256(0));
        IV2Pair(v.pool).swap(out0, out1, address(this), "");
    }
}
