# QED — Self-Review: audit, decision record, adversarial panel and quality gates

Written for a reviewer who wants to know what QED actually is, where it is weak, and what the evidence supports.
Scores are our own and deliberately harsh: 10 would mean nothing material left to criticise.

## 1. Audit of QED before the upgrade (20 Oct 2026, 08:30 IST)

Baseline, re-run from a clean toolchain at the start of the audit: 104/104 Solidity tests and 50/50 TypeScript
tests passed; three runs live on Sepolia (123 transactions); 12 contracts verified on Sourcify.

| Dimension | Score | Evidence for | Weakness |
|---|--:|---|---|
| Conceptual originality | 6.0 | one rule applied consistently: money moves only on proofs the chain checks | every mechanism was a specialisation of known work (certifying algorithms, Cycles-style clearing, Otti-style SNARKs, Todd's bounties) |
| Mathematical sophistication | 7.5 | KKT certificate with an ε-optimality theorem; exact LP duality on a totally unimodular system; a 12.5k-constraint circuit | all of it textbook optimisation, carefully implemented |
| Autonomous financial capability | 4.5 | prices jobs, buys inputs, solves, delivers, refuses scams | could only pay in one currency; decisions limited to a fixed markup rule and owner-instructed payments |
| On-chain functionality | 8.0 | 123 transactions, 12 contracts, 33 designed reverts | — |
| Security architecture | 8.0 | three independent layers, computed blast radius, published-key honeypot | owner key is a single point of total control over free funds |
| Smart-contract correctness | 7.5 | invariants under both hot keys stolen, 2,000-run fuzzers, positive controls | no external audit, no formal verification |
| Software engineering | 7.0 | typed TS, one key per process, CI, deterministic replica + relay | long orchestration scripts |
| System integration | 6.5 | escrow, vault, clearing and verifiers compose | three separate runs; the portfolio QED is paid for is never used by anything |
| User experience | 6.5 | dashboard reads the chain live, explains each proof | an evidence viewer, not an instrument: no transaction-state view |
| Visual design | 7.0 | coherent typographic system, light/dark | dense |
| Financial / commercial relevance | 5.5 | maker–checker, ring-fencing, clearing are real banking controls | single test currency; minimum-variance-as-a-service is niche |
| Presentation | 7.0 | 17-slide deck, notes ≈ 9.5 min | dense; no measured benefit to show |
| Reproducibility | 8.5 | `npm run verify` in CI daily; clean-clone log; Sourcify | — |
| Competition readiness | 7.0 | all mandatory artifacts existed | no benchmarks; no single capability a judge would call new |

**The five most consequential deficiencies.**

1. *Capability gap.* The agent could not trade or convert, the most common and most abusable discretionary
   action of a financial agent.
2. *Innovation gap.* Every contribution was a specialisation of known certificate ideas (`docs/PRIOR_ART.md`).
3. *Autonomy gap.* Financial decisions were a markup rule plus owner-instructed payments.
4. *Evidence gap.* There were no ablations and no measured benefit against a baseline.
5. *Integration and product gap.* Three disconnected runs, an unused portfolio deliverable, and a read-only dashboard.

**Critical defects:** none that broke correct or secure operation. Two defects were found in new code during the
upgrade and fixed before any live run: route recovery returned a worse plan on dislocated markets, and the offline
parser classified "move X into the reserve" as a ring-fence. One operational loss: a container reset deleted the
run-1 key file, so the run-1 vault can no longer be operated by its agent or owner. It is a testnet vault, and
no funds are at risk.

## 2. Decision record: which upgrade, and why

| Candidate | Value | Why not chosen, or why chosen |
|---|---|---|
| **A. Proof of best execution** (chosen) | turns the agent's discretion in trading into a provable duty; route-agnostic; checked atomically on the state that executes | fits QED's rule exactly; a real regulatory duty; measurable benefit; one module, vault unchanged |
| B. Proof-carrying risk limits (CVaR) | caps a portfolio's tail risk by proof | checking a CVaR bound for a given portfolio is plain evaluation: no certificate needed, little novelty |
| C. Verifiable VCG procurement auctions | mechanism design with Walrasian dual prices | a new subsystem off the payment path, needing n + 1 certificates and bidders; too far from QED's core |
| D. Cash-flow matching for ring-fenced liabilities | invest idle reserves while proving future solvency | needs synthetic yield venues with lock-ups; weak demonstration |
| E. Private clearing | hide the obligation graph | Cycles already does private clearing; heavy |
| F. "Fiduciary optimality" for every decision | the owner's objective as a program | A is its most valuable and demonstrable instance |

**Attempts to falsify A.**

- *Done before?* We found no system that verifies, on-chain and at execution time, that an executed route was
  optimal. The closest work is CFMM routing duality (Angeris et al., off-chain), an off-chain improving-path
  certificate (Zhavoronkov, 2026), ERC-8165 and other intent standards (minimum output only), and CoW's EBBO
  (enforced socially). `docs/PRIOR_ART.md` has the details.
- *Necessary?* Yes. Under a 1% floor, a hostile router keeps a median 14–32 bps per trade (B1).
- *Could ordinary code do it?* An on-chain solver could handle constant-product pools. The certificate is
  route-agnostic and cheaper in argument, though we did not measure that comparison (B2).
- *Is the blockchain essential?* Yes. Only an on-chain check binds the proof to the very state the trade executes on.
- *Is the mathematics right?* There is a proof (§12.3), plus 2 × 2,000-run on-chain fuzzers and 12,000 TS pairs.
- *What assumptions does it rest on?* Venue honesty (K22) and path deficiency, which comes from the literature and
  is tested.
- *How could an attacker beat it?* By manipulating every venue by less than the floor (K23).
- *Is it more complexity than it is worth?* One 250-line contract, and QEDVault is unchanged.

## 3. Changelog: limitation → improvement → implementation → benefit → evidence

| Limitation | Improvement | Implementation | Measurable benefit | Evidence |
|---|---|---|---|---|
| Agent could only pay | Conversions with best execution proved on-chain | `QEDExecution` (vault agent module), `CPMMPool`, `TestToken`; `engine/execution.ts`; `roles/trader.ts` | leakage under a hostile agent: up to 99.9 bps → ≤ 1 ppm per trade | E1 0.17 ppm from the bound; EA1–EA3 refused; B1 |
| Co-signer could not judge trades | Independent re-quote written into the order as the floor; manipulation screen | `cosigner.ts → evaluateTrade` (11 checks) | market risk bounded separately from agent discretion | EA8 refused; A2/A5/A8 records |
| Agent did not decide | Plans routes, compares four policies, refuses to trade into a moved market | `planTrade`, `decide` | an explicit, recorded submit/decline rule | A3, A6, A10 records |
| Theorems only as text | Money on Theorem 12.3 | `ExecutionBounty` | anyone can falsify the core inequality for 1,000 tUSD | XA1–XA3; positive control |
| No benchmarks | Deterministic benchmark suite, checked in CI | `benchmarks/run.ts`, `docs/BENCHMARKS.md` | B1–B5 with unfavourable results | `benchmarks/results.json` |
| Single currency | A multi-currency treasury made of QED vaults | euro reserve = second `QEDVault`, ring-fenced euro liability | — | R1 |
| Docs incomplete for the directive | Prior art, protocol spec, expanded security, attributions, self-review | `docs/*`, `ATTRIBUTIONS.md` | — | this repository |

Not done, honestly: the portfolio from job #1 still feeds nothing; runs remain separate deployments; no autonomous
treasury policy (conversions are owner-initiated, the agent decides *how*, not *whether*); concentrated-liquidity
venues; external audit.

## 4. Scores after the upgrade

| Dimension | Before | After | Why it moved (or not) |
|---|--:|--:|---|
| Conceptual originality | 6.0 | 7.5 | a capability we found nowhere else, with a falsifiable theorem behind it |
| Mathematical sophistication | 7.5 | 8.0 | duality for routing, closed-form venue values, rounding-safe integer bound, convex solver |
| Autonomous financial capability | 4.5 | 6.0 | trades, plans, compares, declines; still owner-initiated |
| On-chain functionality | 8.0 | 8.5 | 59 more transactions, 11 more contracts, 11 more refused attacks |
| Security architecture | 8.0 | 8.5 | a fourth layer: agent discretion in trading becomes ≤ 1 ppm |
| Smart-contract correctness | 7.5 | 8.0 | soundness fuzzers, bit-exact cross-language parity, positive controls |
| Software engineering | 7.0 | 7.5 | engine and role modules, typed, tested; orchestrators still long |
| System integration | 6.5 | 7.5 | new module composes with the unchanged vault and co-signer; runs still separate |
| User experience | 6.5 | 7.0 | trade lifecycle view, accept-zone chart |
| Visual design | 7.0 | 7.5 | figures that show the proof, not decoration |
| Financial / commercial relevance | 5.5 | 7.0 | best execution is a legal duty; multi-currency treasuries |
| Presentation | 7.0 | see gates | rebuilt around the upgrade |
| Reproducibility | 8.5 | 8.5 | unchanged standard, extended to Run 4 |
| Competition readiness | 7.0 | see gates | |

## 5. Adversarial panel: the strongest criticism from each seat

| Seat | Strongest criticism | Our answer | What remains |
|---|---|---|---|
| Cryptographer | "Your zk setup is single-machine; your 'proof' of best execution is just arithmetic." | The setup risk is disclosed (K18). Best execution needs no cryptography: it is an exact inequality checked on public state, which is a strength. | a multi-party setup |
| Blockchain engineer | "A malicious pool in the venue set breaks everything." | Only the owner names venues; fees are cross-checked; a change voids every order (K22). | pin venues by code hash |
| Financial economist | "Your benchmark baselines are strawmen; real aggregators are near-optimal." | Agreed for average-case: small trades gain ~3 bps (B1 by size). The claim is adversarial: a *hostile* router is held to 1 ppm. | mainnet comparison with aggregators |
| Mathematician | "Path deficiency is assumed, not proved." | Correct: cited (Angeris & Chitra 2020) and tested (3,000 cases plus 4,000 on-chain fuzz runs). | a formal proof for V2 with integer rounding |
| AI researcher | "The 'AI' is an LLM parser plus convex optimisation." | Intended: probabilistic AI only proposes; decisions that move money are deterministic and provable. The agent now plans, compares and declines. | an autonomous treasury policy |
| Security engineer | "Cheapest attack: sandwich below the floor." | Yes, ≤ 1% of a trade (K23), the same as every slippage-protected wallet, but the agent can no longer add its own leakage on top. | private order flow; TWAP screen |
| Software architect | "Four runs, four orchestrators, a browser relay." | Each run is reproducible locally (`npm run local*`) and verified from the public chain; the relay is disclosed. | one long-lived deployment |
| Product designer | "Too much to explain in ten minutes." | The deck now leads with one capability and one picture (the accept zone). | user testing |
| FinTechathon judge | "Is anything here new and real?" | Live Sepolia transactions for each claim, 23 Sourcify-verified contracts, a theorem with money on it, and a prior-art page that says what is not ours. | — |

## 6. Research question this supports

*Can duality certificates checked on-chain make an autonomous agent's discretionary financial actions provably
near-optimal at the moment of execution, and at what cost across market structures?* The next experiments are a
piecewise h_i for concentrated liquidity, gas as a function of venue count, a mainnet-fork comparison against
production aggregators, and leakage under adversarial agents over historical order flow.

## 7. Business significance (no invented traction)

Users would be operators of AI agents that hold balances in several currencies (fintech apps, DAO and company
treasuries) and institutions with a best-execution duty that route through on-chain venues. The problem exists
because delegating routing to software, and now to AI, creates unobservable discretion, and today's evidence of
best execution is an after-the-fact report. QED's difference is that best execution becomes a condition of
settlement, with leakage under compromise bounded at τ.

Adoption barriers: venue coverage (concentrated liquidity, order books), gas on mainnet, custody of the owner key,
and regulators' acceptance of on-chain evidence. A credible model would be the execution module and co-signer as an
SDK or service, plus audits. Defensibility comes from the integration of the proofs with the vault's authority
model, not from any single formula.

## 8. Quality gates

| Gate | Verdict | Evidence |
|---|---|---|
| Novelty | **PASS** (with stated limits) | `docs/PRIOR_ART.md` §1–5; no prior on-chain atomic best-execution check found |
| Correctness | **PASS** | Theorem 12.3 with proof; 132 Solidity + 56 TS tests; bit-exact parity; `npm run verify` |
| Autonomy | **PARTIAL** | the agent plans, compares, decides and declines (A3, A6, A10), but conversions are owner-initiated |
| Security | **PASS** | I1–I25; 44 attack transactions on Sepolia, every one reverted with its designed error; honeypot |
| Execution | **PASS** | 182 Sepolia transactions in four runs, receipts matched |
| Reproducibility | **PASS** | CI runs all four economies, benchmarks and `verify`; Sourcify for 23 contracts |
| Innovation | **PASS** | E1/E2 and the accept-zone result (EA1, EA2) |
| UX | **PARTIAL** | new section rendered and checked at 1366 px and 390 px, light and dark; full-page re-review pending |
| Presentation | **NOT VERIFIED** | deck rebuild in progress |
| Documentation | **PARTIAL** | this file and the specs are done; README and PDF rebuild in progress |
| Integration | **PARTIAL** | the module composes with the unchanged vault and co-signer; runs are separate deployments |
| Submission | **NOT VERIFIED** | depends on the deck, the PDFs and the user's video and email |

This table is updated at the end of the work; the final state is in `docs/SUBMISSION_CHECKLIST.md`.
