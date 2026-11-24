// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSD (tUSD)
/// @notice Valueless 6-decimal test stablecoin used by the QED demonstration.
/// @dev    Anyone can draw from the faucet once per day so that external reviewers can
///         reproduce the full lifecycle on testnet with their own keys. The minter is the
///         deployer and can seed demo accounts. THIS TOKEN HAS NO VALUE.
contract TestUSD is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6; // 1,000 tUSD
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    address public immutable minter;
    mapping(address => uint256) public lastFaucetAt;

    error NotMinter();
    error FaucetCoolingDown(uint256 availableAt);

    constructor() ERC20("QED Test USD", "tUSD") {
        minter = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Draw 1,000 tUSD once per 24h. Lets any reviewer reproduce the demo.
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCoolingDown(last + FAUCET_COOLDOWN);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
