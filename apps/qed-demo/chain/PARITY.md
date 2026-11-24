# Parity register: what the chain rail delivers of F-001 … F-086

Baseline: `docs/research/qed-systems-architect/20261118-release-feature-baseline.md` §7.1 (86 rows). This file covers
the rail only (`apps/qed-demo/chain/`). **The one mapping for the product is `../CAPABILITIES.md`**: it has the
wallet's side of every row and takes its Rail word from the status below; a check run by the wallet's tests fails
if the two disagree. This file is the rail's detail that mapping refers to, test by test. Rows that belong to the backend or the interface are listed too, so that
nothing is silently missing, and say what the rail supplies for them.

**Status words.** The status of a row is the first words of its last cell, one of six. *Verified*: a test ran it on a
real local Anvil chain with the release's unmodified contracts and passed; the Evidence cell names the test, and what
follows the word narrows the claim where it must. *Partly*: part is verified, the rest is named in the row. *Not
done*: nothing on the rail. *Awaiting owner decision*: the baseline's own disposition; what exists is stated.
*Backend* or *Interface*: not the rail's to deliver; what the rail hands over is stated. The owner's rule applies:
placeholders and descriptive cards do not establish parity; a row is Verified only if something ran.

**How to read the Evidence column.** `` `core.test.ts` › "conversion: the eight visible steps" `` is the test of this
package (`test/`) whose title starts with the quoted words. A file without a quote means every test in it. "gate
`QEDVault.t.sol` 36/36" is a suite of the release, run unmodified in a disposable copy of `vendor/` by the first
parity gate (`results/PARITY-GATE.md`, raw output under `results/gate/`). `scripts/parity-counts.mjs` checks that
every Verified row names a test and that every named test exists; `npm test` runs that check.

Nothing here was run against a public chain, the public URL or a model. No vendored file is modified
(`VENDORED.json`, `"modified": []`). **Counts** and how the register was checked are in the last two sections.

