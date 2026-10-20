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
    COSIGN["Co-signer process<br/>🔑 CO-SIGNER key only<br/>12 policy checks · own route quote"]
    ROUTER["Best-execution router<br/>dual prices ν · route · bound replica"]
    VENDOR["Helix Data vendor<br/>🔑 VENDOR key only"]
    LLM --> GUARD --> AGENT
    ECON --> AGENT
    SOLVER --> AGENT
    ROUTER --> AGENT
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
    CLEAR["QEDClearing<br/>proof-gated multilateral netting"]
    PRIV["PrivateMinVarianceVerifier<br/>vendor attestation · Groth16"]
    BOUNTY["Optimality · Maximality · Execution bounties<br/>pay anyone who refutes the theorems"]
    EXEC["QEDExecution<br/>the vault's agent · on-chain best-execution bound"]
    POOLS["Owner-named venues<br/>(Uniswap-V2-interface pools)"]
    EXEC -- "executePayment" --> VAULT
    EXEC -- "swap" --> POOLS
    BOUNTY -.re-runs.-> EXEC
    ESCROW --> VERIFIER
    ESCROW --> PRIV
    BOUNTY -.re-runs.-> VERIFIER
    LENS -.reads.-> VAULT
  end

  OWNER["Owner (cold key)<br/>signs mandates"] -. "EIP-712 mandate (off-chain)" .-> AGENT
  CLIENT["Client agent (Northwind)"] -- "open(quote)" --> ESCROW
  AGENT -- "executePayment(mandate, cert)" --> VAULT
  AGENT -- "deliver(spec, w, ν, μ, L)" --> ESCROW
  ESCROW -- "pays on valid proof" --> VAULT
  GUARDIAN["Guardian"] -- "pause()" --> VAULT
  VAULT -- "settle() → creditor only" --> CREDITOR["CloudCo (creditor)"]
  AGENT -- "net(ids, x, π, y)" --> CLEAR
  AGENT -- "trade(order, route, ν)" --> EXEC
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
| `QEDClearing` | 5.3 KB | Proof-gated multilateral netting for agent economies. Members `join` (on-chain consent to the terms) and record debts as debtors; `net` is permissionless and executes only if net positions are unchanged, nothing is created, the snapshot is complete and current, and an exact LP-duality certificate proves the netting maximal (ALGORITHMS §9). |
| `PrivateMinVarianceVerifier` + `Groth16Verifier` | 2.1 KB + 1.6 KB | `IProofVerifier` for the same problem **in zero knowledge**: checks the data vendor's attestation of a Poseidon commitment, binds the proof to its provider, then verifies a Groth16 proof of the KKT certificate (ALGORITHMS §10). Usable by the deployed `ProofEscrow` unchanged. |
| `OptimalityBounty`, `MaximalityBounty` | 2.0 KB, 2.6 KB | Standing offers that pay their whole balance to anyone who refutes, on-chain, Theorem 4.4 (via the deployed verifier) or the netting maximality theorem (ALGORITHMS §11). No owner, no withdrawal. |
| `QEDExecution` | 9.6 KB | Lets a vault's agent convert money with **best execution proved on-chain**. It is the vault's `agent`: funds arrive only through `executePayment` in the same transaction; the co-signed order fixes recipient, floor, tolerance and venue set; the contract computes the weak-duality bound over every owner venue from live reserves, runs the agent's route and refuses any output more than τ below the bound (ALGORITHMS §12). Holds nothing between transactions. |
| `CPMMPool` | 2.1 KB | Trading venue with the Uniswap V2 pair interface and invariant, fee as a parameter; liquidity by transfer + `sync`. |
| `ExecutionBounty` | 3.7 KB | Pays its pool to anyone whose route, run on the bounty's own funds, beats `QEDExecution.quoteBound` (Theorem 12.3). |
| `TestUSD`, `TestToken` | 2.1 KB, 1.8 KB | Valueless test tokens: tUSD (6 dp, public 1 000/day faucet), tEUR (6 dp) and tETH (18 dp). |

