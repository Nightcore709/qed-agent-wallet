// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IProofVerifier — a checker for a certifying computation
/// @notice A verifier decides, cheaply and deterministically, whether `solution` is a correct answer
///         to the problem `spec`. It never solves the problem itself: the provider (an AI agent) does
///         the expensive work and must attach a certificate (witness) that makes checking cheap.
/// @dev    MUST revert with a descriptive custom error if the certificate is invalid.
///         MUST be view/pure (called with STATICCALL from the escrow).
interface IProofVerifier {
    /// @return resultDigest A compact, verifier-defined summary of the verified result
    ///         (e.g. the certified objective value), recorded on-chain at settlement.
    function verify(bytes calldata spec, bytes calldata solution) external view returns (bytes32 resultDigest);

    /// @notice Human-readable identifier of the problem class this verifier certifies.
    function problemClass() external pure returns (string memory);
}
