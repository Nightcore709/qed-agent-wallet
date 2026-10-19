# QED — Security Design & Self-Assessment

> Scope: `contracts/src/*` (QEDVault, QEDLens, ProofEscrow, MinVarianceVerifier, QEDClearing, TestUSD) and the off-chain
> agent system in `agent/`. Status: **testnet prototype, not externally audited.** Every claim below links to a
> test, an invariant, or a public Sepolia transaction.

## 1. Security thesis

**Treat the AI as compromised by default.** Prompt injection, tool poisoning, model error and key theft are
not edge cases for autonomous agents — they are the operating environment. QED therefore makes the safety of
money independent of the AI's behaviour:

1. **The AI holds one key that can call one function** (`executePayment`), and that function succeeds only with
   an owner-signed mandate *and* an independent co-signer certificate *and* inside the solvency invariant.
2. **The worst case is computed, not hoped for.** `QEDLens.blastRadius` returns, at any block, the maximum
   loss if the agent key and the co-signer key are both stolen. Loss to addresses the owner never approved is 0.
3. **Proof replaces trust in payment for work.** The escrow pays only for answers that pass an on-chain KKT
   optimality check.
4. **We publish the keys.** The honeypot vault's agent and co-signer private keys are in the repo
   (`evidence/ethereum-sepolia/honeypot.json`). Its 90 tUSD ring-fence is protected by the contract, not by secrecy.

## 2. Permission tiers (implemented in `QEDVault.sol`)

| Capability | Owner (cold) | Agent (AI hot key) | Co-signer (independent service) | Guardian | Creditor | Anyone |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Sign mandates (scope of agent authority) | **✓** (off-chain EIP-712, EOA or ERC-1271 multisig) | ✗ | ✗ | ✗ | ✗ | ✗ |
| `executePayment` (spot / forward) | ✗ | **✓** only with owner mandate + co-signer certificate | ✗ (signs certificates only) | ✗ | ✗ | ✗ |
| Sign payment certificates | ✗ | ✗ | **✓** after 12 policy checks | ✗ | ✗ | ✗ |
| `ringFence` (create protected liability) | **✓** from free funds only | ✗ (only via mandate-scoped forward payments) | ✗ | ✗ | ✗ | ✗ |
| `withdraw` | **✓** free funds only — never ring-fenced | ✗ | ✗ | ✗ | ✗ | ✗ |
| `settle` a due liability | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** (always pays the creditor; works while paused) |
| `release` / `assign` a liability | ✗ | ✗ | ✗ | ✗ | **✓** own claims only | ✗ |
| `pause` | ✓ | ✗ | ✗ | **✓** | ✗ | ✗ |
| `unpause` | **✓** | ✗ | ✗ | ✗ (can only make things safer) | ✗ | ✗ |
| `bumpEpoch` / `revokeMandate` (mass / single revocation) | **✓** | ✗ | ✗ | ✗ | ✗ | ✗ |
| `setAgent` / `setCosigner` / `setGuardian` / `setDailyCap` | **✓** | ✗ | ✗ | ✗ | ✗ | ✗ |
| `transferOwnership` (two-step) | **✓** | ✗ | ✗ | ✗ | ✗ | accept by pending owner |

ProofEscrow tiers: provider signs quotes and is the only party that may `deliver`; client opens by presenting a
provider-signed quote; anyone may `refund` after the deadline (funds go to the client only); the provider may
release the client early. MinVarianceVerifier and QEDLens are stateless and privilege-free.

QEDClearing tiers (no owner, no admin, no upgrade path):

| Capability | Member | Anyone | Notes |
|---|:-:|:-:|---|
| `join` | ✓ (self only) | ✓ | emits the hash of the netting terms: explicit, on-chain consent |
| `issue` an obligation | ✓ as **debtor** only | ✗ | nobody can create a debt for someone else |
| `pay` an obligation | ✓ as **debtor** only | ✗ | tokens move debtor → creditor, nowhere else |
| `net` (submit a netting) | ✓ | ✓ | permissionless, because the contract enforces: unchanged net positions, no new claims, full snapshot, maximality proof |

Off-chain tiers: each role runs as a separate OS process that receives exactly one private key in its environment
(`agent/scripts/live.ts → spawnRole`). The language model never receives any key, address book mutation rights or
tool that can sign.

## 3. Security properties and how each is verified

