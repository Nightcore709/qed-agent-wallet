# QED — Core Algorithms

This document specifies every algorithm QED relies on, with the exact conditions the smart contracts check
and proofs of the properties we claim. Notation: all token amounts are integers in `tUSD` base units
(6 decimals). Real numbers in the optimiser are fixed-point **WAD** integers (1.0 = 10¹⁸).

---

## 1. The solvency invariant (ring-fenced liabilities)

**State.** `B` = vault token balance, `P` = `totalProtected` = Σ of open liabilities, `F = B − P` = free balance.

**Invariant I1.** `B ≥ P` at every reachable state.

**Proof (induction over state transitions).** Initially `B = P = 0`. Every function that changes `B` or `P`:

| Transition | ΔB | ΔP | Pre-condition checked on-chain | I1 preserved because |
|---|---|---|---|---|
| `deposit(a)` / direct transfer in | +a | 0 | — | B grows |
| `executePayment` (spot) | −a | 0 | `a ≤ F` | B − a ≥ P |
| `executePayment` (forward, `dueAt>0`) | 0 | +a | `a ≤ F` | P + a ≤ B |
| `ringFence(a)` (owner) | 0 | +a | `a ≤ F` | P + a ≤ B |
| `withdraw(a)` (owner) | −a | 0 | `a ≤ F` | B − a ≥ P |
| `settle(id)` (anyone, after due) | −aᵢ | −aᵢ | liability open | both sides drop equally |
| `release(id)` (creditor only) | 0 | −aᵢ | `msg.sender == creditor` | P shrinks |

No other function moves tokens. ∎

**Corollary (creditor exclusivity).** Ring-fenced value leaves the vault only via `settle(id)`, which transfers
exactly `aᵢ` to `liabilities[id].creditor`. Nobody — agent, co-signer, guardian or owner — can redirect it.
Only the creditor can `release` (forgive) or `assign` (sell) its own claim.

Both facts are checked by stateful fuzzing (`contracts/test/Invariants.t.sol`: 7 invariants × 512 runs × 96 calls
with an attacker holding the agent **and** co-signer keys) and re-checked live on Sepolia by `npm run verify`.

---

## 2. Authorisation: owner mandate × independent certificate

A payment executes only if **all** of the following hold (in this order; the first failure reverts with a
self-describing custom error):

```
executePayment(m, ownerSig, c, cosignerSig):
  require !paused                                   VaultPaused
  require msg.sender == agent                       NotAgent
  ─ mandate ─
  require m.vault == this, m.agent == agent         WrongVault / MandateAgentMismatch
  require m.period > 0, 0 < |m.payees| ≤ 32         InvalidMandate
  require m.validFrom ≤ now ≤ m.validUntil          MandateNotActive
  require m.epoch == epoch, !revoked[H(m)]          StaleEpoch / MandateIsRevoked
  require SigCheck(owner, EIP712(H(m)), ownerSig)    BadOwnerSignature      (EOA or ERC-1271)
  ─ certificate ─
  require c.mandateHash == H(m)                     CertificateMandateMismatch
  require SigCheck(cosigner, EIP712(H(c)), sig)      BadCosignerSignature   (authenticity FIRST)
  require c.epoch == epoch, c.notBefore ≤ now ≤ c.expiresAt
  require !intentUsed[c.intentId]                   IntentAlreadyUsed      (replay)
  require c.recipient ∈ m.payees                    PayeeNotInMandate
  require c.amount ≤ m.maxPerPayment               ExceedsPerPaymentCap
  ─ economics ─
  require c.amount ≤ F                              SolvencyViolation(requested, free)
  require mandate period / lifetime / global 24h window caps
  effects: intentUsed[c.intentId] = true; counters += amount
  if c.dueAt == 0: transfer(c.recipient, c.amount)
  else:            create liability(c.recipient, c.amount, c.dueAt)   // ring-fenced promise
  emit PaymentExecuted(intentId, H(m), recipient, amount, liabilityId, evidenceHash, ref)
```