### Off-chain (`agent/`, TypeScript, viem)

| Module | Process / key | Responsibility |
|---|---|---|
| `roles/agent.ts` | agent process · AGENT key | RFQ handling, autonomous job fulfilment (watches `JobOpened`), owner console, decision records |
| `roles/cosigner.ts` | co-signer process · CO-SIGNER key | 12-check policy engine; writes & hashes decision records; signs certificates |
| `roles/vendor.ts` | vendor process · VENDOR key | catalog, signed invoices, releases data only after seeing the on-chain payment |
| `brain/*` | inside agent | `AnthropicBrain` (live LLM) / `OfflineBrain`; `slots.ts` deterministic payment slot filling; `guard.ts` deterministic security layer; `evaluate.ts` red-team scoring |
| `engine/minvar.ts` | inside agent | certifying solver + bit-exact TS checker |
| `engine/economics.ts` | inside agent | pricing and acceptance rules |
| `engine/privateMinvar.ts` | inside agent | fixed-point witness, Poseidon commitments, Groth16 prover (snarkjs), bit-exact mirror of every circuit constraint |
| `circuits/private_minvar.circom` | build time | the zero-knowledge statement (12,569 constraints); `circuits/setup.sh` runs the two-phase trusted setup |
| `engine/netting.ts` | inside agent | certifying netting solver (min-mean cycle cancelling + Bellman–Ford dual), bit-exact checker, naive greedy rival |
| `scripts/clearing.ts` | orchestrator (5 member agents, QED prover, Mallory) | runs the clearing economy: gridlock, attacks, proven netting, settlement |
| `engine/execution.ts` | inside agent and co-signer | best-execution solver: closed-form venue values, coordinate descent + Newton on B(ν), route recovery (incl. arbitrage legs), exact integer simulator, bit-exact replica of the on-chain bound, baseline policies |
| `roles/trader.ts` | inside agent · OPERATOR key | reads the owner's venues, plans and pre-flights the certified route, ranks alternatives, applies the submit rule |
| `cosigner.ts → evaluateTrade` | co-signer process | 11 checks for a conversion, including its own optimal quote (written into the order as the floor) and a quoted-rate manipulation screen |
| `scripts/execute.ts`, `execution-bounty.ts` | orchestrators | Run 4 (conversions, attacks, front-run) and Run 4b (execution bounty) |
| `scripts/private.ts` | orchestrator (Helix, Northwind, QED, Atlas, Mallory) | runs the private economy and the bounty challenges on the main run's escrow and verifier |
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

### 3.3 Certified clearing of an agent economy (QEDClearing)

```mermaid
sequenceDiagram
  participant M as 5 member agents (one key each)
  participant P as QED prover (any key)
  participant X as Mallory / rival bot
  participant C as QEDClearing
  M->>C: join()  — on-chain consent to TERMS
  M->>C: issue(creditor, amount, dueAt, memo)  — 11 debts, 200 tUSD
  M-xC: pay(id) gross — reverts: 28 tUSD of cash cannot settle 200 (G1)
  P->>P: min-mean cycle cancelling → x (169) · Bellman–Ford → π, y · Σx = Σd·y
  X-xC: net(lazy / shifting / oversized / partial / forged / replayed) — 6 reverts (N1–N5, N7)
  P->>C: net(ids, amounts, x, π, y)
  C->>C: conservation per member · 0 ≤ x ≤ d · dual feasibility · Σx = Σd·y (exact integers)
  C-->>M: Reduced × 11 · Netted(169 cancelled, 200 → 31)
  M->>C: pay(id) in DAG order — each payer needs only its net debit (S1–S4)
```

### 3.4 Private work, paid on a zero-knowledge proof (QED Private)