## A. Agent and intent

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-001 | `validateToolCall` (registry), `checkExplicitAmount` (the owner's number governs), durable proposals with a terms hash. The model call and the conversation are the backend's | `language.test.ts` › "(b) a model-proposed tool call is validated"; `core.test.ts` › "the approval must carry the hash of the exact terms" | Partly: rail part verified; no model was ever called |
| F-002 | `parseOffline`, engine always `offline-deterministic`; the rail's own conversion step uses it and labels it | `language.test.ts` › "(c) the labelled offline parser proposes" and › "plain Node, no loader: the 32-case red-team corpus" (every case labelled); `core.test.ts` › "conversion: the eight visible steps" (the label on the language step and on the stored trade); `service.test.ts` › "the language layer over HTTP" | Verified |
| F-003 | The release's guard, unmodified, importable on plain Node; `screenMessage` with the fixed refusal text | `language.test.ts` › "plain Node, no loader: the 32-case red-team corpus" (25 of 25 attacks refused, 7 of 7 benign allowed) and › "(a) the guard runs before any model call" (the release's text, English and Chinese); gate `guard.test.ts` 35/35 | Verified |
| F-004 | `GET /limits`, `/maximum`, `/quote` create no job and sign nothing; `isQuestion` exported | `core.test.ts` › "limit check and maximum: one function" (80 tUSD: allowed false, no job, balance unchanged); `language.test.ts` › "(a) the guard runs before any model call" (`isQuestion`) | Verified for the read-only routes; classifying chat messages is the backend's |
| F-005 | `GET /quote` with `source` (provider, instrument, price type, block, source time, receipt time, freshness) | `core.test.ts` › "read-only quote carries its source and freshness" | Partly: a displayed quote is not marked stale later; the rail re-plans at execution instead |
| F-006 | The nine tools with exact schemas, from the release's file | `language.test.ts` › "(b) a model-proposed tool call is validated"; `service.test.ts` › "the language layer over HTTP" (nine tools over the route); gate `capabilities.test.mjs` 3/3 | Verified |
| F-007 | One-use proposals, ten-minute expiry, bound to the chain's genesis id and to the terms hash; `isChatConsent` exported | `core.test.ts` › "the approval must carry the hash of the exact terms" (hash, one use, a replayed approval); `integrity.test.ts` › "a proposal expires" (expiry, cancellation, and a proposal that carries another chain's id: `proposal_stale`); `language.test.ts` › "(a) the guard runs before any model call" (`isChatConsent`) | Verified for hash, one use, expiry and genesis. Binding to the requester is the backend's (the rail has one client) |
| F-008 | The release's lexer. (`runConvert` also compares the amount it reads at execution with the approved terms; no test falsifies that comparison on its own) | `language.test.ts` › "the exact amount lexer, formatting without floating point"; `core.test.ts` › "limit check and maximum: one function" (eight malformed amounts refused); gate `amount-parsing.test.mjs` 9/9 | Verified for the lexer and its refusals |
| F-009 | `POST /proposals/:id/cancel`; a newer proposal of the same kind replaces the older; `isCancel` exported | `integrity.test.ts` › "a proposal expires" (cancel); `core.test.ts` › "the approval must carry the hash of the exact terms" (replacement) | Backend (conversation). Building blocks only |
| F-010 | `GET /maximum`: the smallest remaining amount over every limit | `core.test.ts` › "limit check and maximum: one function" (25); `admin.test.ts` › "pause stops the agent and zeroes the worst-case figure" (0 when paused); `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (20.876544 once funds are ring-fenced) | Verified |
| F-011 | The ten knowledge topics and `identifyKnowledgeTopic` exported | `language.test.ts` › "the exact amount lexer, formatting without floating point" (topics) | Partly: topics only. The grounded explainer (`agent-chat.mjs`) is vendored but not wired; the backend owns explanations |
| F-012 | Each action is its own proposal by construction | — | Backend (splitting a compound request) |
| F-013 | The rail labels its own engine; it never calls a model | — | Backend |

## B. Authority and custody

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-014 | The release's EIP-712 mandate, thirteen fields, all readable (`GET /state`, `/mandates`) | `core.test.ts` › "mandate: thirteen fields readable" (fields, digest equals `QEDLens.hashMandate`, signer recovered); gate `parity.test.ts` 1/1; `workspaces.test.ts` › "owner actions need a valid passkey assertion", › "no key the service holds can sign for the owner account" and › "two workspaces cannot read or move each other's funds" (a mandate signed by the passkey through ERC-1271, certified by the forked co-signer) | Verified for every workspace created with `POST /workspaces` (R7, 22 Nov 2026): the correction "a key the server does not hold" is achieved there. The owner is a passkey account (`chain/accounts`); the rail holds no key that can satisfy it and checks every passkey signature on chain before it relays. The baseline-parity workspace keeps the release's development owner key in the rail, for the parity tests only (RISK-040) |
| F-015 | Contract limits unmodified; the preview lists every limit with usage and what remains | `core.test.ts` › "mandate: thirteen fields readable" (usage per limit) and › "limit check and maximum: one function" (eight rules; 25 allowed, 25.000001 refused by name); `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (free balance less the buffer, to the unit) and › "payment from the main treasury (F-030)" (earned allowance, to the unit); gate `QEDVault.t.sol` 36/36 | Verified for the listing, and one unit over for three limits. One unit over the period, lifetime and daily caps is shown by the release's contract tests only. The fixed-window caveat is in the usage text, which no test reads |
| F-016 | `pause`, `guardian-pause`, `resume`, `revoke-mandate`, `void-all`, `rotate-key`; a new mandate revokes the old one on-chain; unsent work is refused | `admin.test.ts` (all three tests); `core.test.ts` › "mandate supersession: signing v2 revokes v1 on-chain"; `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (a due liability still settles while paused) | Verified. In a passkey workspace (R7) the owner account's guarded calls (co-signer, operator, agent, venues, daily cap, ownership, policy) are scheduled behind its delay and cancellable by any one member (`workspaces.test.ts` › "guarded calls"); pause, resume, revoke, void-all, the guardian's setter and withdrawals stay immediate. No notice to the members of a pending change (W-14 partly done) |
| F-017 | Contract unmodified; certificates from the release's co-signer | gate `sandbox-clock.integration.mjs` 3/3 (inclusive window, forged, replayed); `scenarios.test.ts` › "each scenario runs on real contracts" (replay `IntentAlreadyUsed`); `treasury-ops.test.ts` › "payment from the main treasury (F-030)" (a genuine certificate replayed on the main vault: mined as `IntentAlreadyUsed`); `cosigner-process.test.ts` › "the co-signer is another process with its own random key" (forged: `BadCosignerSignature`) | Verified |
| F-018 | Co-signer as a separate process with its own key (default); durable replay set and policy state; every verdict stored after its hash is checked against the certificate; one failing case per check | `cosigner-process.test.ts` › "the co-signer is another process with its own random key"; `cosigner-checks.test.ts` (both tests); `checks-alone.test.ts` › "the rail's engine (D-K4a): P1, P2 and P3 each fail alone"; `policy.test.ts` › "the co-signer refuses an over-sized tranche (P2)" (P0 across a restart); `persistence.test.ts` › "service restart: balances, mandate usage" (a nonce certified before the restart is refused after it, C6 alone) | Partly: verified as listed. C1, C2, C3 in its three forms, C4 to C12, C9b, T2 and P2 each fail alone with a stored refusal record whose hash matches. In the release's engine (the baseline's) T1, P1 and P3 fail only together with T2, P2 and P2, and T3 cannot fail on a chain: that is the release's own logic, shown in the test. In the rail's engine (every workspace's, decision D-K4a, R13) each of T1, T2, T3, P1, P2 and P3 fails alone on a real chain, with T3 now comparing the venue-set hash with the venues read; on generated markets P1∧P2∧P3 is the release's verdict (`checks-alone.test.ts`). Not done: the checker runs the same solver as the maker (no independently written logic, W-08) |
| F-019 | Approval `{approvalId, docHash, termsHash, confirmedAt, method}`; the signer recomputes the hash of what it signs | `core.test.ts` › "the approval must carry the hash of the exact terms" (wrong hash, replay) and › "the terms a proposal shows are exactly what is signed" (tampered terms) | Verified for the binding. Authenticating the owner is the backend's |
| F-020 | Contract unmodified | gate `Invariants.t.sol` 8/8; `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (`SolvencyViolation` with both figures on the main vault) | Verified on the rail by the release's suite. The ledger invariant is the backend's |
| F-021 | On the **main** treasury: `ring-fence` proposal (owner), `GET /liabilities`, `POST /liabilities/:id/settle` (anyone, when due, also while paused). Also the `liability` scenario | `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (70.123456 ring-fenced; the owner cannot withdraw or release it, the agent cannot release or spend it; settled to CloudCo when due while the guardian's pause holds; not paid twice) and › "over HTTP with the co-signer in its own process"; `scenarios.test.ts` › "each scenario runs on real contracts" (70.123456 and 95) | Verified. `release` and `assign` are the creditor's own calls and are not rail operations (the release's `QEDVault.t.sol` in the gate) |
| F-022 | On the **main** treasury: `pay` with `dueInDays` (1 to 365). The vault ring-fences the amount under the mandate and a certificate | `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (4 tUSD: nothing leaves, free funds fall and every cap counts it at creation; paid on the due date by `settle`, with no approval) and › "over HTTP with the co-signer in its own process" | Verified. Due dates are whole days |
| F-023 | Reserve vault deployed with a zero cap | `core.test.ts` › "deploys the release's contracts from embedded bytecode" (cap 0); gate `Invariants.t.sol` 8/8 | Verified for the zero cap on the rail; the refusal of an agent payment from the reserve is shown by the release's suite |
| F-024 | `worstCaseLoss24h` from `QEDLens`, with `worstCaseScope` saying what it does not cover | `admin.test.ts` › "pause stops the agent and zeroes the worst-case figure": 100, 90 (partly used), 0 (paused), and the scope text | Verified. Not extended to market leakage (W-09) |
| F-025 | `guardian-pause`, sent by the guardian's key | `admin.test.ts` › "pause stops the agent and zeroes the worst-case figure" (cannot resume: `NotOwner`); `treasury-ops.test.ts` › "forward payment and owner ring-fence (F-021, F-022)" (settlement still works under the guardian's pause) | Verified |
| F-026 | On the **main** treasury: `withdraw` and `deposit` proposals, to and from the owner's own account only | `treasury-ops.test.ts` › "deposit and withdrawal (F-026)" and › "forward payment and owner ring-fence (F-021, F-022)" (above the free balance: refused by the rail with both figures, and `SolvencyViolation(25876545, 25876544)` by the vault itself); `recovery.test.ts` › "treasury operations killed mid-way"; gate `QEDVault.t.sol` 36/36 | Verified for deposit and withdrawal. The two-step transfer of ownership is not a rail operation (the release's contract test only) |
| F-027 | Contract unmodified | gate `QEDVault.t.sol` 36/36 (ERC-1271) | Verified by the release's test; not used on the rail |
| F-028 | `mandate` proposal: 1 to 100 tUSD, plus per-day, lifetime and validity | `core.test.ts` › "mandate: thirteen fields readable" (0.5 and 101 refused) and › "mandate supersession: signing v2 revokes v1 on-chain"; `policy.test.ts` › "stop conditions: the tick limit" (per-day and lifetime limits) | Verified |
| F-029 | One limits function for preview, conversion, payment and policy ticks | `core.test.ts` › "limit check and maximum: one function" and › "over the signed limit: refused before any signature"; `policy.test.ts` › "stop conditions: the tick limit" (tick refused by name); `treasury-ops.test.ts` › "payment from the main treasury (F-030)" (preview and co-signer refuse the same unit) | Verified |