**Why the certificate binds everything.** `H(c)` covers `recipient, amount, dueAt, intentId, evidenceHash, ref,
notBefore, expiresAt, epoch` and `H(m)`. Changing any byte changes the EIP-712 digest, so the recovered signer is
no longer the co-signer. `intentId` is single-use. `epoch` lets the owner revoke every outstanding mandate and
certificate with one transaction (`bumpEpoch`).

**Key separation.** Owner (cold) ≠ agent (hot) ≠ co-signer (independent service) ≠ guardian. Each runs in a
separate OS process holding exactly one key (`agent/scripts/live.ts → spawnRole`).

---

## 3. Provable blast radius (worst-case loss under total hot-key compromise)

**Threat.** The attacker holds the agent key **and** the co-signer key (owner key safe).

**Bound.** Within horizon `h` the attacker can extract at most

```
BR(h) = 0                                    if paused
      = min( F ,  cap_now + k·D )            otherwise
cap_now = D − spentInWindow   if the current window is open, else D
k       = ⌊(t + h − windowEnd)/W⌋ + 1        if t + h ≥ windowEnd, else 0
```

with `D` = global daily cap, `W` = 1 day, and `windowEnd` the end of the current (or next-opened) fixed window.

**Proof sketch.** Every agent outflow (spot or forward) passes `_consumeLimits`, which bounds spending in each
fixed window by `D`; a new window opens no earlier than the previous one closes, so at most `k` further windows can
start inside the horizon (counting a window that opens exactly at `t + h`, a deliberately conservative choice).
Every outflow also requires `a ≤ F`. Ring-fenced funds (`P`) are unreachable by §1. ∎

**And the part a cap alone can't give you:** the attacker cannot invent payees — `c.recipient ∈ m.payees` and `m`
must carry the **owner's** signature. So loss to any address the owner did not approve is exactly **0**.
`QEDLens.blastRadius(vault, h)` computes `BR(h)` on-chain from public state.

---

## 4. Certified optimality: paying AI for proofs, not for answers

### 4.1 Problem

The client agent buys the long-only minimum-variance portfolio for a committed covariance Σ:

```
minimise  f(w) = ½ wᵀΣw     subject to   1ᵀw = 1,  w ≥ 0.
```

### 4.2 What the provider submits

`(w, ν, μ, L)` — the portfolio, the Lagrange multipliers of the budget constraint (`ν`) and of the long-only
constraints (`μ`), and a lower-triangular factor `L` witnessing that Σ is positive semidefinite.

### 4.3 What the contract checks (`MinVarianceVerifier.verify`, exact integer arithmetic, tolerance τ)

| # | Condition | Meaning |
|---|---|---|
| P1 | `wᵢ ≥ 0`, `|1ᵀw − 1| ≤ τ` | primal feasibility |
| D1 | `μᵢ ≥ 0` | dual feasibility |
| S  | `|(Σw)ᵢ − ν − μᵢ| ≤ τ` for all i | stationarity of the Lagrangian |
| CS | `Σᵢ wᵢμᵢ ≤ τ` | complementary slackness = the **duality gap** |
| C  | `|Σᵢⱼ − (LLᵀ)ᵢⱼ| ≤ τ` for all i ≥ j | convexity witness |

All products are formed at 10³⁶ scale and compared without any rounding. Inputs are range-bounded
(|x| ≤ 10²⁷) so no product can overflow. Cost for n = 6: ≈ 0.3 M gas.

### 4.4 Theorem (ε-optimality certificate)

*If checks P1, D1, S, CS and C pass with tolerance τ, then for every feasible portfolio x*

```
f(w) ≤ f(x) + τ·(|ν| + 3 + 2n) + O(τ²).
```

*In particular `f(w) ≤ f* + (2n + 3 + |ν|)·τ + O(τ²)`: the escrow pays only for answers provably within a tiny,
known distance of the global optimum.*

**Proof.** Write `Σ = LLᵀ + E` with `|Eᵢⱼ| ≤ τ` (check C), so `‖E‖₂ ≤ ‖E‖_F ≤ nτ`. For feasible `x`
(`x ≥ 0, 1ᵀx = 1`) let `d = x − w`. Exactly,

