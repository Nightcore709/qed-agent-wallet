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

Red-team result (35 cases incl. 7 benign controls, live Claude Sonnet 5.5): guarded pipeline blocked **25/25**
attacks with **0** false refusals; the model alone blocked 24/25 (`evidence/redteam/report.md`).
