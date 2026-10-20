# QED — Known limitations

What QED does not do, what it assumes, and what we have not verified. Security risks are catalogued with
severities in [SECURITY.md §5](SECURITY.md#5-known-risk-list-honest) (K1–K29); this page groups them with the
product, engineering and evaluation limits so a reviewer can see the whole boundary in one place.

## 1. Status

* **Testnet prototype.** Ethereum Sepolia only, valueless tokens (tUSD, tEUR, tETH), demo-size liquidity.
  Do not use with real funds (K13).
* **Not audited.** No external audit, no formal verification of the contracts or the zk circuit (K19). The
  security self-assessment is ours.
* **Not production-ready** in the sense of an operated service: no HSM or KMS signers, no monitoring or alerting
  service, no co-signer quorum, no upgrade path (contracts are deliberately immutable). [SECURITY §5a](SECURITY.md#production-readiness-limitations)
  lists what production would need.

## 2. Best execution (`QEDExecution`)

| Limit | Consequence | Where it is discussed |
|---|---|---|
| The proof is about the state the trade executes on | A front-runner who moves every venue changes what is optimal; the bound follows. Moves larger than the co-signed 1% floor revert (EA8); smaller ones are not caught | ALGORITHMS §12.7, K23 |
| Venues must be honest constant-product pools with the declared fee | A malicious pool could report reserves unrelated to its swap behaviour. Only the vault owner names venues; fees are cross-checked | K22 |
| Constant-product venues only | Uniswap V3-style concentrated liquidity, Curve stable-swap and order books are not covered by the bound; their per-venue term has a (piecewise) closed form that we did not implement | K26 |
| The bound covers the owner's venue set, not the whole market | "Best" means best through the venues the owner allowed; a better price elsewhere is out of scope by design | ALGORITHMS §12.4 |
| Integer granularity | Rounding costs up to one raw unit of output per hop; τ = 1 ppm is too tight for outputs of a few raw units. The co-signer sets τ adaptively (1–100 ppm) | K24, BENCHMARKS B2 |
| Gas is not in the objective | An output-optimal route may use more hops than a cheaper near-optimal one | K25 |
| Prices and route are public | The proof is computed by the chain, not in zero knowledge, so the trade reveals its route | ALGORITHMS §12.7 |
| Path deficiency is taken from the literature | Theorem 12.3 uses it as a lemma; we test it (3,000 random cases) rather than re-prove it | ALGORITHMS §12.3 |

## 3. Autonomy

| Limit | Consequence | Where |
|---|---|---|
| The standing policy is enforced off-chain | The co-signer re-derives every tranche; the chain enforces the mandate's caps and best execution, not the policy's target or impact limit. Both hot keys colluding could convert up to the mandate's caps, at best execution, without a shortfall | K28 |
| Impact is per tranche against the current mid | Successive tranches can move the price further in total; no cumulative budget or TWAP reference yet | K29, ALGORITHMS §12.8 |
| One objective type | The live policy keeps a reserve topped up. Other objectives (rebalancing to weights, paying a schedule of invoices in foreign currency) would reuse the same loop but are not implemented | — |
| The language model is a parser, not a planner | It reads owner instructions; deterministic code decides amounts and routes. This is a deliberate safety choice, not a capability claim | ALGORITHMS §8 |
| No scheduler in the repository | Run 4c's ticks run in sequence inside one script; a deployed agent would run the same loop on a timer or on events | — |

## 4. The rest of QED

* **Clearing:** obligations are acknowledgements, not escrowed funds (K17); griefing by tiny obligations fails safe (K15).
* **Private optimality:** the Groth16 setup is a single-machine ceremony and must be trusted (K18); the circuit is fixed
  at n = 6 assets.
* **Paid work:** one problem class (long-only minimum variance) has a certificate verifier; others need their own.
* **Guard:** regex-based and heuristic; it is defence in depth, never the binding control (K7).

## 5. Evaluation limits

* **Benchmarks are on synthetic markets** (fixed seeds, 1,000 random markets), not on historical mainnet pool states.
  They measure what a proof buys over routing policies *without* one; they do not measure any named aggregator.
  For small trades in deep markets a good router is already within about 3 bps, so there the proof's value is the
  guarantee, not the average (BENCHMARKS B1).
* **The red-team corpus is ours** (32 cases); it shows the architecture's behaviour, not coverage of all attacks.
* **No user study** and no traction claims.

## 6. How the evidence was produced

The build sandbox had no outbound RPC. Every transaction was signed in the sandbox against a replica of Sepolia and
the identical bytes were broadcast through a browser relay; all 188 public receipts matched the replica (status and
logs). Two early attempts under other keys were abandoned and are disclosed (K12, EVIDENCE.md). The keys of the very
first run were lost in a container reset, so that run cannot sign again; its evidence is unaffected.

## 7. Not verified

* Behaviour on mainnet gas schedules and with real MEV searchers.
* Interaction with tokens that charge fees on transfer or rebase (K9: unsupported).
* Liveness of the dashboard's live reads: it falls back to the committed snapshot when a public RPC is unreachable.
* Long-running operation: every run is a scripted scenario of minutes to hours.
