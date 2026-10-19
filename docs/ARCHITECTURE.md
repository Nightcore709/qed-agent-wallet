# QED — System Architecture

## 1. One picture

```mermaid
flowchart LR
  subgraph OFF["Off-chain — untrusted by design"]
    direction TB
    LLM["Language model<br/>(Claude Sonnet 5.5 or offline brain)"]
    GUARD["Deterministic guard<br/>+ payment slot filling"]
    ECON["Economic engine<br/>(prices, reserve buffer)"]
    SOLVER["Certifying solver<br/>(KKT + Cholesky witness)"]
    AGENT["QED agent process<br/>🔑 AGENT key only"]
    COSIGN["Co-signer process<br/>🔑 CO-SIGNER key only<br/>12 policy checks"]
    VENDOR["Helix Data vendor<br/>🔑 VENDOR key only"]
    LLM --> GUARD --> AGENT
    ECON --> AGENT
    SOLVER --> AGENT
    AGENT -- "request certificate" --> COSIGN
    AGENT -- "invoice / data" --> VENDOR
  end

  subgraph ON["Ethereum Sepolia — the proof checker"]
    direction TB
    VAULT["QEDVault<br/>mandates · certificates · ring-fenced liabilities · caps · pause"]
    ESCROW["ProofEscrow<br/>signed quotes · settle-on-proof"]
    VERIFIER["MinVarianceVerifier<br/>KKT + PSD certificate check"]
    LENS["QEDLens<br/>blast radius · snapshots · EIP-712 digests"]
    TOKEN["TestUSD (tUSD)"]
    ESCROW --> VERIFIER
    LENS -.reads.-> VAULT
  end

  OWNER["Owner (cold key)<br/>signs mandates"] -. "EIP-712 mandate (off-chain)" .-> AGENT
  CLIENT["Client agent (Northwind)"] -- "open(quote)" --> ESCROW
  AGENT -- "executePayment(mandate, cert)" --> VAULT
  AGENT -- "deliver(spec, w, ν, μ, L)" --> ESCROW
  ESCROW -- "pays on valid proof" --> VAULT
  GUARDIAN["Guardian"] -- "pause()" --> VAULT
  VAULT -- "settle() → creditor only" --> CREDITOR["CloudCo (creditor)"]
```

The design rule is a trust gradient: **everything that can be fooled is off-chain and holds at most one key;
everything that decides whether money moves is on-chain and checks proofs.**

## 2. Components

### On-chain (`contracts/src`, Solidity 0.8.26, via-IR, OpenZeppelin 5.1)

| Contract | Size | Responsibility |
|---|---|---|
| `QEDVault` | 9.1 KB | Treasury of one agent. Verifies owner mandates (EIP-712, EOA or ERC-1271) and co-signer certificates; enforces payee scope, per-payment/period/lifetime caps, a global 24 h window cap, the solvency invariant, single-use intents, epochs, pause. Holds ring-fenced liabilities that only creditors can be paid from. |
| `QEDLens` | 5.1 KB | Stateless views: `blastRadius(vault, horizon)`, `snapshot(vault)`, EIP-712 hashes/digests. Separate so the enforcement contract stays small (Sepolia's state-creation pricing + EIP-7825's 2²⁴ gas cap bound deployable code size). |
| `ProofEscrow` | 5.6 KB | Agent-to-agent work. Provider-signed EIP-712 quote binds price, payee, client, verifier, problem hash, deadline. `deliver` pays iff `IProofVerifier.verify(spec, solution)` succeeds. Refund after deadline. |
| `MinVarianceVerifier` | 2.4 KB | `IProofVerifier` for long-only minimum-variance portfolios: exact-integer KKT + PSD certificate check (docs/ALGORITHMS.md §4). |
| `TestUSD` | 2.1 KB | Valueless 6-decimal test token with a public 1 000 tUSD/day faucet for reviewers. |

### Off-chain (`agent/`, TypeScript, viem)

| Module | Process / key | Responsibility |
|---|---|---|
| `roles/agent.ts` | agent process · AGENT key | RFQ handling, autonomous job fulfilment (watches `JobOpened`), owner console, decision records |
| `roles/cosigner.ts` | co-signer process · CO-SIGNER key | 12-check policy engine; writes & hashes decision records; signs certificates |
| `roles/vendor.ts` | vendor process · VENDOR key | catalog, signed invoices, releases data only after seeing the on-chain payment |
| `brain/*` | inside agent | `AnthropicBrain` (live LLM) / `OfflineBrain`; `slots.ts` deterministic payment slot filling; `guard.ts` deterministic security layer; `evaluate.ts` red-team scoring |
| `engine/minvar.ts` | inside agent | certifying solver + bit-exact TS checker |
| `engine/economics.ts` | inside agent | pricing and acceptance rules |
| `scripts/live.ts` | orchestrator (owner, client, guardian, Mallory) | deploys and runs the whole economy, records evidence |
| `scripts/verify.ts` | anyone · no keys | independent re-derivation of every on-chain claim |

## 3. Key lifecycle flows

