// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Base64} from "@oz-5.6.1/utils/Base64.sol";
import {P256} from "@oz-5.6.1/utils/cryptography/P256.sol";
import {ReentrancyGuardTransient} from "@oz-5.6.1/utils/ReentrancyGuardTransient.sol";

/// @title  QEDOwnerAccount: a passkey-owned account that can own the release's QEDVault
/// @notice R7 decision D3, layer 3 ("cryptographic owner signing"). The account's signers are P-256 public keys.
///         - Member keys are WebAuthn passkeys. They approve `execute` batches, ERC-1271 messages and cancellations.
///           Every Member assertion must carry user verification (UV) and user presence (UP), come from the stored
///           relying party (rpIdHash) and the stored web origin, and sign the exact challenge the contract derives.
///         - Recovery keys are raw P-256 keys derived client-side from a recovery code. A Recovery key can do exactly
///           one thing: start a recovery that, after `recoveryDelay`, adds one new Member. It is consumed on use.
///         - Guarded calls: a (target, selector) list fixed at construction (for the vault set: ownership transfer,
///           agent, co-signer, operator, venues, limits). `execute` refuses them whatever the approvals; they run only
///           through the delayed path: `scheduleCalls` (adminThreshold, via execute), then `delay`, during which any
///           one Member can cancel, then `applyCalls` by anyone.
///         - Protective calls (R13): a second list fixed at construction of calls that only stop things and move no
///           money (pause the vault, invalidate or revoke mandates, end the standing policy). ONE Member, whatever
///           the thresholds and even while frozen, may make them through `protect`, which has its own nonce.
///         - The sentinel (R13): one address, QED's service key, that can do two things, both protective: `freeze` a
///           Member at once, when QED has suspended that passkey, and `stopRecovery`, a pending recovery the guardian
///           co-signed (H1). A frozen Member's approval no longer counts for `execute` or
///           ERC-1271: it moves no money, signs no mandate and changes nothing. It keeps its veto (`cancel`, except
///           its own removal) and may still `protect`. Only the admin quorum of unfrozen Members unfreezes it. The
///           sentinel holds no key that can satisfy this account; dropping it is immediate, a new one waits `delay`.
///         - The guardian (R13, optional): one more WebAuthn passkey, the person's recovery contact's. It approves and
///           protects nothing. While one is set, a recovery starts only with its assertion over the same recovery
///           digest as the recovery key's signature, and a frozen Member cannot cancel a recovery it co-signed; the
///           guardian itself can cancel a recovery it co-signed (withdraw its co-signature) until it finishes. A
///           co-signed recovery finishes only after a whole `recoveryDelay` during which some Member was unfrozen and
///           able to cancel it, or during which the sentinel, unchanged, could stop it (`stopRecovery`): with every
///           Member frozen and no such sentinel it cannot finish, and its wait restarts in full when a Member is unfrozen. A recovery started without the guardian does not finish while a guardian is set. A recovery
///           signature is accepted only within `MAX_RECOVERY_WINDOW` of its deadline. Setting, replacing and removing
///           the guardian wait `delay`, during which any one Member can cancel.
///         - Time-locks (R13, optional): a third list fixed at construction (for the vault: withdraw, ringFence,
///           unpause, setGuardian). While `timeLocked` is on, `execute` refuses them like guarded calls. Turning it on
///           is immediate and voids every pending change that would turn it off; turning it off waits `delay`, during
///           which any one Member can cancel.
///         - A removal that names an unfrozen Member is scheduled only if more than `adminThreshold` Members it does not
///           name have each been a Member for at least `delay` (the constructor's from the start) (R13). Naming every
///           other unfrozen Member thus takes adminThreshold + 1 such seats, not one seat and a Member added at once.
///         The relayer (the execution service) only submits transactions and pays gas. It holds no key that can
///         satisfy this account. Signature verification uses only the EIP-7951 P-256 precompile at 0x100.
/// @dev    Not upgradeable, no initializer, no delegatecall. Research code: not audited.
contract QEDOwnerAccount is ReentrancyGuardTransient {
    // ─────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────

    enum Role {
        None,
        Member,
        Recovery,
        Guardian
    }

    enum ChangeKind {
        None,
        RemoveSigners,
        SetThresholds,
        SetDelays,
        GuardedCalls,
        SetSentinel,
        SetGuardian,
        SetTimeLock
    }

    /// @notice One call made by the account. EIP-712 type `Call(address target,uint256 value,bytes data)`.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice One WebAuthn assertion by a Member passkey (the fields of a browser `AuthenticatorAssertionResponse`
    ///         plus the indices the contract needs to find the checked JSON members without parsing JSON).
    struct Assertion {
        bytes32 signerId; //            keccak256(abi.encode(x, y)) of the Member key
        bytes32 r; //                   P-256 signature r
        bytes32 s; //                   P-256 signature s, must be <= n/2 (clients normalise)
        uint256 challengeIndex; //      index of "challenge":"…" in clientDataJSON
        uint256 typeIndex; //           index of "type":"webauthn.get" in clientDataJSON
        uint256 originIndex; //         index of "origin":"…" in clientDataJSON
        bytes authenticatorData; //     rpIdHash (32) || flags (1) || signCount (4) [|| extensions]
        string clientDataJSON; //       exactly the bytes the browser produced
    }

    struct SignerInit {
        uint256 x;
        uint256 y;
        Role role;
    }

    /// @notice Constructor input: a call that may only run through the delayed path, and why.
    struct Guard {
        address target;
        bytes4 selector;
        string reason;
    }

    struct GuardKey {
        address target;
        bytes4 selector;
    }

    struct Signer {
        uint256 x;
        uint256 y;
        Role role;
        uint64 serial; //               unique per addition; a re-added key gets a new serial
        uint8 index; //                 position in `_signerIds`
        bool frozen; //                 set by the sentinel; a frozen Member's approval does not count (R13)
        uint64 since; //                when it became a signer; 0 for the constructor's signers (R13)
    }

    /// @notice A scheduled protection-reducing change. Thresholds and delays are compare-and-swap: the change applies
    ///         only if the current values still equal `fromA`/`fromB`; removals only if each target still has the
    ///         serial it had when scheduled; a scheduled batch only with exactly the calls whose hash is `callsHash`.
    ///         The sentinel, the guardian and the time-lock: `fromA` is the epoch of that setting when scheduled, and
    ///         the change applies only if the setting has not changed since (R13: no stale change ever applies).
    struct PendingChange {
        ChangeKind kind;
        uint64 readyAt;
        uint256 fromA;
        uint256 fromB;
        uint256 toA;
        uint256 toB;
        bytes32[] targets;
        uint64[] targetSerials;
        bytes32 callsHash;
    }

    struct PendingRecovery {
        bytes32 recoverySignerId;
        uint256 newX;
        uint256 newY;
        uint64 readyAt;
        bool cosigned; //               the guardian co-signed it: a frozen Member cannot cancel it, the guardian
        //                              and the sentinel can; it finishes only after a whole recoveryDelay with a Member
        //                              unfrozen, or with the sentinel set and unchanged throughout (R13)
        uint64 sentinelEpoch; //        the sentinel's epoch when its current wait began (R13 H1)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Upper bound on signers (Members plus Recovery keys). Keeps every loop bounded.
    uint256 public constant MAX_SIGNERS = 16;
    /// @notice Bounds on `delay` and `recoveryDelay`. The floor only rules out a zero cancel window; the wallet's
    ///         default recovery delay is 72 hours (R7 D2).
    uint64 internal constant MIN_DELAY = 1 minutes;
    uint64 internal constant MAX_DELAY = 30 days;
    /// @notice Upper bound on guarded (target, selector) entries.
    uint256 internal constant MAX_GUARDS = 32;
    /// @notice Upper bound on protective (target, selector) entries.
    uint256 internal constant MAX_PROTECTIVE = 16;
    /// @dev A recovery starts only if its deadline is at most this long after the block that starts it (R13), so a
    ///      recovery code's signature and the guardian's co-signature are usable only within a day of their deadline.
    uint64 internal constant MAX_RECOVERY_WINDOW = 1 days;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("QEDOwnerAccount");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 internal constant EXECUTE_TYPEHASH = keccak256(
        "Execute(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)"
    );
    /// @notice ERC-1271 messages are re-hashed under this account's EIP-712 domain (account address and chain id),
    ///         so a signature made for one account or chain never verifies on another.
    bytes32 internal constant MESSAGE_TYPEHASH = keccak256("QEDOwnerMessage(bytes32 hash)");
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 id)");
    bytes32 internal constant START_RECOVERY_TYPEHASH =
        keccak256("StartRecovery(bytes32 recoverySignerId,uint256 newX,uint256 newY,uint64 deadline)");
    /// @notice A `protect` batch: its own type, so that an `execute` approval is never a `protect` approval.
    bytes32 internal constant PROTECT_TYPEHASH = keccak256(
        "Protect(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)"
    );

    /// @dev keccak256 of the JSON member every assertion must carry at `typeIndex` (21 bytes).
    bytes32 private constant _TYPE_FIELD_HASH = keccak256('"type":"webauthn.get"');

    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant _ERC1271_INVALID = 0xffffffff;

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice sha256 of the WebAuthn relying-party id (sha256("localhost") for the local wallet).
    bytes32 public immutable rpIdHash;
    /// @notice keccak256 of `"origin":"<origin>"` and its length: the exact JSON member every Member assertion
    ///         must contain at `originIndex`.
    bytes32 private immutable _originFieldHash;
    uint256 private immutable _originFieldLength;
    /// @notice The web origin passkey assertions must come from (for example "http://localhost:5175").
    string public origin;

    /// @notice Next `execute` nonce. Only the current value is accepted; it increments on every successful execute.
    uint256 public nonce;
    /// @notice Distinct Member approvals needed by `execute` (when no call targets the account) and by ERC-1271.
    uint256 public threshold;
    /// @notice Distinct Member approvals needed by `execute` when any call targets the account itself.
    uint256 public adminThreshold;
    uint256 public memberCount;
    /// @notice Wait before a scheduled protection-reducing change can be applied.
    uint64 public delay;
    /// @notice Wait between `startRecovery` and `finishRecovery`.
    uint64 public recoveryDelay;

    uint64 private _serial;
    mapping(bytes32 signerId => Signer) private _signers;
    bytes32[] private _signerIds;
    mapping(bytes32 changeId => PendingChange) private _changes;
    mapping(bytes32 recoveryId => PendingRecovery) private _recoveries;
    /// @notice The recovery a Recovery key has started and that is still pending (zero if none).
    mapping(bytes32 recoverySignerId => bytes32 recoveryId) public pendingRecoveryOf;
    /// @notice Recovery keys that have been used once. They can never be added as Recovery keys again.
    mapping(bytes32 keyId => bool) public spentRecoveryKey;
    /// @notice Calls `execute` refuses; fixed at construction. They run only through scheduleCalls / applyCalls.
    mapping(address target => mapping(bytes4 selector => bool)) private _guarded;
    GuardKey[] private _guardList;
    /// @notice Calls `protect` accepts with one Member's approval; fixed at construction (R13).
    mapping(address target => mapping(bytes4 selector => bool)) private _protective;
    GuardKey[] private _protectiveList;
    /// @notice The one address that may freeze a Member (QED's service key); zero when there is none (R13).
    address public sentinel;
    /// @notice Next `protect` nonce, separate from `nonce`: stopping things never uses up a prepared execute.
    uint256 public protectNonce;
    /// @notice The guardian's signer id, zero when there is none (R13). Its key is in `getSigner` with Role.Guardian.
    bytes32 public guardian;
    /// @notice While true, `execute` refuses the lockable calls too; they run only through the delayed path (R13).
    bool public timeLocked;
    /// @notice Calls `execute` refuses while `timeLocked`; fixed at construction (R13).
    mapping(address target => mapping(bytes4 selector => bool)) private _lockable;
    GuardKey[] private _lockableList;
    /// @dev How many times the time-lock, the sentinel and the guardian have each been set (R13). A scheduled change of
    ///      one of them records its epoch and applies only while it is unchanged.
    mapping(ChangeKind kind => uint256) private _epoch;

    // ─────────────────────────────────────────────────────────────────────────────
    // Events (every authority change, schedule, cancel and recovery step)
    // ─────────────────────────────────────────────────────────────────────────────

    event AccountConfigured(bytes32 rpIdHash, string origin);
    event GuardConfigured(address indexed target, bytes4 indexed selector, string reason);
    event SignerAdded(bytes32 indexed signerId, Role role, uint256 x, uint256 y, uint64 serial);
    event SignerRemoved(bytes32 indexed signerId, Role role);
    event ThresholdsChanged(uint256 threshold, uint256 adminThreshold);
    event DelaysChanged(uint64 delay, uint64 recoveryDelay);
    event ChangeScheduled(
        bytes32 indexed changeId, ChangeKind kind, uint64 readyAt, uint256 toA, uint256 toB, bytes32[] targets
    );
    event ChangeApplied(bytes32 indexed changeId, ChangeKind kind);
    event ChangeCancelled(bytes32 indexed changeId, bytes32 indexed bySignerId);
    event RecoveryStarted(
        bytes32 indexed recoveryId,
        bytes32 indexed recoverySignerId,
        bytes32 newSignerId,
        uint256 newX,
        uint256 newY,
        uint64 readyAt
    );
    /// @dev `bySignerId` is zero when the recovery was dropped because its Recovery key was removed by a change, and the
    ///      sentinel's address (left-padded) when the sentinel stopped it (R13 H1).
    event RecoveryCancelled(bytes32 indexed recoveryId, bytes32 indexed bySignerId);
    event RecoveryFinished(bytes32 indexed recoveryId, bytes32 indexed newSignerId);
    event Executed(uint256 indexed nonce, bytes32 indexed digest, bytes32[] approvers, uint256 callCount);
    /// @dev The full batch, so the wallet can show it and anyone can apply it once ready.
    event CallsScheduled(bytes32 indexed changeId, uint64 readyAt, Call[] calls);
    event ProtectiveCallConfigured(address indexed target, bytes4 indexed selector, string reason);
    event SentinelChanged(address indexed sentinel);
    event SignerFrozen(bytes32 indexed signerId, address indexed by);
    event SignerUnfrozen(bytes32 indexed signerId);
    event Protected(uint256 indexed nonce, bytes32 indexed digest, bytes32 indexed signerId, uint256 callCount);
    event LockableCallConfigured(address indexed target, bytes4 indexed selector, string reason);
    event TimeLockChanged(bool on);
    event RecoveryCosigned(bytes32 indexed recoveryId, bytes32 indexed guardianId);
    /// @dev A co-signed recovery's wait restarted in full because a Member became unfrozen after none was (R13).
    event RecoveryRestarted(bytes32 indexed recoveryId, uint64 readyAt);

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────

    error InvalidRpIdHash();
    error InvalidOrigin();
    error InvalidPublicKey(uint256 x, uint256 y);
    error InvalidRole();
    error InvalidThresholds(uint256 threshold, uint256 adminThreshold, uint256 memberCount);
    error InvalidDelay(uint64 value);
    error SignerExists(bytes32 signerId);
    error UnknownSigner(bytes32 signerId);
    error TooManySigners();
    error RecoveryKeySpent(bytes32 signerId);
    error PrecompileCheckFailed();
    error OnlySelf(address caller);
    error BadNonce(uint256 provided, uint256 expected);
    error Expired(uint64 deadline, uint256 nowTs);
    error NotEnoughApprovals(uint256 provided, uint256 required);
    error AssertionsNotStrictlyIncreasing(uint256 index);
    error NotAMember(bytes32 signerId);
    error InvalidAssertion(uint256 index);
    error CallFailed(uint256 index, bytes reason);
    error EmptyRemoval();
    error IdsNotStrictlyIncreasing(uint256 index);
    error NothingPending(bytes32 id);
    error NotReady(bytes32 id, uint64 readyAt);
    error ChangeStale(bytes32 changeId);
    error CannotCancelOwnRemoval(bytes32 signerId);
    error NotARecoverySigner(bytes32 signerId);
    error RecoveryAlreadyPending(bytes32 recoverySignerId, bytes32 recoveryId);
    error InvalidRecoverySignature();
    error InvalidGuard(uint256 index);
    error TooManyGuards();
    error GuardedCall(uint256 index, address target, bytes4 selector);
    error EmptyCalls();
    error SelfCallNotAllowed(uint256 index);
    error CallsMismatch(bytes32 changeId);
    error WrongChangeKind(bytes32 changeId);
    error InvalidProtective(uint256 index);
    error TooManyProtective();
    error NotProtective(uint256 index, address target, bytes4 selector);
    error NotSentinel(address caller);
    error InvalidSentinel(address sentinel);
    error FrozenSigner(bytes32 signerId);
    error AlreadyFrozen(bytes32 signerId);
    error NotFrozen(bytes32 signerId);
    error InvalidLockable(uint256 index);
    error GuardianRequired(bytes32 guardianId);
    error NotGuardian(bytes32 signerId);
    error DeadlineTooFar(uint64 deadline);
    error NoCancellerLeft();
    error NoUnfrozenMember();

    // ─────────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────────

    /// @param rpIdHash_       sha256 of the WebAuthn relying-party id.
    /// @param origin_         web origin assertions must come from; printable ASCII without `"` or `\`.
    /// @param signers_        initial Members and Recovery keys.
    /// @param threshold_      Member approvals for execute and ERC-1271; 1 <= threshold_ <= adminThreshold_.
    /// @param adminThreshold_ Member approvals when a call targets the account; <= number of Members.
    /// @param guards_         calls that may only run through the delayed path, each with its reason (non-empty).
    /// @param protective_     calls that only stop things and move no money, which one Member may make through
    ///                        `protect` (value 0 only); each with its reason; never also guarded.
    /// @param sentinel_       the one address that may freeze a Member (QED's service key), or zero for none.
    /// @param lockable_       calls `execute` refuses while `timeLocked` (each with its reason); never also guarded or
    ///                        protective.
    /// @param timeLocked_     whether the lockable calls start time-locked (the household's choice at setup).
    constructor(
        bytes32 rpIdHash_,
        string memory origin_,
        SignerInit[] memory signers_,
        uint256 threshold_,
        uint256 adminThreshold_,
        uint64 delay_,
        uint64 recoveryDelay_,
        Guard[] memory guards_,
        Guard[] memory protective_,
        address sentinel_,
        Guard[] memory lockable_,
        bool timeLocked_
    ) {
        if (rpIdHash_ == bytes32(0)) revert InvalidRpIdHash();
        bytes memory o = bytes(origin_);
        if (o.length == 0) revert InvalidOrigin();
        for (uint256 i; i < o.length; ++i) {
            bytes1 c = o[i];
            if (c < 0x21 || c > 0x7e || c == 0x22 || c == 0x5c) revert InvalidOrigin();
        }
        // Refuse to exist on a chain without the P-256 precompile: OpenZeppelin's verifyNative reverts with
        // MissingPrecompile(0x100) there. Vector: Wycheproof ecdsa_secp256r1_sha256_p1363 (the one OZ uses).
        if (
            !P256.verifyNative(
                0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023,
                bytes32(uint256(5)),
                bytes32(uint256(1)),
                0xa71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957,
                0x5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b
            )
        ) revert PrecompileCheckFailed();

        rpIdHash = rpIdHash_;
        bytes memory field = abi.encodePacked('"origin":"', o, '"');
        _originFieldHash = keccak256(field);
        _originFieldLength = field.length;
        origin = origin_;
        emit AccountConfigured(rpIdHash_, origin_);

        for (uint256 i; i < signers_.length; ++i) {
            _addSigner(signers_[i].x, signers_[i].y, signers_[i].role);
        }
        _setDelays(delay_, recoveryDelay_);
        _setThresholds(threshold_, adminThreshold_);

        if (guards_.length > MAX_GUARDS) revert TooManyGuards();
        for (uint256 i; i < guards_.length; ++i) {
            Guard memory g = guards_[i];
            if (
                g.target == address(0) || g.target == address(this) || g.selector == bytes4(0)
                    || bytes(g.reason).length == 0 || _guarded[g.target][g.selector]
            ) revert InvalidGuard(i);
            _guarded[g.target][g.selector] = true;
            _guardList.push(GuardKey(g.target, g.selector));
            emit GuardConfigured(g.target, g.selector, g.reason);
        }

        if (protective_.length > MAX_PROTECTIVE) revert TooManyProtective();
        for (uint256 i; i < protective_.length; ++i) {
            Guard memory p = protective_[i];
            if (
                p.target == address(0) || p.target == address(this) || p.selector == bytes4(0)
                    || bytes(p.reason).length == 0 || _protective[p.target][p.selector] || _guarded[p.target][p.selector]
            ) revert InvalidProtective(i);
            _protective[p.target][p.selector] = true;
            _protectiveList.push(GuardKey(p.target, p.selector));
            emit ProtectiveCallConfigured(p.target, p.selector, p.reason);
        }
        if (sentinel_ == address(this)) revert InvalidSentinel(sentinel_);
        if (sentinel_ != address(0)) _setSentinel(sentinel_);

        if (lockable_.length > MAX_GUARDS) revert TooManyGuards();
        for (uint256 i; i < lockable_.length; ++i) {
            Guard memory l = lockable_[i];
            if (
                l.target == address(0) || l.target == address(this) || l.selector == bytes4(0)
                    || bytes(l.reason).length == 0 || _lockable[l.target][l.selector] || _guarded[l.target][l.selector]
                    || _protective[l.target][l.selector]
            ) revert InvalidLockable(i);
            _lockable[l.target][l.selector] = true;
            _lockableList.push(GuardKey(l.target, l.selector));
            emit LockableCallConfigured(l.target, l.selector, l.reason);
        }
        if (timeLocked_) _setTimeLock(true);
    }

    /// @notice The account may hold ETH for calls that carry value.
    receive() external payable {}

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Execute (anyone may relay)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Runs `calls` atomically when at least `threshold` distinct Members (or `adminThreshold` when any
    ///         call targets this account) approved `executeDigest(calls, nonce_, deadline)`. A guarded
    ///         (target, selector), or a lockable one while `timeLocked`, is refused here whatever the approvals:
    ///         schedule it with `scheduleCalls`.
    /// @dev    Assertions must be ordered by strictly increasing `signerId`; every one must be a valid Member
    ///         assertion. If any call reverts, everything reverts (the nonce is not consumed).
    function execute(Call[] calldata calls, uint256 nonce_, uint64 deadline, Assertion[] calldata assertions)
        external
        nonReentrant
    {
        if (nonce_ != nonce) revert BadNonce(nonce_, nonce);
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);

        uint256 required = threshold;
        for (uint256 i; i < calls.length; ++i) {
            address target = calls[i].target;
            if (target == address(this)) {
                required = adminThreshold;
            } else if (calls[i].data.length >= 4) {
                bytes4 sel = bytes4(calls[i].data[:4]);
                if (_guarded[target][sel] || _locked(target, sel)) revert GuardedCall(i, target, sel);
            }
        }
        bytes32 digest = _hashTypedData(_hashExecute(calls, nonce_, deadline));
        bytes32[] memory approvers = _requireApprovals(digest, assertions, required);

        nonce = nonce_ + 1;
        emit Executed(nonce_, digest, approvers, calls.length);
        _run(calls);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ERC-1271
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice ERC-1271. `signature` is `abi.encode(Assertion[])` over `replaySafeHash(hash)`; valid when at least
    ///         `threshold` distinct Members approved it. Never reverts on a bad signature: returns 0xffffffff.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        try this.checkSignature(hash, signature) {
            return _ERC1271_MAGIC;
        } catch {
            return _ERC1271_INVALID;
        }
    }

    /// @notice Reverts (with the reason) unless `signature` would make `isValidSignature(hash, signature)` valid.
    function checkSignature(bytes32 hash, bytes calldata signature) external view {
        Assertion[] memory assertions = abi.decode(signature, (Assertion[]));
        _requireApprovals(replaySafeHash(hash), assertions, threshold);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Protective calls and the sentinel (R13)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Runs `calls` when ONE Member, frozen or not, approved the EIP-712 digest of `Protect(calls, nonce_,
    ///         deadline)` under this account's domain (PROTECT_TYPEHASH; the calls hashed as for execute) and every call
    ///         is on the protective list with value 0: calls that only stop things and move no money. Whatever the
    ///         thresholds, so that one device can always stop the agent, and so that a freeze never takes that away.
    /// @dev    Its own nonce (`protectNonce`) and type, so it never uses up or stands in for an `execute` approval.
    function protect(Call[] calldata calls, uint256 nonce_, uint64 deadline, Assertion calldata assertion)
        external
        nonReentrant
    {
        if (nonce_ != protectNonce) revert BadNonce(nonce_, protectNonce);
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (calls.length == 0) revert EmptyCalls();
        for (uint256 i; i < calls.length; ++i) {
            bytes4 sel = calls[i].data.length >= 4 ? bytes4(calls[i].data[:4]) : bytes4(0);
            if (calls[i].value != 0 || !_protective[calls[i].target][sel]) {
                revert NotProtective(i, calls[i].target, sel);
            }
        }
        Signer storage sg = _signers[assertion.signerId];
        if (sg.role != Role.Member) revert NotAMember(assertion.signerId);
        bytes32 digest = _hashTypedData(keccak256(abi.encode(PROTECT_TYPEHASH, _hashCalls(calls), nonce_, deadline)));
        if (!_verifyAssertion(digest, assertion, sg.x, sg.y)) revert InvalidAssertion(0);
        protectNonce = nonce_ + 1;
        emit Protected(nonce_, digest, assertion.signerId, calls.length);
        _run(calls);
    }

    /// @notice The sentinel freezes a Member at once: its approval stops counting for `execute` and ERC-1271 (so
    ///         mandates it alone signed stop paying). It keeps its veto and may still `protect`. Nothing else.
    function freeze(bytes32 signerId) external {
        address s = sentinel;
        if (s == address(0) || msg.sender != s) revert NotSentinel(msg.sender);
        Signer storage sg = _signers[signerId];
        if (sg.role != Role.Member) revert NotAMember(signerId);
        if (sg.frozen) revert AlreadyFrozen(signerId);
        sg.frozen = true;
        emit SignerFrozen(signerId, msg.sender);
    }

    /// @notice The sentinel stops a pending recovery the guardian co-signed (R13 H1): the owner's way to challenge it
    ///         through QED even when every passkey is frozen. Protective only: it starts, approves and finishes nothing
    ///         and stops nothing else. The recovery key that started it is spent, as with a Member's cancel.
    function stopRecovery(bytes32 recoveryId) external {
        address s = sentinel;
        if (s == address(0) || msg.sender != s) revert NotSentinel(msg.sender);
        if (!_recoveries[recoveryId].cosigned) revert NothingPending(recoveryId);
        _dropRecovery(recoveryId, bytes32(uint256(uint160(s))));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Self-administration (only through `execute` with `adminThreshold` approvals)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Adds a Member or a Recovery key. Immediate: adding a signer does not reduce protection by itself,
    ///         and it already needs `adminThreshold` Members. A guardian is set only through `setGuardian`.
    function addSigner(uint256 x, uint256 y, Role role) external onlySelf {
        _addSigner(x, y, role);
    }

    /// @notice Schedules the removal of `ids` (strictly increasing). Protection-reducing: applies only after
    ///         `delay`, and any Member that is not itself being removed can cancel it. When it names an unfrozen Member,
    ///         more than `adminThreshold` Members it does not name must each have been a Member for at least `delay`
    ///         (R13): otherwise one seat (or one seat and a Member it just added) could name every other Member, and
    ///         nobody left could cancel. Removing only frozen Members or recovery keys needs no such witnesses.
    function removeSigners(bytes32[] calldata ids) external onlySelf returns (bytes32 changeId) {
        uint256 n = ids.length;
        if (n == 0) revert EmptyRemoval();
        uint64[] memory serials = new uint64[](n);
        uint256 membersRemoved = 0;
        uint256 settledRemoved = 0;
        bool unfrozenNamed = false;
        for (uint256 i; i < n; ++i) {
            if (i > 0 && uint256(ids[i]) <= uint256(ids[i - 1])) revert IdsNotStrictlyIncreasing(i);
            Signer storage s = _signers[ids[i]];
            if (s.role == Role.None) revert UnknownSigner(ids[i]);
            if (s.role == Role.Guardian) revert InvalidRole(); // only setGuardian(0, 0) removes the guardian
            serials[i] = s.serial;
            if (s.role == Role.Member) {
                ++membersRemoved;
                if (!s.frozen) unfrozenNamed = true;
                if (_settled(s)) ++settledRemoved;
            }
        }
        _requireQuorum(threshold, adminThreshold, memberCount - membersRemoved);
        if (unfrozenNamed) _requireCanceller(settledRemoved);
        changeId = _schedule(ChangeKind.RemoveSigners, 0, 0, 0, 0, ids, serials, bytes32(0));
    }

    /// @notice Sets both thresholds. Immediate when neither decreases; otherwise scheduled (protection-reducing).
    /// @return changeId zero when applied immediately.
    function setThresholds(uint256 newThreshold, uint256 newAdminThreshold)
        external
        onlySelf
        returns (bytes32 changeId)
    {
        _requireQuorum(newThreshold, newAdminThreshold, memberCount);
        if (newThreshold >= threshold && newAdminThreshold >= adminThreshold) {
            _setThresholds(newThreshold, newAdminThreshold);
        } else {
            changeId = _schedule(
                ChangeKind.SetThresholds,
                threshold,
                adminThreshold,
                newThreshold,
                newAdminThreshold,
                new bytes32[](0),
                new uint64[](0),
                bytes32(0)
            );
        }
    }

    /// @notice Sets both delays. Immediate when neither shortens; otherwise scheduled (protection-reducing).
    /// @return changeId zero when applied immediately.
    function setDelays(uint64 newDelay, uint64 newRecoveryDelay) external onlySelf returns (bytes32 changeId) {
        _checkDelay(newDelay);
        _checkDelay(newRecoveryDelay);
        if (newDelay >= delay && newRecoveryDelay >= recoveryDelay) {
            _setDelays(newDelay, newRecoveryDelay);
        } else {
            changeId = _schedule(
                ChangeKind.SetDelays,
                delay,
                recoveryDelay,
                newDelay,
                newRecoveryDelay,
                new bytes32[](0),
                new uint64[](0),
                bytes32(0)
            );
        }
    }

    /// @notice Unfreezes a Member. Immediate: only the admin quorum of unfrozen Members reaches it (through execute),
    ///         and that quorum could add a new Member at once anyway.
    function unfreeze(bytes32 signerId) external onlySelf {
        Signer storage sg = _signers[signerId];
        if (sg.role != Role.Member || !sg.frozen) revert NotFrozen(signerId);
        _thaw();
        sg.frozen = false;
        emit SignerUnfrozen(signerId);
    }

    /// @notice Drops the sentinel at once (zero), or schedules a new one behind `delay`: a new holder of the freeze
    ///         power waits, and any Member can cancel it meanwhile. Freezes already made stay until unfrozen. Any change
    ///         of the sentinel, a drop included, voids every pending one scheduled before it (R13).
    /// @return changeId zero when applied immediately.
    function setSentinel(address newSentinel) external onlySelf returns (bytes32 changeId) {
        if (newSentinel == address(this)) revert InvalidSentinel(newSentinel);
        if (newSentinel == address(0)) {
            _setSentinel(address(0));
        } else {
            changeId = _schedule(
                ChangeKind.SetSentinel,
                _epoch[ChangeKind.SetSentinel],
                0,
                uint256(uint160(newSentinel)),
                0,
                new bytes32[](0),
                new uint64[](0),
                bytes32(0)
            );
        }
    }

    /// @notice Sets, replaces or (with x = y = 0) removes the guardian (R13). Always scheduled behind `delay`: a guardian
    ///         takes away frozen Members' veto over the recoveries it co-signs, and without one a code alone starts a
    ///         recovery again. Any one Member can cancel it meanwhile. Applies only if the guardian has not changed since
    ///         it was scheduled.
    function setGuardian(uint256 x, uint256 y) external onlySelf returns (bytes32 changeId) {
        if (x != 0 || y != 0) {
            if (!P256.isValidPublicKey(bytes32(x), bytes32(y))) revert InvalidPublicKey(x, y);
            bytes32 id = signerIdOf(x, y);
            if (_signers[id].role != Role.None) revert SignerExists(id);
        }
        changeId = _schedule(
            ChangeKind.SetGuardian, _epoch[ChangeKind.SetGuardian], 0, x, y, new bytes32[](0), new uint64[](0), bytes32(0)
        );
    }

    /// @notice Turns the time-lock of the lockable calls on at once (it adds protection), or schedules turning it off
    ///         behind `delay` (it removes protection); any one Member can cancel that meanwhile (R13). Turning it on,
    ///         even when it is already on, voids every pending change that would turn it off.
    /// @return changeId zero when applied immediately.
    function setTimeLock(bool on) external onlySelf returns (bytes32 changeId) {
        if (on || !timeLocked) {
            _setTimeLock(on);
        } else {
            changeId = _schedule(
                ChangeKind.SetTimeLock, _epoch[ChangeKind.SetTimeLock], 0, 0, 0, new bytes32[](0), new uint64[](0), bytes32(0)
            );
        }
    }

    /// @notice The delayed path for calls to other contracts, and the only path for guarded calls. Applies after
    ///         `delay` through `applyCalls`; any one Member can cancel it meanwhile. Calls to this account itself are
    ///         not accepted here (they have their own rules above).
    function scheduleCalls(Call[] calldata calls) external onlySelf returns (bytes32 changeId) {
        if (calls.length == 0) revert EmptyCalls();
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target == address(this)) revert SelfCallNotAllowed(i);
        }
        changeId = _schedule(ChangeKind.GuardedCalls, 0, 0, 0, 0, new bytes32[](0), new uint64[](0), _hashCalls(calls));
        emit CallsScheduled(changeId, _changes[changeId].readyAt, calls);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Scheduled changes: apply (anyone, after the delay) and cancel (any one Member)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Runs a scheduled batch once its delay has passed. Anyone may call, with exactly the scheduled calls
    ///         (they are in the CallsScheduled event). Atomic: if a call reverts, nothing happens and it stays pending.
    function applyCalls(bytes32 changeId, Call[] calldata calls) external nonReentrant {
        PendingChange storage c = _changes[changeId];
        if (c.kind == ChangeKind.None) revert NothingPending(changeId);
        if (c.kind != ChangeKind.GuardedCalls) revert WrongChangeKind(changeId);
        if (block.timestamp < c.readyAt) revert NotReady(changeId, c.readyAt);
        if (_hashCalls(calls) != c.callsHash) revert CallsMismatch(changeId);
        delete _changes[changeId];
        emit ChangeApplied(changeId, ChangeKind.GuardedCalls);
        _run(calls);
    }

    /// @notice Applies a scheduled change once its delay has passed. Anyone may call. Re-checks everything.
    /// @dev    Kinds: removals, thresholds, delays, the sentinel, the guardian and the time-lock (GuardedCalls go
    ///         through applyCalls).
    function applyChange(bytes32 changeId) external nonReentrant {
        PendingChange storage c = _changes[changeId];
        ChangeKind kind = c.kind;
        if (kind == ChangeKind.None) revert NothingPending(changeId);
        if (kind == ChangeKind.GuardedCalls) revert WrongChangeKind(changeId);
        if (block.timestamp < c.readyAt) revert NotReady(changeId, c.readyAt);

        if (kind == ChangeKind.RemoveSigners) {
            bytes32[] memory targets = c.targets;
            uint64[] memory serials = c.targetSerials;
            delete _changes[changeId];
            for (uint256 i; i < targets.length; ++i) {
                Signer storage s = _signers[targets[i]];
                if (s.role == Role.None || s.serial != serials[i]) revert ChangeStale(changeId);
                _removeSigner(targets[i]);
            }
            _requireQuorum(threshold, adminThreshold, memberCount);
        } else if (kind == ChangeKind.SetThresholds) {
            if (threshold != c.fromA || adminThreshold != c.fromB) revert ChangeStale(changeId);
            (uint256 t, uint256 a) = (c.toA, c.toB);
            delete _changes[changeId];
            _setThresholds(t, a);
        } else if (kind == ChangeKind.SetDelays) {
            if (delay != c.fromA || recoveryDelay != c.fromB) revert ChangeStale(changeId);
            (uint256 d, uint256 rd) = (c.toA, c.toB);
            delete _changes[changeId];
            // Bounds were checked when scheduled and the fields only ever hold uint64 values.
            _setDelays(uint64(d), uint64(rd));
        } else {
            // The sentinel, the guardian or the time-lock (GuardedCalls was refused above): stale once that setting has
            // changed in any way since the change was scheduled (R13), e.g. the time-lock turned on again.
            if (!_isCurrent(kind, c.fromA)) revert ChangeStale(changeId);
            (uint256 x, uint256 y) = (c.toA, c.toB);
            delete _changes[changeId];
            if (kind == ChangeKind.SetSentinel) {
                // Scheduled only with a non-zero address that is not this account; toA only ever holds an address.
                _setSentinel(address(uint160(x)));
            } else if (kind == ChangeKind.SetTimeLock) {
                _setTimeLock(false); // scheduled only while on, and unchanged since
            } else {
                bytes32 old = guardian;
                if (old != bytes32(0)) _removeSigner(old);
                // the key was checked when scheduled; _insertSigner checks it again (curve, not a signer now, room)
                guardian = (x | y) == 0 ? bytes32(0) : _insertSigner(x, y, Role.Guardian);
                ++_epoch[ChangeKind.SetGuardian];
            }
        }
        emit ChangeApplied(changeId, kind);
    }

    /// @notice Cancels a scheduled change or a pending recovery with ONE Member assertion over
    ///         `cancelDigest(id)`, whatever the thresholds. A Member cannot cancel a change that removes itself.
    ///         Cancelling a recovery also removes the Recovery key that started it (recovery codes are single use).
    ///         A frozen Member keeps this veto, except over a recovery the guardian co-signed (R13): otherwise a
    ///         stolen passkey, once frozen, could still stop every recovery and hold the household hostage. The
    ///         guardian may cancel a recovery it co-signed, and nothing else (R13: it withdraws its co-signature).
    function cancel(bytes32 id, Assertion calldata assertion) external nonReentrant {
        Signer storage sg = _signers[assertion.signerId];
        PendingChange storage c = _changes[id];
        bool isChange = c.kind != ChangeKind.None;
        if (sg.role == Role.Guardian) {
            if (isChange || !_recoveries[id].cosigned) revert NotAMember(assertion.signerId);
        } else {
            if (sg.role != Role.Member) revert NotAMember(assertion.signerId);
            if (!isChange) {
                PendingRecovery storage pr = _recoveries[id];
                if (pr.readyAt == 0) revert NothingPending(id);
                if (!_mayCancelRecovery(sg, pr)) revert FrozenSigner(assertion.signerId);
            } else if (c.kind == ChangeKind.RemoveSigners) {
                for (uint256 i; i < c.targets.length; ++i) {
                    if (c.targets[i] == assertion.signerId) revert CannotCancelOwnRemoval(assertion.signerId);
                }
            }
        }
        if (!_verifyAssertion(_hashTypedData(keccak256(abi.encode(CANCEL_TYPEHASH, id))), assertion, sg.x, sg.y)) {
            revert InvalidAssertion(0);
        }

        if (isChange) {
            delete _changes[id];
            emit ChangeCancelled(id, assertion.signerId);
        } else {
            _dropRecovery(id, assertion.signerId);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Recovery
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice A Recovery key proposes a new Member. The raw P-256 signature (r, s) is over
    ///         sha256(recoveryDigest(recoverySignerId, newX, newY, deadline)), as WebCrypto ECDSA/SHA-256 produces.
    ///         Raw P-256 signatures are accepted nowhere else. The Recovery key is consumed by this call.
    ///         Refused while a guardian is set (R13): then only `startCosignedRecovery` starts a recovery.
    function startRecovery(
        bytes32 recoverySignerId,
        uint256 newX,
        uint256 newY,
        uint64 deadline,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 recoveryId) {
        if (_cosignRequired()) revert GuardianRequired(guardian);
        recoveryId = _startRecovery(recoverySignerId, newX, newY, deadline, r, s, false);
    }

    /// @notice As `startRecovery`, with the guardian's WebAuthn assertion over the same recovery digest (R13): the
    ///         guardian confirms this recovery, of this key, to this new passkey, before this deadline. A recovery
    ///         started this way cannot be cancelled by a frozen Member; any unfrozen Member and the guardian still can,
    ///         and it finishes only after a whole recoveryDelay during which some Member was unfrozen.
    function startCosignedRecovery(
        bytes32 recoverySignerId,
        uint256 newX,
        uint256 newY,
        uint64 deadline,
        bytes32 r,
        bytes32 s,
        Assertion calldata cosign
    ) external nonReentrant returns (bytes32 recoveryId) {
        bytes32 g = guardian;
        if (g == bytes32(0) || cosign.signerId != g) revert NotGuardian(cosign.signerId);
        Signer storage gs = _signers[g];
        if (!_verifyAssertion(recoveryDigest(recoverySignerId, newX, newY, deadline), cosign, gs.x, gs.y)) {
            revert InvalidAssertion(0);
        }
        recoveryId = _startRecovery(recoverySignerId, newX, newY, deadline, r, s, true);
        emit RecoveryCosigned(recoveryId, g);
    }

    function _startRecovery(
        bytes32 recoverySignerId,
        uint256 newX,
        uint256 newY,
        uint64 deadline,
        bytes32 r,
        bytes32 s,
        bool cosigned
    ) internal returns (bytes32 recoveryId) {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (deadline > _latestRecoveryDeadline()) revert DeadlineTooFar(deadline);
        Signer storage rs = _signers[recoverySignerId];
        if (rs.role != Role.Recovery) revert NotARecoverySigner(recoverySignerId);
        bytes32 already = pendingRecoveryOf[recoverySignerId];
        if (already != bytes32(0)) revert RecoveryAlreadyPending(recoverySignerId, already);
        if (!P256.isValidPublicKey(bytes32(newX), bytes32(newY))) revert InvalidPublicKey(newX, newY);
        bytes32 newId = signerIdOf(newX, newY);
        if (_signers[newId].role != Role.None) revert SignerExists(newId);

        bytes32 digest = recoveryDigest(recoverySignerId, newX, newY, deadline);
        if (!P256.verifyNative(sha256(abi.encodePacked(digest)), r, s, bytes32(rs.x), bytes32(rs.y))) {
            revert InvalidRecoverySignature();
        }

        spentRecoveryKey[recoverySignerId] = true;
        recoveryId = keccak256(abi.encode(address(this), ++_serial, recoverySignerId, newX, newY));
        uint64 readyAt = uint64(block.timestamp) + recoveryDelay;
        _recoveries[recoveryId] =
            PendingRecovery(recoverySignerId, newX, newY, readyAt, cosigned, uint64(_epoch[ChangeKind.SetSentinel]));
        pendingRecoveryOf[recoverySignerId] = recoveryId;
        emit RecoveryStarted(recoveryId, recoverySignerId, newId, newX, newY, readyAt);
    }

    /// @notice After `recoveryDelay`, anyone may finish a recovery: the new Member is added and the Recovery key
    ///         that started it is removed. R13: a co-signed recovery only while some Member is unfrozen (its wait
    ///         restarts in full whenever a Member is unfrozen after none was), or, with every Member frozen, only if a
    ///         sentinel has been set and unchanged since its current wait began, so that the owner could stop it
    ///         through QED for the whole wait (H1); a recovery started without the guardian not while one is set.
    function finishRecovery(bytes32 recoveryId) external nonReentrant {
        PendingRecovery memory p = _recoveries[recoveryId];
        if (p.readyAt == 0) revert NothingPending(recoveryId);
        if (block.timestamp < p.readyAt) revert NotReady(recoveryId, p.readyAt);
        if (p.cosigned) {
            if (!_someUnfrozen() && !_sentinelWatched(p.sentinelEpoch)) revert NoUnfrozenMember();
        } else if (_cosignRequired()) {
            revert GuardianRequired(guardian);
        }
        delete _recoveries[recoveryId];
        delete pendingRecoveryOf[p.recoverySignerId];
        _removeSigner(p.recoverySignerId);
        bytes32 newId = _addSigner(p.newX, p.newY, Role.Member);
        emit RecoveryFinished(recoveryId, newId);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views: challenges the client must sign
    // ─────────────────────────────────────────────────────────────────────────────

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice The WebAuthn challenge for an `execute` batch.
    function executeDigest(Call[] calldata calls, uint256 nonce_, uint64 deadline) external view returns (bytes32) {
        return _hashTypedData(_hashExecute(calls, nonce_, deadline));
    }

    /// @notice The WebAuthn challenge Members sign for an ERC-1271 `hash` (binds this account and this chain).
    function replaySafeHash(bytes32 hash) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(MESSAGE_TYPEHASH, hash)));
    }

    /// @notice The WebAuthn challenge for cancelling a scheduled change or a pending recovery.
    function cancelDigest(bytes32 id) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(CANCEL_TYPEHASH, id)));
    }

    /// @notice The digest a Recovery key signs (with ECDSA/SHA-256, i.e. over sha256 of these 32 bytes).
    function recoveryDigest(bytes32 recoverySignerId, uint256 newX, uint256 newY, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedData(keccak256(abi.encode(START_RECOVERY_TYPEHASH, recoverySignerId, newX, newY, deadline)));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views: state
    // ─────────────────────────────────────────────────────────────────────────────

    function signerIdOf(uint256 x, uint256 y) public pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    function signerIds() external view returns (bytes32[] memory) {
        return _signerIds;
    }

    function getSigner(bytes32 signerId) external view returns (Signer memory) {
        return _signers[signerId];
    }

    /// @notice The protective (target, selector) list, in construction order (reasons are in the events).
    function protectiveCalls() external view returns (GuardKey[] memory) {
        return _protectiveList;
    }

    function getChange(bytes32 changeId) external view returns (PendingChange memory) {
        return _changes[changeId];
    }

    function getRecovery(bytes32 recoveryId) external view returns (PendingRecovery memory) {
        return _recoveries[recoveryId];
    }

    function isGuarded(address target, bytes4 selector) external view returns (bool) {
        return _guarded[target][selector];
    }

    /// @notice The lockable (target, selector) list, in construction order (reasons are in the events) (R13).
    function lockableCalls() external view returns (GuardKey[] memory) {
        return _lockableList;
    }

    /// @notice The guarded (target, selector) list, in construction order (reasons are in GuardConfigured events).
    function guardedCalls() external view returns (GuardKey[] memory) {
        return _guardList;
    }

    /// @notice The hash a scheduled batch is stored under: the EIP-712 array hash of its Call structs.
    function callsHash(Call[] calldata calls) external pure returns (bytes32) {
        return _hashCalls(calls);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals: approvals and WebAuthn
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Reverts unless every assertion is a valid assertion of `challenge` by a distinct, unfrozen Member (strictly
    ///      increasing signerId) and there are at least `required` of them.
    function _requireApprovals(bytes32 challenge, Assertion[] memory assertions, uint256 required)
        internal
        view
        returns (bytes32[] memory approvers)
    {
        uint256 n = assertions.length;
        if (n < required) revert NotEnoughApprovals(n, required);
        approvers = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            Assertion memory a = assertions[i];
            if (i > 0 && uint256(a.signerId) <= uint256(assertions[i - 1].signerId)) {
                revert AssertionsNotStrictlyIncreasing(i);
            }
            Signer storage sg = _signers[a.signerId];
            if (sg.role != Role.Member) revert NotAMember(a.signerId);
            if (!_approvalCounts(sg)) revert FrozenSigner(a.signerId);
            if (!_verifyAssertion(challenge, a, sg.x, sg.y)) revert InvalidAssertion(i);
            approvers[i] = a.signerId;
        }
    }

    /// @dev WebAuthn assertion check: the checks of OpenZeppelin 5.6.1 `WebAuthn.verify` with UV required (type,
    ///      challenge, UP, UV, BS only with BE, authenticatorData of at least 37 bytes), reproduced from its source
    ///      (MIT) with bounds-checked indices, plus the relying-party hash and the origin. The signature is checked by
    ///      the P-256 precompile only: `P256.verifyNative` (r and s in range, low s, the key on the curve; a revert if
    ///      0x100 has no precompile). Until R13 the account called `WebAuthn.verify` after `verifyNative`; that ran the
    ///      precompile a second time and carried P256's Solidity fallback, which this account can never reach (3.1 kB
    ///      of code). test/WebAuthnDiff.t.sol checks this function against `WebAuthn.verify` itself, unmodified.
    function _verifyAssertion(bytes32 challenge, Assertion memory a, uint256 x, uint256 y)
        internal
        view
        returns (bool)
    {
        bytes memory ad = a.authenticatorData;
        if (ad.length < 37) return false;
        bytes32 adRpIdHash;
        assembly ("memory-safe") {
            adRpIdHash := mload(add(ad, 0x20))
        }
        if (adRpIdHash != rpIdHash) return false;
        // flags: UP (0x01) and UV (0x04) set; BS (0x10) only with BE (0x08)
        bytes1 flags = ad[32];
        if (flags & 0x05 != 0x05 || flags & 0x18 == 0x10) return false;
        bytes memory json = bytes(a.clientDataJSON);
        if (!_hasField(json, a.originIndex, _originFieldHash, _originFieldLength)) return false;
        if (!_hasField(json, a.typeIndex, _TYPE_FIELD_HASH, 21)) return false;
        bytes memory field = abi.encodePacked('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        if (!_hasField(json, a.challengeIndex, keccak256(field), field.length)) return false;
        return P256.verifyNative(sha256(abi.encodePacked(ad, sha256(json))), a.r, a.s, bytes32(x), bytes32(y));
    }

    /// @dev Whether `json` holds, at `index`, exactly `len` bytes whose keccak256 is `fieldHash`.
    function _hasField(bytes memory json, uint256 index, bytes32 fieldHash, uint256 len) internal pure returns (bool) {
        if (index > json.length || json.length - index < len) return false;
        bytes32 h;
        assembly ("memory-safe") {
            h := keccak256(add(add(json, 0x20), index), len)
        }
        return h == fieldHash;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals: EIP-712
    // ─────────────────────────────────────────────────────────────────────────────

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            callHashes[i] =
                keccak256(abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data)));
        }
        return keccak256(abi.encodePacked(callHashes));
    }

    function _hashExecute(Call[] calldata calls, uint256 nonce_, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXECUTE_TYPEHASH, _hashCalls(calls), nonce_, deadline));
    }

    /// @dev Calls are made with all remaining gas; atomic: the first revert reverts everything.
    function _run(Call[] calldata calls) internal {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, reason);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internals: signer set, thresholds, delays, scheduling
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Members and Recovery keys (the constructor and addSigner). The guardian is inserted by applyChange only.
    function _addSigner(uint256 x, uint256 y, Role role) internal returns (bytes32 id) {
        if (role == Role.None || role == Role.Guardian) revert InvalidRole();
        id = _insertSigner(x, y, role);
    }

    function _insertSigner(uint256 x, uint256 y, Role role) internal returns (bytes32 id) {
        if (!P256.isValidPublicKey(bytes32(x), bytes32(y))) revert InvalidPublicKey(x, y);
        id = signerIdOf(x, y);
        if (_signers[id].role != Role.None) revert SignerExists(id);
        if (role == Role.Recovery && spentRecoveryKey[id]) revert RecoveryKeySpent(id);
        uint256 index = _signerIds.length;
        if (index >= MAX_SIGNERS) revert TooManySigners();
        if (role == Role.Member) {
            _thaw();
            ++memberCount;
        }
        uint64 serial = ++_serial;
        // since: 0 during construction (the household's own signers), the block time afterwards
        _signers[id] = Signer({
            x: x,
            y: y,
            role: role,
            serial: serial,
            index: uint8(index),
            frozen: false,
            since: address(this).code.length == 0 ? 0 : uint64(block.timestamp)
        });
        _signerIds.push(id);
        emit SignerAdded(id, role, x, y, serial);
    }

    function _removeSigner(bytes32 id) internal {
        Signer storage s = _signers[id];
        Role role = s.role;
        uint256 index = s.index;
        uint256 last = _signerIds.length - 1;
        if (index != last) {
            bytes32 moved = _signerIds[last];
            _signerIds[index] = moved;
            _signers[moved].index = uint8(index);
        }
        _signerIds.pop();
        delete _signers[id];
        if (role == Role.Member) --memberCount;
        if (role == Role.Recovery) {
            bytes32 pending = pendingRecoveryOf[id];
            if (pending != bytes32(0)) {
                delete _recoveries[pending];
                delete pendingRecoveryOf[id];
                emit RecoveryCancelled(pending, bytes32(0));
            }
        }
        emit SignerRemoved(id, role);
    }

    function _setThresholds(uint256 t, uint256 a) internal {
        _requireQuorum(t, a, memberCount);
        threshold = t;
        adminThreshold = a;
        emit ThresholdsChanged(t, a);
    }

    function _setDelays(uint64 d, uint64 rd) internal {
        _checkDelay(d);
        _checkDelay(rd);
        delay = d;
        recoveryDelay = rd;
        emit DelaysChanged(d, rd);
    }

    /// @dev The account's one structural invariant: 1 <= threshold <= adminThreshold <= memberCount.
    ///      adminThreshold >= threshold matters: otherwise fewer Members than `threshold` could add a Member
    ///      immediately and then reach `threshold` with it. Virtual only so the test suite's seeded-bug twin can
    ///      disable it and show the invariant test catches the difference.
    function _requireQuorum(uint256 t, uint256 a, uint256 members) internal view virtual {
        if (t == 0 || t > a || a > members) revert InvalidThresholds(t, a, members);
    }

    /// @dev Whether a Member's approval counts for execute and ERC-1271: not while it is frozen (R13). Virtual only so
    ///      the test suite's seeded-bug twin can disable it and show the invariant test catches the difference.
    function _approvalCounts(Signer storage sg) internal view virtual returns (bool) {
        return !sg.frozen;
    }

    /// @dev Whether a lockable call is refused by execute now (R13). Virtual only so the test suite's seeded-bug twin
    ///      can disable it and show the invariant test catches the difference.
    function _locked(address target, bytes4 sel) internal view virtual returns (bool) {
        return timeLocked && _lockable[target][sel];
    }

    /// @dev Whether a recovery needs the guardian's co-signature (R13). Virtual only for the seeded-bug twin.
    function _cosignRequired() internal view virtual returns (bool) {
        return guardian != bytes32(0);
    }

    /// @dev Whether this Member may cancel this recovery: not a frozen Member, when the guardian co-signed it (R13).
    ///      Virtual only for the seeded-bug twin.
    function _mayCancelRecovery(Signer storage sg, PendingRecovery storage pr) internal view virtual returns (bool) {
        return !(pr.cosigned && sg.frozen);
    }

    /// @dev How many Members are unfrozen, and how many have been Members for at least `delay` (R13).
    function _memberCounts() internal view returns (uint256 unfrozen, uint256 settled) {
        uint256 n = _signerIds.length;
        for (uint256 i; i < n; ++i) {
            Signer storage s = _signers[_signerIds[i]];
            if (s.role == Role.Member) {
                if (!s.frozen) ++unfrozen;
                if (_settled(s)) ++settled;
            }
        }
    }

    /// @dev Whether some Member is unfrozen, and so able to cancel any recovery (R13). Virtual only for the seeded-bug
    ///      twin.
    function _someUnfrozen() internal view virtual returns (bool) {
        (uint256 unfrozen,) = _memberCounts();
        return unfrozen != 0;
    }

    /// @dev Called just before a Member is unfrozen or added. If no Member is unfrozen until then, every pending
    ///      co-signed recovery's wait restarts in full now (R13, the owner's rule: a co-signed recovery finishes only
    ///      after a whole recoveryDelay during which some Member was unfrozen and able to cancel it). Virtual only for the
    ///      seeded-bug twin.
    function _thaw() internal virtual {
        if (_someUnfrozen()) return;
        uint256 n = _signerIds.length;
        for (uint256 i; i < n; ++i) {
            bytes32 rid = pendingRecoveryOf[_signerIds[i]];
            PendingRecovery storage p = _recoveries[rid];
            if (p.cosigned) {
                // never earlier than it was (independent review L1: the delay may have been lowered meanwhile)
                uint64 readyAt = uint64(block.timestamp) + recoveryDelay;
                if (readyAt < p.readyAt) readyAt = p.readyAt;
                p.readyAt = readyAt;
                p.sentinelEpoch = uint64(_epoch[ChangeKind.SetSentinel]);
                emit RecoveryRestarted(rid, readyAt);
            }
        }
    }

    /// @dev Drops a pending recovery and spends the recovery key that started it (recovery codes are single use).
    function _dropRecovery(bytes32 id, bytes32 by) internal {
        bytes32 rsid = _recoveries[id].recoverySignerId;
        delete _recoveries[id];
        delete pendingRecoveryOf[rsid];
        emit RecoveryCancelled(id, by);
        _removeSigner(rsid);
    }

    /// @dev Whether a sentinel has been set, and not changed, since a co-signed recovery's current wait began (`epoch`):
    ///      the owner could then have stopped it through QED for the whole wait (R13 H1). Virtual only for the seeded-bug
    ///      twin.
    function _sentinelWatched(uint64 epoch) internal view virtual returns (bool) {
        return sentinel != address(0) && _epoch[ChangeKind.SetSentinel] == epoch;
    }

    /// @dev Whether a signer has been one for at least `delay`; the constructor's signers always have (R13).
    function _settled(Signer storage s) internal view returns (bool) {
        return s.since == 0 || uint256(s.since) + delay <= block.timestamp;
    }

    /// @dev Reverts unless more than `adminThreshold` settled Members remain besides the `settledRemoved` settled
    ///      Members a removal names (R13). Virtual only for the seeded-bug twin.
    function _requireCanceller(uint256 settledRemoved) internal view virtual {
        (, uint256 settled) = _memberCounts();
        if (settled - settledRemoved <= adminThreshold) revert NoCancellerLeft();
    }

    /// @dev The latest deadline a recovery started now may carry (R13). Virtual only for the seeded-bug twin.
    function _latestRecoveryDeadline() internal view virtual returns (uint256) {
        return block.timestamp + MAX_RECOVERY_WINDOW;
    }

    /// @dev Whether a scheduled change of the sentinel, the guardian or the time-lock still applies: that setting has
    ///      not changed since it was scheduled (R13). Virtual only for the seeded-bug twin.
    function _isCurrent(ChangeKind kind, uint256 epoch) internal view virtual returns (bool) {
        return _epoch[kind] == epoch;
    }

    function _setTimeLock(bool on) internal {
        timeLocked = on;
        ++_epoch[ChangeKind.SetTimeLock];
        emit TimeLockChanged(on);
    }

    function _setSentinel(address s) internal {
        sentinel = s;
        ++_epoch[ChangeKind.SetSentinel];
        emit SentinelChanged(s);
    }

    function _checkDelay(uint64 d) internal pure {
        if (d < MIN_DELAY || d > MAX_DELAY) revert InvalidDelay(d);
    }

    function _schedule(
        ChangeKind kind,
        uint256 fromA,
        uint256 fromB,
        uint256 toA,
        uint256 toB,
        bytes32[] memory targets,
        uint64[] memory serials,
        bytes32 callsHash_
    ) internal returns (bytes32 id) {
        id = keccak256(abi.encode(address(this), ++_serial, kind, toA, toB, targets, callsHash_));
        uint64 readyAt = uint64(block.timestamp) + delay;
        PendingChange storage c = _changes[id];
        c.kind = kind;
        c.readyAt = readyAt;
        c.fromA = fromA;
        c.fromB = fromB;
        c.toA = toA;
        c.toB = toB;
        c.targets = targets;
        c.targetSerials = serials;
        c.callsHash = callsHash_;
        emit ChangeScheduled(id, kind, readyAt, toA, toB, targets);
    }
}
