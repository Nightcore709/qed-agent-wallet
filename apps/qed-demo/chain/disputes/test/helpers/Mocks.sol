// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IProofVerifier} from "qed/src/interfaces/IProofVerifier.sol";

/// @notice TEST ONLY. A plain token anyone can mint (2 decimals, like the wallet's tINR).
contract MockToken is ERC20 {
    constructor() ERC20("Test Rupee", "tINR") {}

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice TEST ONLY. A token that burns 1% of every transfer: the dispute escrow must refuse it.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice TEST ONLY. Accepts exactly the solution "ok" and reports keccak256(spec); refuses anything else, as the
///         release's verifiers refuse a bad certificate with a revert.
contract MockVerifier is IProofVerifier {
    error Counterfeit();

    function verify(bytes calldata spec, bytes calldata solution) external pure returns (bytes32) {
        if (keccak256(solution) != keccak256("ok")) revert Counterfeit();
        return keccak256(spec);
    }

    function problemClass() external pure returns (string memory) {
        return "test.mock/v1";
    }
}
