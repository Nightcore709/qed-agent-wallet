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

### `QEDClearing.t.sol` (15 tests)

* `test_OptimalNettingExecutes_PositionsUnchanged`: the demo economy's proven netting clears 169 of 200 tUSD; every member's net position is unchanged.
* `test_GridlockThenSettlementWithExactCash`: gross payment fails (`ERC20InsufficientBalance`); after netting, the remaining debts settle in topological order with each agent's net debit only; every agent ends at exactly its net position.
* Rejections: `GreedyNettingIsNotProvablyMaximal` (162 vs 169), `ShiftingValueBetweenMembers`, `CancellingMoreThanOwed`, `HidingAnObligation`, `StaleAmounts_AndReplayAfterNetting`, `ForgedDualCertificate`, `IdsNotIncreasing`, `NothingToNet`, `PotentialOverflowGames`, `MembershipAndDebtRules`.
* `testFuzz_AnyCirculationAroundTheOptimumIsRejected` (2,000 runs): push any amount of debt around any of the 11 simple cycles of the demo economy; conservation still holds, and every such proposal is rejected.
* `test_SixtyRandomEconomies`: 60 random economies (3–7 agents, 3–16 debts) from the TypeScript solver: every optimal certificate executes with the exact cleared amount; wherever the greedy agent falls short (11 economies) it is rejected with `NotProvablyMaximal`.

### `PrivateMinVarianceVerifier.t.sol` (11 tests): a real Groth16 proof, attacked

The fixture (`npm run fixtures:private`) is a genuine proof from `circuits/private_minvar.circom`.
* Accepted: the proof verifies through the generated Groth16 verifier and returns `keccak(weightsCommitment, variance)`; ≈ 270 k gas.
* Rejected: an understated variance, a swapped portfolio commitment, the same proof under another provider's spec (`StolenProofIsUselessToAnotherProvider`), data attested by anyone but the vendor, an attestation replayed on another chain, a non-canonical field element.
* `testFuzz_AnyCorruptedProofCoordinateIsRejected` (2,000 runs): perturb any of the 8 proof coordinates by any amount; always `ProofRejected`.
* `test_EscrowPaysOnlyForThePrivateProof`: through `ProofEscrow`, Mallory's copy of QED's proof is refused and QED's delivery pays the vault.

### `Bounties.t.sol` (11 tests): theorems with money on them

* `OptimalityBounty`: the equal-weight portfolio, the certified portfolio itself and 2,000 random feasible portfolios (`testFuzz_Optimality_NoFeasiblePortfolioRefutesTheTheorem`) all fail to refute Theorem 4.4; a forged certificate cannot even enter (the deployed verifier reverts); infeasible challengers are refused; **positive control:** against a verifier that accepts anything, the bounty pays the first real refutation.
* `MaximalityBounty`: the demo economy is accepted at exactly 169; the greedy 162 cannot refute it; 2,000 random circulations built from the economy's cycles never beat it; `test_Maximality_AgreesWithQEDClearingOnSixtyEconomies` executes each of the 60 economies on a fresh `QEDClearing` and checks the bounty's rule agrees; **positive control:** an acceptance rule that under-reports by 7 tUSD gets refuted and pays out.

### `QEDExecution.t.sol` (28 tests): best execution, proved at the instant of the trade

The fixture (`npm run fixtures:execution`) is the TypeScript engine's output on the five demo venues, so the Solidity bound is checked **bit for bit** against the off-chain replica.
* Accepted: the solver's 4-venue, two-hop route for 20 tUSD returns 18.086846 tEUR against an on-chain bound of 18.086849 (`test_honestRoute_isAccepted_andMatchesTheSolverBitForBit`); `quoteBound` equals the TypeScript bound exactly; `test_honestBoundIsTight` shows the gap is below 1 ppm.
* Rejected (`NotBestExecution`): an optimally split direct-only route that a 1% slippage floor would accept (−33 bps); a 0.6 bp skim; any price vector offered for a bad route (`test_noPriceVectorRescuesABadRoute`). Rejected for structure: a stranded bridge token (`Leftover`), an unknown pool, a mis-normalised price vector, a single-venue route below the co-signed floor (`InsufficientOutput`).
* Order and authority: a tampered order (`OrderMismatch`), a recipient outside the owner's mandate, a venue-set change invalidating outstanding orders, a tolerance above the cap, operator-only trading and vault-owner-only configuration, a declared fee that differs from the pool's own; the vault's mandate, replay protection, pause and per-payment cap still apply; `pay` passes through but rejects a trade certificate.
* `test_frontRun_isStoppedByTheCosignedFloor`: a sandwich attacker moves the market between signing and execution; the co-signed floor reverts the trade.
* `testFuzz_boundIsNeverBeaten` and `testFuzz_nearOptimalRoutesNeverBeatTheBound` (2,000 runs each): random amounts, random routes over all five venues and random price vectors; no executed route ever returns more than the on-chain bound (Theorem 12.3, weak duality with upward rounding).
* `ExecutionBounty` (6 tests): the optimal route and lowered prices cannot claim; the pool's own holdings and over-spending cannot be used; `testFuzz_bounty_neverPays` (2,000 runs); **positive control:** against an unsound bound source the bounty pays the first real refutation.