```
f(x) = f(w) + (Σw)ᵀd + ½ dᵀΣd.
```

*Curvature term.* `dᵀΣd = ‖Lᵀd‖² + dᵀEd ≥ −nτ‖d‖₂²`.

*Linear term.* By S, `Σw = ν1 + μ + r` with `‖r‖∞ ≤ τ`. Hence

```
(Σw)ᵀd = ν(1ᵀx − 1ᵀw) + μᵀx − μᵀw + rᵀd
       ≥ −|ν|τ        + 0    − τ    − τ‖d‖₁        (P1, D1 with x ≥ 0, CS, Hölder)
```

*Sizes.* `‖d‖₁ ≤ ‖x‖₁ + ‖w‖₁ ≤ 2 + τ` and `‖d‖₂² ≤ ‖d‖₁² ≤ (2 + τ)²`.

Combining: `f(x) ≥ f(w) − τ(|ν| + 1 + 2 + τ) − ½nτ(2 + τ)²`, i.e.
`f(w) − f(x) ≤ τ(|ν| + 3 + 2n) + O(τ²)`. ∎

**Corollary (the revert message is a certificate of failure).** With exact stationarity (`r = 0`) the same
argument gives `f(w) − f* ≤ μᵀw`. So when a forger dresses up a portfolio with the best multipliers it can find
(`ν = minᵢ(Σw)ᵢ`, `μ = Σw − ν1 ≥ 0`, which makes S and D1 hold *exactly*), the only check left to fail is CS —
and `DualityGapTooLarge(gap)` reports an upper bound on how suboptimal the forgery is. On Sepolia, Mallory's lazy
1/N portfolio was rejected with gap = 0.019113 (the true optimum has half-variance 0.00133).

**Numbers for the live job** (n = 6, τ = 10⁻⁹, ν = 0.0026604): certified bound `(12 + 3 + 0.0027)·10⁻⁹ ≈ 1.5·10⁻⁸`.
The submitted certificate had stationarity residual **0** (exact), duality gap **0**, PSD residual 6.3·10⁻¹⁷.

### 4.5 Why this matters

Classical escrow needs a human, an oracle, a reviewer quorum or "client acceptance" — each a trust assumption
and an attack surface. A *certifying algorithm* (McConnell, Mehlhorn, Näher & Schweitzer, 2011) returns a witness
that a simple checker can verify. QED makes the blockchain that checker for AI work: the expensive, opaque part
(an AI-driven optimiser) is untrusted; the cheap, transparent part (the KKT check) is executed by every Ethereum
node. The same construction extends to every convex financial problem with a duality certificate — CVaR (an LP),
risk parity, index tracking, cash-flow matching, multilateral netting — by deploying a new `IProofVerifier`.

---

## 5. The certifying solver (off-chain, untrusted)

`agent/src/engine/minvar.ts`

1. **Exact support enumeration.** For each non-empty support S ⊆ {1..n}, solve `Σ_SS x = 1`; set
   `w_S = x / 1ᵀx`, `ν = 1 / 1ᵀx`. Accept S iff `w_S ≥ 0` and `μᵢ = (Σw)ᵢ − ν ≥ 0` for all `i ∉ S`.
   Σ ≻ 0 ⇒ the KKT point is unique, so this returns the exact optimum. Cost `O(2ⁿ n³)`: 1.3 ms for n = 6.
2. **Fixed-point certificate.** Round w to WAD, place the rounding residue on the largest weight so `1ᵀw = 10¹⁸`
   exactly, recompute `g = Σw` at 10³⁶ scale in BigInt, set `ν` = mean of `gᵢ` over the support, `μᵢ = max(0,
   gᵢ − ν)` off-support. Cholesky factor L via standard decomposition, rounded to WAD.
3. **Pre-flight.** `checkCertificate` is a bit-exact TypeScript re-implementation of the verifier; the agent also
   dry-runs `ProofEscrow.check` (eth_call) before spending gas on `deliver`.

Result for the Helix model: Global Equities 16.32 %, US Treasuries 7–10y 80.81 %, Gold 2.87 %, all others 0
(their μ > 0 certifies that adding any of them would increase variance). Portfolio volatility 5.16 %.