| # | Property | Mechanism | Verified by |
|---|---|---|---|
| I1 | Vault balance ≥ ring-fenced liabilities, always | `a ≤ free` checks on every outflow (§1 ALGORITHMS) | invariant fuzzing (512×96, both hot keys stolen); `npm run verify` live |
| I2 | `totalProtected` = Σ open liabilities | single code path for create / settle / release | invariant `ProtectedEqualsSumOfOpenLiabilities` |
| I3 | Ring-fenced value reaches only its creditor | `settle` pays `liabilities[id].creditor`; only creditor may release/assign | invariant `CreditorsPaidExactly`; Sepolia P3 |
| I4 | Zero loss to addresses the owner did not approve | payee ∈ owner-signed mandate | invariant `ZeroLossToUnapprovedAddresses`; Sepolia X6, H4 |
| I5 | Signed terms are immutable | EIP-712 over every field; authenticity checked first | unit tests `Revert_Tampered*`; Sepolia X2, X3, X8, X9 |
| I6 | No replay | single-use `intentId` / `quoteId` | Sepolia X10; `test_Revert_Replay` |
| I7 | Agent key has no admin power | `onlyOwner` / creditor / guardian gates | invariant `AgentKeyHasNoAdminPower`; Sepolia X13–X15, H6 |
| I8 | Bounded loss under total hot-key compromise | global window cap + free-balance bound | fuzz `BlastRadiusIsAnUpperBound`; Sepolia X11, X12, H5 |
| I9 | Pause stops the AI, never the creditors | `executePayment` checks `paused`; `settle` doesn't | `test_GuardianPausesButCannotUnpause_CreditorsStillPaid`; Sepolia P1–P3 |
| I10 | Escrow pays only for ε-optimal work | KKT certificate check (Theorem §4.4) | 3×2000-run fuzz incl. "accepted ⇒ ε-optimal"; Sepolia X17, X18 |
| I11 | Clients can't underpay / redirect, providers can't swap the problem | quote binds price, payee, verifier, spec hash, deadline | `test_Revert_ClientTampers*`; Sepolia X2, X3 |
| I12 | Purchased data is the data the job committed to | `job.specHash == invoice.dataCommitment`, re-hashed by the agent | co-signer C8; agent `fulfil()` |
| I13 | A netting never changes any member's net position | per-member conservation check | `test_Revert_ShiftingValueBetweenMembers`; 2,000-run cycle fuzz; Sepolia N2; `npm run verify` |
| I14 | A netting never erases more than is owed and never creates a claim | 0 ≤ x ≤ d; amounts only decrease | `test_Revert_CancellingMoreThanOwed`; Sepolia N3 |
| I15 | Only a provably maximal netting executes | LP-duality certificate, Σx = Σd·y, exact integers | 60 random economies; TS solver = exhaustive oracle on 150 economies; Sepolia N1, N5 |
| I16 | A proof covers the whole, current state | every open id, current amounts | `test_Revert_HidingAnObligation`, `StaleAmounts_AndReplay`; Sepolia N4, N7 |

Test totals: **82 Solidity tests** (unit, fuzz, stateful invariants — ≈350 000 adversarial calls per CI run,
plus 60 random clearing economies), **45 TypeScript tests** (TS ≡ Solidity parity on a live node, portfolio solver vs.
a 20 000-sample oracle, netting solver vs. an exhaustive oracle, 32-case red-team).

## 4. Threat model

**Assets**: ring-fenced liabilities; free treasury; escrowed client funds; integrity of signed terms; the
owner's authority; confidentiality of keys.

**Adversaries considered**

| Adversary | Capabilities assumed | Outcome (evidence) |
|---|---|---|
| External prompt injector | arbitrary text in RFQs, invoices, chat | guard + typed-only economics; no payment path (X1, red-team 25/25) |
| Manipulated LLM | outputs anything, including "pay Mallory" | co-signer refuses (X4); contract rejects (X5–X7) |
| Agent-key thief | signs and sends any tx as the agent | can only pay owner-approved payees within caps & solvency (X5–X15) |
| Agent **+ co-signer** key thief | forges valid certificates | still bounded by owner mandate, caps, solvency (X6, X11, X12) |
| Public-key attacker (honeypot) | both hot keys are public | ≤ 1 tUSD/day to CloudCo; ring-fence intact (H3–H6, live) |
| Malicious client | edits signed quotes | rejected (X2, X3) |
| Lazy / dishonest AI provider | submits unoptimised or near-miss work | rejected by mathematics; client refunded (X17–X19) |
| Stranger | calls permissionless functions | can only settle due liabilities to their creditors (P3) |
| Owner-key thief | full owner powers | **out of scope** — see K1 |

**STRIDE summary.** Spoofing → EIP-712 signatures from fixed role addresses; Tampering → all terms signed,
calldata re-hashed; Repudiation → every payment anchors a hash of its decision record; Information disclosure →
LLM never sees keys, guard blocks secret requests (DE-1…6); Denial of service → no unbounded loops on-chain,
payees ≤ 32; Elevation of privilege → single-function agent key, owner-only admin.

## 5. Known-risk list (honest)