### `QEDTreasuryPolicy.t.sol` (13 tests): the owner's policy, enforced on-chain

With QEDTreasuryPolicy as QEDExecution's operator and the fixture's 20 tUSD route (18.086846 tEUR, 111.5 bps against mid):
* Accepted: a tranche under a target it does not over-shoot; a tranche that exactly covers the need (shortfall just
  above out·(1 − σ)); the mid-price reference equals ΣR_out/ΣR_in of the direct venues.
* Refused: no shortfall (`NoShortfall`); over-conversion (`OverConversion`); cost above κ = 100 bps
  (`ExecutionCostTooHigh`); a tranche above the owner's maximum (`TrancheOutOfBounds`); a lapsed and a revoked policy
  (`PolicyLapsed`); an order paying anyone but the reserve (`WrongOrder`); the agent's key calling `trade` directly
  (`NotOperator`) and anyone else calling `convert` (`NotAgent`); non-owners configuring it, and invalid parameters.
* `test_ringFencingCreatesTheShortfall`: the owner ring-fences reserve money for a creditor; the shortfall that
  creates makes the same tranche legitimate.
* `testFuzz_everyAcceptedTrancheSatisfiesThePolicy` (2,000 runs over target, κ and σ): every accepted tranche
  satisfies C1–C4; every refused one breaks at least one, and nothing moves.

## TypeScript (`node --test`, `agent/test`)

