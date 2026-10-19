# QED — proof-carrying autonomy for AI-agent wallets

**An autonomous on-chain wallet in which the AI is allowed to be wrong, manipulated or stolen — and the money is still safe, because every payment carries a proof the chain checks.**

FinTechathon 2026 · International Track · Topic F — Autonomous On-chain Wallet ·
Live on **Ethereum Sepolia** · [Dashboard](https://nightcore709.github.io/qed-agent-wallet/) · [Evidence](docs/EVIDENCE.md) · [Security self-assessment](docs/SECURITY.md) · [Algorithms](docs/ALGORITHMS.md) · [Architecture](docs/ARCHITECTURE.md) · PDFs: [technical documentation](docs/pdf/QED-Technical-Documentation.pdf), [security self-assessment](docs/pdf/QED-Security-Self-Assessment.pdf), [execution evidence](docs/pdf/QED-Execution-Evidence.pdf)

[![CI](https://github.com/Nightcore709/qed-agent-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/Nightcore709/qed-agent-wallet/actions/workflows/ci.yml)

---

## The idea in five sentences

1. **The AI holds one key that can call one function.** `QEDVault.executePayment` succeeds only with an owner-signed EIP-712 *mandate* **and** a certificate from an *independent co-signer* (a separate process, a separate key, 12 policy checks) **and** inside an on-chain *solvency invariant* that ring-fences money owed to creditors.
2. **The worst case is computed, not hoped for.** `QEDLens.blastRadius(vault, horizon)` returns, at any block, the most the vault can lose if *both* hot keys are stolen — and the loss to any address the owner never approved is provably **zero**.
3. **AI work is paid for proofs, not promises.** In `ProofEscrow` a client pays only when the delivered answer passes an **on-chain optimality check** (exact-integer KKT conditions + a positive-semidefiniteness witness). A lazy or dishonest AI provider is rejected by mathematics and the client is refunded.
4. **We published the keys.** The honeypot vault's agent *and* co-signer private keys are in this repository. Its 90 tUSD ring-fence is protected by the contract, not by secrecy. [Try to steal it.](#steal-this-the-honeypot)
5. **Whole agent economies clear by proof.** In `QEDClearing`, five AI businesses that owe each other 200 tUSD but hold only 28 tUSD escape gridlock: the QED agent proves, with an exact linear-programming duality certificate checked on-chain, that its netting is the **largest possible** and leaves every member's net position unchanged. A lazy netting is rejected with `NotProvablyMaximal(162, 169)`. [Details below.](#certified-clearing-a-whole-agent-economy-settles-by-proof)

## The four outcomes — each one a public transaction

| # | Outcome asked for | Proof on Ethereum Sepolia |
|---|---|---|
| **O1** | A **separate AI-agent key** executes a payment under an **independent policy certificate** | [`L4 0x56a2334e…`](https://sepolia.etherscan.io/tx/0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6) — sent **by the agent key** `0x2A10…d0Bb`; mandate signature recovers to the **owner** `0xb7Ed…97f7`; certificate signature recovers to the **co-signer** `0xf1F8…2402`; on-chain `evidenceHash` = keccak256 of the [published decision record](evidence/ethereum-sepolia/records/cosigner/). Also [`C1 0x7000d3cc…`](https://sepolia.etherscan.io/tx/0x7000d3cc8dba8ebed99a2a9d43805b09b70a0ccbf0d33f484ad3fd044b675ee3): a chat request → clarified → corrected → owner-signed confirmation → certified payment. |
| **O2** | A **paid-work lifecycle** that ends in a **real escrow settlement** | RFQ → agent-signed quote → [`L2` client funds escrow, 15 tUSD](https://sepolia.etherscan.io/tx/0xa0546be0dc61e68e2f9b5ed2c1455dcb33bce6911ca762adae486f2a5f0646b9) → [`L4` agent buys the risk model it needs](https://sepolia.etherscan.io/tx/0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6) → solves → [`L6` delivers portfolio + KKT certificate, verified **on-chain**, 15 tUSD settles into the agent's vault](https://sepolia.etherscan.io/tx/0x4166253f06143b2a07b3c77fb4d4603a33e84f3b6706363f0d727f485f9335f9). Competing provider's lazy answer [`X17` rejected: `DualityGapTooLarge`](https://sepolia.etherscan.io/tx/0x5a6f26aca564583a77b0a0be3c65d830a5ef0e616591c1e5c4e755e1f6ec6481), near-miss [`X18` rejected: `StationarityViolated`](https://sepolia.etherscan.io/tx/0xc269055a7f1e1238e23814e5bc1c034d9bfa28dcd55f116766d7887be987f0fe), client [`X19` refunded](https://sepolia.etherscan.io/tx/0x014cb96984b48ea63495b4dec56471dd3a186757b3e07799b39f13876a144b83). |
| **O3** | An **adversarial agent cannot violate a protected liability or tamper with signed terms** | **19 attack transactions, all reverted on-chain with exactly the designed error** — tampered quote price/payee (`BadProviderSignature` ×2), forged/altered/redirected certificates (`BadCosignerSignature` ×3), both hot keys stolen paying the attacker (`PayeeNotInMandate`), self-signed mandate (`BadOwnerSignature`), replay (`IntentAlreadyUsed`), drain beyond free balance (`SolvencyViolation`), beyond the 24 h window (`ExceedsDailyCap`), admin calls (`NotOwner`, `NotCreditor`), published-key honeypot (×3), payment while paused (`VaultPaused`). Ring-fenced 70 tUSD reached **only** its creditor — [settled by the attacker's own address while the vault was paused](https://sepolia.etherscan.io/tx/0x9f4a753c58da0f5831d705973f9b0b5c484fa9baa68e47b8a7dc994a46a4135d). Full table: [docs/EVIDENCE.md](docs/EVIDENCE.md#attack-transactions-19--each-reverted-with-exactly-the-designed-error). Plus **6 attacks on the clearing house**, all reverted ([below](#certified-clearing-a-whole-agent-economy-settles-by-proof)). |
| **O4** | An **external reviewer can reproduce everything** from GitHub source, tests and receipts | `npm run verify` re-derives every claim from a public RPC with **no keys**: on-chain bytecode == this repo's compiled bytecode; every receipt's status and sender; every revert's custom error (replayed on archive state); signatures recovered from calldata; the KKT certificate re-checked off-chain; Mallory received 0 tUSD from any vault. It runs in [CI](.github/workflows/ci.yml) on every push and daily. 82 Solidity tests (unit, fuzz, stateful invariants ≈ 350 k adversarial calls/run, 60 random clearing economies) + 45 TypeScript tests. A fresh machine reproduced all of it from a clean clone ([log](docs/TESTING.md#clean-clone-reproduction-log)). |

## What makes this different

| Usual agent wallet | QED |
|---|---|
| Spending limits on a hot key | Limits **plus** an independent co-signer **plus** a solvency invariant — three layers, each sufficient for protected funds |
| "The AI will follow its system prompt" | The AI is assumed compromised. Language model → deterministic slot filling → deterministic guard → owner-signed confirmation. Red-team: **25/25 attacks blocked, 0 false refusals** (LLM alone: 24/25) |
| Trust the provider's answer, or re-run it | **Verify a certificate**: the chain checks optimality in O(n²) exact integer operations instead of solving the problem |
| Risk = "we have limits" | Risk = a **number on-chain** (`blastRadius`), proven an upper bound by fuzzing, displayed live |
| Pause = everything stops | Pause stops the **AI**, never the **creditors** — anyone can settle a due liability, even while paused |
| Keys are the security boundary | Keys are **published** for the honeypot; the contract is the boundary |
| Netting needs a trusted clearing house | **Anyone** can clear; the chain checks that the netting is maximal and moves no value (exact LP-duality certificate) |

## Architecture

```
            ┌────────────────────────── off-chain: untrusted by design ──────────────────────────┐
 owner ──▶  │  LLM (Claude) → slot filling → guard ──▶ QED agent      ──cert request──▶ co-signer   │
 (cold key, │                                        🔑 AGENT key only               🔑 CO-SIGNER  │
  signs     │  economics · certifying solver ─────────┘     │                  12 checks, record   │
  mandates) └───────────────────────────────────────────────┼──────────────────────────────────────┘
                                                            ▼ executePayment(mandate, cert)   deliver(spec, proof)
            ┌──────────────────────────── on-chain: the proof checker ─────────────────────────────┐
            │  QEDVault  — mandates · certificates · ring-fenced liabilities · caps · pause          │
            │  ProofEscrow — signed quotes · pays iff verifier accepts · refunds after deadline      │
            │  MinVarianceVerifier — exact KKT + PSD certificate check     QEDLens — blast radius    │
            │  QEDClearing — anyone may net agents' debts; executes only on an LP-duality proof      │
            └────────────────────────────────────────────────────────────────────────────────────────┘
```

Each off-chain role is a **separate OS process that receives exactly one private key**. The language model never sees a key. Diagrams and flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Steal this: the honeypot

[`evidence/ethereum-sepolia/honeypot.json`](evidence/ethereum-sepolia/honeypot.json) contains the **private keys** of the honeypot vault's agent and co-signer, plus the owner-signed mandate. The vault [`0xe5b3…7f04`](https://sepolia.etherscan.io/address/0xe5b3e7773115dba454e7e40fa97a5d3e332c7f04) holds 99 tUSD, of which **90 are ring-fenced** for a creditor until 30 Jun 2027. With both keys you can:

* pay the one approved payee up to 1 tUSD per day ([`H3`](https://sepolia.etherscan.io/tx/0xd401d7e9a908c082d0a7a3b7ce636556e055c1faca72adeff47570f2ab507de6) proves the keys are real) — that is the published blast radius;
* **not** pay yourself ([`H4` `PayeeNotInMandate`](https://sepolia.etherscan.io/tx/0x9f1f19d59139ce1f46197d6900307019a68bbb70257691c209e7ea69ad1523b7)), **not** exceed the caps ([`H5`](https://sepolia.etherscan.io/tx/0xf30a4765ed04f230359e4069543aaeab6d11babed4113d4896097d78af721b4f)), **not** withdraw ([`H6` `NotOwner`](https://sepolia.etherscan.io/tx/0x887cab2cd8fce18a1727f2f3e427407ee937798a8ababb9d96813d77925e3c3f)), **not** touch the ring-fence.

## Certified clearing: a whole agent economy settles by proof

Five AI businesses (Northwind, QED, CloudCo, Helix, Atlas) owe each other **200 tUSD** in overlapping cycles and hold only **28 tUSD** of cash. Gross settlement is impossible: [`G1` Northwind cannot pay its 40 tUSD debt with 18](https://sepolia.etherscan.io/tx/0x7d86cdc9dca5a548c5eba0b2a3725466a467d09484f8a8bb04230421bef33b2c). Yet every one of them is solvent on a net basis.

`QEDClearing` lets **anyone** submit a netting, and executes it only if the contract can check that (1) every member's net position is exactly unchanged, (2) no debt is cut below zero and none is created, (3) the proof covers every open debt at its current amount, and (4) an **LP-duality certificate** proves no larger netting exists: Σx = Σd·y with π_debtor − π_creditor + y ≥ 1. The constraint matrix is totally unimodular, so the check is exact integer arithmetic: no tolerance. Joining is the only consent needed, and the QED agent can be a member *and* the prover without being able to favour itself. Theory: [docs/ALGORITHMS.md §9](docs/ALGORITHMS.md#9-certified-clearing-maximal-multilateral-netting-with-an-exact-proof-qedclearing).

| Step on Ethereum Sepolia | Result |
|---|---|
| [`N1` a naive shortest-cycle-first netting](https://sepolia.etherscan.io/tx/0x1b62ae8cbdd1fcaacda3f3305b880e75b504c712575389e7ad780c69c4724976) | reverted `NotProvablyMaximal(162, 169)` |
| [`N2` a netting that cancels 1 tUSD more of one member's debt](https://sepolia.etherscan.io/tx/0x29c4ef66a5eb98558fce184b0058cf295bc39e095e8eccf58ec6ba99172b3eaf) | reverted `NetPositionChanged(Northwind, 1)` |
| [`N3` cancel more than is owed](https://sepolia.etherscan.io/tx/0x96a304a4c3fbb50c325a43e983a61f5c02aa93f7da499b4eb1aec6aed77fbdfb) · [`N4` hide an obligation](https://sepolia.etherscan.io/tx/0xd6c3f25ca5f8f38664907cb3065a61c41b184e14e584c90747616ce6ece04c9c) · [`N5` forge the certificate](https://sepolia.etherscan.io/tx/0xa7d7e7bcb0303b4c3e7267e1c6d3de472f7ff1bb2a1bddf628de4ccfdeedef8a) | `ExceedsObligation` · `IncompleteSnapshot` · `DualInfeasible` |
| [`N6` the QED agent's proven netting](https://sepolia.etherscan.io/tx/0x46288ece141a762a1889eb8e4692b6a19719643b341e0dd31a1e4166c51a05a2) | **executed: 169 tUSD of debt cancelled, gross 200 → 31, no token moved** |
| [`N7` replay it](https://sepolia.etherscan.io/tx/0x4588659bad4770f283e3600885b6dabbb95e8b734fb5c27c14ac491acc2e4df5) | reverted `IncompleteSnapshot` |
| [`S1`](https://sepolia.etherscan.io/tx/0x8e6ffd33285277503602a5b46743e6acda21ce9f42270a76939feb916781358c)…[`S4`](https://sepolia.etherscan.io/tx/0xb69b59c99d14062acb126d36036f72850ed6671c45e11ba23bd0da04022aa654) the remaining 31 tUSD, paid in topological order | **0 debts left; every agent ends holding exactly its net position, using only the 28 tUSD that existed** |

Contracts: [`QEDClearing 0x7b7d…6ad2`](https://sepolia.etherscan.io/address/0x7b7de15772198d82d07019fc816cffc52e7d6ad2) · run token [`0x6753…52d4`](https://sepolia.etherscan.io/address/0x6753a8ea4560f07534bcfbca2dea790afb9552d4). Evidence: [`evidence/ethereum-sepolia/clearing/`](evidence/ethereum-sepolia/clearing/) (44 public receipts, 44/44 matched the replica).

## Reproduce

Requirements: Node 22, [Foundry](https://getfoundry.sh) (forge, anvil).

```bash
git clone --recursive https://github.com/Nightcore709/qed-agent-wallet && cd qed-agent-wallet
npm ci && forge build

forge test                      # 82 Solidity tests: unit, fuzz, stateful invariants with both hot keys stolen, 60 clearing economies
npm run test:ts                 # 45 TS tests: TS ≡ Solidity parity on a live node, solvers vs oracles, red-team corpus
npm run verify                  # re-derive every Sepolia claim (both runs) from a public RPC — no keys, ~2 minutes
QED_OFFLINE=1 npm run local     # run the whole autonomous economy on a local chain (deterministic brain, dev keys)
npm run local:clearing          # run the clearing economy on a local chain
npm run redteam                 # 32-case red-team corpus against the LLM alone and the guarded pipeline (needs ANTHROPIC_API_KEY)
```

Run the economy against a public network yourself: copy `.env.example`, fund the deployer, then
`RPC_URL=… CHAIN_ID=11155111 GAS_LIMIT=16700000 npm run live`. Deployment details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Test catalogue: [docs/TESTING.md](docs/TESTING.md).

## How the evidence was produced (full disclosure)

Our build sandbox had no RPC egress. Every transaction was signed inside the sandbox — one key per process — against a wall-clock-synchronised replica of Sepolia (same chain id, nonces and balances); the **identical signed bytes** were committed to [`relay/`](relay/) and broadcast unchanged by a browser relay, and each public receipt was compared with the replica's (status + every log): **55/55 matched** for the main run and **44/44** for the clearing run. Two earlier attempts under other keys failed (Sepolia's state-creation gas repricing; one under-provisioned agent transaction) and were abandoned; the canonical run uses fresh keys. Details: [docs/EVIDENCE.md](docs/EVIDENCE.md#how-these-transactions-were-produced--full-disclosure), risk K12 in [docs/SECURITY.md](docs/SECURITY.md).

## Repository map

```
contracts/src/          QEDVault · QEDLens · ProofEscrow · verifiers/MinVarianceVerifier · QEDClearing · TestUSD
contracts/test/         unit, fuzz and invariant tests (CompromisedAgentHandler holds both hot keys)
agent/src/roles/        agent · cosigner (12-check policy engine) · vendor · adversary
agent/src/brain/        LLM adapter · deterministic slot filling · deterministic guard (EN + 中文) · offline brain
agent/src/engine/       certifying min-variance solver · certifying netting solver (min-mean cycle cancelling) · economics
agent/scripts/          live (full economy) · clearing · local · verify (independent) · redteam · build-app · evidence-md
evidence/ethereum-sepolia/  manifest · public receipts · co-signer & agent decision records · honeypot keys · clearing/
relay/                  the exact signed transactions broadcast to Sepolia
app/ · site/            the QED Proof Ledger dashboard (GitHub Pages)
docs/                   ARCHITECTURE · ALGORITHMS · SECURITY · EVIDENCE · DEPLOYMENT · TESTING
```

## Status

Testnet prototype with a valueless token; not audited. Known risks are listed honestly in [docs/SECURITY.md §5](docs/SECURITY.md#5-known-risk-list-honest). MIT licence.