## C. Spend

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-030 | On the **main** treasury: `pay` proposal. The owner's signed instruction, the co-signer's certificate (the release's eight payment checks), `QEDExecution.pay` sent by the operator key. Also the `payment` scenario | `treasury-ops.test.ts` › "payment from the main treasury (F-030)" (3.123456 reaches only CloudCo; a replay is mined as `IntentAlreadyUsed`; an unlisted payee is refused by the rail, by C9 and by the vault) and › "over HTTP with the co-signer in its own process"; `recovery.test.ts` › "treasury operations killed mid-way"; `scenarios.test.ts` › "each scenario runs on real contracts"; `authority-rail.test.ts` › "after a conversion of 10 tINR" (a passkey workspace) | Verified, within one limit, the co-signer's C12. In the baseline-parity workspace it is the release's own rule: 10 tUSD plus half of escrow revenue, conversions counted as spend; the main treasury has no escrow, so payments stop once conversions and payments together reach 10 tUSD. In a workspace it is the authority budget of R7 decision D7 (`README.md` › "Amounts in a workspace"): after a conversion of 10 tINR a payment still executes, and what is beyond the budget is refused. Unavailable while a contract-enforced policy is wired (W-12) |
| F-031 | Inside the `economy` script. The rail certifies no purchase on the main treasury: it has no vendor registry, price list or escrow there | `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts"; `cosigner-checks.test.ts` › "owner-instructed payments: C1, C2, C3, C6, C9, C10, C11 and C12 each fail alone" (its purchase half: C3 to C8, on the unmodified engine with a registry, a price list and a funded escrow job that the test supplies) | Partly: scripted. Each of C3 to C8 has a failing case that is refused and recorded, on the engine and not through a rail operation |
| F-032 | Inside the `economy` script (steps C1, C2) | `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts" | Partly: scripted; the live conversation is the backend's |
| F-033 | Co-signer deny-list: one entry, the attacker's address, fixed in code | `cosigner-checks.test.ts` (C11 fails alone, for a payment and for a conversion, with a payee that the mandate lists); `core.test.ts` › "conversion: the eight visible steps" (11 checks in every verdict) | Verified for the check. The list has no source or date and cannot be configured |
| F-034 | Co-signer check C12: the release's, unmodified, in the baseline-parity workspace, shown in the `pay` preview as `earned-autonomy`; in a workspace the authority budget of R7 decision D7 (`rail/authority-ledger.ts`, through the fork's generator), shown as `authority-budget` with the co-signer's own figures | `treasury-ops.test.ts` › "payment from the main treasury (F-030)" and `cosigner-checks.test.ts` › "owner-instructed payments: C1, C2, C3, C6, C9, C10, C11 and C12 each fail alone" (one unit above the allowance: C12 alone; exactly the allowance: accepted); `authority.test.ts` › "cross-implementation fixtures"; `authority-rail.test.ts` › "after a conversion of 10 tINR" and › "earnings:" | Partly: the release's refusal is verified to the unit; its allowance rising after a job settles is not tested, the baseline-parity treasury having no escrow to settle into. In a workspace the authority budget is verified on the chain to the unit, an outside client's escrow job raising it after two confirmations and self-dealt ones not; its figures (B0 10 tINR, rate ½, a ±0.5% fixed band) await the owner's confirmation, and the wallet does not show grants yet |
| F-035 | Inside the `economy` script | `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts" | Partly: scripted |

## D. Save and treasury

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-036 | Treasury vault (tUSD) and reserve vault (tEUR) | `core.test.ts` › "deploys the release's contracts from embedded bytecode" | Verified |
| F-037 | Conversion job: the eight steps, receipt, reconciliation, `doNotRetry` | `core.test.ts` › "conversion: the eight visible steps"; `integrity.test.ts` › "an injected reconciliation mismatch" | Verified on the rail. Live market data and paper execution are the backend's |
| F-038 | `QEDExecution` unmodified | gate `QEDExecution.t.sol` 28/28; `core.test.ts` › "Security Lab: each of the six attacks" and › "conversion: the eight visible steps" (output within the order's tolerance) | Verified |
| F-039 | The rail claims the bound for constant-product pools only | — | Awaiting owner decision |
| F-040 | The release's co-signer; each order's floor and tolerance are in the job and in `lastTrade` | `core.test.ts` › "conversion: the eight visible steps"; `cosigner-checks.test.ts` › "conversions: C1, C2, C3, C6, C9, C9b, C10, C11, T2 and P2 each fail alone" (the mid-price screen alone, at 90 tUSD) | Partly: floor and tolerance are known only **after** approval (the co-signer sets them); no external reference price (W-09) |
| F-041 | The owner names the venues at provisioning and can name a new set later out of the five deployed pools (`venues` proposal). Before provisioning the planned set is in `plannedVenues` | `treasury-ops.test.ts` › "venue set (F-041)" (an order signed before the change is mined as `VenueSetChanged`; conversions go on over the new set); `core.test.ts` › "the approval must carry the hash of the exact terms" (five venues named at provisioning); gate `QEDExecution.t.sol` 28/28 (fee cross-check) | Verified. The Security Lab is unavailable while the named set is not the five |
| F-042 | The release's planner; the plan's bound must equal `quoteBound` or it throws; three baselines listed | `core.test.ts` › "read-only quote carries its source and freshness" (three baselines) and › "parity with the release's own Sandbox class" (the same bound and route); gate `execution.test.ts` 6/6 | Verified |
| F-043 | `policy` proposal, `POST /policy/tick` for a scheduler, five candidates stored, `policy-revoke` | `policy.test.ts` › "the owner signs the policy text once", › "a tick: observe, decide with five candidates" and › "the co-signer refuses an over-sized tranche (P2)" (revocation); gate `treasury.test.ts` 4/4 | Verified for the rail. The scheduler itself is the backend's |
| F-044 | The release's co-signer | `policy.test.ts` › "the co-signer refuses an over-sized tranche (P2)"; `cosigner-checks.test.ts` › "conversions: C1, C2, C3, C6, C9, C9b, C10, C11, T2 and P2 each fail alone" (one unit above its own tranche: P2 alone) | Verified |
| F-045 | `enforcement: "contract"`: unmodified `QEDTreasuryPolicy` wired by the owner; zero slack refused | `policy-contract.test.ts` › "contract-enforced policy: wired by the owner"; gate `QEDTreasuryPolicy.t.sol` 13/13 | Verified, with one limit: while wired, direct conversions and payments are unavailable; they return when the policy ends. A savings policy and other payments do not coexist. The Security Lab is no longer affected: it runs on an ephemeral chain of its own (R7) |
| F-046 | `POST /policy/run` with stop conditions | `policy.test.ts` › "run until the target is met, on the server" and › "stop conditions: the tick limit" | Verified |
| F-047 | `lastTrade` with route per hop, price vector, alternatives; venues with reserves | `core.test.ts` › "conversion: the eight visible steps" and › "parity with the release's own Sandbox class" (hops, prices, venues) | Verified (data). The screen is the interface's |

## E. Earn, F. Grow, G. Coordination

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-048 | The release's pricing engine; a signed quote inside the `economy` script | gate `engine.test.ts` 6/6; `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts" | Verified (engine, by the release's suite); scripted (quote) |
| F-049 | `ProofEscrow` unmodified; the `portfolio` scenario | `scenarios.test.ts` › "each scenario runs on real contracts" (7.123456 paid, escrow 0); gate `ProofEscrow.t.sol` 13/13 | Verified |
| F-050 | Unmodified solver and verifier | gate `MinVarianceVerifier.t.sol` 12/12; gate `engine.test.ts` 6/6 | Verified by the release's suites |
| F-051 | The `portfolio` scenario at its bounds | `scenarios.test.ts` › "input bounds are the release's" and › "each scenario runs on real contracts" | Verified |
| F-052 | Optional directory `zk-optional/`, off by default; nothing GPL-3.0 in the default package except the embedded verifier bytecode in the release's own `contracts.ts` | `zk.test.ts` 3/3 with the tier enabled on this machine (2 of the 3 are skipped otherwise); gate tier `full` | Awaiting owner decision. Built and verified as an optional module |
| F-053 | The `economy` script, unmodified | `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts" (the bundled Run 1 step ids) | Verified |
| F-054 | Only the certified computation on synthetic inputs | — | Awaiting owner decision |
| F-055 | `QEDClearing` unmodified; the `clearing` scenario | `scenarios.test.ts` › "each scenario runs on real contracts" (21.75 cleared, none open); gate `QEDClearing.t.sol` 15/15; gate `netting.test.ts` 3/3 | Verified |
| F-056 | Inside the scenario, which fails unless final balances equal net credits | `scenarios.test.ts` › "each scenario runs on real contracts" (the release's own check ran and the scenario completed) | Verified |
| F-057 | The `clearing` script, unmodified | `economies.test.ts` › "clearing economy: one at a time, a step stream" (169 of 200, naive 162, 31 settled) | Verified |

## H. Assurance, evidence and service

| ID | How the rail delivers it | Evidence | Status |
|---|---|---|---|
| F-058 | Six attacks from a genuine order; plus on the rail: approval replay, proposal reuse, revoked authority, duplicate submission | `core.test.ts` › "Security Lab: each of the six attacks", › "the approval must carry the hash of the exact terms" (approval replay, proposal reuse) and › "conversion: the eight visible steps" (duplicate submission); `admin.test.ts` › "revoke one mandate, then void all" (revoked authority); `hazards.test.ts` (the attacks run on ephemeral chains while another workspace transacts) | Verified for the rail. Since R7 every attack runs on an ephemeral chain of its own, seeded with the release's contracts and throwaway keys; nothing on the shared chain is attacked. Attacks on the backend are the backend's |
| F-059 | Unmodified bounties; challenges inside three scenarios | gate `Bounties.t.sol` 11/11; `scenarios.test.ts` › "each scenario runs on real contracts" (`TheoremHolds`) | Verified |
| F-060 | The script's honeypot runs with development keys; the Sepolia key files are not in the workspace; the script's own key file is deleted after the run | `economies.test.ts` › "paid-work economy: 47 steps and 19 reverts" (H3 mined, H4 to H6 reverted, no key file) | Awaiting owner decision |
| F-061 | The corpus in the automated suite; the saved report vendored | `language.test.ts` › "plain Node, no loader: the 32-case red-team corpus"; gate `guard.test.ts` 35/35 | Verified offline. A run with a real model was not done |
| F-062 | Hash-chained, append-only decision records: owner actions, co-signer verdicts, refused approvals, policy decisions, clock events; attempts journaled before submission | `core.test.ts` › "decision records are hash-chained and append-only" and › "the approval must carry the hash of the exact terms" (refusals recorded); `integrity.test.ts` › "an altered decision record breaks the hash chain"; `recovery.test.ts` (the attempt journal decides both tests); `clock.test.ts` › "machine sleep between two heartbeats" (clock event recorded) | Verified |
| F-063 | `verify.ts` listed in the optional tier; never run | — | Awaiting owner decision |
| F-064 | `GET /evidence`: 161 transactions, 24 contracts, every row `HISTORICAL` | `scenarios.test.ts` › "historical evidence index" | Verified (index). The screen is the interface's; the static ledger page is not vendored |
| F-065 | Receipts and history in SQLite | `persistence.test.ts` › "service restart: balances, mandate usage" | Verified for the rail. Per-owner scoping is the backend's |
| F-066 | Mandatory key, stored with the request hash; lookup by key | `core.test.ts` › "conversion: the eight visible steps" (same key: same job; another body: conflict); `service.test.ts` › "an owner journey over HTTP" (lookup by key); `recovery.test.ts` (both tests: five kill points) | Verified |
| F-067 | Job states `accepted`, `running`, `done`, `failed`, `interrupted`; outcomes `executed`, `refused`, `reverted`, `no-action`, `error` | `core.test.ts` › "conversion: the eight visible steps" (executed), › "over the signed limit: refused before any signature" (refused) and › "Security Lab: each of the six attacks" (reverted); `policy.test.ts` › "run until the target is met, on the server" (no-action); `integrity.test.ts` › "an injected reconciliation mismatch" (error); `clock.test.ts` › "a chain ahead of the wall clock is refused with both times shown" (failed); `recovery.test.ts` › "killed between accept and reply, after broadcast" (accepted then run; interrupted) | Verified for the rail's states. The wording for the user is the interface's |
| F-068 | Reconciliation in conversions, ticks, attacks, scenarios and every main-treasury operation | `core.test.ts` › "conversion: the eight visible steps"; `integrity.test.ts` › "an injected reconciliation mismatch"; `treasury-ops.test.ts` (payment, forward payment, ring-fence, settlement, withdrawal and deposit each end with a reconcile step) | Verified. A mismatch ends as outcome `error` with `doNotRetry`; the job's status is `done`, which only means finished |
| F-069 | The rail's own budget in a rolling window, stored durably: proposals prepared, operations accepted, scripted economies started (`GET /quota`; `429 quota_exceeded` with `Retry-After`). A bounded writer queue (`429 busy`) | `quota.test.ts` (all four tests); `workspaces-http.test.ts` (the host's budget over all workspaces: `429 quota_exceeded` with `scope: "global"`) | Verified for the rail's own budget, per workspace and over all workspaces together (R7). Limits per signed-in owner and the one model budget are the backend's; reads are not counted |
| F-070 | Proposal kinds, tools, scripts, attack kinds, payees and venues are fixed lists | `core.test.ts` › "deploys the release's contracts from embedded bytecode" (unsupported kind) and › "Security Lab: each of the six attacks" (unknown attack); `scenarios.test.ts` › "input bounds are the release's" (unsupported scenario); `economies.test.ts` › "run requests are validated by the release's own rules"; `treasury-ops.test.ts` › "payment from the main treasury (F-030)" (unknown payee, address refused) and › "venue set (F-041)" (a pool that is not one of the five) | Verified |
| F-071 | Loopback only. The release's public-mode health test was not run (it binds every interface) | — | Awaiting owner decision |
| F-072 | `/health` is 503 until Anvil, contracts, store, co-signer and the vendored-file check all pass; it recovers alone | `service.test.ts` › "readiness, token and transport rules" and › "health stays 503 with the reason"; `persistence.test.ts` › "Anvil crash: the rail notices"; `integrity.test.ts` › "vendored release files that no longer match VENDORED.json"; `cosigner-process.test.ts` › "the co-signer is another process with its own random key" (unready without a co-signer) | Verified |
| F-073 | Bearer token, no CORS, loopback Host, body limit, sanitised errors | `service.test.ts` › "readiness, token and transport rules" | Verified. Output escaping is the interface's |
| F-074 | No reset and no idle reset; a fresh chain means deleting the data folder | — | Awaiting owner decision |
| F-075 | `formatMicro` | `language.test.ts` › "the exact amount lexer, formatting without floating point" (12,345,678,901.000001) | Verified |
| F-076 | Three tokens deployed from the embedded bytecode | `core.test.ts` › "deploys the release's contracts from embedded bytecode" | Verified (deployment). The faucet rule has no test of its own |
| F-077 | Four scripts, one at a time, as jobs with a step stream | `economies.test.ts` (three scripts; one at a time; the step stream); `zk.test.ts` › "with the tier enabled: the privacy economy completes" (optional tier) | Verified. `execution` lacks only the seven step ids of the release's separate bounty script |
| F-078 | Six scenarios with the release's bounds | `scenarios.test.ts` › "each scenario runs on real contracts" (five); `zk.test.ts` › "with the tier enabled: the Groth16 scenario settles" (sixth, optional tier) | Verified |
| F-079 | Data for the Treasury, Execution, Lab, Economies and Evidence functions over the routes | — | Interface |
| F-080 | `network` on state, jobs, proposals and receipts; `HISTORICAL`; `SCRIPTED`; engine labels | `core.test.ts` › "conversion: the eight visible steps" (the label on state, proposal, job and receipt; the engine label); `scenarios.test.ts` › "historical evidence index"; `economies.test.ts` › "clearing economy: one at a time, a step stream" (`SCRIPTED`) | Verified for the rail's output |
| F-081 | — | — | Interface |
| F-082 | The release's suites in a disposable copy | `results/PARITY-GATE.md` and the raw output under `results/gate/`, for example gate `QEDVault.t.sol` 36/36. Recorded on 19 and 20 Nov 2026; the gate was not run again when this register was checked | Verified: see counts |
| F-083 | Venue fee per venue in the state; gas per receipt | — | Partly: no fee and slippage lines that sum to the difference from mid value |
| F-084 | One clock, aligned before each transaction, stored with each decision, refused with both times when ahead; sleep gaps detected and recorded | `clock.test.ts` (all five tests); `service.test.ts` › "a process that is stopped and continued" | Verified |
| F-085 | `benchmarks/` vendored | `benchmarks/run.ts` re-run 24 Nov (fixed seeds, no network); `benchmarks.test.ts` › "F-085: the release's benchmarks B1 to B5" (the same re-run in a temporary folder, the vendored tree only read) | Verified: `benchmarks/results.json` reproduced byte for byte (`evidence/20261124-f085-benchmarks-rerun.json`) |
| F-086 | `guidance` on failed and interrupted jobs; decoded contract errors; clock refusal with both times | `clock.test.ts` › "a chain ahead of the wall clock is refused with both times shown"; `integrity.test.ts` › "an injected reconciliation mismatch"; `recovery.test.ts`; `policy-contract.test.ts` › "contract-enforced policy: wired by the owner" (decoded `OverConversion`) | Partly: the rail's messages. The certificate-window and connection wording is the interface's |

## The six corrections asked of this layer

| | Correction | Status | Evidence |
|---|---|---|---|
| a | Idempotency keys mandatory and durable; proposals, decision records and receipts survive a restart | Done | `recovery.test.ts`, `persistence.test.ts` |
| b | Signing a new mandate or policy revokes the previous one | Done: mandate on-chain (`MandateIsRevoked`); policy at the co-signer under the owner's signature (P0), and on-chain in contract mode | `core.test.ts`, `policy.test.ts` |
| c | One clock, aligned at start and before each transaction, both times stored, refusal on skew; machine sleep detected between heartbeats | Done | `clock.test.ts`, `service.test.ts` (real stopped process) |
| d | Chain state survives a restart | Done with Anvil state dump and load, confirmed on Anvil 1.7.1 including receipts and logs | `persistence.test.ts`, `recovery.test.ts` |
| e | Co-signer in its own process with its own key | Done as a process boundary, and the default. Not OS-level isolation; same solver as the maker | `cosigner-process.test.ts` |
| f | `QEDTreasuryPolicy` on the live path, zero slack refused | Done as an owner-chosen enforcement mode. While wired, direct conversions and payments are unavailable (the Security Lab runs on its own ephemeral chain since R7) | `policy-contract.test.ts` |

## Not finished (exactly)

Items 1 to 8 keep the numbers they had on 20 Nov 2026 before this pass; what changed is said in each.

1. **The owner key is still held by the rail** (a development key). *Done in R7 (22 Nov 2026) for every workspace
   created with `POST /workspaces`*: its owner is a passkey account (`chain/accounts`, declared ready in
   `chain/accounts/READY.json`) and the rail holds no key that can satisfy it (F-014). *Still so, by design:* the
   baseline-parity workspace, which exists for the parity tests only.
2. **Operations on the main treasury besides conversion.** *Done in this pass:* payment, forward payment, owner
   ring-fence, settlement when due, withdrawal, deposit and a later change of venues, each through proposal →
   approval → execute (settlement needs no approval), with tests on Anvil (F-021, F-022, F-026, F-030, F-041).
   *Still not done:* the creditor's own `release` and `assign`, and the two-step transfer of ownership, are not rail
   operations. Purchases against a vendor invoice are not made from the main treasury. The payee book has one entry
   and due dates are whole days. In the baseline-parity workspace payments stop at 10 tUSD of total outflow,
   conversions included, by the release's own C12, because the main treasury has no escrow revenue (in a workspace
   C12 is the authority budget of R7 D7: item 13); and they are unavailable while a contract-enforced policy is wired
   (W-12).
3. **No external price reference** (W-09) and no fee and slippage breakdown (F-083); floor and tolerance are not
   known before approval (F-040). **Not done; not attempted in this pass.**
4. **Co-signer checks.** *Done in this pass:* one failing case per check with a stored refusal record whose hash
   matches, as far as the release's logic allows (F-018 row). *Done in R7:* the rail's fork of the release's engine
   (`rail/cosigner-engine.ts`, generated by `scripts/fork-cosigner.mjs`) checks owner signatures as the vault does
   and works in the vault asset's units; for an ordinary-key owner it decides identically to the release's engine
   (`cosigner-fork.test.ts`). Every passkey workspace uses it; the baseline-parity workspace keeps the release's
   engine. *Done in R7 (D7):* the same generator's third change makes C12 the authority budget when the configuration
   says so (every workspace by default), and leaves it the release's otherwise; the differential test still holds in
   that mode. *Still not done:* an independently written checker (W-08); the fork is the same logic. T1, P1 and P3 have
   no case in which they fail alone, and T3 none at all.
5. **Benchmarks not re-run** (F-085). **No model run** of the red-team corpus (F-061). **Not done; not attempted in
   this pass.** *Benchmarks done 24 Nov (R12): re-run with fixed seeds, `benchmarks/results.json` reproduced byte for
   byte (`evidence/20261124-f085-benchmarks-rerun.json`); the red-team corpus item is kept as written.*
6. **No delay or notice** on protection-reducing owner changes (W-14). *Done in R7 for passkey workspaces:* the owner
   account's guarded calls (`releaseGuards`: ownership, agent, co-signer, daily cap, venues, operator, policy) run only
   after its delay, are listed (`GET /workspaces/:workspaceId/scheduled`) and cancellable by any one member. *Still not
   done:* a notice to the members of a pending change; `withdraw` stays immediate (to the owner's own account, by the
   R7 orchestrator's decision of 22 Nov 2026, `docs/r7/00-ARCHITECTURE-DECISIONS.md`); the baseline-parity workspace has no delay. **The quota on the rail** (F-069):
   *done in this pass*, and over all workspaces together in R7.
7. `GET /state` before provisioning: *done in this pass.* `venues` stays empty until the owner names a set, and the
   five planned pools are in `plannedVenues`.
8. The release's `health-gate.integration.mjs` (3 tests) and `deploy-script.test.mjs` (7 tests) were not run, on
   purpose: the first binds every network interface, the second asserts the old hosting script. **Not done; not
   attempted in this pass.**

Found in R7 (22 Nov 2026), and not closed:

13. **The release's earned-autonomy rule in tINR.** The forked co-signer kept C12 as the release has it, in the vault
    asset's units (D-A): 10 tINR plus half of verified escrow revenue, conversions counted as spend, so a passkey
    workspace could pay nothing after a conversion above 10 tINR. *Done on 22 Nov 2026 (R7 D7):* C12 in a workspace is
    the authority budget (`rail/authority.ts`, `rail/authority-ledger.ts`; `README.md` › "Amounts in a workspace"):
    payments to others consume it, a conversion only its realised cost against a fixed reference band, earnings add
    only after settlement from clients outside the workspace's principal set, owner grants add as granted; after a
    conversion of 10 tINR a payment executes (`authority-rail.test.ts`). `QED_RAIL_AUTHORITY=release` restores the
    release's rule. *Still not done:* the owner's confirmation of its figures (B0 10 tINR, rate ½, a ±0.5% band); a
    reference that follows the market (the local chain has none the agent cannot move; the fixed band refuses every
    conversion once the shared pools drift outside it, and re-centring it is not built); a conversion's preview does not show its C12 worst case before the owner signs (the co-signer's
    refusal names it).
14. **The wallet's backend is not moved yet.** `apps/qed-demo/server/rail.ts` still calls the routes without the
    `/workspaces/:workspaceId` prefix and sends five-field approvals; the orchestrator moves it (the exact contract is
    in `README.md` › "The multi-tenant HTTP contract (R7)").
15. **One signature slot at a time.** A passkey execute is bound to the account's nonce, so two owner actions of one
    workspace prepared together cannot both run: the second is refused as `proposal_stale` (nothing sent). Correct,
    but the backend must prepare them one after another.

Found while checking the register, and not closed:

9. **The first parity gate was not run again.** Its figures here are the recorded output of 19 and 20 Nov 2026. Which
   ports the release's integration suites bind was not checked against the ports of the running review app.
10. **Refusals that exist in the code and that no test reaches:** `stale_job`, `decision_record_mismatch`,
    `mined_revert`, `rotation_mismatch`, `mandate_changed`, `policy_changed`, `no_room`, `cosigner_refused`,
    `approval_after_expiry`.
11. **A conversion of exactly 1 tUSD is refused** on the five-venue market: the release's solver returns a route that
    does not execute for that size, so the co-signer fails T1 and T2. 2 and 3 tUSD convert. This is the release's
    behaviour, shown in `cosigner-checks.test.ts`; the rail does not correct it.
12. **One unit over** the mandate's period and lifetime caps and the vault's daily cap is not tested on the rail
    (F-015); the allowance rising with revenue is not tested (F-034); the faucet rule is not tested (F-076).

## Counts

Rows by status word, computed from the tables above by `node scripts/parity-counts.mjs`:

<!-- parity-counts:start (written by scripts/parity-counts.mjs --write; do not edit by hand) -->
| Section | Rows | Verified | Partly | Not done | Awaiting owner decision | Backend | Interface |
|---|---|---|---|---|---|---|---|
| A. Agent and intent | 13 | 7 | 3 | 0 | 0 | 3 | 0 |
| B. Authority and custody | 16 | 15 | 1 | 0 | 0 | 0 | 0 |
| C. Spend | 6 | 2 | 4 | 0 | 0 | 0 | 0 |
| D. Save and treasury | 12 | 10 | 1 | 0 | 1 | 0 | 0 |
| E. Earn, F. Grow, G. Coordination | 10 | 8 | 0 | 0 | 2 | 0 | 0 |
| H. Assurance, evidence and service | 29 | 21 | 2 | 0 | 4 | 0 | 2 |
| **All** | **86** | **63** | **11** | **0** | **7** | **3** | **2** |
<!-- parity-counts:end -->

The rail's own suite, as observed on 20 Nov 2026 with Node v26.12.0 and Anvil 1.7.1 (`npm test`, one file at a time;
the optional zero-knowledge tier is enabled on this machine, so its three tests ran; with the tier off, two of them
are skipped). Before this pass the suite was 15 files and 61 tests, all passing on the same machine:

| File | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| `admin.test.ts` | 3 | 3 | 0 | 0 |
| `clock.test.ts` | 5 | 5 | 0 | 0 |
| `contract.test.ts` | 3 | 3 | 0 | 0 |
| `core.test.ts` | 12 | 12 | 0 | 0 |
| `cosigner-checks.test.ts` | 2 | 2 | 0 | 0 |
| `cosigner-process.test.ts` | 2 | 2 | 0 | 0 |
| `economies.test.ts` | 4 | 4 | 0 | 0 |
| `integrity.test.ts` | 4 | 4 | 0 | 0 |
| `language.test.ts` | 5 | 5 | 0 | 0 |
| `persistence.test.ts` | 3 | 3 | 0 | 0 |
| `policy-contract.test.ts` | 1 | 1 | 0 | 0 |
| `policy.test.ts` | 7 | 7 | 0 | 0 |
| `quota.test.ts` | 4 | 4 | 0 | 0 |
| `recovery.test.ts` | 2 | 2 | 0 | 0 |
| `scenarios.test.ts` | 4 | 4 | 0 | 0 |
| `service.test.ts` | 5 | 5 | 0 | 0 |
| `treasury-ops.test.ts` | 5 | 5 | 0 | 0 |
| `zk.test.ts` | 3 | 3 | 0 | 0 |
| **18 files** | **74** | **74** | **0** | **0** |

The first parity gate (the release's own suites, unmodified; recorded output, not run again for this register):
default tier 268 of 268 on Node v22.23.3 and on Node v26.12.0; full tier 295 of 295 on both. Solidity with
`SOLC_VERSION=0.8.26`: 136 of 136 (default), 147 of 147 (full). Of the release's 305 tests for these labels, 37 are
not run in the default tier and 10 in the full tier; `results/PARITY-GATE.md` lists each with its reason.

## How this register was checked (20 Nov 2026)

Every row whose status starts with "Verified" was compared with the test it names, by reading the test, and the
whole suite was then run. Where a test did not exercise what its row said, the test was extended or the row was
narrowed:

- F-002: no test read the engine label on the conversion's language step. `core.test.ts` now asserts it there and on
  the stored trade.
- F-007: no test reached `proposal_stale` (the genesis binding). `integrity.test.ts` now does.
- F-018: the test meant to show the co-signer's durable replay set asserted something else. `persistence.test.ts` now
  sends a nonce that was certified before the restart and requires C6, and only C6, to fail.
- F-024: no test read `worstCaseScope`. `admin.test.ts` now does.
- F-080: no test read the network label on a proposal, a job or a receipt. `core.test.ts` now does.
- F-008, F-015, F-023, F-048, F-050 and F-068 keep the word Verified, with their status text narrowed to what a
  test shows.
- Seven rows moved to Verified in this pass, each because a new test runs it: F-021, F-022, F-026, F-030, F-033,
  F-041 (from Partly) and F-069 (from Backend). Before the pass the totals were 54 Verified, 18 Partly, 4 Backend;
  the other three words are unchanged. No row lost its status word.
- F-069's earlier text named a bounded writer queue (`429 busy`). No request could reach that refusal: every caller
  bypassed the bound. It is now enforced where requests are accepted and tested in `quota.test.ts`.
