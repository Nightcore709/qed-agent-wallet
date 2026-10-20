// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Valueless test token with configurable decimals, minted only by its deployer. Used for the
///         second currency (tEUR, 6 decimals) and the bridge asset (tETH, 18 decimals) of the
///         best-execution run. THIS TOKEN HAS NO VALUE.
contract TestToken is ERC20 {
    address public immutable minter;
    uint8 private immutable _decimals;

    error NotMinter();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        minter = msg.sender;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