| ID | Risk | Severity | Status / mitigation |
|---|---|---|---|
| K1 | **Owner-key compromise = full control** of mandates, caps, withdrawals of *free* funds. Ring-fenced liabilities remain protected even then. | High | Owner can be an ERC-1271 multisig (tested: `test_SmartAccountOwner_ERC1271`). Roadmap: timelocked admin. |
| K2 | **Both hot keys stolen**: attacker can move up to the blast radius to owner-approved payees (waste, not theft — unless an approved payee colludes). | Medium | Bounded and displayed on-chain (`blastRadius`); guardian pause; tight per-mandate caps. |
| K3 | Fixed 24h windows allow up to 2× cap around a window boundary. | Low | The published bound accounts for it (inclusive counting). Roadmap: rolling window. |
| K4 | **Verifier trust**: both sides must agree on the verifier contract in the quote; a malicious verifier could accept anything. | Medium | Verifier address is signed in the quote; clients pin canonical verifiers by bytecode (`npm run verify` checks bytecode). Roadmap: verifier registry. |
| K5 | **ε-optimal, not exact**: accepted solutions are within `(2n+3+|ν|)τ` of the optimum; τ is client-chosen (≤ 1 %). | Low | Theorem §4.4; `MAX_TOL` cap; clients choose τ = 1e-9 in practice. |
| K6 | **Data confidentiality**: delivering the certificate reveals the licensed covariance in calldata. | Medium (commercial) | Roadmap: verify the KKT check inside a zk-SNARK so Σ stays private. |
| K7 | **Guard is heuristic**: regex detectors can have false negatives/positives, the LLM is non-deterministic. | Medium | Guard is defence-in-depth only; the co-signer and contract are the binding controls. Red-team: 25/25 blocked, 0 false refusals. |
| K8 | **Co-signer liveness**: if the co-signer is down, the agent cannot pay (fails safe). | Low | Fail-closed by design; owner can rotate co-signer. |
| K9 | Token assumptions: standard ERC-20 (no fee-on-transfer / rebasing). | Low | Single, known asset per vault. |
| K10 | Timestamp influence (validators ±seconds) on windows / deadlines. | Low | Windows are hours/days; certificates valid for 2 h. |
| K11 | **Gas-schedule drift**: Sepolia's state-creation repricing (≈6.7× deployment cost) and EIP-7825's 2²⁴ per-tx gas cap bound deployable code size. | Info | Vault slimmed to 9.1 KB (views moved to QEDLens); deploys at 14.96 M gas. |
| K12 | **Execution topology**: our build sandbox had no RPC egress. Transactions were signed in the sandbox against a wall-clock-synchronised local replica of Sepolia, then the identical signed bytes were broadcast via a browser relay; every public receipt was compared with the replica's (status + logs). Two earlier attempts failed (gas schedule; one under-provisioned agent transaction) and were superseded by a run under fresh keys. | Info | Disclosed in `docs/EVIDENCE.md`; `npm run verify` re-derives every claim from the public chain; the canonical run is self-contained. |
| K13 | Unaudited prototype on a testnet with a valueless token. | — | Do not use with real funds. |
| K14 | Honeypot keys are public: anyone can spend ≤ 1 tUSD/day of honeypot free balance to CloudCo. | Expected | That is the demonstration of a bounded blast radius. |
| K15 | **Clearing griefing**: a member can issue many tiny obligations (≤ 128 open) or front-run a netting with a new obligation, making a submitted proof stale. | Low | Fails safe (`IncompleteSnapshot` / `StaleAmount`); the prover recomputes in milliseconds. Roadmap: per-member caps, a proposal window. |
| K16 | **Netting changes counterparties' credit mix** only by shrinking it: claims are reduced, never re-assigned, but a member loses a specific receivable it might have preferred to keep. | Low | Disclosed in the on-chain terms every member signs by joining. |
| K17 | Clearing obligations are acknowledgements, not escrowed funds: a debtor can still default on what remains after netting. | Medium | Netting minimises what must be paid; pairing it with QEDVault ring-fencing is the roadmap. |

## 6. Incident response

1. **Guardian** pauses the vault (one transaction). Creditors keep being paid.
2. **Owner** bumps the epoch → every outstanding mandate and certificate is void.
3. **Owner** rotates the compromised key (`setAgent` / `setCosigner`), re-issues mandates, unpauses.
4. Forensics: every payment event carries `evidenceHash`; the decision record reproduces the exact inputs.

## 7. Compliance-relevant controls

* **Four-eyes / maker–checker** for every discretionary payment (agent proposes, co-signer certifies).
* **Segregation of duties**: owner, agent, co-signer, guardian are distinct keys and processes.
* **Ring-fencing** of obligations (bankruptcy-remote within the vault).
* **Sanctions / deny-list screening** at the co-signer (C11).
* **Audit trail**: canonical decision records, hash-anchored on-chain; LLM transcripts hashed per turn.
* **Explainability**: every decision has a human-readable rationale; the agent answers "why" from its decision log.
* **Kill switch** with creditor continuity.
