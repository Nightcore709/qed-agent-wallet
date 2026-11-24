// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";

/// @title  ProofEscrow — agent-to-agent work that settles on a mathematical proof, not on trust
/// @notice Lifecycle:
///           1. QUOTE    The provider agent signs an EIP-712 Quote binding price, payee, problem spec
///                       hash, verifier and deadline. Neither side can alter these terms afterwards.
///           2. OPEN     The client funds the escrow by presenting the provider-signed quote.
///           3. DELIVER  The provider submits the solution WITH its certificate. The escrow asks the
///                       quote's verifier to check it. Valid ⇒ instant payment to the payee.
///                       Invalid ⇒ the transaction reverts with the exact violated condition.
///           4. REFUND   If no valid certificate arrives by the deadline, anyone can return the
///                       funds to the client.
///         No reviewer, oracle, arbitrator or "client acceptance" step exists: acceptance is a theorem.
contract ProofEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Quote {
        address provider; //  signer: the agent that will do the work
        address payee; //     where payment goes (e.g. the agent's QEDVault)
        address client; //    0 = any client may accept; otherwise only this client
        address token;
        uint256 price;
        address verifier; //  IProofVerifier that defines "correct"
        bytes32 specHash; //  keccak256 of the exact problem specification
        uint64 deliverBy; //  delivery deadline
        uint64 validUntil; // quote must be accepted before this time
        bytes32 quoteId; //   provider-unique id (replay protection)
    }

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Job {
        address client;
        address provider;
        address payee;
        address token;
        uint256 price;
        address verifier;
        bytes32 specHash;
        uint64 deliverBy;
        Status status;
        bytes32 quoteHash;
        bytes32 solutionHash;
        bytes32 resultDigest;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address provider,address payee,address client,address token,uint256 price,address verifier,bytes32 specHash,uint64 deliverBy,uint64 validUntil,bytes32 quoteId)"
    );

    uint256 public jobCount;
    mapping(uint256 => Job) internal _jobs;
    mapping(bytes32 => bool) public quoteUsed;

    event JobOpened(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address payee,
        address token,
        uint256 price,
        address verifier,
        bytes32 specHash,
        uint64 deliverBy,
        bytes32 quoteHash
    );
    event JobSettled(
        uint256 indexed jobId, address indexed payee, uint256 price, bytes32 solutionHash, bytes32 resultDigest
    );
    event JobRefunded(uint256 indexed jobId, address indexed client, uint256 price);

    error NotQuotedClient(address caller, address quotedClient);
    error QuoteExpired(uint64 validUntil);
    error InvalidDeadline(uint64 deliverBy);
    error InvalidQuote();
    error BadProviderSignature();
    error QuoteAlreadyUsed(bytes32 quoteId);
    error JobNotOpen(uint256 jobId);
    error NotProvider(address caller);
    error DeadlinePassed(uint64 deliverBy);
    error SpecMismatch(bytes32 expected, bytes32 provided);
    error NotRefundableYet(uint64 deliverBy);

    constructor() EIP712("ProofEscrow", "1") {}

    /// @notice Client accepts a provider-signed quote and funds the job.
    function open(Quote calldata q, bytes calldata providerSig) external nonReentrant returns (uint256 jobId) {
        if (q.client != address(0) && q.client != msg.sender) revert NotQuotedClient(msg.sender, q.client);
        if (block.timestamp > q.validUntil) revert QuoteExpired(q.validUntil);
        if (q.deliverBy <= block.timestamp) revert InvalidDeadline(q.deliverBy);
        if (
            q.price == 0 || q.provider == address(0) || q.payee == address(0) || q.token == address(0)
                || q.verifier == address(0)
        ) revert InvalidQuote();

        bytes32 qHash = hashQuote(q);
        if (!SignatureChecker.isValidSignatureNow(q.provider, _hashTypedDataV4(qHash), providerSig)) {
            revert BadProviderSignature();
        }
        bytes32 key = keccak256(abi.encode(q.provider, q.quoteId));
        if (quoteUsed[key]) revert QuoteAlreadyUsed(q.quoteId);
        quoteUsed[key] = true;

        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        j.client = msg.sender;
        j.provider = q.provider;
        j.payee = q.payee;
        j.token = q.token;
        j.price = q.price;
        j.verifier = q.verifier;
        j.specHash = q.specHash;
        j.deliverBy = q.deliverBy;
        j.status = Status.Open;
        j.quoteHash = qHash;

        IERC20(q.token).safeTransferFrom(msg.sender, address(this), q.price);
        emit JobOpened(
            jobId, msg.sender, q.provider, q.payee, q.token, q.price, q.verifier, q.specHash, q.deliverBy, qHash
        );
    }

    /// @notice Provider delivers a solution + certificate. Pays out iff the verifier accepts it.
    function deliver(uint256 jobId, bytes calldata spec, bytes calldata solution) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert JobNotOpen(jobId);
        if (msg.sender != j.provider) revert NotProvider(msg.sender);
        if (block.timestamp > j.deliverBy) revert DeadlinePassed(j.deliverBy);
        bytes32 specHash = keccak256(spec);
        if (specHash != j.specHash) revert SpecMismatch(j.specHash, specHash);

        // Reverts with the precise violated condition if the certificate is invalid.
        bytes32 digest = IProofVerifier(j.verifier).verify(spec, solution);

        j.status = Status.Settled;
        j.solutionHash = keccak256(solution);
        j.resultDigest = digest;
        IERC20(j.token).safeTransfer(j.payee, j.price);
        emit JobSettled(jobId, j.payee, j.price, j.solutionHash, digest);
    }

    /// @notice After the deadline anyone may return unsettled funds to the client.
    ///         Before the deadline only the provider may (voluntarily) release the client.
    function refund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert JobNotOpen(jobId);
        if (block.timestamp <= j.deliverBy && msg.sender != j.provider) revert NotRefundableYet(j.deliverBy);
        j.status = Status.Refunded;
        IERC20(j.token).safeTransfer(j.client, j.price);
        emit JobRefunded(jobId, j.client, j.price);
    }

    /// @notice Dry-run a certificate without state changes (agents call this before delivering).
    function check(uint256 jobId, bytes calldata spec, bytes calldata solution) external view returns (bytes32) {
        Job storage j = _jobs[jobId];
        bytes32 specHash = keccak256(spec);
        if (specHash != j.specHash) revert SpecMismatch(j.specHash, specHash);
        return IProofVerifier(j.verifier).verify(spec, solution);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function hashQuote(Quote calldata q) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.provider,
                q.payee,
                q.client,
                q.token,
                q.price,
                q.verifier,
                q.specHash,
                q.deliverBy,
                q.validUntil,
                q.quoteId
            )
        );
    }

    function quoteDigest(Quote calldata q) external view returns (bytes32) {
        return _hashTypedDataV4(hashQuote(q));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