---

## 6. Economic decision engine

`agent/src/engine/economics.ts` — deterministic; the LLM never prices anything.

```
price  = ⌈ cost × 2.5 ⌉ (whole tUSD, ≥ 10)
accept ⇔ budget ≥ price
       ∧ margin/price ≥ 30 %
       ∧ cost ≤ F                       (only FREE money funds costs)
       ∧ F − cost ≥ 5 tUSD              (reserve buffer above ring-fenced liabilities)
       ∧ cost ≤ remaining 24h window
       ∧ delivery ≤ 72 h
```

Unsettled revenue is never treated as capital: the 15 tUSD fee becomes spendable only when the escrow settles
into the vault (check E7).

**Earned autonomy (co-signer check C12).** Discretionary spend is capped at `10 tUSD + 50 % × verified revenue`,
where verified revenue is the sum of `JobSettled` events paid into this vault. Autonomy grows only with on-chain,
proof-settled performance.

---

## 7. Co-signer policy (12 checks, one decision record)

| ID | Check | Source of truth |
|---|---|---|
| C1 | Mandate signed by the vault owner | ecrecover over `QEDLens.mandateDigest` |
| C2 | Mandate active, current epoch | chain |
| C3 | Invoice signed by the payee's registered key (or owner-signed instruction for chat payments) | signatures |
| C4 | Invoice addressed to this vault, unexpired | invoice |
| C5 | Price = vendor's published list price | catalog |
| C6 | Invoice / instruction nonce not seen before | co-signer state |
| C7 | A funded escrow job for this vault covers the cost with ≥ 30 % margin | chain (`getJob`) |
| C8 | Purchased data is exactly the job's committed spec | `job.specHash == invoice.dataCommitment` |
| C9 | Payee listed in the owner's mandate | mandate |
| C10 | Reserve buffer preserved | chain (`QEDLens.snapshot`) |
| C11 | Sanctions / deny-list screening | policy |
| C12 | Earned autonomy | chain (`JobSettled`, `PaymentExecuted`) |

The full record (inputs, treasury snapshot, every check) is canonicalised (sorted-key JSON), hashed with
keccak-256, and that hash is signed into the certificate's `evidenceHash` — so the on-chain payment event
permanently commits to the exact reasoning that authorised it. `npm run verify` recomputes the hash.

---

## 8. Conversational layer: LLM for language, a state machine for money

```
message ─▶ LLM (or offline brain) ─▶ fillPaymentSlots (deterministic) ─▶ Guard (deterministic) ─▶ reply / proposal
                                                                                      │
                                                         confirm + owner signature ───┴─▶ co-signer ─▶ vault
```

* **Slot filling** (`agent/src/brain/slots.ts`): payee, amount, due date, *confirm* and *cancel* are extracted by
  code from the raw text and the pending proposal, so a payment never depends on how the model phrased a turn.
* **Guard** (`agent/src/brain/guard.ts`): detectors for the rubric's four attack classes (English + Chinese);
  any transfer to an address outside the owner's mandate, any request for secrets, any attempt to widen authority
  produces a fixed refusal written by code, not by the model.
* **Confirmation** is a signature: the owner's console signs the exact instruction
  (`payee, amount, dueInDays, nonce`), and the co-signer verifies it (check C3) before certifying.

Red-team result (32 cases: 25 attacks + 7 benign controls, live Claude Sonnet 5.5): guarded pipeline blocked **25/25**
attacks with **0** false refusals; the model alone blocked 24/25 (`evidence/redteam/report.md`).

---

## 9. Certified clearing: maximal multilateral netting with an exact proof (`QEDClearing`)

### 9.1 The gridlock

Members of an agent economy owe each other money in cycles. In the live run five AI businesses owe each other
**200 tUSD** but hold only **28 tUSD** of cash between them; every one of them is solvent on a net basis, yet
nobody can settle gross (on-chain receipt G1: Northwind owes 40 and holds 18). Cancelling debts around cycles
needs no tokens at all, but the party that computes the cancellation could be wrong, lazy or self-serving.

### 9.2 The linear program and its dual