```mermaid
sequenceDiagram
  participant H as Helix (data vendor)
  participant C as Northwind (client)
  participant A as QED agent
  participant E as ProofEscrow (the escrow of job 1)
  participant P as PrivateMinVarianceVerifier
  participant G as Groth16Verifier
  H-->>A: covariance Σ (licensed, off-chain) and a signed Poseidon commitment
  A-->>C: EIP-712 quote with verifier P and a spec naming QED as provider
  C->>E: open(quote) — 12 tUSD escrowed
  A->>A: optimum and KKT certificate in fixed point, then a Groth16 proof (1.5 s)
  A->>E: deliver(spec, proof, weightsCommitment, variance)
  E->>P: verify(spec, solution)
  P->>P: vendor attestation valid, public signals canonical
  P->>G: verifyProof(a, b, c, public signals)
  E-->>A: 12 tUSD into the QED vault, while Σ and w never reach the chain
  A-->>C: w and its salt off-chain, re-hashed by the client against the commitment
```

### 3.5 A conversion with proven best execution (QEDExecution)

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner
  participant L as Language model + guard
  participant A as QED agent (operator key)
  participant C as Co-signer
  participant X as QEDExecution
  participant V as QEDVault
  participant P as Venues
  O->>L: "Move 20 tUSD into the euro reserve"
  L->>A: proposal: pay Euro reserve 20 tUSD (a tEUR vault, so convert)
  A->>X: read venues and reserves; solve min B(ν); pre-flight quoteBound
  O->>C: signed confirmation of the exact conversion
  C->>X: read venues itself, solve itself, set floor = own quote less 1%
  C-->>A: certificate with ref = hash(order)
  A->>X: trade(mandate, certificate, order, route, prices ν)
  X->>X: bound B from live reserves of all venues
  X->>V: executePayment: mandate, co-signature, caps, solvency
  V-->>X: exactly 20 tUSD
  X->>P: the agent's hops (split and two-hop)
  P-->>X: tEUR measured as a balance change
  X->>X: require out ≥ floor and out ≥ (1 − τ)·B, no leftovers
  X-->>O: tEUR to the euro reserve; BestExecution event
