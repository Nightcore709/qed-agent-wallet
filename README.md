# QED — proof-carrying autonomy for AI-agent wallets

**An autonomous on-chain wallet in which the AI is allowed to be wrong, manipulated or stolen — and the money is still safe, because every movement of money carries a proof the chain checks: who may pay, what may never be spent, whether paid work is optimal, whether a clearing is maximal, and whether a trade got the best price any route could.**

FinTechathon 2026 · International Track · Topic F — Autonomous On-chain Wallet ·
Live on **Ethereum Sepolia** · [Dashboard](https://nightcore709.github.io/qed-agent-wallet/) · [Docs index](docs/README.md) · [Evidence](docs/EVIDENCE.md) · [Security self-assessment](docs/SECURITY.md) · [Algorithms](docs/ALGORITHMS.md) · [Benchmarks](docs/BENCHMARKS.md) · [Prior art](docs/PRIOR_ART.md) · [Reproducibility](docs/REPRODUCIBILITY.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md) · [Talk, demo and video scripts](presentation/SCRIPT.md) · [Submission checklist](docs/SUBMISSION_CHECKLIST.md) · PDFs: [technical documentation](docs/pdf/QED-Technical-Documentation.pdf), [security self-assessment](docs/pdf/QED-Security-Self-Assessment.pdf), [execution evidence](docs/pdf/QED-Execution-Evidence.pdf), [pitch deck](presentation/QED-Pitch-Deck.pdf)

[![CI](https://github.com/Nightcore709/qed-agent-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/Nightcore709/qed-agent-wallet/actions/workflows/ci.yml) · Source of all 24 deployed contracts verified on [Sourcify](verification/README.md) (creation + runtime match)

---

## New: best execution, proved at the instant of the trade

An autonomous treasury must convert money as well as pay it: settle a euro invoice from dollars, sweep revenue into a
reserve. That is where an agent's discretion is largest and least visible. Wallets and intent standards bound it
with a minimum output, so a compromised or careless agent can leak up to the whole slippage tolerance on every trade.

In QED the agent may route a conversion however it likes, but it must attach **one price per token**. From those
prices and the live reserves of *every* venue the owner allows, `QEDExecution` computes, on-chain and in the same
transaction, a rigorous upper bound on what **any** route could have returned (weak Lagrangian duality for
constant-product markets, every rounding step upward). It then runs the agent's route, measures what actually
arrived, and refuses the trade if that is more than **1 ppm** below the bound. Every price vector yields a valid
bound, so a dishonest agent cannot forge a proof; it can only fail to produce one.
([§12](docs/ALGORITHMS.md#12-best-execution-proved-at-the-instant-of-the-trade-qedexecution),
[prior art](docs/PRIOR_ART.md): we found no system that checks the optimality of an executed route on-chain.)

| On Ethereum Sepolia (Run 4) | Result |
|---|---|
| [`E1` the agent converts 20 tUSD for the euro reserve over 4 venues and a two-hop path](https://sepolia.etherscan.io/tx/0x56f798cd321e0d85ba6a7b1425dd7b12f04db386a81bf0e67c94374f12f19690) | **18.086846 tEUR delivered; on-chain bound 18.086849: 0.17 ppm from the best possible route** |
| [`EA1` a compromised agent routes over the direct pools only: −33 bps, *above* the 1% floor](https://sepolia.etherscan.io/tx/0xccd07d1790d002a173435e216c80f0c305e3a10dd0c720548b38d50cd9b54937) | reverted `NotBestExecution` — a slippage-only wallet would have paid it |
| [`EA2` …skims 0.47 bps](https://sepolia.etherscan.io/tx/0xe9d68952a2c45513966c5b721a50dfb5f48c2aeab858b46a3a007364229f7b90) · [`EA3` …"forges" the prices](https://sepolia.etherscan.io/tx/0x0b4591467b610537b40a2cf6c3df504c0c46e11e16346ce1b148272409ef8472) | reverted `NotBestExecution` · `NotBestExecution` |
| [`EA4` strand the bridge token](https://sepolia.etherscan.io/tx/0x3a957099556e5e3e20ed29d602dda1c08d7305139a74d6d20d40754f596f4e58) · [`EA5` one pool, −118 bps](https://sepolia.etherscan.io/tx/0x565d52b6c9b507e4489bf2504dd64d634b4bf8cbb8c91b623c71127cf94415e1) · [`EA6` redirect to Mallory](https://sepolia.etherscan.io/tx/0x7e317abb6f9a431600627e1240f3f8743f8258a27591d69ef7c534ef1d5a7066) · [`EA7` no agent key](https://sepolia.etherscan.io/tx/0xf6423a13e09730be435232272f1bd46c58df539fde4bd725e4dbb9bf2c121545) | `Leftover` · `InsufficientOutput` · `OrderMismatch` · `NotOperator` |
| [`E2` the same co-signed order, honest route](https://sepolia.etherscan.io/tx/0xbd051424e52211d3d5997ffbcbf70e537931bf03b618dcc6d0e9e4d830d60e6f) | **accepted: 17.612720 of ≤ 17.612723 tEUR** |
| [`EA8` Mallory front-runs a signed order](https://sepolia.etherscan.io/tx/0xaa364d6493cd972e174a6f58302c6261b19478e893372d8eeed4eb75b36f16d1) | reverted `InsufficientOutput` by the co-signed floor; the agent then declines to trade into the moved market |
| [`XA1`](https://sepolia.etherscan.io/tx/0x05813963ca47b352664df1f66813e7f2c45aeb7636f45ed841b3287537246b4e)–[`XA3` claims on the 1,000 tUSD `ExecutionBounty`](https://sepolia.etherscan.io/tx/0xdc6140ae9fd9d562a9a929d9bc154ad91a690c3d38fe1a1f44b5c3cdd78ab3e2) | `TheoremHolds(output, bound)`: nobody has beaten the bound |

Across 1,000 random markets, routing policies without a proof fall a median **34–117 bps** short of the optimum,
and among routes that still clear a 1% floor, a hostile agent keeps a median 14–32 bps per trade. With the proof,
it keeps at most 1 ppm. For small trades in deep markets a good router is already within about 3 bps, so there the
benefit is the *guarantee*, not the average ([benchmarks](docs/BENCHMARKS.md)). The language layer reads the owner's
instruction (live model); the co-signer re-quotes independently and writes its own floor into the order; the vault
is unchanged and still enforces mandate, caps and solvency.

### The agent decides when and how much (Run 4c)

The owner signs one standing policy (EIP-191): *keep at least 45 tEUR free in the euro reserve; tranches of 2–25 tUSD;
at most 1.5% execution cost per tranche*. From then on nobody approves individual trades. The agent observes the
reserve, the treasury and every venue, and picks each tranche as the minimum of five quantities: the smallest input whose
certified output covers the shortfall, the largest input whose cost stays inside the impact limit, the policy cap, the
mandate cap and the free funds. The co-signer re-derives the same decision from the chain before it signs; the chain
then proves best execution of whatever is traded.

| On Ethereum Sepolia (Run 4c) | Result |
|---|---|
| `PA1` an over-eager agent asks for 25 tUSD at once | co-signer re-derives 19.535234 and refuses (P2, P3: 180 bps > 150 bps); no transaction |
| [`PE1` tranche 1, limited by market impact](https://sepolia.etherscan.io/tx/0xaaa0bacddd313493ff89f08f25f86b5f5eb294423b517bdf16c5489626a0c9ff) | 19.535234 tUSD → **16.816098 tEUR** (bound 16.816101, 0.18 ppm); reserve 20.70 → 37.52 |
| [`PE2` tranche 2, limited by need](https://sepolia.etherscan.io/tx/0xa9e90f580bb9f0457bfd8a966ec2c0322d877d6ea66e4f4aaabccd147d1aae35) | 8.835281 tUSD → **7.484336 tEUR** (bound 7.484339, 0.40 ppm); reserve **45.00**: target met |
| `T3` the agent observes again | shortfall 0: it sends nothing |

### The policy becomes a contract (Run 4d)

The co-signer is a second opinion, not a guarantee: if both hot keys were stolen, nothing above would stop a
"tranche" the reserve does not need. So the owner also states the policy on-chain. `QEDTreasuryPolicy` is now
`QEDExecution`'s only operator, and in the trade's own transaction it refuses a conversion when the reserve already
meets its target, when the tranche is outside the owner's bounds, when its cost exceeds κ against the direct venues'
mid price, or when **a smaller tranche provably covered the shortfall**. The last check solves nothing: the best
output OPT(x) is concave with OPT(0) = 0, so OPT(a') ≥ out·a'/a, and if that lower bound already reaches the target,
the agent over-converted ([§12.9](docs/ALGORITHMS.md#129-the-policy-as-a-contract-qedtreasurypolicy)).

| On Ethereum Sepolia (Run 4d) — the attacks hold **both** the agent key and the co-signer key | Result |
|---|---|
| [`QD3` the owner makes the policy contract the only operator](https://sepolia.etherscan.io/tx/0x9b4a8ef68ccbea527ccc8be860d564a1b46f10c242027e376f8c0b0c0b134f3b) | from here the agent's key trades only through `convert` |
| [`QA1` the agent's key calls `QEDExecution.trade` directly with a genuine co-signed order](https://sepolia.etherscan.io/tx/0x39093e1490228c609da03f081ad536dc017cf62ab598f6be72ad75a737844a9f) | reverted `NotOperator` |
| [`QA2` convert 14.93 tUSD when 11.94 covers the need, best-executed and co-signed](https://sepolia.etherscan.io/tx/0xb49d0c4f40dbeb6e66bc764ed96f3054e701be7d3e5932c03b3e6d72cd23f9f3) | reverted `OverConversion` |
| [`QA3` convert 25 tUSD into the thin market](https://sepolia.etherscan.io/tx/0xc5760e247bfe16526f5af00229ff56f333fb8ef5dd44b88a84f0c6c7ae8e2be9) | reverted `ExecutionCostTooHigh` |
| [`QE1` the agent's own need-limited tranche, through the policy](https://sepolia.etherscan.io/tx/0x12739525e1a11bdcc6921f0eef5dffa3ab1bcb63b9fcd5bc544dda24dbb341c8) | 11.943294 tUSD → **10.00 tEUR**; reserve 45.00 → **55.00** = target; every clause re-checked by `npm run verify` |
| [`QA4` one more tranche after the target is met](https://sepolia.etherscan.io/tx/0x2c68af035340391318a581625610fe2535d9de3284256e9be83e4e618ade245e) | reverted `NoShortfall` |

## The idea in eight sentences

1. **The AI holds one key that can call one function.** `QEDVault.executePayment` succeeds only with an owner-signed EIP-712 *mandate* **and** a certificate from an *independent co-signer* (a separate process, a separate key, 12 policy checks) **and** inside an on-chain *solvency invariant* that ring-fences money owed to creditors.
2. **Trades carry a proof of best execution, and the owner's objective is a contract.** `QEDExecution` refuses any conversion whose measured output is more than 1 ppm below the bound it computes, from live reserves, for every route through the owner's venues; `QEDTreasuryPolicy` lets the agent decide when and how much to convert, and refuses tranches the objective does not need. [Above.](#new-best-execution-proved-at-the-instant-of-the-trade)
3. **The worst case is computed, not hoped for.** `QEDLens.blastRadius(vault, horizon)` returns, at any block, the most the vault can lose if *both* hot keys are stolen — and the loss to any address the owner never approved is provably **zero**.
4. **AI work is paid for proofs, not promises.** In `ProofEscrow` a client pays only when the delivered answer passes an **on-chain optimality check** (exact-integer KKT conditions + a positive-semidefiniteness witness). A lazy or dishonest AI provider is rejected by mathematics and the client is refunded.
5. **We published the keys.** The honeypot vault's agent *and* co-signer private keys are in this repository. Its 90 tUSD ring-fence is protected by the contract, not by secrecy. [Try to steal it.](#steal-this-the-honeypot)
6. **Whole agent economies clear by proof.** In `QEDClearing`, five AI businesses that owe each other 200 tUSD but hold only 28 tUSD escape gridlock: the QED agent proves, with an exact linear-programming duality certificate checked on-chain, that its netting is the **largest possible** and leaves every member's net position unchanged. A lazy netting is rejected with `NotProvablyMaximal(162, 169)`. [Details below.](#certified-clearing-a-whole-agent-economy-settles-by-proof)
7. **Optimality, proven in zero knowledge.** Proving an AI decision correct has meant showing its inputs; confidentiality has meant not showing them. In QED Private the agent proves, in a Groth16 zk-SNARK verified on-chain, that its portfolio is optimal for a data model the vendor attested by commitment. The escrow that settled job #1 pays on that proof, and the chain never sees the model or the portfolio. A copied proof is useless: it is bound to its author. [Details below.](#qed-private-paid-for-a-proof-about-data-nobody-saw)
8. **Theorems with money on them.** Three contracts each hold 1,000 tUSD and pay it, automatically, to anyone who refutes on-chain the optimality theorem behind job #1, the maximality theorem behind the clearing house, or the best-execution bound. No judge: the contract checks the counterexample. Every attempt so far reverted with the gap it could not close. [Details below.](#theorems-with-money-on-them)

## The four outcomes — each one a public transaction

| # | Outcome asked for | Proof on Ethereum Sepolia |
|---|---|---|
| **O1** | A **separate AI-agent key** executes a payment under an **independent policy certificate** | [`L4 0x56a2334e…`](https://sepolia.etherscan.io/tx/0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6) — sent **by the agent key** `0x2A10…d0Bb`; mandate signature recovers to the **owner** `0xb7Ed…97f7`; certificate signature recovers to the **co-signer** `0xf1F8…2402`; on-chain `evidenceHash` = keccak256 of the [published decision record](evidence/ethereum-sepolia/records/cosigner/). Also [`C1 0x7000d3cc…`](https://sepolia.etherscan.io/tx/0x7000d3cc8dba8ebed99a2a9d43805b09b70a0ccbf0d33f484ad3fd044b675ee3): a chat request → clarified → corrected → owner-signed confirmation → certified payment. And [`E1`](https://sepolia.etherscan.io/tx/0x56f798cd321e0d85ba6a7b1425dd7b12f04db386a81bf0e67c94374f12f19690): the agent's operator key trades through `QEDExecution` under a co-signer certificate that commits to the order, with best execution proved on-chain. |
| **O2** | A **paid-work lifecycle** that ends in a **real escrow settlement** | Twice. **Private:** [`Z3` the same escrow pays 12 tUSD into QED's vault on a zero-knowledge proof of optimality](https://sepolia.etherscan.io/tx/0xbb619bf09eebacd240514eab5ec4a03c189612954101b07c59a11fa56f612ec7) for data the chain never sees. **Public:** RFQ → agent-signed quote → [`L2` client funds escrow, 15 tUSD](https://sepolia.etherscan.io/tx/0xa0546be0dc61e68e2f9b5ed2c1455dcb33bce6911ca762adae486f2a5f0646b9) → [`L4` agent buys the risk model it needs](https://sepolia.etherscan.io/tx/0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6) → solves → [`L6` delivers portfolio + KKT certificate, verified **on-chain**, 15 tUSD settles into the agent's vault](https://sepolia.etherscan.io/tx/0x4166253f06143b2a07b3c77fb4d4603a33e84f3b6706363f0d727f485f9335f9). Competing provider's lazy answer [`X17` rejected: `DualityGapTooLarge`](https://sepolia.etherscan.io/tx/0x5a6f26aca564583a77b0a0be3c65d830a5ef0e616591c1e5c4e755e1f6ec6481), near-miss [`X18` rejected: `StationarityViolated`](https://sepolia.etherscan.io/tx/0xc269055a7f1e1238e23814e5bc1c034d9bfa28dcd55f116766d7887be987f0fe), client [`X19` refunded](https://sepolia.etherscan.io/tx/0x014cb96984b48ea63495b4dec56471dd3a186757b3e07799b39f13876a144b83). |
| **O3** | An **adversarial agent cannot violate a protected liability or tamper with signed terms** | **19 attack transactions, all reverted on-chain with exactly the designed error** — tampered quote price/payee (`BadProviderSignature` ×2), forged/altered/redirected certificates (`BadCosignerSignature` ×3), both hot keys stolen paying the attacker (`PayeeNotInMandate`), self-signed mandate (`BadOwnerSignature`), replay (`IntentAlreadyUsed`), drain beyond free balance (`SolvencyViolation`), beyond the 24 h window (`ExceedsDailyCap`), admin calls (`NotOwner`, `NotCreditor`), published-key honeypot (×3), payment while paused (`VaultPaused`). Ring-fenced 70 tUSD reached **only** its creditor — [settled by the attacker's own address while the vault was paused](https://sepolia.etherscan.io/tx/0x9f4a753c58da0f5831d705973f9b0b5c484fa9baa68e47b8a7dc994a46a4135d). Full table: [docs/EVIDENCE.md](docs/EVIDENCE.md#attack-transactions-19--each-reverted-with-exactly-the-designed-error). Plus **6 attacks on the clearing house** and **8 on the private job and the bounties** (a copied zk proof, an understated variance, self-attested data, five refutation attempts), all reverted. Plus **11 on best execution** (a direct-only route and a 0.47 bp skim that a 1% slippage floor would allow, a "forged" proof, a stranded token, a redirected order, a front-run, three bounty claims) and **4 on the on-chain policy** with both hot keys stolen (bypass, over-conversion, excess cost, a tranche after the target). **48 attacks, 48 reverts, 0 tUSD to the attacker.** |
| **O4** | An **external reviewer can reproduce everything** from GitHub source, tests and receipts | `npm run verify` re-derives every claim from a public RPC with **no keys**: on-chain bytecode == this repo's compiled bytecode; every receipt's status and sender; every revert's custom error (replayed on archive state); signatures recovered from calldata; the KKT certificate re-checked off-chain; the netting certificate re-checked; the Groth16 proof re-verified with snarkjs and the vendor's attestation recovered; the best-execution bound recomputed from pre-trade reserves and the route replayed; every clause of the on-chain policy re-checked; all three bounty pools intact; Mallory received 0 tUSD. It runs in [CI](.github/workflows/ci.yml) on every push and daily, with all four economies and the benchmarks. 145 Solidity tests (unit, fuzz, stateful invariants ≈ 350 k adversarial calls/run, 60 random clearing economies, a real zk proof attacked 2,000 ways, routes and prices fuzzed against the bound 6,000 ways) + 60 TypeScript tests. A fresh machine reproduced all of it from a clean clone ([log](docs/TESTING.md#clean-clone-reproduction-log)). |

## What makes this different

| Usual agent wallet | QED |
|---|---|
| Spending limits on a hot key | Limits **plus** an independent co-signer **plus** a solvency invariant — three layers, each sufficient for protected funds |
| "The AI will follow its system prompt" | The AI is assumed compromised. Language model → deterministic slot filling → deterministic guard → owner-signed confirmation. Red-team: **25/25 attacks blocked, 0 false refusals** (LLM alone: 24/25) |
| Trust the provider's answer, or re-run it | **Verify a certificate**: the chain checks optimality in O(n²) exact integer operations instead of solving the problem |
| Risk = "we have limits" | Risk = a **number on-chain** (`blastRadius`), proven an upper bound by fuzzing, displayed live |
| Pause = everything stops | Pause stops the **AI**, never the **creditors** — anyone can settle a due liability, even while paused |
| Keys are the security boundary | Keys are **published** for the honeypot; the contract is the boundary |
| Verifying an AI's decision means exposing its data | **Zero-knowledge optimality**: the chain verifies the KKT certificate without seeing the data or the answer |
| "Trust our audit" | **Bounties the contract adjudicates**: refute the theorem on-chain and the contract pays you |
| Netting needs a trusted clearing house | **Anyone** can clear; the chain checks that the netting is maximal and moves no value (exact LP-duality certificate) |
| A slippage limit: the agent may leak up to 0.5–1% per trade | **Best execution proved per trade**: within 1 ppm of the best route through the owner's venues, checked on the state the trade executes on |

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
            │  QEDExecution — the vault's agent for trades; pays out only within 1 ppm of the best   │
            │                 route through the owner's venues (bound computed on-chain)             │
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

## QED Private: paid for a proof about data nobody saw

Helix sells a private-markets covariance model it may not publish; Northwind, a wealth-manager agent, wants the provably optimal allocation and does not want it public. Helix signs a **Poseidon commitment** to its model. QED solves the problem, then proves inside a **Groth16 zk-SNARK** (`circuits/private_minvar.circom`, 12,569 constraints) the full KKT certificate of §4 — stationarity, dual feasibility, complementary slackness, a convexity witness and an exact budget — over the committed data. `PrivateMinVarianceVerifier` checks Helix's attestation, binds the proof to its author and verifies it; it is just another `IProofVerifier`, so **the escrow deployed for job #1 settles the private job unchanged**. For reproducibility, this demo's synthetic model sits in `agent/src/engine/privateScenario.ts`; in production it would never leave Helix and the agent. Theory, constraints and trusted setup: [docs/ALGORITHMS.md §10](docs/ALGORITHMS.md#10-private-optimality-the-same-certificate-proven-in-zero-knowledge-privateminvarianceverifier).

| Step on Ethereum Sepolia | Result |
|---|---|
| [`Z1` Northwind funds job #3 in the original ProofEscrow](https://sepolia.etherscan.io/tx/0xed610de8e55518f91a3a8bb7dd3704a217b7146f5ad0d0a157d6cb265a7470b3) | 12 tUSD escrowed; the verifier is part of the signed terms |
| [`Z3` QED delivers the zero-knowledge proof](https://sepolia.etherscan.io/tx/0xbb619bf09eebacd240514eab5ec4a03c189612954101b07c59a11fa56f612ec7) | **verified on-chain; 12 tUSD paid into QED's vault; the model and portfolio never appear** |
| [`ZA1` Mallory replays QED's proof in her own job](https://sepolia.etherscan.io/tx/0xbe69abd9db0d21661c45e34dcbb8351363917c534b180196eaaae1a607e6d28e) | reverted `ProofRejected` (bound to QED) |
| [`ZA2` Mallory claims a lower variance](https://sepolia.etherscan.io/tx/0x95426566e07412babb0c55ffa3d8668e7fd1f02c80d69308bfa714755c599431) | reverted `ProofRejected` |
| [`ZA3` a genuine proof about data Mallory attested herself](https://sepolia.etherscan.io/tx/0x35bbaa47631852c780312e00431e77d28decb6bce43b5d8621f22fb2582625b7) | reverted `UntrustedDataAttestation` |

## Theorems with money on them

`OptimalityBounty` and `MaximalityBounty` each hold **1,000 tUSD** and pay all of it to anyone who refutes, on-chain, the theorem QED's money depends on: a certificate the deployed `MinVarianceVerifier` accepted plus a strictly better portfolio (beyond the proven bound), or a netting larger than one `QEDClearing` accepts as maximal. The contracts check the counterexample in exact integers and pay with no human involved. Tests prove the payout path works against an unsound verifier and an under-reporting rule; on Sepolia every attempt reverted:

| Attempt | Result |
|---|---|
| [`BA1` equal-weight portfolio vs job #1](https://sepolia.etherscan.io/tx/0x6a5849455a07b9fcf279d197b1ad2fe0de8d8b7d260328f54150c138b028d19d) · [`BA2` QED's optimum shifted 0.1%](https://sepolia.etherscan.io/tx/0xb9fbcad2715fa9675736bae047f69823abb1bbb1def5d0d973a0c0cb9fd9e059) | `TheoremHolds(advantage, bound)` |
| [`BA3` the forged certificate from job #2](https://sepolia.etherscan.io/tx/0x68e498bb76868c4caa1d48b98c0c8c1f5fdb0213122e73c37f24af7de2501c35) | `DualityGapTooLarge` (the verifier refuses it first) |
| [`BM1` the naive 162 tUSD netting](https://sepolia.etherscan.io/tx/0x47ef93bf3c1a6eea445dc7f0c1b6ccc4c013105c49da0b508130db38f06562bb) · [`BM2` a 170 tUSD netting](https://sepolia.etherscan.io/tx/0xd5124345468035c6409bcde3792f11ed994c062ba019d18bcb40744f8685af2a) | `TheoremHolds(169, 162)` · `NetPositionChanged` |

`npm run verify` checks daily that both pools are still full. [docs/ALGORITHMS.md §11](docs/ALGORITHMS.md#11-theorems-with-money-on-them-optimalitybounty-maximalitybounty).

## Reproduce

Requirements: Node 22, [Foundry](https://getfoundry.sh) (forge, anvil).

```bash
git clone --recursive https://github.com/Nightcore709/qed-agent-wallet && cd qed-agent-wallet
npm ci && forge build

forge test                      # 145 Solidity tests: invariants with both hot keys stolen, 60 clearing economies, a real zk proof attacked, best-execution soundness fuzzers, bounties
npm run test:ts                 # 60 TS tests: TS ≡ Solidity parity on a live node, solvers vs oracles, routing duality (weak: 12,000 route–price pairs; strong: 300 markets), treasury policy, zk prover, red-team corpus
npm run verify                  # re-derive every Sepolia claim (all four runs) from a public RPC — no keys
npx tsx benchmarks/run.ts       # B1–B5 benchmarks and ablations, deterministic (docs/BENCHMARKS.md)
QED_OFFLINE=1 npm run local     # run the whole autonomous economy on a local chain (deterministic brain, dev keys)
npm run local:clearing          # run the clearing economy on a local chain
npm run local:private           # zero-knowledge job + theorem bounties on a local chain
QED_OFFLINE=1 npm run local:execute   # best-execution economy: 5 venues, 2 conversions, 8 attacks, a front-run, the standing policy,
                                      # then the policy as a contract with 4 attacks (dev keys; reproduces Runs 4c and 4d to the raw unit)
npm run zk:setup                # re-run the Groth16 trusted setup from the circuit (circom 2.2)
npm run redteam                 # 32-case red-team corpus against the LLM alone and the guarded pipeline (needs ANTHROPIC_API_KEY)
```

Run the economy against a public network yourself: copy `.env.example`, fund the deployer, then
`RPC_URL=… CHAIN_ID=11155111 GAS_LIMIT=16700000 npm run live`. Deployment details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Test catalogue: [docs/TESTING.md](docs/TESTING.md).

## How the evidence was produced (full disclosure)

Our build sandbox had no RPC egress. Every transaction was signed inside the sandbox — one key per process — against a wall-clock-synchronised replica of Sepolia (same chain id, nonces and balances); the **identical signed bytes** were committed to [`relay/`](relay/) and broadcast unchanged by a browser relay, and each public receipt was compared with the replica's (status + every log): **55/55 matched** for the main run, **44/44** for the clearing run, **24/24** for the private run and **73/73** for the best-execution runs: **196 transactions in all** (Runs 4b and 4c first replayed the earlier runs' signed bytes on the replica, so its state was Sepolia's). Two earlier attempts under other keys failed (Sepolia's state-creation gas repricing; one under-provisioned agent transaction) and were abandoned; the canonical run uses fresh keys. Details: [docs/EVIDENCE.md](docs/EVIDENCE.md#how-these-transactions-were-produced--full-disclosure), risk K12 in [docs/SECURITY.md](docs/SECURITY.md).

## Repository map

```
contracts/src/          QEDVault · QEDLens · QEDExecution · ProofEscrow · QEDClearing · TestUSD
                        venues/    CPMMPool (Uniswap-V2 interface) · TestToken
                        verifiers/ MinVarianceVerifier · PrivateMinVarianceVerifier · zk/Groth16Verifier (generated)
                        bounties/  OptimalityBounty · MaximalityBounty · ExecutionBounty
circuits/               private_minvar.circom (Groth16) · setup.sh · ceremony transcript · proving and verification keys
contracts/test/         unit, fuzz and invariant tests (CompromisedAgentHandler holds both hot keys)
agent/src/roles/        agent · trader (best-execution planning) · treasury (standing policy, tranche rule) · cosigner (12 payment checks, 14 trade and policy checks) · vendor · adversary
agent/src/brain/        LLM adapter · deterministic slot filling · deterministic guard (EN + 中文) · offline brain
agent/src/engine/       certifying min-variance solver · certifying netting solver (min-mean cycle cancelling) · best-execution solver (dual prices, route, bound replica) · zk prover · economics
agent/scripts/          live (full economy) · clearing · private · execute · execution-bounty · execute-policy · local · verify (independent) · redteam · build-app · evidence-md
benchmarks/             run.ts → results.json (B1–B5)
evidence/ethereum-sepolia/  manifest · public receipts · co-signer & agent decision records · honeypot keys · clearing/ · private/ · execution/
relay/                  the exact signed transactions broadcast to Sepolia
app/ · site/            the QED Proof Ledger dashboard (GitHub Pages)
docs/                   index (README) · ARCHITECTURE · ALGORITHMS · PROTOCOL_SPECIFICATION · SECURITY · BENCHMARKS · PRIOR_ART · EVIDENCE · DEPLOYMENT · TESTING · REPRODUCIBILITY · KNOWN_LIMITATIONS · SELF_REVIEW · SUBMISSION_CHECKLIST
presentation/           SCRIPT (10-minute talk + demo) · JUDGE_QA
```

## Status

Testnet prototype with a valueless token; not audited. The Groth16 parameters come from a local ceremony and must be treated as trusted (risk K18). Known risks are listed honestly in [docs/SECURITY.md §5](docs/SECURITY.md#5-known-risk-list-honest), and our own audit, adversarial review and quality gates are in [docs/SELF_REVIEW.md](docs/SELF_REVIEW.md). MIT licence, except `contracts/src/verifiers/zk/Groth16Verifier.sol`, which snarkjs generates under GPL-3.0 ([attributions](ATTRIBUTIONS.md)).
