# QEDOwnerAccount: a passkey owner for the release's QEDVault

R7 decision D3, layer 3 (`docs/r7/00-ARCHITECTURE-DECISIONS.md`). Written 20 to 22 Nov 2026 by the
qed-solidity-security agent. **Research code: not audited, never deployed outside an ephemeral local Anvil.**

Each workspace's vault set (the release's `QEDVault`, `QEDExecution`, `QEDTreasuryPolicy`, unmodified) is owned by
one `QEDOwnerAccount`. Its signers are P-256 public keys:

- **Members** are WebAuthn passkeys. They approve `execute` batches, ERC-1271 messages (the vault's mandates) and
  cancellations. Every assertion must carry user verification, come from the stored relying party and web origin,
  and sign the exact challenge the contract derives.
- **Recovery keys** are raw P-256 keys derived in the client from a recovery code. One can only start a recovery
  that adds one Member after `recoveryDelay`; the code is used up by the attempt.

The execution service only relays transactions and pays gas; it holds no key that can satisfy the account.
Signatures are verified only by the EIP-7951 P-256 precompile at `0x100`; the account refuses to deploy on a chain
without it.

## Files

| Path | What |
|---|---|
| `src/QEDOwnerAccount.sol` | the contract (solc 0.8.38, `evm_version = osaka`, via-IR, optimizer 200) |
| `webauthn.ts` | client module, `node:crypto` only: challenges, browser assertion to calldata, software authenticator, recovery codes, guard list |
| `test/*.t.sol`, `test/helpers/*` | Foundry tests (unit, fuzz, invariants, vault integration against the real release contracts) |
| `seeded/BuggyQuorum.t.sol` | seeded-bug twin; its invariant test is expected to FAIL |
| `test-ts/*.test.ts` | `node --test`: offline tests and the real-Anvil integration |
| `lib/openzeppelin-contracts-5.6.1/` | 13 OpenZeppelin files, unmodified, see `VENDORED.md` |
| `evidence/` | logs and JSON of every run cited below |
| `READY.json` | build artefact hash for the rail. `out/` is git-ignored (`../.gitignore`), so after a fresh checkout rebuild first; the artefact JSON can hash differently after a rebuild with another source set, while the creation bytecode stays SHA-256 `329a52c5d9486ba2f98ac993dc6bb5c80ff09d64d63f966a932c0f959bad3ae6` (24,027 bytes) |

## Interface

```solidity
constructor(bytes32 rpIdHash, string origin, SignerInit[] signers, uint256 threshold, uint256 adminThreshold,
            uint64 delay, uint64 recoveryDelay, Guard[] guards)
// SignerInit(uint256 x, uint256 y, Role role)   Role: None=0, Member=1, Recovery=2
// Guard(address target, bytes4 selector, string reason)   fixed at construction, reason required

// Anyone may relay. nonce must equal nonce(); block.timestamp <= deadline; assertions strictly increasing by
// signerId, every one a valid Member assertion; >= threshold of them, >= adminThreshold if any call targets the
// account. Refuses any guarded (target, selector) whatever the approvals. Atomic; nonReentrant.
function execute(Call[] calls, uint256 nonce, uint64 deadline, Assertion[] assertions)
// Call(address target, uint256 value, bytes data)
// Assertion(bytes32 signerId, bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex,
//           uint256 originIndex, bytes authenticatorData, string clientDataJSON)

// ERC-1271: signature = abi.encode(Assertion[]) over replaySafeHash(hash); >= threshold Members.
function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)   // 0x1626ba7e or 0xffffffff
function checkSignature(bytes32 hash, bytes signature) view                       // reverts with the reason

// Only through execute (msg.sender == account, so adminThreshold approvals):
function addSigner(uint256 x, uint256 y, Role role)                 // immediate
function removeSigners(bytes32[] ids) returns (bytes32 changeId)    // scheduled; ids strictly increasing
function setThresholds(uint256 threshold, uint256 adminThreshold) returns (bytes32 changeId) // scheduled if either decreases
function setDelays(uint64 delay, uint64 recoveryDelay) returns (bytes32 changeId)            // scheduled if either shortens
function scheduleCalls(Call[] calls) returns (bytes32 changeId)     // the delayed path; no calls to the account itself

// After the delay, anyone:
function applyChange(bytes32 changeId)                    // removals, thresholds, delays; re-checks everything
function applyCalls(bytes32 changeId, Call[] calls)       // the exact scheduled batch (see CallsScheduled)
// Any ONE Member, whatever the thresholds; not for a removal that targets that Member:
function cancel(bytes32 id, Assertion assertion)          // over cancelDigest(id); also cancels recoveries

// Recovery (raw P-256 over sha256(recoveryDigest(...)), low-s):
function startRecovery(bytes32 recoverySignerId, uint256 newX, uint256 newY, uint64 deadline, bytes32 r, bytes32 s)
function finishRecovery(bytes32 recoveryId)               // anyone, after recoveryDelay

// Challenges and state
function executeDigest(Call[] calls, uint256 nonce, uint64 deadline) view returns (bytes32)
function replaySafeHash(bytes32 hash) view returns (bytes32)
function cancelDigest(bytes32 id) view returns (bytes32)
function recoveryDigest(bytes32 recoverySignerId, uint256 newX, uint256 newY, uint64 deadline) view returns (bytes32)
function callsHash(Call[] calls) pure returns (bytes32)
function domainSeparator() view returns (bytes32);  function eip712Domain() view returns (...)   // ERC-5267
function signerIdOf(uint256 x, uint256 y) pure returns (bytes32)       // keccak256(abi.encode(x, y))
function signerIds() view returns (bytes32[]);  function getSigner(bytes32) view returns (Signer)
function getChange(bytes32) view returns (PendingChange);  function getRecovery(bytes32) view returns (PendingRecovery)
function isGuarded(address, bytes4) view returns (bool);   function guardedCalls() view returns (GuardKey[])
// public getters: rpIdHash, origin, nonce, threshold, adminThreshold, memberCount, delay, recoveryDelay,
//                 pendingRecoveryOf(bytes32), spentRecoveryKey(bytes32), MAX_SIGNERS=16, MIN_DELAY=60, MAX_DELAY=30 days
```

EIP-712 domain: `name "QEDOwnerAccount"`, `version "1"`, `chainId`, `verifyingContract` (the account). Types:
`Execute(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)`,
`QEDOwnerMessage(bytes32 hash)`, `Cancel(bytes32 id)`,
`StartRecovery(bytes32 recoverySignerId,uint256 newX,uint256 newY,uint64 deadline)`.

**What a Member assertion must satisfy on chain:** `authenticatorData` at least 37 bytes and its first 32 bytes
equal to `rpIdHash`; flags UP and UV set, and BS only with BE; `"type":"webauthn.get"` at `typeIndex`;
`"challenge":"<base64url(challenge)>"` at `challengeIndex`; `"origin":"<origin>"` at `originIndex`;
`0 < r < n`, `0 < s <= n/2`, the key on the curve; P-256 verification of
`sha256(authenticatorData || sha256(clientDataJSON))` by the precompile. `P256.verifyNative` runs first, and its
result is the decision (false for an invalid signature, a revert if `0x100` is absent). OpenZeppelin's
`WebAuthn.verify` then applies its own checks unchanged, so its Solidity fallback can never run.

**Events** (the wallet turns these into notifications): `AccountConfigured`, `GuardConfigured`, `SignerAdded`,
`SignerRemoved`, `ThresholdsChanged`, `DelaysChanged`, `ChangeScheduled`, `CallsScheduled`, `ChangeApplied`,
`ChangeCancelled`, `RecoveryStarted`, `RecoveryCancelled`, `RecoveryFinished`, `Executed` (with the approving
signer ids).

**Invariant:** `1 <= threshold <= adminThreshold <= memberCount`, always. `adminThreshold >= threshold` is
enforced because otherwise fewer than `threshold` Members could add a Member immediately and then reach `threshold`.

## Guarded calls (decided by the R7 orchestrator, 22 Nov 2026; `docs/r7/00-ARCHITECTURE-DECISIONS.md`)

Calls that take the vault away, or widen who may move its funds or how much, must go through the delayed,
cancellable admin path: `scheduleCalls` (adminThreshold approvals via `execute`), then `delay`, during which any
one Member can `cancel`, then `applyCalls` by anyone. `execute` refuses them even when every Member signs. The list
is fixed at construction. `webauthn.ts` `releaseGuards()` and `test/helpers/Release.sol` hold the recommended
list, with identical reasons (a unit test compares them word for word):

| Target | Selector | Reason |
|---|---|---|
| QEDVault | `transferOwnership(address)` | Moves every owner power over the vault, and through `vault.owner()` over its execution and policy contracts, to another address. |
| QEDVault | `setAgent(address)` | The agent is the only key that can redeem the owner's mandates; replacing it changes who can move the vault's funds. |
| QEDVault | `setCosigner(address)` | The co-signer certifies every payment independently; replacing it changes who approves the vault's outflows. |
| QEDVault | `setDailyCap(uint256)` | The daily cap bounds all agent payments across every mandate; raising it lets the agent move more. Guarded by selector, so lowering also waits; pause, bumpEpoch and revokeMandate stay immediate. |
| QEDExecution | `setVenues(address[],uint16[])` | The venue set decides where the agent's orders may trade the vault's funds; adding a venue widens where they can go. |
| QEDExecution | `setOperator(address)` | The operator is the hot key that may call trade and pay against the vault; replacing it changes who can move the vault's funds. |
| QEDTreasuryPolicy | `setPolicy((uint256,uint256,uint256,uint16,uint16,uint64))` | The standing conversion policy's limits bound automatic conversions; raising them lets more move. Guarded by selector, so any change waits; revoke() stays immediate. |
| QEDTreasuryPolicy | `setAgent(address)` | The policy agent is the key allowed to run conversions under the policy; replacing it changes who can move the treasury's funds. |

**Not guarded (immediate at `threshold`), and why:**
- `pause()`, `bumpEpoch()`, `revokeMandate(bytes32)`, `QEDTreasuryPolicy.revoke()`: protective, must be immediate.
- `acceptOwnership()`: it gains a vault, it takes nothing away.
- `withdraw(address,uint256)` and `ringFence(...)`: these are the owner moving its own free funds, and they stay
  spending authority at `threshold` under the decision as worded. **A threshold quorum can still move free funds
  out immediately** (open question below).
- `unpause()` and `setGuardian(address)`: not in the decision. One re-enables the agent; the other replaces the
  emergency brake (open question below).
- ERC-1271 approvals (mandates) stay at `threshold`. A threshold quorum can sign a mandate with high caps; the
  vault's guarded daily cap still bounds the agent's total per day.

Selector granularity is deliberate: the contract does not decode arguments, so "raising a limit" is guarded by
guarding the setter.

## Decisions taken in this work

| Id | Decision | Status |
|---|---|---|
| D-a | OpenZeppelin 5.6.1 (`WebAuthn`, `P256`), not base/webauthn-sol. Base's code re-checks every invalid signature with FreshCryptoLib, which breaks fail-closed. `P256.verifyNative` runs before `WebAuthn.verify`. | proposed |
| D-b | The web origin is fixed at construction and checked on chain. The relying-party id `localhost` is shared by every local port. | **accepted 22 Nov** |
| D-c | A Member cannot cancel a removal that targets it; `removeSigners` takes a set. Otherwise a stolen passkey could veto its own removal forever. | **accepted 22 Nov** |
| D-d | Cancelling a recovery also burns its code (single use). | **accepted 22 Nov** |
| D-e | `adminThreshold >= threshold` is enforced. | proposed |
| D-f | ERC-1271 is invalid if any supplied assertion is invalid (stricter than "at least threshold verify"). | proposed |
| D-g | The recovery key signs `sha256(digest)` (what WebCrypto ECDSA/SHA-256 produces). | proposed |
| D-h | `delay` and `recoveryDelay` must lie between 1 minute and 30 days. The wallet uses 72 h for recovery outside labelled test mode (D2). | proposed |
| D-i | Guarded calls as above. Scheduled batches are hash-bound, cannot target the account, and stay pending until applied or cancelled. | **accepted 22 Nov (R7 orchestrator, not the owner), implemented** |

## Threat table

| Attacker holds | Can | Cannot |
|---|---|---|
| **The relayer** (execution service) | Withhold or delay any transaction (execute, cancel, startRecovery, applyCalls). Pick when, before a batch's deadline, to submit it. Choose the gas: inner calls get what is left, so a target whose behaviour depends on gas could be steered (the vault set's owner functions do not; `isValidSignature` fails closed, returning invalid). Apply a ready change or finish a ready recovery (anyone can). On a chain with a public mempool, front-run a cancel sent after `readyAt`. | Change any call, value, nonce or deadline. Replay a batch (nonce). Use an approval on another account or chain. Make `isValidSignature` valid. Accept vault ownership for the account. Run a guarded call early. |
| **A stolen web session** (no passkey) | Ask the user's authenticator for an assertion through the wallet page; the user still sees a biometric or PIN prompt. Show misleading terms if the page displays what the server says. | Produce an assertion without the user (UV is checked on chain). Use an assertion made on another origin or relying party. The client must compute challenges from the terms it shows itself; `webauthn.ts` does. |
| **One Member passkey, personal account** (1 Member, thresholds 1/1) | Everything the owner can do immediately: withdraw free funds, sign mandates, pause and unpause, add signers. Schedule guarded calls and removals. Cancel recoveries, which burns the codes. | Make any guarded call before `delay`; the real owner can cancel it meanwhile. Remove the only Member (quorum). A 1-of-1 account whose passkey is stolen is shared with the thief: on-chain rules cannot tell them apart. The delays buy notification time and keep the vault's authority wiring from changing at once. |
| **One Member passkey, business account** (threshold 1, admin 2) | Spend at `threshold`: withdraw, ringFence, sign mandates. Pause and unpause, bumpEpoch, revokeMandate. Cancel any scheduled change except its own removal, and any recovery. | Add or remove signers, change thresholds or delays, make or even schedule a guarded call. Stop its own removal by the other Members. |
| **One Member passkey, threshold ≥ 2** | Veto: cancel scheduled changes (not its own removal) and recoveries. | Execute anything, sign ERC-1271, schedule anything. |
| **A recovery code** | Start one recovery naming its own key. After `recoveryDelay`, if no Member cancels, it holds one Member seat (thresholds unchanged). | Execute, sign ERC-1271, cancel, act before the delay, use the code twice, or act at all once a Member cancels (the code is burnt). |
| **An admin quorum** (adminThreshold Members, colluding or stolen) | Everything immediate, including adding its own keys. Schedule anything. | Make guarded calls or protection-reducing changes before `delay`. Stop any other Member from cancelling them, except removals that target that Member. |