For open obligations e = (u → v) with outstanding amounts dₑ, choose cancellations xₑ:

```
(P)  maximise  Σₑ xₑ    s.t.  Σ_{e out of v} xₑ = Σ_{e into v} xₑ   for every member v      (net positions unchanged)
                               0 ≤ xₑ ≤ dₑ                                                     (never below zero)

(D)  minimise  Σₑ dₑ yₑ  s.t.  π_u − π_v + yₑ ≥ 1   for every e = (u → v),   yₑ ≥ 0,   π free
```

**Weak duality.** For any x feasible in (P) and (π, y) feasible in (D):

```
Σₑ xₑ ≤ Σₑ xₑ (π_u − π_v + yₑ) = Σ_v π_v (Σ_out x − Σ_in x) + Σₑ xₑ yₑ = Σₑ xₑ yₑ ≤ Σₑ dₑ yₑ .
```

So a proposal with **Σₑ xₑ = Σₑ dₑ yₑ** is optimal: no larger netting exists. (P)'s constraint matrix is a
network matrix, hence totally unimodular; with integer data there are integer optimal (x, π, y), so the
certificate is exact: no tolerance, no rounding, no floating point.

### 9.3 What the contract checks (`QEDClearing.net`, O(obligations + members))

| Check | Error if it fails | What it rules out |
|---|---|---|
| The proposal lists **every** open obligation, ids strictly increasing | `IncompleteSnapshot`, `IdsNotIncreasing` | proving "maximality" on a doctored subset |
| Each listed amount equals the current amount | `StaleAmount` | proofs about a past state; replays |
| 0 ≤ xₑ ≤ dₑ | `ExceedsObligation` | erasing more debt than exists |
| For every member, cancelled payables = cancelled receivables | `NetPositionChanged(member, Δ)` | moving value between members |
| π_u − π_v + yₑ ≥ 1, bounded values | `DualInfeasible`, `ValueOutOfRange` | forged certificates, overflow games |
| Σₑ xₑ = Σₑ dₑ yₑ | `NotProvablyMaximal(cleared, bound)` | lazy or suboptimal nettings |

**Properties (proved by the checks themselves).** Every member's receivable − payable is unchanged; no claim is
created or re-assigned, only reduced, so every counterparty exposure shrinks; and the executed netting is maximal.
That is why `net()` can be **permissionless**: joining (`join()`, which emits the hash of these terms) is the only
consent needed, and the QED agent can be both a member and the prover without being able to favour itself.

### 9.4 The certifying solver (off-chain, untrusted): `agent/src/engine/netting.ts`

1. (P) is a maximum-gain circulation = a min-cost circulation with cost −1 per unit cancelled. Solved exactly by
   **minimum-mean cycle cancelling** (Goldberg & Tarjan, 1989), each cycle found with **Karp's algorithm**
   (1978): strongly polynomial and integral.
2. At optimality the residual graph (forward arcs cost −1 where x < d, backward arcs cost +1 where x > 0) has no
   negative cycle, so **Bellman–Ford** from a virtual source gives integer distances π. Setting
   yₑ = max(0, 1 − (π_u − π_v)) is dual-feasible and complementary-slack, hence Σx = Σd·y.
3. `checkNetting` re-implements the on-chain checks bit for bit (pre-flight and independent verification).

**Verified:** equals an exhaustive brute-force oracle on 150 random small economies; certificates valid on 60
random economies (3–7 agents, 3–16 debts) that the Solidity suite also executes; a 2,000-run fuzzer pushes
any amount of debt around every simple cycle of the demo economy and every such proposal is rejected.

### 9.5 The live run (Ethereum Sepolia)

| | |
|---|---|
| Gross debt | 200 tUSD across 11 obligations, 5 agents |
| Cash held | 28 tUSD (each agent exactly its net debit) |
| Maximal netting (QED agent) | **169 tUSD cancelled**, dual bound 169: executed (N6) |
| Naive shortest-cycle-first netting | 162 tUSD: `NotProvablyMaximal(162, 169)` (N1) |
| Remaining after netting | 31 tUSD in 4 obligations, an acyclic graph, paid in topological order with the 28 tUSD of cash |
| End state | 0 open obligations; every agent holds exactly its net position |

