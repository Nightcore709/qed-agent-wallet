# QED — Benchmarks and Ablations

All numbers on this page come from `benchmarks/run.ts`. It is deterministic (fixed seeds, no network) and writes
`benchmarks/results.json`; `npx tsx benchmarks/run.ts` reproduces it in about 7 seconds. Each section states the
baseline, the metric and what the result does **not** show. Unfavourable results are included.

## B1 · Best execution: what a proof buys over the routing policies agents use without one

**Setup.** 1,000 seeded markets: 3–4 tokens, 1–3 direct pools plus 1–2 two-hop paths per bridge token, depths
100–10,000 USD per side, fees from {1, 5, 30, 100} bps, each venue mispriced by less than its own fee (so no
fee-free arbitrage exists), trade sizes 0.1%–20% of the direct pools' depth. The certified route is QED's solver;
shortfalls are measured against its integer-simulated output.

| Policy (no proof) | Median shortfall | p90 | p99 | Already optimal (< 0.01 bp) | Passes a 1% slippage floor |
|---|--:|--:|--:|--:|--:|
| Best single pool | 74.5 bps | 667 bps | 1,534 bps | 2.2% | 55.4% |
| Equal split over direct pools | 117.2 bps | 1,097 bps | 3,044 bps | 1.7% | 47.6% |
| Optimal split over direct pools only (a single-pair aggregator) | 33.7 bps | 350 bps | 1,045 bps | 6.2% | 71.3% |

**The security reading (the reason QED exists).** A wallet that enforces only a minimum output lets a compromised
or careless agent use any route that clears the floor. Among routes that clear a 1% floor, the value given up is a
median 14–32 bps and up to 99.9 bps per trade, depending on the policy. Under `QEDExecution` the same agent can give
up at most τ = 1 ppm (0.01 bp) of the bound, whatever route it picks.

**Size matters; this is the unfavourable part.**

| Trade size (share of direct depth) | Markets | Direct-only median shortfall | Direct-only p90 | Single pool median |
|---|--:|--:|--:|--:|
| < 0.5% | 297 | 3.2 bps | 40.9 bps | 11.5 bps |
| 0.5–2% | 277 | 22.7 bps | 96.4 bps | 53.9 bps |
| 2–5% | 168 | 60.0 bps | 230.9 bps | 170.9 bps |
| > 5% | 258 | 267.9 bps | 769.7 bps | 537.6 bps |

For small trades in deep markets a decent router is already within a few basis points of the optimum: there the
proof adds a *guarantee against a hostile agent* rather than much average improvement. The average improvement is
large only when trades are large relative to liquidity, as in thin on-chain markets or the demo's pools.

**Not shown.** The baselines are simple policies, not production aggregators (1inch, 0x, CoW solvers), which use
multi-path search and would sit closer to the optimum; we had no way to query them on our test venues. The markets
are synthetic and contain only constant-product pools.

## B2 · The certificate: precision and cost

| Metric | Median | p90 | p99 | Max |
|---|--:|--:|--:|--:|
| Gap between realised output and the on-chain bound | 0.075 ppm | 0.75 ppm | 4.2 ppm | 7.4 ppm |

The solver takes a median 3.4 ms per market on one CPU (p99 34 ms; printed by the script, not stored, because it
depends on the machine). 92.3% of the 1,000 certified routes are within 1 ppm of their bound. Every one above 1 ppm is within one raw token
unit per hop of it: integer rounding on outputs of a few tokens, where a single unit is several ppm. The live run
uses τ = 1 ppm on outputs of about 18 tEUR (gaps of 0.17 ppm). An order's τ should be at least
`(hops + 1) / output` in raw units.

**On-chain cost (Sepolia receipts).** The honest four-hop trade E1, which pulls funds through the vault (two
signature checks, caps, solvency), reads five venues, computes ten square roots, executes four swaps and checks
three balances, used 1,122,781 gas on Sepolia; E2 used 667,936 (warm storage). At Sepolia's 0.01 gwei that is about
0.00001 ETH. We did not meter the bound alone on Sepolia; in Foundry, two `quoteBound` calls over the five venues cost
156,462 gas together, test overhead included. We did not
build an on-chain solver to compare against, so the claim that verifying is cheaper than solving on-chain is argued
(the bound needs one pass over the venues; solving needs an iterative search with square roots in every step), not
measured.

## B3 · Clearing: certified maximal netting vs a greedy netter vs none

500 seeded economies (4–12 members, 1–4 obligations per member on average, 1–200 tUSD each).

| Netting | Share of gross debt cleared (median) | p90 |
|---|--:|--:|
| None | 0% | 0% |
| Greedy: repeatedly cancel the shortest cycle | 34.0% | 59.2% |
| QED: maximal, with an LP-duality certificate | 39.2% | 65.3% |

The greedy netter clears a median 4.2 percentage points less of the gross debt (p90 12.7, max 27.7) and is already
optimal in 30.4% of economies. The unfavourable reading: on easy economies a heuristic is often enough. The
certificate's value is that the contract can tell which case it is in, without trusting whoever computed the netting.

## B4 · Paid work: what the escrow's optimality check prevents

500 seeded minimum-variance problems (4–8 assets, volatilities 5–60%, one-factor correlations). Without the KKT
check, a provider can be paid for any feasible portfolio. Two lazy deliverables, measured against the certified
optimum:

| Deliverable without the check | Excess variance over the optimum (median) | p90 | Min |
|---|--:|--:|--:|
| Equal weights (1/N) | +259% | +908% | +10% |
| Everything in the lowest-volatility asset | +144% | +399% | 0% |

The size of these numbers depends on the generator: correlated factor models make 1/N look bad. The point is
qualitative. With the check, neither deliverable is payable (live attack X17 on Sepolia: `DualityGapTooLarge`).

## B5 · Authorisation layers: which layer refused each recorded attack

Taken from the public evidence manifests: for every attack transaction on Sepolia (42 across the four runs), the
contract whose check produced the revert.

| Layer that refused the attack | Attacks |
|---|--:|
| `QEDVault` (mandate, co-signature, caps, solvency, ring-fence, replay) | 16 |
| `QEDClearing` (consent, conservation, duality certificate) | 6 |
| `QEDExecution` (best-execution bound, leftovers, operator) | 5 |
| `QEDExecution` with the co-signed order (floor, order hash) | 3 |
| `PrivateMinVarianceVerifier` (proof binding, attestation) | 3 |
| `OptimalityBounty` · `MaximalityBounty` | 3 · 2 |
| `ProofEscrow` · `MinVarianceVerifier` | 2 · 2 |

This is not a re-run with layers switched off, so removing a layer does not imply that the next one would have
caught the attack. `benchmarks/results.json` lists every attack with its error.

## Reproduce

```bash
npx tsx benchmarks/run.ts                       # B1–B5 → benchmarks/results.json
node --import tsx --test agent/test/execution.test.ts   # the property tests behind B1/B2
forge test --match-contract QEDExecutionTest    # on-chain soundness fuzzers (2 × 2,000 runs)
```