**Incident sequences that work under these rules.**
1. Agent or co-signer key leaked: any one Member pauses and/or bumps the epoch (both immediate). The admin quorum
   schedules `setAgent`/`setCosigner`, applies it after `delay`, signs new mandates, then unpauses.
2. A Member passkey stolen (business account): the other Members schedule the removal of that key, which it cannot
   cancel; pause meanwhile if needed. Remove the thief first, because it can veto other changes during the delay.
3. A recovery code stolen: any Member cancels the recovery when notified; that burns the code.

## Gas

Measured on Anvil 1.7.1 (`--hardfork osaka`) from transaction receipts (`evidence/anvil-integration.json`), and in
the forge EVM (`evidence/forge-gas-measurements.txt`, `evidence/forge-gas-report.txt`).

| Operation | Gas used |
|---|---|
| Deploy QEDOwnerAccount (1 Member, 1 Recovery, 8 guards) | 5,281,679 |
| Deploy QEDVault (release bytecode), for comparison | 2,173,330 |
| `execute`, 1 assertion: `vault.acceptOwnership()` | 104,654 |
| `execute`, 1 assertion: `vault.revokeMandate(...)` | 107,124 |
| `vault.executePayment` with an ERC-1271 owner signature and a co-signer certificate (the agent's transaction) | 254,054 |
| `checkSignature`, 1 assertion, as a transaction (estimate; includes 21,000 intrinsic and about 800 bytes of calldata) | 62,471 |
| `execute` → `scheduleCalls` (1 guarded call) | 154,293 |
| `applyCalls` (1 guarded call: `setDailyCap`) | 54,299 |
| `cancel` a scheduled guarded batch (1 assertion) | 73,815 |
| `execute` → `removeSigners` (scheduled) | 216,489 |
| `cancel` a removal (1 assertion) | 77,442 |
| `startRecovery` (raw P-256) | 184,328 |
| `finishRecovery` | 126,395 |
| forge EVM: one P-256 precompile call, valid signature, including call overhead | 7,432 |
| forge EVM: `isValidSignature`, 1 / 2 assertions (cold storage) | 29,246 / 53,439 |

Each Member assertion goes through the precompile twice (`verifyNative`, then inside `WebAuthn.verify`), about 7,000
gas extra. That is the price of a precompile-only decision with OpenZeppelin's checks left unmodified.

Do not estimate gas on `isValidSignature`: with too little gas it returns `0xffffffff` instead of reverting, so an
estimate measures the cost of answering "invalid". Estimate `checkSignature`.

Contract size: 20,229 bytes runtime (EIP-170 margin 4,347); 24,027 bytes initcode (`evidence/forge-build-sizes.txt`).
Most of it is OpenZeppelin's Solidity P-256 code, which this contract can never reach.

## Verified

Every item was produced on the final source: `src/QEDOwnerAccount.sol` SHA-256 `e984ffbe6bc6575a1e2ff8fcb0c208b43e41328bcab97e0d205b4db969e2e122`, artefact `out/QEDOwnerAccount.sol/QEDOwnerAccount.json` SHA-256 `84566df15d0c3965fcd83672ab8522b76bdb44f281f2a77e60137c058523a5bd` (as in `READY.json`).

| | Claim | Evidence |
|---|---|---|
| V1 | Builds with solc 0.8.38 (osaka); the release's QEDVault, TestUSD, QEDExecution and QEDTreasuryPolicy (solc 0.8.26) are built from the vendored sources | `evidence/forge-build-sizes.txt` |
| V2 | The four release contracts we build are byte-identical to the release's recorded creation bytecode (`../vendor/agent/src/abi/contracts.ts`), and the Anvil test deploys those recorded bytes | `test-ts/anvil.integration.test.ts`, `evidence/node-test.txt` |
| V3 | 155 forge tests pass in 11 suites: Verifier 26, Execute 27, ERC1271 14, Admin 26, Recovery 17, Construction 8, Guards 16, VaultIntegration 9, BusinessGuards 6, Invariants 5, Gas 1. 21 fuzz tests ran 1,000 times each (seed 0x7e5a); 5 invariants ran 256 runs × 48 calls | `evidence/forge-test.txt` |
| V4 | Invariants with fail-on-revert: 0 handler reverts. Not vacuous: 115 scheduled changes applied, 391 cancellations, 27 recoveries finished, 978 immediate guarded calls attempted with every Member signing, none ran | `evidence/forge-invariants-fail-on-revert.txt`, `evidence/invariant-ghosts-summary.txt` |
| V5 | The seeded-bug twin (quorum rule disabled) fails `invariant_quorum` ("adminThreshold <= members: 4 > 3"); its other four invariants hold | `evidence/forge-seeded-twin.txt` |
| V6 | 24 `node --test` tests pass: 10 offline and 14 on real Anvil chains (A: osaka 31337, B: osaka 31338, C: prague 31339), all on 127.0.0.1 and stopped by the test. Covered: ownership moves from an EOA to the account through `execute` with a software-passkey assertion; (a) the old EOA is refused on all 10 onlyOwner functions, `pause` and `acceptOwnership`, and a mined attempt fails; (b) an ERC-1271 mandate with a co-signer certificate pays 40 tUSD; (c) a mandate signature made for another account fails with `BadOwnerSignature`; all 8 guarded calls refused immediately; the delayed path applies after `delay`; one Member cancels a scheduled guarded call; `pause` stays immediate; an assertion from `http://localhost:8080` is refused; batch replay is refused; cancel and recovery work end to end; on chain B (same address) chain-A signatures and batches are refused; on chain C the account cannot be deployed (`MissingPrecompile(0x100)`) | `evidence/node-test.txt`, `evidence/anvil-integration.json` |
| V7 | `webauthn.ts`: ABI encoding equals `cast calldata`/`cast abi-encode`; selectors equal `cast sig`; all four challenge types equal viem `hashTypedData` and the contract's own views; strict TypeScript, 0 errors | `test-ts/webauthn.unit.test.ts`, `evidence/tsc.txt` |
| V8 | Slither 0.11.6: 19 findings on our code, every one dispositioned below | `evidence/slither.json`, `evidence/slither.txt` |

## Not verified

- **Real browsers and authenticators** (Touch ID, Windows Hello, security keys, Android). Only the software
  authenticator was tested; it serialises `clientDataJSON` as WebAuthn Level 3 §5.8.1.1 says. Browser variants,
  such as Chrome's extra member, should pass because the checks are by substring at an index. Not tested.
- **Any chain other than Anvil 1.7.1.** Neither L2s using RIP-7212 at `0x100` nor public networks were tested.
- **Audit coverage of the dependencies.** OpenZeppelin `WebAuthn.sol` (5.5.0, changed in 5.6.0) and the 5.6.0
  texts of Base64, Bytes, Strings, Math and SafeCast are outside OpenZeppelin's listed audits. `P256.sol` (5.3.0) is
  inside the listed v5.3 audit. See `VENDORED.md`.
- **No independent review of QEDOwnerAccount**, and no formal verification (no Halmos or Certora). All reviews so
  far are by the author.
- **Not integrated with the rail or the wallet**, and no browser UI. The rail must deploy the vault set first (the
  guard list needs its addresses), then the account, then `transferOwnership`/`acceptOwnership` through `execute`.
- **Recovery-code KDF** (scrypt N=2^15, r=8, p=1, fixed salt): chosen for local use and not reviewed. The codes
  carry 130 bits of entropy, so the KDF's cost is not what protects them.

## Slither 0.11.6 findings and dispositions

`SOLC_VERSION=0.8.38 slither . --exclude-dependencies --json evidence/slither.json` (exit 255 = findings present;
`"success": true`).

| # | Detector | Impact | Where | Disposition |
|---|---|---|---|---|
| 1 | arbitrary-send-eth | High | `src/QEDOwnerAccount.sol:775-780` `_run` | **False positive, by design.** Every target and value is either in the EIP-712 digest that at least `threshold` Members approved (`execute`), or in a batch the admin quorum scheduled, nobody cancelled, and whose hash is checked (`applyCalls`). Relayer tampering and `CallsMismatch` are tested. |
| 2-3 | calls-loop | Low | `:775-780`, reached from `execute` and `applyCalls` | Intended: a batch is atomic. A failing call reverts it, keeping the nonce, or keeping the change pending. |
| 4-8 | timestamp | Low | `execute :336`, `applyCalls :471`, `applyChange :484`, `startRecovery :558`, `finishRecovery :585` | Accepted: deadlines, and delays of at least 1 minute (days in practice). A few seconds of block-time drift does not matter. |
| 9-10 | assembly | Info | `:718-720` (load the rpIdHash word after a length check of at least 37), `:747-749` (keccak over a bounds-checked slice) | Reviewed; memory-safe; covered by tests including out-of-range indices. |
| 11 | pragma | Info | OpenZeppelin `^0.8.20`/`^0.8.24`, ours `0.8.38` | Accepted; all compiled with 0.8.38. |
| 12-18 | costly-loop | Info | `_addSigner :786-799` and `_removeSigner :801-823` inside loops (constructor, `applyChange`) | Accepted: bounded by `MAX_SIGNERS = 16`. |
| 19 | low-level-calls | Info | `:777` | Needed for generic calls; success is checked and the revert reason is bubbled up in `CallFailed`. |

Run with dependencies (`evidence/slither-with-dependencies.json`): 87 findings; the 68 extra are all in unmodified
OpenZeppelin 5.6.1 code, and all are intentional:
- `incorrect-exp` at `Math.sol:259` (XOR seeds Newton-Raphson) and `Base64.sol:83` (XOR switches to the URL-safe alphabet);
- `divide-before-multiply` in `Math.mulDiv` and in Base64's length rounding;
- `too-many-digits` (curve constants), `assembly`, `solc-version`.

## How to run

```bash
cd apps/qed-demo/chain/accounts
SOLC_VERSION=0.8.38 forge build
SOLC_VERSION=0.8.38 forge test                              # 155 tests
FOUNDRY_PROFILE=seeded SOLC_VERSION=0.8.38 forge test       # seeded-bug twin: expected to FAIL
node --test --test-concurrency=1 test-ts/                   # 24 tests; starts and stops its own Anvil chains
node ../node_modules/typescript/bin/tsc -p tsconfig.json    # type check (TypeScript from the chain rail's tree)
rm -f evidence/slither.json && SOLC_VERSION=0.8.38 slither . --exclude-dependencies --json evidence/slither.json
```

Slither does not overwrite an existing `--json` file, so delete it first. Foundry filters four warning codes, all
emitted only by the read-only forge-std 1.9.7 (see `foundry.toml`).

## Using webauthn.ts

```ts
import * as W from './webauthn.ts';
const guards = W.releaseGuards({ vault, execution, policy });                        // constructor input
// A guarded call cannot go through execute directly: wrap it in a scheduling batch (needs adminThreshold).
const batch = calls.some((c) => W.isGuardedCall(c, guards))
  ? [{ target: account, value: 0n, data: W.encodeScheduleCalls(calls) }]
  : calls;
const challenge = W.executeDigest({ account, chainId, calls: batch, nonce, deadline }); // computed by the client
// browser: navigator.credentials.get({ publicKey: { challenge: hexToBytes(challenge), rpId: 'localhost',
//          userVerification: 'required', allowCredentials } })
const a = W.toContractAssertion(cred.response, signerId, { challenge, rpId: 'localhost', origin: 'http://localhost:5175' });
const data = W.encodeExecute(batch, nonce, deadline, [a]);
// after `delay`, anyone: W.encodeApplyCalls(changeId, calls)   (changeId from the ChangeScheduled event)
```

`toContractAssertion` checks every rule the contract applies before anything is sent, and normalises `s`.
`SoftwarePasskey` and `RecoveryKey` are for tests and for deriving the recovery key from a code. Recovery codes are
26 Crockford base-32 characters (130 bits); never shorten them, because the recovery public key is on chain.

## R13: containing a suspended passkey (24 Nov 2026)

Written by the qed-solidity-security agent for R13 (SECURITY.md "New residual risks", item 2). **Research code: not
audited.** This build supersedes the counts above for its own artefact: `src/QEDOwnerAccount.sol` SHA-256
`f398b6e11714daf4652ac3993c8dfd914fb5a3711dacd3366f15c39fd3204925`, creation bytecode SHA-256
`8ec79bc04b8dd14f98830b32fb72cc90d09bee40eab10e10063764119c0842fd` (27,705 bytes), runtime 23,112 bytes (EIP-170
margin 1,464; `evidence/forge-build-sizes.txt`). The artefact's own hash is in `READY.json`.

**What changed.** Two powers, both fixed at construction (two constructor arguments appended: `Guard[] protective`,
`address sentinel`):

```solidity
function freeze(bytes32 signerId)                  // the sentinel only; a Member only; once
function unfreeze(bytes32 signerId)                // onlySelf: the admin quorum of UNFROZEN Members, immediate
function setSentinel(address s)                    // onlySelf: zero at once; a new one is scheduled behind `delay`
function protect(Call[] calls, uint256 nonce, uint64 deadline, Assertion a)   // ONE Member, frozen or not
function protectDigest(Call[] calls, uint256 nonce, uint64 deadline) view returns (bytes32)
// views: sentinel(), protectNonce(), isProtective(address,bytes4), protectiveCalls(), getSigner(id).frozen
// EIP-712 type: Protect(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)
// events: SentinelChanged, SignerFrozen, SignerUnfrozen, ProtectiveCallConfigured, Protected
```

- **The sentinel** is one address (the workspace's own HKDF-derived service key, `workspace:<id>:sentinel`). It can
  call `freeze` and nothing else. A frozen Member's approval does not count for `execute` or ERC-1271 (a mandate it
  alone signed stops paying at the next payment); an assertion by a frozen Member spoils the batch (D-f). A frozen
  Member **keeps its veto** (`cancel`, except its own removal) and may still `protect`.
- **Protective calls** (`webauthn.ts releaseProtective`, `test/helpers/Release.sol ReleaseProtective`, compared word
  for word by a unit test): `pause()`, `bumpEpoch()`, `revokeMandate(bytes32)` on both vaults, and the policy's
  `revoke()`. Each only stops something and moves no money; none is guarded; value must be 0. `protect` has its own
  nonce and type, so it never uses up or stands in for an `execute` approval.

**Why these choices (decision D-j, proposed).** Pausing the vault through its guardian (the release's
`QEDVault.pause`) does not contain a stolen passkey: the vault's owner, the account, can still `withdraw`, `ringFence`
and `unpause` at threshold. Containment has to be in the account, per signer, because only the wallet knows which
passkey it suspended. The frozen Member keeps its veto and `protect` on purpose: a sentinel that could take away a
veto, or the owner's way to stop the agent, would let the service (which also holds the agent and co-signer keys)
help a thief (freeze the owner, let a thief's scheduled change apply) or keep spending under mandates. With both
kept, the worst the sentinel can do is stop the household spending.

**Abuse case of the sentinel, and its limits.** If the service's sentinel key is misused it can freeze any Member,
or all of them. Then: no money moves (nothing it can do executes or signs); every Member can still cancel any change
(except its own removal) and any recovery, and stop the agent through `protect`; it cannot unfreeze, cancel, schedule,
apply early, freeze a recovery key, or sign anything. The household ends it with the admin quorum of unfrozen Members
(`unfreeze` and `setSentinel(0)` in one execute, both immediate). If every Member is frozen, with its recovery key:
the recovery waits `recoveryDelay`, and finishing it and the new Member's `execute([setSentinel(0), unfreeze…])` in one
transaction leaves the sentinel no moment to freeze the new key (`test_sentinel_abuse_freezes_everyone_moves_nothing_and_a_recovery_ends_it`).
Not built: QED's interface offers neither path; both need direct access to the chain. A household with no recovery
key whose every Member is frozen cannot spend until the sentinel's holder relents.

**Threat table, added rows.**

| Attacker holds | Can | Cannot |
|---|---|---|
| **The sentinel key** | Freeze any Member at once (stopping the household's spending; mandates signed only by frozen Members stop paying). | Move money, sign, execute, schedule, cancel, unfreeze, freeze a recovery key, or take away any Member's veto or `protect`. |
| **A frozen Member passkey** | Cancel scheduled changes (not its own removal) and recoveries (spending their code); `protect` (pause, bump the epoch, revoke a mandate or the policy) until it is removed. | Approve any execute or ERC-1271 message: no payment, mandate, signer, threshold, delay, sentinel or scheduled change. Unfreeze itself. |
| **One Member passkey, threshold ≥ 2** | As before, plus `protect`. | As before. |

**Verified (this build).** 181 Forge tests in 13 suites (the 155 above plus Containment 20, VaultContainment 3 against
the release's own contracts, and three new invariants), `evidence/forge-test.txt`. Eight invariants, 256 runs × 48
calls, all with fail-on-revert and 0 handler reverts (`evidence/forge-invariants-fail-on-revert.txt`); not vacuous: 2,092
freezes, 2,034 attempts by frozen Members alone to approve a batch or an ERC-1271 message (all refused, asserted),
3,934 protective calls run, 1,258 of them by frozen Members (`evidence/invariant-ghosts-summary.txt`). Seeded twins:
`seeded/BuggyFreeze.t.sol` (frozen approvals counted) fails `invariant_frozen_member_never_approves`;
`seeded/BuggyQuorum.t.sol` fails `invariant_quorum`; each twin's other seven invariants hold
(`evidence/forge-seeded-twin.txt`). `node --test test-ts/`: 24 of 24, its Anvil chains on 127.0.0.1 within
`QED_ANVIL_PORTS` (`evidence/node-test.txt`); `tsc` 0 errors. The rail on a real local chain:
`chain/test/containment.test.ts` 3 of 3 (a new account carries the workspace's sentinel and seven protective calls; a
freeze refuses the passkey's approval on chain while the other acts; only members can be frozen; the sentinel key can
neither execute nor unfreeze).

Gas, forge EVM (`evidence/forge-gas-report-r13.txt`): `freeze` 31,735 (median, successful); `unfreeze` 22,601;
`protect` 39,920 (one call) to 154,423 (four calls on the release's vault set).

**Slither 0.11.6, this build:** 23 findings (`evidence/slither.json`, `evidence/slither.txt`; exit 255 = findings).

| # | Detector | Impact | Where | Disposition |
|---|---|---|---|---|
| 1 | arbitrary-send-eth | High | `_run` (`src/QEDOwnerAccount.sol:924-929`) | **False positive, by design**, as before; now also reached from `protect`, where every call must be on the protective list fixed at construction and carry value 0 (`NotProtective` otherwise; tested). |
| 2-4 | calls-loop | Low | `_run`, from `execute`, `applyCalls` and `protect` | Intended: a batch is atomic. |
| 5-10 | timestamp | Low | `execute`, `applyCalls`, `applyChange`, `startRecovery`, `finishRecovery`, `protect` | Accepted: deadlines and delays of at least a minute. |
| 11-12 | assembly | Info | `_verifyAssertion`, `_hasOriginField` | Unchanged; reviewed, memory-safe. |
| 13 | pragma | Info | OpenZeppelin `^0.8.20`/`^0.8.24` | Accepted. |
| 14-20 | costly-loop | Info | `_addSigner`, `_removeSigner` | Accepted: bounded by `MAX_SIGNERS`. |
| 21-22 | cyclomatic-complexity | Info | `constructor` (validates the protective list and the sentinel), `applyChange` (the `SetSentinel` branch) | Accepted: flat validation branches, each tested (`test_construction_refuses_a_bad_protective_list_or_sentinel`, `test_a_scheduled_sentinel_is_cancelled_by_one_member_and_refused_when_stale`). |
| 23 | low-level-calls | Info | `_run` | Needed for generic calls; success checked, reason bubbled. |

**Existing accounts do not gain this.** The account is not upgradeable and each workspace keeps the ABI it was
created with. A household whose wallet was set up before this build has no sentinel and no `protect`: the vault service
refuses a freeze (`409 no_sentinel`) and the wallet says so. To gain them it needs a new wallet (a new account and vault
set, its funds moved by its own passkeys); there is no in-place path.

**Not done here, designed (next steps).**
1. *Two devices for payments (R13 item 3).* The account already enforces it: `setThresholds(2, 2)` on a household with
   two or more passkeys makes every payment, mandate and change need two of them, and one device alone can only cancel
   and `protect`. What is missing is in QED, not on the chain: an approval collects one signature per person
   (`approval_signatures` is keyed by person), so a household at threshold 2 could not sign through QED at all. The
   screen must not offer it until QED asks the same person for two different passkeys per digest (one approval, one
   person, two assertions over each digest from distinct vault signers; `railSignBegin` issuing `threshold` prompts per
   digest and `railSignFinish` refusing a repeated credential). With exactly two passkeys a stolen one can still cancel
   a recovery: three passkeys, or the guardian below, avoid that. Per-signer daily limits were rejected: the account
   does not decode calls or mandates, and one device's ERC-1271 mandate would bypass any limit it could enforce.
2. *A guardian for recovery (R13 item 4).* One more P-256 WebAuthn key, Role `Guardian`: a passkey of the person's
   active recovery contact (`server/recovery.ts`), on the same origin. Set, replaced or removed only behind `delay`
   (any Member may cancel). While one is set, `startRecovery` also needs its assertion over the same recovery digest,
   so a stolen code alone starts nothing even when every device is lost; a recovery the guardian co-signed cannot be
   cancelled by a frozen Member, which ends the two-of-two hostage case. It approves nothing else and cancels nothing.
   Limits: a guardian who colludes with a code thief gets a seat when no unfrozen Member cancels in time; an
   unreachable guardian blocks recovery until the Members replace it. QED side: the contact co-signs in their own
   session, and the owner sees who co-signed. Needs the owner's decision on whether co-signing is required or a veto.
3. *Unfreezing through QED* (a passkey allowed again in QED stays frozen on the chain until the household unfreezes it
   directly, or removes and re-adds it), and relaying `protect` from QED's own pause (QED still pauses through
   `execute` at the account's threshold).

## R13: owner options (24 Nov 2026)

Written by the qed-solidity-security agent for R13 (the owner: "implement and verify safe, configurable functionality now;
require my authorization only where genuinely necessary"). **Research code: not audited.** Each option is off by default
or keeps the earlier behaviour, so the owner's decision is a setting. Items 1 and 2 of "Not done here, designed" above (two
devices for payments, a guardian for recovery) are built here; the guardian as the brief worded it (its co-signature is
required, not a veto). This build supersedes the counts above for its own
artifact: `src/QEDOwnerAccount.sol` SHA-256 `3230a781d34c7b07f353ed164411a3784b982f8c9873faa73780079b1b2f6e29`; creation
bytecode 29,252 bytes (SHA-256 of the raw bytes `9f990339995837ad8b800d452670c75b44ba0284b18983ab8ef82fccb49cba1a`); runtime
23,873 bytes, EIP-170 margin 703 (`evidence/r13-owner/forge-build-sizes.txt`). The artifact's own hash is in `READY.json`
(reproducible: `SOLC_VERSION=0.8.38 FORGE_OFFLINE=1 sh scripts/deploy/build-owner-account.sh`). This build's evidence is in
`evidence/r13-owner/` (`scripts/run-evidence.sh` writes all of it); the files directly in `evidence/` are the earlier builds'
and are kept as history.

**What changed.** Two constructor arguments appended (`Guard[] lockable`, `bool timeLocked`), one role, two change kinds:

```solidity
enum Role { None, Member, Recovery, Guardian }            // Guardian: set only by setGuardian
function setGuardian(uint256 x, uint256 y) returns (bytes32 changeId)   // onlySelf; ALWAYS scheduled; (0, 0) removes it
function startCosignedRecovery(bytes32 recoverySignerId, uint256 newX, uint256 newY, uint64 deadline,
                               bytes32 r, bytes32 s, Assertion cosign) returns (bytes32 recoveryId)
// startRecovery reverts GuardianRequired(guardian) while a guardian is set
function setTimeLock(bool on) returns (bytes32 changeId) // onlySelf; on at once; off scheduled behind `delay`
// views: guardian() (signer id, zero when none), timeLocked(), lockableCalls(); getRecovery(id).cosigned
// events: LockableCallConfigured, TimeLockChanged(bool), RecoveryCosigned(recoveryId, guardianId)
// errors: InvalidLockable(index), GuardianRequired(guardianId), NotGuardian(signerId)
```

- **Guardian (design D-m, built as the brief asked).** One more WebAuthn passkey: the person's recovery contact's, on the same
  origin. It is set, replaced or removed only behind `delay`, any Member can cancel, and the change applies only if the
  guardian is still the one it replaces (compare-and-swap; a second scheduled change is then `ChangeStale`). `addSigner`, the
  constructor and `removeSigners` refuse Role.Guardian (`InvalidRole`). While a guardian is set, a recovery starts only through
  `startCosignedRecovery`: the recovery key's raw signature and the guardian's assertion over the same recovery digest (this
  account, chain, recovery key, new key and deadline). A frozen Member cannot cancel a co-signed recovery (`FrozenSigner`); an
  unfrozen Member still can. The guardian approves, cancels and protects nothing (`NotAMember`), and the sentinel cannot
  freeze it.
- **Two devices (D-l).** No contract change: `setThresholds(2, 2)` already makes every payment, mandate and change need two
  Members. QED now collects two different passkeys of one person per approval (`server/rail.ts` railSignBegin/railSignFinish:
  one device per round, the second round offered only the passkeys not used yet) and sends both assertions; the chain counts
  them. Offered under Security as "Require two of your devices", with its trade-off stated.
- **Time-lock (decision D-n, proposed).** A third list fixed at construction (for the release's vault set: `withdraw`,
  `ringFence`, `unpause`, `setGuardian` on both vaults; `webauthn.ts releaseLockable`, `test/helpers/Release.sol
  ReleaseLockable`, compared word for word) that `execute` refuses while `timeLocked`, like a guarded call: they then run
  only through `scheduleCalls` (admin threshold), `delay`, and `applyCalls`. A lockable entry may be neither guarded nor
  protective (`InvalidLockable`): `protect` must never run one. On at once (it only adds protection, as raising a threshold
  is); off behind `delay`. The household chooses it at set-up (`POST /workspaces` `timeLock`).
- **The EIP-170 trim (decision D-a revised, proposed).** The account no longer calls OpenZeppelin's `WebAuthn.verify`
  after `P256.verifyNative`: that call ran the precompile a second time and carried P256's Solidity fallback, which this
  account can never reach (3,138 bytes, measured). `_verifyAssertion` now applies the same checks itself (authenticatorData
  at least 37 bytes, UP and UV set, BS only with BE, `"type":"webauthn.get"` at `typeIndex`, the challenge member at
  `challengeIndex`, the origin member at `originIndex`, the relying-party hash) with bounds-checked indices, and
  `P256.verifyNative` stays the only signature check (range, low s, the key on the curve). `test/WebAuthnDiff.t.sol`
  computes the earlier decision with OpenZeppelin's own unmodified `WebAuthn.verify` and requires identical decisions on
  1,000 fuzzed assertions (flags, the three indices shifted, the type member varied, another challenge, another key, high
  and random s, another relying party and origin, extra JSON members, trailing authenticatorData bytes, short data) and on
  all 256 flag bytes; the 26 verifier tests pass unchanged. Gas: about 7,000 less per assertion (one precompile call).

**Existing accounts gain nothing.** The account is not upgradeable; a workspace keeps the ABI it was created with. A wallet
set up before this build has no guardian and no time-lock: the vault service refuses those proposals
(`409 owner_options_unavailable`), and the Security screen says the wallet keeps its bytecode and gains nothing.

**Threat table, rows added or changed.**

| Attacker holds | Can | Cannot |
|---|---|---|
| **The guardian's passkey** (the recovery contact) | Co-sign a recovery that someone holding a recovery code started (QED asks it in its own session). | Approve, sign ERC-1271, cancel, protect, add or remove anything; start a recovery without a code; co-sign a recovery other than the one its assertion names. |
| **A recovery code, with a guardian set** | Nothing alone: `startRecovery` reverts `GuardianRequired`, and the code is not spent. | Start, finish or hold up a recovery. |
| **A code and the guardian, colluding** | A Member seat after `recoveryDelay`, unless an unfrozen Member cancels in time. | Act before the delay; stop an unfrozen Member's cancel. |
| **A frozen Member passkey** | As before, except: it cannot cancel a recovery the guardian co-signed. | As before. |
| **The sentinel key, misused, with a guardian set** | Freeze every Member, so that a co-signed recovery can be cancelled by nobody: with a recovery code and the guardian's co-signature, someone gets a seat after `recoveryDelay`. Before the guardian, frozen Members kept their veto over every recovery. | Anything else, as before. |
| **A threshold quorum, time-lock on** | Spend under mandates (the vault's daily cap bounds it), pause, revoke. Schedule a withdrawal only with the admin threshold. | Withdraw, ring-fence, resume or replace the vault's guardian at once. |
| **An admin quorum, time-lock off** | Turn it on at once (as it could raise a threshold at once). | Turn it off at once: that waits `delay`, any Member can cancel. |

**Verified (this build).** 207 Forge tests in 16 suites (`evidence/r13-owner/forge-test.txt`): the 181 of the R13 containment
build plus Guardian 11, TimeLock 7 (against the release's own vault set), WebAuthnDiff 3, and five new invariants. Thirteen
invariants, 256 runs x 48 calls, all with fail-on-revert and 0 handler reverts (`forge-invariants-fail-on-revert.txt`); not
vacuous (`invariant-ghosts-summary.txt`): 2,915 guardians installed, 576 recoveries co-signed, 2,216 attempts by the guardian
to execute, sign, cancel or protect (all refused, asserted), 405 cancels of pending recoveries by frozen Members, 6,157
immediate lockable calls while time-locked (all refused, asserted) and 182 while unlocked (all ran). Seeded twins
(`forge-seeded-twin.txt`, each fails its own invariant and holds the other twelve): `BuggyGuardian` (a code alone starts a
recovery while a guardian is set), `BuggyCosignCancel` (a frozen Member cancels a co-signed recovery), `BuggyTimeLock`
(execute ignores the time-lock), and the earlier `BuggyFreeze` and `BuggyQuorum`. On real chains:
`chain/test/owner-options.test.ts` 2 of 2 (time-lock chosen at set-up, withdraw, ring-fence and resume scheduled and
applied, cancelled by one member, escrow funding refused, off waits and on is immediate; the guardian set behind the
delay, a recovery refused without its co-signature and with another passkey's, started with it, a frozen passkey's cancel
refused, removal behind the delay). `node --test test-ts/` 24 of 24 (`evidence/r13-owner/node-test.txt`).

Gas, forge EVM (`evidence/r13-owner/forge-gas-report.txt`): `startCosignedRecovery` 212,320 when it starts a recovery
(`startRecovery` 186,670); `setGuardian` about 25,000 inside its `execute`; `setTimeLock` 25,599; `applyChange` up to
161,541. One assertion now costs about 7,000 gas less (one precompile call instead of two).

**Slither 0.11.6, this build:** 23 findings (`evidence/r13-owner/slither.json`, `slither.txt`; exit 255 = findings), the same
detectors as the R13 containment build at new lines.

| # | Detector | Impact | Where | Disposition |
|---|---|---|---|---|
| 1 | arbitrary-send-eth | High | `_run` (`src/QEDOwnerAccount.sol:1051-1056`) | **False positive, by design**, as before: every target and value is approved by the threshold (execute), scheduled and unchanged (applyCalls), or on the protective list with value 0 (protect). The lockable list only adds refusals. |
| 2-4 | calls-loop | Low | `_run`, from `execute`, `applyCalls`, `protect` | Intended: a batch is atomic. |
| 5-10 | timestamp | Low | `execute` 433, `protect` 486, `applyCalls` 668, `applyChange` 682, `_startRecovery` 812, `finishRecovery` 845 | Accepted: deadlines and delays of at least a minute. |
| 11-12 | assembly | Info | `_verifyAssertion` 996 (the rpIdHash word after a length check of at least 37), `_hasField` 1020 (keccak over a slice whose bounds are checked first) | Reviewed; memory-safe; covered by the verifier tests and the differential test. |
| 13 | pragma | Info | OpenZeppelin `^0.8.20` (Base64) | Accepted. |
| 14-20 | costly-loop | Info | `_insertSigner`, `_removeSigner` | Accepted: bounded by `MAX_SIGNERS`. |
| 21-22 | cyclomatic-complexity | Info | `constructor` (three lists and the time-lock), `applyChange` (now six kinds) | Accepted: flat branches, each tested (`TimeLock.t.sol`, `Guardian.t.sol`). |
| 23 | low-level-calls | Info | `_run` | Needed for generic calls; success checked, reason bubbled. |

**Not verified, and limits.** No independent review; no formal verification. Real authenticators for the two-device rounds
and the guardian's co-signature (Chrome's virtual authenticator and software passkeys only). A guardian who cannot be reached
blocks every recovery until the Members replace it; a misused sentinel plus the guardian plus a recovery code can win a seat
(threat table); the time-lock makes resuming after a pause wait the delay, and funding an earning job from the vault is
refused while it is on. The alternative design for the frozen veto (keep it while every Member is frozen) and both
directions of the time-lock behind the delay are the owner's to choose (`SECURITY.md` section 7).

## R13 review fixes (25 Nov 2026)

An independent review of the owner options found release-blocking faults; these are the fixes, test-first, within the owner's
two rules of 25 November: (1) a frozen device cannot cancel a properly authorised guardian-co-signed recovery, a fraudulent one
stays challengeable, and the guardian alone never takes over; (2) turning the time-lock on is immediate, turning it off or
weakening it waits the delay, with no bypass. Tests: `test/ReviewFixes.t.sol` (13), the adapted `test/Admin.t.sol`, four new
invariants and five new seeded twins, each failing its invariant: the owner's rule has two (`seeded/BuggyAllFrozenFinish.t.sol`:
a finish while every Member is frozen; `BuggyNoRestart.t.sol`: a finish at once after a thaw), then `BuggyRemovalCanceller.t.sol`,
`BuggyStaleSetting.t.sol` and `BuggyRecoveryDeadline.t.sol`. The handler's composite actions make co-signed recoveries finish in
the campaign (and try to finish one right after a thaw), so the owner's rule is exercised both ways (`invariant-ghosts-summary.txt`).
Evidence in `evidence/r13-secfix/`.

- **F1, every Member frozen (HIGH).** The owner's rule: a co-signed recovery finishes only after a whole `recoveryDelay` during
  which some Member was unfrozen and able to cancel it. While no Member is unfrozen, `finishRecovery` refuses it
  (`NoUnfrozenMember`); when a Member becomes unfrozen after none was (unfrozen, or added), every pending co-signed recovery's
  wait restarts in full (`RecoveryRestarted`). The guardian can cancel a recovery it co-signed, and nothing else, until it
  finishes (it withdraws its co-signature; the recovery key is spent). A recovery signature is accepted only if its deadline is at
  most `MAX_RECOVERY_WINDOW` (one day) after the block that starts it (`DeadlineTooFar`). **Consequence, stated plainly:** a
  household whose every passkey is frozen cannot finish any co-signed recovery; unfreezing needs the admin quorum of unfrozen
  Members, so in practice such a household stays where it is (funds unmoved; `protect` still works) until it is given another way.
  **Residual the rule closes:** every device frozen, a colluding guardian and a stolen code no longer give the thief a seat; the
  recovery waits for ever. With one Member unfrozen, collusion still needs that Member not to cancel within the delay.
- **F2, a removal naming every other Member (MEDIUM).** A removal that names an unfrozen Member is scheduled only if more than
  `adminThreshold` Members it does not name have each been a Member for at least `delay` (the constructor's from the start;
  `Signer.since`), else `NoCancellerLeft`. One seat, or one seat and a Member it added in the same batch, can no longer name every
  other Member; naming every other unfrozen Member takes `adminThreshold + 1` such seats, and the household has `delay` after any
  new seat to schedule its removal first (the test shows the household's removal applying first). Removing only frozen Members or
  recovery keys needs no witness (the hostage case still ends). **Cost:** a two-device household removes a device that is not
  frozen only after a third device has been a Member for `delay`, or after QED freezes the device (suspend it first); three
  Members at adminThreshold 2 need a fourth. **Residual:** a removal scheduled by a seat that is later evicted stays pending (its
  targets cannot cancel it) and applies if quorum allows later; a Member it does not name can cancel it.
- **F4, stale changes (LOW).** The time-lock, the sentinel and the guardian each have an epoch; a scheduled change of one of them
  records it (`fromA`) and applies only if that setting has not changed since. Turning the time-lock on, even when it is on, voids
  every pending off-change; dropping the sentinel voids pending sentinel changes; any guardian change voids earlier ones.
- **F5 (LOW).** A recovery started without the guardian does not finish while a guardian is set (`GuardianRequired` at finish);
  a Member can cancel it, and it finishes if the guardian is removed later.
- **Size.** Runtime 24,402 bytes (EIP-170 margin 174 bytes; before 703). Trimmed without weakening any check: the six typehash
  constants and `MAX_GUARDS`, `MAX_PROTECTIVE`, `MIN_DELAY`, `MAX_DELAY` are internal (no off-chain or test reader); the two
  Member scans share one loop; two new errors carry no redundant argument.
- **Slither** (`evidence/r13-secfix/slither.json`): 25 findings, 1 High, 0 Medium, 10 Low, 14 Informational. The 23 of the
  owner-options build are unchanged and keep their dispositions above (their lines moved). New: `timestamp` in `_settled` (Low;
  by design: how long a Member has been one is measured in block time, and a validator's few seconds of drift do not matter
  against a delay of at least one minute); `cyclomatic-complexity` of `cancel` (12) and of `applyChange` (16, down from 18)
  (Informational; accepted: each branch has its own test). A first run also reported `uninitialized-local` (Medium) for the three
  new counters of `removeSigners`; they are now initialised explicitly, as the code before them was, and the finding is gone.
- **The bounty board (F7, LOW)**, `chain/bounties/src/QEDBountyBoard.sol`: each allowed judge is a runtime code hash with its own
  claim function (`judgeClaim`, `setJudge`), and `open` refuses another selector (`WrongSelector`) or a token other than the
  judge's own `token()` (`WrongToken`): before, either could be the opener's choice, every reveal then failed and the pool,
  which nobody can withdraw, stayed. Evidence `chain/bounties/evidence/r13-secfix/`: main and deep 45 of 45; the seeded twin fails
  17 checks (the new binding test among them); Slither adds one Informational `low-level-calls` for `_tokenOf` (a `staticcall`, so
  a judge without `token()` is refused; it cannot change state).

## R13 H1: an independent challenger while every passkey is frozen (25 Nov 2026)

An independent review (H1) found that, with a guardian set and every Member frozen, the owner's rule as implemented above held a
co-signed recovery for ever and nothing could unfreeze a passkey: a permanent hold, reachable through QED by suspending every
member passkey. The owner's rule (25 Nov): keep such a recovery pending "unless the owner has an independent way to challenge it
throughout the full waiting period". That way is now the sentinel, QED's vault-service key:

- `stopRecovery(recoveryId)`: the sentinel, and nobody else, stops a pending recovery the guardian co-signed; it starts, approves
  and finishes nothing and stops nothing else (`NothingPending` for a recovery without the guardian, a change or nothing). The
  recovery key that started it is spent. QED's server asks for it only for a person who may sign for the vault, confirmed afresh
  with a passkey that is neither suspended nor removed (`POST /api/vault/recoveries/:id/stop`).
- `finishRecovery` of a co-signed recovery: as before when some Member is unfrozen; with every Member frozen, only if a sentinel
  has been set and unchanged (the same epoch) since the recovery's current wait began, recorded at its start and at each restart
  (`PendingRecovery.sentinelEpoch`). No sentinel, or a sentinel set, dropped or replaced during the wait: `NoUnfrozenMember`.
- A restart never moves a recovery earlier (review L1): `readyAt` becomes the later of its stored time and now plus the
  recovery delay.
- The owner's other rules hold: a frozen Member still cannot cancel a co-signed recovery; the guardian alone still starts
  nothing; turning the time-lock on is immediate and off waits the delay.
- **Residual, stated plainly:** with every passkey frozen, the owner's challenge rests on QED (its sentinel key and the server's
  check of the person's passkey) for the whole wait. A person who cannot reach QED, or a QED that does not act, leaves a
  recovery co-signed by a colluding guardian with a stolen code to finish after its delay.
- **Size:** 24,332 bytes, EIP-170 margin 244. To make room, without weakening any check, three views no QED code read were
  removed: `eip712Domain` (ERC-5267; the domain is fixed: name `QEDOwnerAccount`, version `1`, the chain id and this address,
  and `domainSeparator()` stays), `protectDigest` (the wallet never calls `protect`; the tests compute its EIP-712 challenge
  themselves) and `isProtective` (`protectiveCalls()` lists the same); `MAX_RECOVERY_WINDOW` (one day) is internal.
- **Tests:** `test/ReviewFixes.t.sol` (15); `invariant_cosigned_recovery_needs_a_whole_unfrozen_window` amended to "or the
  sentinel unchanged throughout", the sentinel's only effects checked by `invariant_protect_and_sentinel_reach_nothing_else`; a
  new seeded twin `seeded/BuggySentinelEpoch.t.sol` (the epoch not checked) fails it, as do `BuggyAllFrozenFinish` and
  `BuggyNoRestart`; evidence in `evidence/r13-h1/`.
- **Slither** (`evidence/r13-h1/slither.json`): 26 findings, 1 High, 0 Medium, 11 Low, 14 Informational: the 25 above, plus
  `timestamp` in `_thaw` (Low; by design: the review's L1 compares two block times so that a restart is never earlier).
