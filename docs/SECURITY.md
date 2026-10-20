# QED — Security Design & Self-Assessment

> Scope: `contracts/src/*` (QEDVault, QEDLens, QEDExecution, ProofEscrow, MinVarianceVerifier,
> PrivateMinVarianceVerifier, QEDClearing, the three bounties, CPMMPool, TestUSD, TestToken) and the off-chain agent
> system in `agent/`. Status: **testnet prototype, not externally audited.** Every claim below links to a
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
5. **A trade's quality is a precondition, not a report.** `QEDExecution` refuses any conversion whose measured
   output is more than τ = 1 ppm below the best output *any* route through the owner's venues could have produced
   from the same state. A compromised agent key can no longer leak value through routing; under a slippage-only
   policy it could leak up to the whole tolerance on every trade (`docs/BENCHMARKS.md` B1).

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

QEDExecution tiers (one module per vault; it is the vault's `agent`):

| Capability | Vault owner | Operator (AI hot key) | Co-signer | Anyone |
|---|:-:|:-:|:-:|:-:|
| `setVenues` (the venue set every proof must range over) | **✓** (invalidates outstanding orders) | ✗ | ✗ | ✗ |
| `setOperator` (rotate the AI key) | **✓** | ✗ | ✗ | ✗ |
| `trade` | ✗ | **✓** only with a mandate, a certificate whose `ref` is the order hash, and a passing proof | ✗ (signs the order's certificate) | ✗ |
| `pay` (forward an ordinary payment) | ✗ | **✓** | ✗ | ✗ |
| `quoteBound`, `venues`, `hashOrder` | ✓ | ✓ | ✓ | **✓** (views) |

CPMMPool has no owner (liquidity by transfer + `sync`, no LP shares); TestToken's only privilege is the deployer's
`mint` on a valueless token.

PrivateMinVarianceVerifier, OptimalityBounty, MaximalityBounty and ExecutionBounty have no owner, no admin and no upgrade path.
The private verifier's only configuration is fixed at deployment (the Groth16 verifier and the data vendor's
attestation key). A bounty's only outflow is `claim`, which pays the caller only when its theorem is refuted;
nobody, including the deployer, can withdraw a bounty pool.

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
| I17 | The escrow pays for private work only if it is ε-optimal for the vendor's attested data | Groth16 proof of the KKT certificate + EIP-191 vendor attestation (§10 ALGORITHMS) | real-proof tests incl. 2,000-run corrupted-proof fuzz; no witness exists for 1/N, a 1 bp nudge or other data (`private.test.ts`); Sepolia Z3, ZA2, ZA3 |
| I18 | A valid proof is useless to anyone but its author | `provider` is a public input bound into the proof | `test_StolenProofIsUselessToAnotherProvider`; Sepolia ZA1 |
| I19 | The chain learns nothing about the model or the portfolio beyond two commitments and the variance | zero knowledge of Groth16; Poseidon commitments with 248-bit salts | by construction; `npm run verify` re-verifies the proof from public signals only |
| I20 | Theorems 4.4 and 9.2 are falsifiable on-chain by anyone, for money | `OptimalityBounty`, `MaximalityBounty` | positive controls pay against unsound rules; differential test vs `QEDClearing` on 60 economies; 2×2,000-run fuzz; Sepolia BA1–BA3, BM1–BM2; pools checked daily by `npm run verify` |
| I21 | Every executed conversion delivered at least (1 − τ) of the best output any route through the owner's venues could have produced, from the state it executed on | weak-duality bound B̂(ν) computed on-chain with upward rounding; output measured as a balance change (§12 ALGORITHMS) | 2×2,000-run soundness fuzz (random and near-optimal routes never beat the bound); bit-exact parity with the TS solver; TS weak-duality test (12,000 route/price pairs); Sepolia E1, E2, EA1–EA3; `npm run verify` recomputes the bound from pre-trade reserves |
| I22 | A conversion's output reaches only an owner-approved recipient, and the module holds nothing between transactions | recipient ∈ mandate payees; leftovers revert; unspent input returns to the vault | `test_recipientMustBeInTheOwnerMandate`, `test_leftoverIntermediate_isRejected`; Sepolia EA4; `npm run verify` checks the module's balances are zero and every tEUR it sent went to the reserve |
| I23 | The order (recipient, floor, tolerance, venue set) cannot be changed after the co-signer approved it | certificate `ref` = order hash; venue-set hash in the order | `test_tamperedOrder_isRejected`, `test_venueChangeInvalidatesOutstandingOrders`; Sepolia EA6 |
| I24 | Routing through the module weakens none of the vault's guarantees | funds arrive only via `executePayment` in the same transaction; QEDVault bytecode unchanged | `test_vaultLimitsReplayAndPauseStillApply`, `test_perPaymentCapStillApplies`, `test_payPassesThrough_butNotWithATradeCertificate`; Run 4 vault bytecode verified identical |
| I25 | Theorem 12.3 is falsifiable on-chain by anyone, for money | `ExecutionBounty` runs the claimant's route on its own funds and compares with the deployed bound | positive control pays against a bound understated by 0.1%; donated holdings cannot be used; 2,000-run fuzz never pays; Sepolia XA1–XA3 |
| I26 | Under a standing policy the agent cannot convert more, or at a worse execution cost, than the owner's policy allows at that block | the co-signer re-derives the tranche from the chain (P1–P3) before it certifies; the mandate's caps and best execution still apply on-chain | `treasury.test.ts` (limits never exceeded, determinism); Sepolia PA1 (25 requested, 19.535234 allowed: refused), PE1–PE2, T3; `npm run verify` checks the target was met at PE2's block |

Test totals: **132 Solidity tests** (unit, fuzz, stateful invariants — ≈350 000 adversarial calls per CI run,
60 random clearing economies, a real Groth16 proof attacked 2,000 ways, three bounties, best execution with
two 2,000-run soundness fuzzers), **60 TypeScript tests** (TS ≡ Solidity parity on a live node, portfolio solver vs.
a 20 000-sample oracle, netting solver vs. an exhaustive oracle, zero-knowledge prover soundness checks, routing
weak duality on 12,000 route–price pairs and strong duality on 300 markets, the treasury policy's tranche rule,
32-case red-team).

### Proven properties vs. trust assumptions

| Proven (by code the chain runs, or by mathematics the tests exercise) | Assumed (a party or a fact we rely on) |
|---|---|
| I1–I26 above, within their stated conditions | the owner key is not compromised (K1); Ethereum consensus and the EVM behave as specified |
| Theorems 4.4, 9.2 (with proofs in ALGORITHMS) and 12.3 (proof uses path deficiency from the literature, tested) | the Groth16 setup was not subverted (K18); BN254 pairing and keccak256 are secure |
| Accepted conversions are within τ of the optimum on the state they executed on | the owner's venues are honest constant-product pools with the declared fee (K22) |
| The bound is never understated by integer rounding | the co-signer's quote reflects a fair market when it signs (K23) |
| | the data vendor's attestation means what it says (§10); token contracts are standard ERC-20 (K9) |

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
| Proof thief / data forger | copies a valid zk proof from calldata; proves on self-attested data; overstates quality | proof bound to its author; vendor attestation required (ZA1–ZA3) |
| Theorem challenger | any input at all, with a 1,000 tUSD incentive per theorem | every refutation attempt reverts with the gap it could not close (BA1–BA3, BM1–BM2) |
| Compromised trading agent | holds the operator key; routes any way; picks any prices | cannot leak more than τ = 1 ppm per trade through routing (EA1–EA3); cannot redirect output (EA6); cannot strand value (EA4) |
| Front-runner / sandwich attacker | moves venue prices before a signed trade | refused by the co-signed floor when the move exceeds 1% (EA8); smaller moves are a residual risk (K23) |
| Liquidity provider colluding with the agent | owns liquidity in one venue and wants volume routed through it | routing to it beyond the optimum fails the proof (EA1, EA5) |
| Over-eager or compromised agent under a standing policy | requests larger or costlier tranches than the policy allows, or trades when no shortfall exists | the co-signer recomputes the decision and refuses (PA1); the mandate caps what any certificate can move |
| Execution-theorem challenger | any route and prices, with 1,000 tUSD on offer | every claim reverts with `TheoremHolds(output, bound)` (XA1–XA3) |
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
| K6 | **Data confidentiality** in the public verifier: delivering a §4 certificate reveals the covariance in calldata. | Low (resolved for private jobs) | `PrivateMinVarianceVerifier` (§10) proves the same certificate in zero knowledge; clients choose per job. |
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
| K18 | **Trusted setup**: the Groth16 parameters came from a local two-phase ceremony whose contributions all ran on one machine; whoever held all contributions' randomness could forge proofs. | Medium (testnet) | Public-transaction beacons; transcript and `.ptau`/`.zkey` committed for `snarkjs zkey verify`. Production: phase 1 from a public ceremony, phase 2 with independent parties (`PTAU=… bash circuits/setup.sh`). |
| K19 | **Circuit completeness**: an under-constrained circuit would accept bad witnesses. | Medium | Every arithmetic constraint is mirrored in `checkWitness`; explicit range checks keep all values ≪ p; tests show no witness exists for 1/N, a 1 bp nudge or other data. Roadmap: formal circuit audit (e.g. Picus / Circomspect). |
| K20 | **Provider binding is per spec**: a client that accepts a quote whose spec names a different provider could pay for a proof it cannot use. | Low | Clients check `spec.provider == quote.provider` (enforced by QED's client agent); the escrow already pins delivery to the quoted provider. |
| K21 | Bounty pools are finite and in a test token; they demonstrate falsifiability, not insurance. | Info | Pools and claims are public; `npm run verify` checks daily that no `Refuted` event exists. |
| K22 | **Venue trust**: the bound assumes each owner-named venue is an honest constant-product pool with the declared fee. A malicious pool could report reserves that do not reflect its swap behaviour. | Medium | Only the vault owner names venues; the module cross-checks the fee where the pool reports it; changing the set voids outstanding orders. Production: pin venues by code hash. |
| K23 | **Manipulation below the floor**: an attacker who moves every venue by less than the co-signer's 1% allowance before a trade is caught by neither check; the proof is relative to the moved state. | Medium | Private order flow, tighter floors for larger trades, a TWAP reference in the co-signer's T2 screen. Disclosed in ALGORITHMS §12.7. |
| K24 | **Granularity**: integer rounding costs up to one raw unit of output per hop, so τ = 1 ppm is too tight for outputs of a few raw units. | Low | The co-signer sets τ per order; B2 measures the floor (max 7.4 ppm on tiny outputs). |
| K25 | **Gas is not in the objective**: an output-optimal route can use more hops than a cheaper near-optimal one. | Low | Gas is paid by the operator's ETH, not the vault; at Sepolia prices a four-hop trade costs ~0.00001 ETH. |
| K26 | **Concentrated-liquidity and stable-swap venues** are not supported by the bound. | Info | Their per-venue value h_i has a (piecewise) closed form; not implemented. |
| K27 | **LLM provider credentials**: the language layer calls an external API with a key the operator supplies. | Low | Held only by the brain process, never logged or committed; the offline parser is the fallback; no money field depends on it. |
| K28 | **The standing policy is enforced off-chain**: whether a tranche is due is judged by the co-signer, which re-derives it from the chain; the contracts enforce the mandate's caps and best execution, not the policy's target or impact limit. A compromised co-signer *and* operator could convert up to the mandate's caps at best execution when no shortfall exists. | Medium | Bounded by the mandate (per-payment and window caps, payees) and by best execution; every certificate anchors the decision record's hash; revocation by `bumpEpoch` or `setOperator`. Production: encode target and tranche limits in an on-chain policy module. |
| K29 | **Per-tranche, not cumulative, impact**: κ is measured against the mid price at each tick, so successive tranches can move the price further in total. | Low | Tranche size, daily cap and the 300 bps T2 screen bound it; Run 4c's second tranche paid 90 bps against the moved mid. Production: cumulative impact budget, TWAP reference, minimum interval between tranches. |

## 5a. Key lifecycle, oracles, MEV, availability and administration

**Key lifecycle.** Each role's key is generated per run (`viem` `generatePrivateKey`), stored only in a `.keys.env*` file
excluded from git with mode 0600, and loaded into one process. The language model never sees any key. Rotation is
on-chain and immediate: `setAgent`, `setCosigner`, `setGuardian` (vault), `setOperator` (execution module); a key
compromise is contained by `pause` (guardian, one transaction) and `bumpEpoch` (owner: every mandate and certificate
becomes void). Production would hold the owner key in an ERC-1271 multisig or MPC wallet and the agent and co-signer
keys in HSM or cloud KMS signers; none of that is implemented here.

**Oracles and data integrity.** QED uses no price oracle. Conversions are proven against the venues' own reserves,
read in the same transaction, so there is no stale price to exploit inside the trade. Portfolio data is either public
in the spec (§4) or attested by the vendor's signature over a commitment (§10). The co-signer reads chain state
itself and never trusts the agent's figures.

**MEV and front-running.** A signed trade can be front-run (EA8 on Sepolia). The proof cannot prevent this, because it is
about the state the trade executes on; the co-signed floor bounds it. Escrow deliveries, clearing nettings and bounty
claims are not front-runnable for profit: they pay only their sender (provider binding, or the claimant), or move
no value.

**Availability.** Every failure mode fails closed: no co-signer means no payments (K8), a moved market means no
trade (A10), and a stale clearing snapshot means no netting (K15). Creditors are never blocked: `settle` works while
paused. No contract has an unbounded loop over user-controlled data (payees ≤ 32, venues ≤ 16, hops ≤ 32, open
obligations ≤ 128).

**Administration.** No contract is upgradeable. The only administrators are each vault's owner (configuration, never
ring-fenced funds) and the deployer's `mint` on test tokens. The clearing house, verifiers, escrow, pools and
bounties have no admin at all.

### Mitigation classes

| Class | What it covers here |
|---|---|
| **Eliminated by code** | spending outside the mandate, breaking a ring-fence, replay, tampering with signed terms, a lazy proof being paid, a non-maximal netting, a sub-optimal conversion, value stranded in the module |
| **Eliminated by cryptography** | forged signatures, forged zero-knowledge proofs (given a sound setup), stolen proofs (provider binding) |
| **Bounded by mechanism** | loss under total hot-key compromise (`blastRadius`), front-running (co-signed floor), integer rounding (τ) |
| **Shifted to incentives** | anyone finding a flaw in Theorems 4.4, 9.2 or 12.3 can take the corresponding bounty |
| **Delegated to trusted parties** | the owner key; the co-signer's honesty for its quote and screens; the data vendor; the trusted setup; the venue set |
| **Cannot be eliminated here** | owner-key compromise; market manipulation below the floor; consensus failure; a regulator's view of an autonomous agent |

### Production-readiness limitations

Testnet only, valueless tokens, no external audit, no formal verification of the contracts or the circuit, a single-
machine trusted setup, a co-signer that is one process rather than a quorum, demo-size liquidity, and venues that are
our own constant-product pools rather than production DEXs. Each is listed above with its roadmap.

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
* **Best execution as a precondition** (cf. MiFID II art. 27, FINRA rule 5310): every conversion carries a proof that it
  was within 1 ppm of the best available route, checked on-chain at the moment of execution.