Remaining debts after a maximal netting always form a DAG (a cycle would admit more cancellation), so paying in
topological order needs only each agent's net debit in cash: Σ max(0, payables − receivables).

---

## 10. Private optimality: the same certificate, proven in zero knowledge (`PrivateMinVarianceVerifier`)

### 10.1 The tension it removes

§4 makes the chain check that a paid portfolio is optimal. The check needs Σ and w in calldata, so the licensed
risk model and the client's allocation become public the moment the escrow pays. Accountability and
confidentiality pull in opposite directions: an auditor who can verify the decision can also read the book.
QED proves the **same** KKT certificate inside a zk-SNARK, so the chain verifies optimality while learning only
two commitments, the certified variance and the provider's address.

### 10.2 The statement (`circuits/private_minvar.circom`, n = 6, Groth16 over BN254)

Fixed point `ONE = 10¹²`; all values are integers; signed values use the field's negative encoding.

| Public signal | Meaning |
|---|---|
| `dataCommitment` | `Poseidon(Poseidon(Σ₀…Σ₁₀), Poseidon(Σ₁₁…Σ₂₀, saltΣ))`: the vendor's 21 covariance entries |
| `weightsCommitment` | `Poseidon(w₁…w₆, saltW)`: the delivered portfolio |
| `variance` | `wᵀΣw` at scale ONE³ (exact) |
| `provider` | the address the proof is bound to |

The prover knows (Σ, saltΣ, w, ν, μ, L, saltW) such that, with τ = 10⁻¹⁰:

| Constraint | Encoding in the circuit |
|---|---|
| Range: \|Σᵢⱼ\|, \|Lᵢⱼ\| < 2⁴⁰; Σᵢᵢ ≥ 1; \|ν\| < 2⁸⁰; 0 ≤ wᵢ < 2⁴⁰; 0 ≤ μᵢ < 2⁸⁰ | `Num2Bits` on value (+ offset) |
| Budget Σwᵢ = ONE **exactly** | one linear constraint |
| Stationarity \|(Σw)ᵢ − ν − μᵢ\| ≤ τ | two 90-bit range checks of τ ± r |
| Complementary slackness Σwᵢμᵢ ≤ τ | one 130-bit range check of τ·ONE − gap |
| Convexity \|Σᵢⱼ·ONE − (LLᵀ)ᵢⱼ\| ≤ τ, j ≤ i | two 90-bit range checks per entry |
| Commitments and variance as above | Poseidon (circomlib), 6 products |
| `provider` | a quadratic constraint so the public input is bound into the proof |

12,569 constraints (9,421 non-linear). **No wrap-around:** with the input ranges every intermediate quantity
is below 2¹³¹ in magnitude, far under the field modulus p ≈ 2²⁵⁴, so each range check is an exact integer
comparison. `checkWitness` in `agent/src/engine/privateMinvar.ts` mirrors every arithmetic constraint and is
used as a pre-flight and in tests.

### 10.3 Theorem (private ε-optimality)

*If `PrivateMinVarianceVerifier` accepts, then (under the knowledge soundness of Groth16 and the collision
resistance of Poseidon) the provider knows Σ committed to by the attested `dataCommitment` and w committed to
by `weightsCommitment` such that ½wᵀΣw ≤ min_{x ≥ 0, 1ᵀx = 1} ½xᵀΣx + τ(|ν| + 3 + τ) + ½nτ(2 + τ)².*

**Proof.** The circuit's constraints are exactly the hypotheses of Theorem 4.4 (P1 holds with zero budget
error), so the bound of §4.4 applies verbatim. For the live job, |ν| ≈ 0.0016 and the bound is ≈ 1.5·10⁻⁹. ∎

### 10.4 What the verifier checks before the pairing

