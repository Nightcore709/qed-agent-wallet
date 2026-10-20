// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  CPMMPool — a constant-product venue with the Uniswap V2 pair interface
/// @notice A trading venue for the testnet demonstration. It follows the Uniswap V2 pair interface
///         and invariant exactly (`getReserves`, `token0`, `token1`, `swap`, `sync`, and the K check
///         `(b0·10⁴ − in0·f)(b1·10⁴ − in1·f) ≥ r0·r1·10⁸`), with the fee `f` in basis points as a
///         constructor parameter (Uniswap V2 is the special case f = 30). Liquidity is provided by
///         transferring tokens and calling `sync()`; there are no LP shares and no flash swaps.
///         It is a venue, not a product: QEDExecution only reads reserves and calls `swap`, so it
///         works unchanged against any pair that exposes this interface.
contract CPMMPool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    /// @notice Swap fee in basis points, charged on the input amount.
    uint16 public immutable feeBps;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 private unlocked = 1;

    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    error Locked();
    error IdenticalTokens();
    error ZeroAddress();
    error FeeTooHigh(uint16 feeBps);
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error InsufficientInputAmount();
    error K();
    error Overflow();
    error FlashSwapsUnsupported();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address tokenA, address tokenB, uint16 feeBps_) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (feeBps_ >= 10_000) revert FeeTooHigh(feeBps_);
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        feeBps = feeBps_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// @notice Uniswap V2 semantics: send the input first, then request the output.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (data.length != 0) revert FlashSwapsUnsupported();
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 r0, uint112 r1) = (reserve0, reserve1);
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();
        if (to == token0 || to == token1) revert InvalidTo();

        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));

        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        if (in0 == 0 && in1 == 0) revert InsufficientInputAmount();
        uint256 adj0 = b0 * 10_000 - in0 * feeBps;
        uint256 adj1 = b1 * 10_000 - in1 * feeBps;
        if (adj0 * adj1 < uint256(r0) * uint256(r1) * 1e8) revert K();

        _update(b0, b1);
        emit Swap(msg.sender, in0, in1, amount0Out, amount1Out, to);
    }

    /// @notice Sets reserves to balances. Adding liquidity = transfer both tokens, then sync.
    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    function _update(uint256 b0, uint256 b1) private {
        if (b0 > type(uint112).max || b1 > type(uint112).max) revert Overflow();
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
}
