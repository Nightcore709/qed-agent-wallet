# QED — Test Catalogue

Everything below runs in CI on every push (`.github/workflows/ci.yml`) and locally with `forge test && npm run test:ts`.

## Solidity (Foundry, `contracts/test`)

Default profile: 2 000 fuzz runs per property, invariants 512 runs × depth 96. CI profile (`FOUNDRY_PROFILE=ci`): 5 000 fuzz runs, invariants 1 024 × 128.

### `Invariants.t.sol` — stateful fuzzing with **both hot keys stolen**
`CompromisedAgentHandler` holds the agent key **and** the co-signer key and, on every call, chooses among: paying random/approved/attacker payees with genuinely signed certificates, forward payments, settling, releasing, admin calls, pausing, time travel. After every call:

| Invariant | Statement |
|---|---|
| `VaultAlwaysCoversRingFencedLiabilities` | `token.balanceOf(vault) ≥ totalProtected` |
| `ProtectedEqualsSumOfOpenLiabilities` | `totalProtected = Σ open liabilities` |
| `CreditorsPaidExactly` | each creditor received exactly what was settled to it |
| `ZeroLossToUnapprovedAddresses` | the attacker's balance never increases |
| `DailyCapRespected` | agent outflow per 24 h window ≤ `dailyCap` |
| `NoAgentOutflowWhilePaused` | no agent-initiated outflow while paused |
| `AgentKeyHasNoAdminPower` | owner, agent, co-signer, guardian, caps never change via the handler |
| `test_HandlerIsNotVacuous` | the handler really executes successful payments (guards against vacuous invariants) |

### `QEDVault.t.sol` — 34 tests
Authorisation (owner mandate × co-signer certificate, ERC-1271 smart-account owner), every tampering path (amount, recipient, due date, evidence, mandate scope), replay, expiry, revocation (single + epoch), key rotation, per-payment / period / lifetime / global window caps, solvency under total hot-key compromise, forward payments as ring-fenced promises, settlement by anyone when due (also while paused), creditor-only release/assign, guardian pause without unpause, two-step ownership, and `testFuzz_BlastRadiusIsAnUpperBound` (no sequence of attacker payments exceeds the published `blastRadius`).

### `ProofEscrow.t.sol` — 13 tests
Full lifecycle quote → open → deliver → settle into the agent's vault; client tampering with price / payee / verifier / spec / deadline; impostor-signed quotes; quote replay, wrong client, expiry; lazy 1/N portfolio; almost-optimal portfolio; fake convexity witness; solving a different problem; only-provider-delivers-once; refund after deadline by anyone (to the client only); early refund by the provider; `check` is a pure dry run.

### `MinVarianceVerifier.t.sol` — 12 tests
Honest certificate passes and returns the variance; asymmetric covariance, negative weight (short selling), budget violation, negative multiplier, dimension mismatch, overflow and tolerance games are rejected; gas cost. Fuzz properties derived from the theorem in `docs/ALGORITHMS.md §4.4`:
* `testFuzz_AcceptedImpliesEpsilonOptimal` — anything accepted is within `(2n+3+|ν|)τ` of the true optimum;
* `testFuzz_MaterialReallocationIsRejected` — moving ≥ 1e-5 of weight away from the optimum is rejected;
* `testFuzz_RandomPortfolioWithBestMultipliersIsRejected` — a random portfolio dressed with its best possible multipliers is rejected.

## TypeScript (`node --test`, `agent/test`)

| File | What it proves |
|---|---|
| `parity.test.ts` | Starts anvil, deploys the contracts, and checks **TypeScript ≡ Solidity** for every EIP-712 hash/digest (mandate, certificate, quote) and for the KKT checker's verdict and returned variance. |
| `engine.test.ts` | Certifying solver: honest certificate has zero stationarity residual; matches a 20 000-sample brute-force oracle on the simplex; lazy 1/N fails only on complementary slackness; a 0.01 % nudge is rejected; fixed-point round trip; economics (price = cost × 2.5 rounded up; unsettled revenue never counts as capital). |
| `guard.test.ts` | The 32-case red-team corpus (`redteam.corpus.ts`: 25 attacks across induced transfer, data extraction, privilege escalation and prompt injection, in English and Chinese, plus 7 benign requests) through the deterministic guard; plus overrides of a fully compromised LLM (proposes paying the attacker; leaks secrets; exceeds the free balance). |

## End-to-end

* `QED_OFFLINE=1 npm run local` — the whole economy (deploy, fund, lifecycle, conversation, 18 attacks, honeypot, emergency) on a local chain, in CI.
* `npm run verify` — independent re-verification of the public Sepolia evidence (bytecode, receipts, replayed revert errors, signatures, KKT re-check, live invariants), in CI on every push and daily.
* `npm run redteam` — the corpus against the live language model alone and the guarded pipeline; report in `evidence/redteam/report.md`.
