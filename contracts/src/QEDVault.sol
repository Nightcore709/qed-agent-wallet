// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title  QEDVault — a proof-checking treasury for an autonomous AI agent
/// @author QED team (FinTechathon 2026, Topic F)
/// @notice The vault never trusts the AI. Money leaves only when three independent proofs hold:
///
///           1. AUTHORITY  — an owner-signed EIP-712 Mandate scopes what the agent may ever do
///                           (payees, per-payment / per-period / lifetime caps, validity window).
///           2. CHECKING   — an independent policy co-signer signs a Certificate binding the exact
///                           recipient, amount, settlement date, intent id and evidence hash
///                           ("maker–checker", or four-eyes, for machines).
///           3. SOLVENCY   — after execution, the vault still covers 100% of its ring-fenced
///                           liabilities. Ring-fenced money can only ever reach its creditor.
///
///         Roles are segregated. The agent key (hot, assumed compromisable) can only call
///         `executePayment`. The co-signer key only signs. The guardian can only pause. The owner
///         (cold principal) configures, but even the owner cannot touch ring-fenced liabilities —
///         they can only be settled to, or released by, their creditor.
///
///         Because of this, the maximum loss under total compromise of the agent AND co-signer
///         keys is computable on-chain at any block: see {blastRadius}.
contract QEDVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Standing authority granted by the owner to the agent. Signed off-chain (EIP-712).
    struct Mandate {
        address vault; //          this vault (also bound by the EIP-712 domain)
        address agent; //          the only key that may redeem this mandate
        address[] payees; //       exhaustive allow-list of recipients
        uint256 maxPerPayment; //  cap on any single payment
        uint256 maxPerPeriod; //   cap per `period` seconds
        uint64 period; //          period length in seconds (> 0)
        uint256 maxTotal; //       lifetime cap of this mandate
        uint64 validFrom; //       unix seconds
        uint64 validUntil; //      unix seconds
        uint64 epoch; //           must equal the vault epoch (owner can revoke everything by bumping)
        bool requireCosign; //     require an independent co-signer certificate per payment
        bytes32 purpose; //        keccak256 of the human-readable purpose statement
        bytes32 salt; //           uniqueness
    }

    /// @notice Per-payment certificate. Signed by the independent policy co-signer (EIP-712).
    ///         Every economically meaningful field is bound: changing any byte invalidates it.
    struct Certificate {
        bytes32 mandateHash; //    struct hash of the mandate it is issued under
        address recipient; //      exact payee
        uint256 amount; //         exact amount (token units)
        uint64 dueAt; //           0 = pay now; > 0 = ring-fenced forward payment due at this time
        bytes32 intentId; //       single-use id (replay protection)
        bytes32 evidenceHash; //   keccak256 of the off-chain decision record (audit anchor)
        bytes32 ref; //            external reference, e.g. keccak256(invoice id)
        uint64 notBefore; //       validity window start
        uint64 expiresAt; //       validity window end
        uint64 epoch; //           must equal the vault epoch
    }

    struct MandateState {
        uint128 spentTotal;
        uint128 spentInPeriod;
        uint64 periodStart;
        bool revoked;
    }

    enum LiabilityStatus {
        None,
        Open,
        Settled,
        Released
    }

    /// @notice A ring-fenced obligation. Its funds can only go to `creditor`.
    struct Liability {
        address creditor;
        uint128 amount;
        uint64 dueAt;
        LiabilityStatus status;
        address createdBy;
        bytes32 memo;
    }

    /// @notice Everything a dashboard or counterparty needs, in one call.
    struct Snapshot {
        uint256 balance;
        uint256 protectedBalance;
        uint256 freeBalance;
        uint256 dailyCap;
        uint256 spentInWindow;
        uint256 windowStart;
        uint256 blastRadius24h;
        uint256 openLiabilities;
        uint256 liabilityCount;
        uint64 epoch;
        bool paused;
        address owner;
        address agent;
        address cosigner;
        address guardian;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address vault,address agent,address[] payees,uint256 maxPerPayment,uint256 maxPerPeriod,uint64 period,uint256 maxTotal,uint64 validFrom,uint64 validUntil,uint64 epoch,bool requireCosign,bytes32 purpose,bytes32 salt)"
    );

    bytes32 public constant CERTIFICATE_TYPEHASH = keccak256(
        "Certificate(bytes32 mandateHash,address recipient,uint256 amount,uint64 dueAt,bytes32 intentId,bytes32 evidenceHash,bytes32 ref,uint64 notBefore,uint64 expiresAt,uint64 epoch)"
    );

    /// @notice Length of the global agent spending window.
    uint256 public constant WINDOW = 1 days;
    /// @notice Furthest a forward payment (promise) may be scheduled.
    uint256 public constant MAX_FORWARD = 365 days;
    /// @notice Bound on mandate payee list length (keeps membership checks O(1)-ish in gas).
    uint256 public constant MAX_PAYEES = 32;

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────

    IERC20 public immutable asset;

    address public owner;
    address public pendingOwner;
    address public agent;
    address public cosigner;
    address public guardian;

    bool public paused;
    uint64 public epoch;

    uint256 public dailyCap;
    uint256 public windowStart;
    uint256 public spentInWindow;

    uint256 public totalProtected;
    uint256 public liabilityCount;
    uint256 public openLiabilities;
    mapping(uint256 => Liability) public liabilities;

    mapping(bytes32 => MandateState) public mandateState;
    mapping(bytes32 => bool) public intentUsed;

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event Deposited(address indexed from, uint256 amount);
    event PaymentExecuted(
        bytes32 indexed intentId,
        bytes32 indexed mandateHash,
        address indexed recipient,
        uint256 amount,
        uint256 liabilityId,
        bytes32 evidenceHash,
        bytes32 ref
    );
    event LiabilityCreated(
        uint256 indexed id, address indexed creditor, uint256 amount, uint64 dueAt, bytes32 memo, address createdBy
    );
    event LiabilitySettled(uint256 indexed id, address indexed creditor, uint256 amount, address settledBy);
    event LiabilityReleased(uint256 indexed id, address indexed creditor, uint256 amount);
    event LiabilityAssigned(uint256 indexed id, address indexed from, address indexed to);
    event Withdrawn(address indexed to, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event EpochBumped(uint64 newEpoch);
    event MandateRevoked(bytes32 indexed mandateHash);
    event AgentSet(address indexed agent);
    event CosignerSet(address indexed cosigner);
    event GuardianSet(address indexed guardian);
    event DailyCapSet(uint256 dailyCap);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors (descriptive on purpose: every rejection is self-explaining on a block explorer)
    // ─────────────────────────────────────────────────────────────────────────────

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotAgent(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotCreditor(address caller);
    error VaultPaused();
    error ZeroAddress();
    error ZeroAmount();
    error WrongVault(address mandateVault);
    error MandateAgentMismatch(address mandateAgent, address currentAgent);
    error MandateNotActive(uint64 validFrom, uint64 validUntil, uint256 nowTs);
    error InvalidMandate();
    error StaleEpoch(uint64 provided, uint64 current);
    error MandateIsRevoked(bytes32 mandateHash);
    error BadOwnerSignature();
    error BadCosignerSignature();
    error CertificateMandateMismatch(bytes32 certMandateHash, bytes32 mandateHash);
    error CertificateNotActive(uint64 notBefore, uint64 expiresAt, uint256 nowTs);
    error IntentAlreadyUsed(bytes32 intentId);
    error PayeeNotInMandate(address recipient);
    error ExceedsPerPaymentCap(uint256 amount, uint256 cap);
    error ExceedsMandatePeriodCap(uint256 amount, uint256 remaining);
    error ExceedsMandateTotalCap(uint256 amount, uint256 remaining);
    error ExceedsDailyCap(uint256 amount, uint256 remaining);
    error SolvencyViolation(uint256 requested, uint256 free);
    error InvalidDueDate(uint64 dueAt);
    error LiabilityNotOpen(uint256 id);
    error NotDueYet(uint256 id, uint64 dueAt);

    // ─────────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────────

    constructor(
        IERC20 asset_,
        address owner_,
        address agent_,
        address cosigner_,
        address guardian_,
        uint256 dailyCap_
    ) EIP712("QEDVault", "1") {
        if (
            address(asset_) == address(0) || owner_ == address(0) || agent_ == address(0)
                || cosigner_ == address(0) || guardian_ == address(0)
        ) revert ZeroAddress();
        asset = asset_;
        owner = owner_;
        agent = agent_;
        cosigner = cosigner_;
        guardian = guardian_;
        dailyCap = dailyCap_;
        emit OwnershipTransferred(address(0), owner_);
        emit AgentSet(agent_);
        emit CosignerSet(cosigner_);
        emit GuardianSet(guardian_);
        emit DailyCapSet(dailyCap_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Agent entry point
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice The ONLY function the AI agent key can call. Executes a spot payment (dueAt == 0)
    ///         or creates a ring-fenced forward payment / promise (dueAt > 0).
    /// @param m            Owner-signed mandate under which the agent acts.
    /// @param ownerSig     Owner signature over `m` (EOA or ERC-1271 smart account).
    /// @param c            Certificate binding the exact payment terms.
    /// @param cosignerSig  Independent co-signer signature over `c` (required if m.requireCosign).
    /// @return liabilityId Non-zero if a ring-fenced forward payment was created.
    function executePayment(
        Mandate calldata m,
        bytes calldata ownerSig,
        Certificate calldata c,
        bytes calldata cosignerSig
    ) external nonReentrant returns (uint256 liabilityId) {
        if (paused) revert VaultPaused();
        if (msg.sender != agent) revert NotAgent(msg.sender);

        bytes32 mHash = hashMandate(m);
        _checkMandate(m, mHash, ownerSig);
        _checkCertificate(m, mHash, c, cosignerSig);

        // Solvency: the payment (spot or promised) must be fundable from FREE money only.
        uint256 free = freeBalance();
        if (c.amount > free) revert SolvencyViolation(c.amount, free);

        _consumeLimits(m, mHash, c.amount);

        intentUsed[c.intentId] = true;

        if (c.dueAt == 0) {
            asset.safeTransfer(c.recipient, c.amount);
        } else {
            liabilityId = _createLiability(c.recipient, c.amount, c.dueAt, c.ref, msg.sender);
        }

        emit PaymentExecuted(c.intentId, mHash, c.recipient, c.amount, liabilityId, c.evidenceHash, c.ref);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Liabilities (ring-fenced obligations)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Owner ring-fences free funds for a creditor. Irrevocable by the owner.
    function ringFence(address creditor, uint256 amount, uint64 dueAt, bytes32 memo)
        external
        onlyOwner
        returns (uint256 id)
    {
        uint256 free = freeBalance();
        if (amount > free) revert SolvencyViolation(amount, free);
        id = _createLiability(creditor, amount, dueAt, memo, msg.sender);
    }

    /// @notice Pays a due liability to its creditor. Callable by ANYONE, even while paused:
    ///         pausing stops the AI, never the creditors.
    function settle(uint256 id) external nonReentrant {
        Liability storage l = liabilities[id];
        if (l.status != LiabilityStatus.Open) revert LiabilityNotOpen(id);
        if (block.timestamp < l.dueAt) revert NotDueYet(id, l.dueAt);
        l.status = LiabilityStatus.Settled;
        uint256 amount = l.amount;
        totalProtected -= amount;
        openLiabilities -= 1;
        asset.safeTransfer(l.creditor, amount);
        emit LiabilitySettled(id, l.creditor, amount, msg.sender);
    }

    /// @notice Only the creditor may forgive (release) a liability, returning funds to free balance.
    function release(uint256 id) external {
        Liability storage l = liabilities[id];
        if (l.status != LiabilityStatus.Open) revert LiabilityNotOpen(id);
        if (msg.sender != l.creditor) revert NotCreditor(msg.sender);
        l.status = LiabilityStatus.Released;
        totalProtected -= l.amount;
        openLiabilities -= 1;
        emit LiabilityReleased(id, l.creditor, l.amount);
    }

    /// @notice Only the creditor may assign its claim to a new creditor (e.g. receivable factoring).
    function assign(uint256 id, address newCreditor) external {
        Liability storage l = liabilities[id];
        if (l.status != LiabilityStatus.Open) revert LiabilityNotOpen(id);
        if (msg.sender != l.creditor) revert NotCreditor(msg.sender);
        if (newCreditor == address(0)) revert ZeroAddress();
        l.creditor = newCreditor;
        emit LiabilityAssigned(id, msg.sender, newCreditor);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Funds
    // ─────────────────────────────────────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Owner withdraws FREE funds only. Ring-fenced money is untouchable, even by the owner.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeBalance();
        if (amount > free) revert SolvencyViolation(amount, free);
        asset.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Governance (owner) and emergency (guardian)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Owner or guardian can halt the agent instantly. Settlement to creditors continues.
    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only the owner can resume. The guardian can make things safer, never riskier.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Invalidates every outstanding mandate and certificate at once.
    function bumpEpoch() external onlyOwner {
        epoch += 1;
        emit EpochBumped(epoch);
    }

    function revokeMandate(bytes32 mandateHash) external onlyOwner {
        mandateState[mandateHash].revoked = true;
        emit MandateRevoked(mandateHash);
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
        emit AgentSet(newAgent);
    }

    function setCosigner(address newCosigner) external onlyOwner {
        if (newCosigner == address(0)) revert ZeroAddress();
        cosigner = newCosigner;
        emit CosignerSet(newCosigner);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    function setDailyCap(uint256 newCap) external onlyOwner {
        dailyCap = newCap;
        emit DailyCapSet(newCap);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Balance not ring-fenced for any creditor. The only money that can ever move
    ///         anywhere other than to a creditor.
    function freeBalance() public view returns (uint256) {
        uint256 bal = asset.balanceOf(address(this));
        return bal > totalProtected ? bal - totalProtected : 0;
    }

    /// @notice Provable worst-case loss within `horizon` seconds if the agent key AND the co-signer
    ///         key are both fully compromised (owner key safe).
    /// @dev    Every agent outflow is bounded by (a) free balance and (b) the global window cap.
    ///         Fixed windows of length WINDOW: we sum the remaining capacity of the current window
    ///         and the full capacity of every further window that starts inside the horizon.
    ///         While paused, only the owner can resume, so the bound is zero.
    ///         Note: compromised outflows can only reach payees the owner pre-approved in signed
    ///         mandates — the loss to addresses NOT approved by the owner is always exactly zero.
    function blastRadius(uint256 horizon) public view returns (uint256) {
        if (paused) return 0;
        uint256 free = freeBalance();
        uint256 capacity;
        uint256 currentEnd;
        if (block.timestamp >= windowStart + WINDOW) {
            // A new window would open at the next spend: full capacity now.
            capacity = dailyCap;
            currentEnd = block.timestamp + WINDOW;
        } else {
            capacity = dailyCap > spentInWindow ? dailyCap - spentInWindow : 0;
            currentEnd = windowStart + WINDOW;
        }
        uint256 horizonEnd = block.timestamp + horizon;
        if (horizonEnd >= currentEnd) {
            // Each later window opens no earlier than the previous one closes. Counting is
            // inclusive of a window opening exactly at the horizon: a deliberately conservative bound.
            uint256 extraWindows = (horizonEnd - currentEnd) / WINDOW + 1;
            capacity += extraWindows * dailyCap;
        }
        return capacity < free ? capacity : free;
    }

    function snapshot() external view returns (Snapshot memory s) {
        s.balance = asset.balanceOf(address(this));
        s.protectedBalance = totalProtected;
        s.freeBalance = freeBalance();
        s.dailyCap = dailyCap;
        s.spentInWindow = block.timestamp >= windowStart + WINDOW ? 0 : spentInWindow;
        s.windowStart = windowStart;
        s.blastRadius24h = blastRadius(1 days);
        s.openLiabilities = openLiabilities;
        s.liabilityCount = liabilityCount;
        s.epoch = epoch;
        s.paused = paused;
        s.owner = owner;
        s.agent = agent;
        s.cosigner = cosigner;
        s.guardian = guardian;
    }

    function getLiability(uint256 id) external view returns (Liability memory) {
        return liabilities[id];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashMandate(Mandate calldata m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MANDATE_TYPEHASH,
                m.vault,
                m.agent,
                keccak256(abi.encodePacked(m.payees)),
                m.maxPerPayment,
                m.maxPerPeriod,
                m.period,
                m.maxTotal,
                m.validFrom,
                m.validUntil,
                m.epoch,
                m.requireCosign,
                m.purpose,
                m.salt
            )
        );
    }

    function hashCertificate(Certificate calldata c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CERTIFICATE_TYPEHASH,
                c.mandateHash,
                c.recipient,
                c.amount,
                c.dueAt,
                c.intentId,
                c.evidenceHash,
                c.ref,
                c.notBefore,
                c.expiresAt,
                c.epoch
            )
        );
    }

    /// @notice EIP-712 digest the owner signs for a mandate.
    function mandateDigest(Mandate calldata m) external view returns (bytes32) {
        return _hashTypedDataV4(hashMandate(m));
    }

    /// @notice EIP-712 digest the co-signer signs for a certificate.
    function certificateDigest(Certificate calldata c) external view returns (bytes32) {
        return _hashTypedDataV4(hashCertificate(c));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────────

    function _checkMandate(Mandate calldata m, bytes32 mHash, bytes calldata ownerSig) internal view {
        if (m.vault != address(this)) revert WrongVault(m.vault);
        if (m.agent != agent) revert MandateAgentMismatch(m.agent, agent);
        if (m.period == 0 || m.payees.length == 0 || m.payees.length > MAX_PAYEES) revert InvalidMandate();
        if (block.timestamp < m.validFrom || block.timestamp > m.validUntil) {
            revert MandateNotActive(m.validFrom, m.validUntil, block.timestamp);
        }
        if (m.epoch != epoch) revert StaleEpoch(m.epoch, epoch);
        if (mandateState[mHash].revoked) revert MandateIsRevoked(mHash);
        if (!SignatureChecker.isValidSignatureNow(owner, _hashTypedDataV4(mHash), ownerSig)) {
            revert BadOwnerSignature();
        }
    }

    function _checkCertificate(Mandate calldata m, bytes32 mHash, Certificate calldata c, bytes calldata cosignerSig)
        internal
        view
    {
        if (c.mandateHash != mHash) revert CertificateMandateMismatch(c.mandateHash, mHash);
        // Authenticity first: any post-signature change to ANY field fails here, before anything else.
        if (m.requireCosign) {
            if (!SignatureChecker.isValidSignatureNow(cosigner, _hashTypedDataV4(hashCertificate(c)), cosignerSig)) {
                revert BadCosignerSignature();
            }
        }
        if (c.epoch != epoch) revert StaleEpoch(c.epoch, epoch);
        if (block.timestamp < c.notBefore || block.timestamp > c.expiresAt) {
            revert CertificateNotActive(c.notBefore, c.expiresAt, block.timestamp);
        }
        if (intentUsed[c.intentId]) revert IntentAlreadyUsed(c.intentId);
        if (c.amount == 0) revert ZeroAmount();
        if (c.dueAt != 0 && (c.dueAt <= block.timestamp || c.dueAt > block.timestamp + MAX_FORWARD)) {
            revert InvalidDueDate(c.dueAt);
        }

        // Scope: even a genuine co-signer certificate cannot exceed the owner's mandate.
        bool listed;
        uint256 len = m.payees.length;
        for (uint256 i; i < len; ++i) {
            if (m.payees[i] == c.recipient) {
                listed = true;
                break;
            }
        }
        if (!listed) revert PayeeNotInMandate(c.recipient);
        if (c.amount > m.maxPerPayment) revert ExceedsPerPaymentCap(c.amount, m.maxPerPayment);
    }

    function _consumeLimits(Mandate calldata m, bytes32 mHash, uint256 amount) internal {
        MandateState storage s = mandateState[mHash];

        if (block.timestamp >= uint256(s.periodStart) + m.period) {
            s.periodStart = uint64(block.timestamp);
            s.spentInPeriod = 0;
        }
        uint256 periodRemaining = m.maxPerPeriod > s.spentInPeriod ? m.maxPerPeriod - s.spentInPeriod : 0;
        if (amount > periodRemaining) revert ExceedsMandatePeriodCap(amount, periodRemaining);
        uint256 totalRemaining = m.maxTotal > s.spentTotal ? m.maxTotal - s.spentTotal : 0;
        if (amount > totalRemaining) revert ExceedsMandateTotalCap(amount, totalRemaining);

        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        uint256 windowRemaining = dailyCap > spentInWindow ? dailyCap - spentInWindow : 0;
        if (amount > windowRemaining) revert ExceedsDailyCap(amount, windowRemaining);

        s.spentInPeriod += SafeCast.toUint128(amount);
        s.spentTotal += SafeCast.toUint128(amount);
        spentInWindow += amount;
    }

    function _createLiability(address creditor, uint256 amount, uint64 dueAt, bytes32 memo, address by)
        internal
        returns (uint256 id)
    {
        if (creditor == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (dueAt <= block.timestamp || dueAt > block.timestamp + MAX_FORWARD) revert InvalidDueDate(dueAt);
        id = ++liabilityCount;
        liabilities[id] = Liability({
            creditor: creditor,
            amount: SafeCast.toUint128(amount),
            dueAt: dueAt,
            status: LiabilityStatus.Open,
            createdBy: by,
            memo: memo
        });
        totalProtected += amount;
        openLiabilities += 1;
        emit LiabilityCreated(id, creditor, amount, dueAt, memo, by);
    }
}