```

### 3.6 The autonomous loop: one objective, twelve steps, two independent deciders (Run 4c)

The owner states an objective once; after that no human approves individual trades. Each step below is code that
ran on Sepolia, with the evidence it left. Probabilistic reasoning appears nowhere on this path: the language layer
reads owner instructions (§3.5), but a standing policy is executed by deterministic code that a second process
re-derives before anything is signed.

| # | Step | Where | What happens | Evidence (Run 4c) |
|---|---|---|---|---|
| 1 | Receive an objective | owner → `policyMessage` | "keep ≥ 45 tEUR free in the reserve; tranches 2–25 tUSD; ≤ 150 bps cost", signed once (EIP-191) | `P0` |
| 2 | Observe | `observeTreasury` | reserve free balance, treasury free balance above its buffer within the daily window, reserves of every owner venue | `T1`–`T3` decision records |
| 3 | Interpret constraints | `decideTranche` | policy tranche bounds and impact limit, the mandate's per-payment cap, free funds | candidates in each `T` record |
| 4 | Generate actions | `decideTranche`, `solve` | five candidate sizes (need, impact, three caps); for each size the optimal route over all venues | `T1`: need — (not coverable within the caps), impact 19.535, caps 25 / 25 / 55 |
| 5 | Evaluate consequences | `certifiedOut`, `impactBps` | certified output and execution cost of each candidate, by integer simulation | `T1`: 150.0 bps at 19.535 tUSD |
| 6 | Apply the innovation | `planTrade` → `quoteBound` | the route's dual-price proof is computed and pre-flighted against the on-chain bound | `PE1`: 0.18 ppm from the bound |
| 7 | Decide | `decideTranche` | convert the minimum of the candidates, wait if below the minimum tranche, or do nothing | `T1` convert (impact) · `T2` convert (need) · `T3` none |
| 8 | Construct a narrowly authorised transaction | co-signer `evaluateTrade` | an independent process re-derives the decision (P1–P3), re-quotes (T1–T3), writes its own floor and τ into the order and certifies `hash(order)`; refuses an over-sized request | `C1`, `C2`; refusal `PA1` |
| 9 | Execute through a real wallet | operator key → `QEDExecution.trade` → `QEDVault.executePayment` | the vault checks mandate, certificate, caps and solvency; the module checks best execution | `PE1`, `PE2` |
| 10 | Verify status and state | `execute-policy.ts`, `npm run verify` | receipt status; `BestExecution` event; reserve re-read: its free balance must rise by exactly the output | `PE1` 20.70 → 37.52, `PE2` → 45.00 |
| 11 | Record evidence | `Evidence`, `records/` | every decision and co-signer record hashed; the certificate anchors the record's hash on chain | `evidence/ethereum-sepolia/execution/` |
| 12 | Explain | manifest narratives, dashboard | each step says what was decided and which limit bound it | dashboard "The agent decides" lane |

**Refusal is part of the loop.** The agent declines to trade into a moved market (`A10`, Run 4), the co-signer
refuses an over-sized tranche (`PA1`), the chain refuses sub-optimal routes (`EA1`–`EA3`), and when the target is
met the agent sends nothing (`T3`).

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner (cold key)
  participant A as QED agent (operator key)
  participant C as Co-signer (own key)
  participant X as QEDExecution
  participant V as QEDVault
  O->>A: standing policy, signed once
  loop every tick
    A->>X: observe reserves, free balances, venues
    A->>A: decideTranche: min(need, impact, caps) or wait or none
    A->>C: request: policy + tranche
    C->>X: observe the same block itself
    C->>C: re-derive the tranche (P1-P3), re-quote (T1-T3)
    C-->>A: certificate on hash(order) with its own floor and tau
    A->>X: trade(route, prices) after pre-flight
    X->>V: executePayment (mandate, caps, solvency)
    X->>X: out within tau of the bound, else revert
    A->>V: re-read the reserve: rose by exactly out
  end
```

### 3.7 Defence in depth against a manipulated agent

| Layer | Who | Stops |
|---|---|---|
| 1. Guard | deterministic code in the agent | injection, scams, secret requests, escalation — before any proposal |
| 2. Co-signer | independent process & key | anything not justified by a signed invoice + funded job, an owner confirmation, or a standing owner policy it re-derives itself |
| 3. Vault | Ethereum | everything outside the owner's mandate, caps, solvency, replay, pause — even if layers 1 and 2 are both compromised |
| 4. Proof of best execution | Ethereum | a conversion more than τ = 1 ppm below the best route, a changed order, a stranded token — even with the agent key stolen |

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
| Deploy QEDClearing | 8 579 134 |
| `QEDClearing.net` — 11 obligations, 5 members, certificate checked (N6) | 550 826 |
| `QEDClearing.issue` (first / later) | 795 367 / ≈ 501 600 |
| Deploy Groth16Verifier / PrivateMinVarianceVerifier | see `docs/EVIDENCE.md` (Run 3) |
| Deploy QEDExecution / CPMMPool / ExecutionBounty | 15 330 304 / ≈ 3 632 106 / 5 997 780 |
| `QEDExecution.trade` — vault checks, bound over 5 venues, 4 swaps (E1 / E2) | 1 122 781 / 667 936 |
| `QEDExecution.setVenues` — 5 venues | 1 938 167 |
| `ProofEscrow.deliver` with a zero-knowledge proof (attestation + Groth16) | see `docs/EVIDENCE.md` (Run 3, Z3) |

Sepolia's current schedule prices state creation far above the classic EVM (a plain ETH transfer to a fresh
account costs ≈ 205 k gas); local replicas don't model this, so all broadcasts use an explicit 16.7 M gas limit
(only gas used is charged).