### 3.1 Paid work, end to end (Outcomes 1 & 2)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client agent
  participant A as QED agent (AGENT key)
  participant V as Vendor
  participant S as Co-signer (CO-SIGNER key)
  participant E as ProofEscrow
  participant Q as QEDVault
  participant K as MinVarianceVerifier
  C->>A: RFQ (natural language + typed request, spec commitment)
  A->>A: LLM reads text · guard · economics (price 15, cost 6, buffer ok)
  A-->>C: EIP-712 quote (price, payee=vault, verifier, specHash, deadline)
  C->>E: open(quote, sig)  — 15 tUSD escrowed
  E-->>A: JobOpened (observed on-chain)
  A->>V: request invoice
  V-->>A: signed invoice (6 tUSD, dataCommitment)
  A->>S: certify(purchase: mandate, invoice, job)
  S->>S: 12 checks → decision record → evidenceHash
  S-->>A: certificate (recipient, amount, intent, evidenceHash…) + sig
  A->>Q: executePayment(mandate, ownerSig, cert, cosignerSig)  ← sent by AGENT key
  Q-->>V: 6 tUSD
  V-->>A: licensed data (after seeing the payment on-chain)
  A->>A: verify data hash == spec · solve · certify (w, ν, μ, L)
  A->>E: deliver(jobId, spec, solution)
  E->>K: verify(spec, solution)  — KKT + PSD
  K-->>E: certified variance
  E-->>Q: 15 tUSD into the agent's vault
```

### 3.2 Owner conversation → signed confirmation → payment

```mermaid
sequenceDiagram
  participant O as Owner console (OWNER key)
  participant A as Agent (LLM → slots → guard)
  participant S as Co-signer
  participant Q as QEDVault
  O->>A: "pay the data vendor"
  A-->>O: How much? (clarification)
  O->>A: "2 tUSD"   →   "actually make it 3"
  A-->>O: Proposed 3 tUSD to Helix — confirm?
  O->>A: "confirm" + owner signature over (payee, amount, nonce)
  A->>S: certify(owner-instructed, instructionSig)
  S-->>A: certificate (C3: instruction signed by owner ✓)
  A->>Q: executePayment(...)
```

### 3.3 Defence in depth against a manipulated agent

| Layer | Who | Stops |
|---|---|---|
| 1. Guard | deterministic code in the agent | injection, scams, secret requests, escalation — before any proposal |
| 2. Co-signer | independent process & key | anything not justified by a signed invoice + funded job, or not owner-signed |
| 3. Vault | Ethereum | everything outside the owner's mandate, caps, solvency, replay, pause — even if layers 1 and 2 are both compromised |

## 4. Data & evidence model

* **Mandate** (owner-signed, off-chain): scope of authority. Hash is referenced by every certificate.
* **Certificate** (co-signer-signed): exact payment terms + `evidenceHash` of the decision record.
* **Decision record** (`evidence/…/records/cosigner/<hash>.json`): canonical JSON of inputs, treasury snapshot,
  all 12 checks and verdict. `keccak256(canonical(core)) == evidenceHash` on-chain.
* **Agent records** (`records/agent/*`): RFQ evaluations, fulfilment (solution + certificate stats), every chat turn
  with the LLM transcript.
* **Manifest** (`evidence/ethereum-sepolia/manifest.json`): every step, actor, expected outcome, tx hash, decoded
  events / errors, mapped to Outcomes O1–O4.

## 5. Execution & deployment topology

```mermaid
flowchart LR
  subgraph SB["Build sandbox (no RPC egress)"]
    R["anvil replica of Sepolia<br/>chainId 11155111 · wall-clock timestamps<br/>same nonces & balances"]
    P["agent · co-signer · vendor · orchestrator<br/>(one key per process)"]
    P -- "sign & send" --> R
    R -- "export signed raw txs (canonical order)" --> OB["relay/outbox-11155111.json"]
  end
  OB -- "git push (public)" --> GH["GitHub"]
  GH -- "fetch pinned commit" --> BR["Browser relay"]
  BR -- "eth_sendRawTransaction (identical bytes)" --> SEP["Ethereum Sepolia"]
  SEP -- "receipt" --> BR
  BR -- "compare status + logs with replica" --> OK{{"0 mismatches"}}
  SEP --> CI["GitHub Actions · npm run verify (daily)"]
```

The transaction hashes in the evidence are the public-chain hashes (identical signed bytes). The relay compares each
public receipt with the replica (status and every log, excluding Sepolia's EIP-7708 system log for plain ETH
transfers), and the independent verifier re-derives every claim from a public RPC. A reviewer with RPC access
can also run the economy directly against Sepolia: `RPC_URL=… CHAIN_ID=11155111 GAS_LIMIT=16700000 npm run live`.

## 6. Gas profile on Sepolia (canonical run)

| Operation | Gas used |
|---|---|
| Deploy QEDVault | 14 963 244 |
| Deploy ProofEscrow | 9 051 450 |
| Deploy QEDLens | 8 026 770 |
| Deploy MinVarianceVerifier | 3 847 926 |
| Deploy TestUSD | 3 716 239 |

Sepolia's current schedule prices state creation far above the classic EVM (a plain ETH transfer to a fresh
account costs ≈ 205 k gas); local replicas don't model this, so all broadcasts use an explicit 16.7 M gas limit
(only gas used is charged).