| File | What it proves |
|---|---|
| `parity.test.ts` | Starts anvil, deploys the contracts, and checks **TypeScript ≡ Solidity** for every EIP-712 hash/digest (mandate, certificate, quote) and for the KKT checker's verdict and returned variance. |
| `engine.test.ts` | Certifying solver: honest certificate has zero stationarity residual; matches a 20 000-sample brute-force oracle on the simplex; lazy 1/N fails only on complementary slackness; a 0.01 % nudge is rejected; fixed-point round trip; economics (price = cost × 2.5 rounded up; unsettled revenue never counts as capital). |
| `netting.test.ts` | Netting solver equals an **exhaustive brute-force oracle** on 150 random economies; certificates are exact; netting never changes a net position; remaining debts always form a DAG that settles with net debits only. |
| `private.test.ts` | The zero-knowledge prover: the fixed-point certificate satisfies every circuit constraint with zero duality gap and matches the exact solver to 10⁻¹² per weight; the Groth16 proof verifies and its public signals equal the commitments, the provider and the variance; a tampered signal fails; **no proof exists** for the lazy 1/N portfolio, a 1-basis-point nudge, or a different data commitment (the witness generator's constraints fail). |
| `execution.test.ts` | The best-execution engine: `isqrt` is the exact floor square root on 2,000 inputs up to 2²⁵⁰; path deficiency (repeated swaps on one pool never beat one swap, 3,000 cases); **weak duality**: no route at any prices beats the bound (400 markets × 10 routes × 3 price vectors); **strong duality in practice**: the solver's route is within 1 ppm of its own bound, or within one raw unit per hop, on 300 random markets; the certified route beats every baseline on 200 markets; the committed Solidity fixture equals the engine's current output. |
| `treasury.test.ts` | The standing-policy tranche rule: execution cost is non-decreasing in size; a tranche never exceeds any of its five limits and covers the shortfall when need binds; no shortfall → no action, a market too thin for the minimum tranche → wait; the decision is deterministic, so the co-signer recomputes exactly what the agent decided. |
| `guard.test.ts` | The 32-case red-team corpus (`redteam.corpus.ts`: 25 attacks across induced transfer, data extraction, privilege escalation and prompt injection, in English and Chinese, plus 7 benign requests) through the deterministic guard; plus overrides of a fully compromised LLM (proposes paying the attacker; leaks secrets; exceeds the free balance). |

## End-to-end

* `QED_OFFLINE=1 npm run local` — the whole economy (deploy, fund, lifecycle, conversation, 18 attacks, honeypot, emergency) on a local chain, in CI.
* `npm run local:clearing` — the clearing economy (gridlock, 6 attacks, proven netting, settlement) on a local chain.
* `npm run local:private` — the private economy (zero-knowledge proof, escrow settlement, 3 attacks, both bounties funded and 5 refutation attempts) on a local chain.
* `QED_OFFLINE=1 npm run local:execute` — the best-execution economy (5 venues, the owner's instruction read by the brain, 2 certified conversions, 8 refused attacks, a front-run, then the standing policy run to its target: PA1 refused, two tranches, stop) on a local chain with dev keys, in CI. Being deterministic, it reproduces Run 4c's Sepolia figures to the raw unit.
* `npx tsx benchmarks/run.ts` — B1–B5 benchmarks with fixed seeds; CI re-runs them and diffs `benchmarks/results.json`, so the published numbers are reproducible.
* `npm run zk:setup` — re-runs the trusted setup from the circuit (new keys; the committed keys are the ones deployed).
* `npm run verify` — independent re-verification of the public Sepolia evidence for all four runs (bytecode, receipts, replayed revert errors, signatures, KKT re-check, netting certificate re-check, Groth16 proof re-verified off-chain with snarkjs, vendor attestation recovered, every accepted trade's bound recomputed from pre-trade reserves and its route replayed, the policy's target met, every clause of the on-chain policy re-checked for QE1, all three bounty pools intact, live invariants; 244 checks), in CI on every push and daily.
* `npm run redteam` — the corpus against the live language model alone and the guarded pipeline; report in `evidence/redteam/report.md`.

## Clean-clone reproduction log

| When (UTC) | Machine | Steps | Result |
|---|---|---|---|
| 2026-10-19 16:50 | Fresh Linux container with nothing installed (no Foundry, no keys, no prior state) | `git clone --recursive`, install Foundry 1.7.1 + solc 0.8.26 from their GitHub releases, `npm ci`, `forge build`, `forge test`, `npm run test:ts` | **67 / 67** Solidity tests and **42 / 42** TypeScript tests passed |
| 2026-10-19 21:46 | Fresh `git clone --recursive` of commit `dee4c07` into an empty directory (Foundry 1.7.1 toolchain present; no keys, no `node_modules`, no build output) | `npm ci`, `forge build`, `forge test`, `npm run test:ts`, `QED_OFFLINE=1 npm run local`, `npm run local:clearing` | **82 / 82** Solidity and **45 / 45** TypeScript tests passed; both economies ran end to end on a local chain (4 min 6 s) |
| 2026-10-20 02:29 | Fresh `git clone --recursive` of commit `aeaf628` into an empty directory (Foundry 1.7.1 toolchain present; no keys, no `node_modules`, no build output) | `npm ci`, `forge build`, `forge test`, `npm run test:ts`, `QED_OFFLINE=1 npm run local`, `npm run local:clearing`, `npm run local:private` | **104 / 104** Solidity and **50 / 50** TypeScript tests passed; all three economies ran end to end on a local chain, including a real Groth16 proof (4 min 49 s) |
| 2026-10-20 13:40 IST | Fresh `git clone --recursive` of commit `87cb60c` into an empty directory (Foundry 1.7.1 toolchain present; no keys, no `node_modules`, no build output) | `npm ci`, `forge build`, `forge test`, `npm run test:ts`, `QED_OFFLINE=1 npm run local:execute` | **132 / 132** Solidity and **60 / 60** TypeScript tests passed; the best-execution economy and the standing-policy loop ran end to end with dev keys, the policy met its target (3 min 58 s) |
| every push + daily | GitHub Actions `ubuntu-latest` | `.github/workflows/ci.yml`: Solidity suite, TypeScript suite, all four economies on a local chain, benchmark reproducibility, `npm run verify` (all four runs) against public Sepolia | green |