| Check | Error | What it rules out |
|---|---|---|
| The data commitment is signed by the registered vendor (EIP-191 over tag, chain id, commitment, universe) | `UntrustedDataAttestation(signer)` | proofs about made-up data; replaying an attestation on another chain |
| Every public signal is a canonical field element | `NotAFieldElement` | malleable encodings |
| `verifyProof(a, b, c, [weightsCommitment, variance, dataCommitment, provider])` | `ProofRejected` | everything else: a different portfolio, a lower claimed variance, a copied proof |

Verification costs ≈ 270 k gas, and the escrow needs no change: the verifier is just another `IProofVerifier`
named in the provider-signed quote. A client accepts a quote only if its spec names the quoting provider; the
escrow already requires the delivery to come from that provider.

### 10.5 Trusted setup

Groth16 needs a structured reference string. This deployment used a local two-phase ceremony
(`circuits/setup.sh`): phase 1 powers of tau (2¹⁴) with two contributions and a beacon, phase 2 with two
contributions and a beacon. The beacons are the hashes of public Sepolia transactions from earlier runs (S4 and
N6), fixed before the setup ran. Groth16 is sound if any one contributor destroyed their secret; since every
contribution ran on one machine, **this setup must be treated as trusted** (risk K18). A production deployment
takes phase 1 from a public ceremony (`PTAU=… bash circuits/setup.sh`) and runs phase 2 with independent
parties; nothing else changes. `circuits/ceremony-transcript.txt` records every contribution hash, and
`snarkjs zkey verify` reproduces the check from the committed `.r1cs`, `.ptau` and `.zkey`.

### 10.6 The live run (Ethereum Sepolia)

Helix attested a six-sleeve private-markets model by commitment only. The QED agent proved the optimal
allocation in 1.5 s; the original `ProofEscrow` paid 12 tUSD into QED's vault on that proof (Z3). Mallory then
replayed QED's proof from the public calldata into her own job (`ProofRejected`: it is bound to QED), claimed a
lower variance (`ProofRejected`), and delivered a genuine proof about a data set she attested herself
(`UntrustedDataAttestation`). The chain never saw the model or the portfolio. (So that reviewers can reproduce
the run, the demo's synthetic model is in `agent/src/engine/privateScenario.ts`; in production it stays with the
vendor and the agent, and only its commitment is ever published.)

---

## 11. Theorems with money on them (`OptimalityBounty`, `MaximalityBounty`)

A proof in a document is only as convincing as the reader's patience. These two contracts turn the two theorems
QED's money depends on into **standing, self-adjudicating offers**: each holds 1,000 tUSD and pays all of it,
with no human involved, to the first caller who refutes its theorem on-chain.

| Contract | Theorem guarded | A claim must contain | The contract checks, in exact integers |
|---|---|---|---|
| `OptimalityBounty` | §4.4: an accepted certificate is within the bound of the optimum | a certificate the **deployed** `MinVarianceVerifier` accepts, and a feasible portfolio x | re-runs the verifier; x ≥ 0, Σx = 1; pays iff F(w) − F(x) > 2tW(\|ν\| + 3W + t) + n·t·(2W + t)² (the theorem's inequality × 2W³) |
| `MaximalityBounty` | §9.2: a netting with Σx = Σd·y is maximal | an economy, a netting `QEDClearing` would accept, and another netting | re-states `QEDClearing.net`'s acceptance rule line for line; checks the alternative conserves every net position within the debts; pays iff it cancels more |

If the theorems are true the bounties can never pay, and every attempt reverts with the numbers that show why:
`TheoremHolds(advantage, bound)` or `TheoremHolds(169, 162)`. Positive controls in `contracts/test/Bounties.t.sol`
show that against an unsound verifier, or an acceptance rule that under-reports by 7 tUSD, the same contracts
pay out at once; a differential test shows `MaximalityBounty.accepts` agrees with the deployed `QEDClearing` on
all 60 generated economies; fuzzers try 2,000 random feasible portfolios and 2,000 random circulations.

On Sepolia, Mallory tried the equal-weight portfolio (BA1), QED's optimum shifted by 0.1% (BA2), the forged
certificate the chain refused in job #2 (BA3), the naive 162 tUSD netting (BM1) and a 170 tUSD netting that
breaks one net position (BM2). All five reverted; `npm run verify` checks daily that both pools are still full.
