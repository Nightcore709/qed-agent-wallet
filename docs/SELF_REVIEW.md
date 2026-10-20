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
| The agent decided *how*, never *whether* or *how much* | A standing owner-signed treasury policy; the agent sizes tranches as min(need, impact, policy cap, mandate cap, free funds), waits when the market is too thin, stops at target | `roles/treasury.ts` (`decideTranche`, Proposition 12.8); co-signer P1–P3; `policy-phases.ts` shared by Sepolia and local runs | no human approval per trade; an over-sized request is refused before any transaction exists | Run 4c: PA1 refused, PE1 (impact-limited), PE2 (need-limited), T3 (stop); `local:execute` reproduces it to the raw unit |
| The policy was enforced by the co-signer only; both hot keys stolen could convert without a need | The owner's policy as a contract: `QEDTreasuryPolicy` is QEDExecution's only operator and refuses no-shortfall, out-of-bounds, over-cost and provably over-sized tranches (Proposition 12.9, by concavity) | `contracts/src/QEDTreasuryPolicy.sol`, 13 tests; Run 4d script with an original-timestamp replica | the agent's discretion over *whether* and *how much* is now bounded by the chain, not only by a second process | Run 4d: QA1–QA4 refused with both real hot keys, QE1 accepted; Sourcify match; `npm run verify` re-checks every clause |
| No view of a transaction's life | Lifecycle lanes and a nine-state legend (proposed → simulated → evaluated → rejected/authorized → submitted → pending → confirmed/reverted), each tied to a Sepolia step | `app/index.html` | a judge can follow one order from words to receipt | dashboard *Execution* |
| The independent verifier failed on trades sharing a block | Pre-trade reserves rebuilt from the previous block plus earlier `Sync` events in the same block; failures become CI annotations | `agent/scripts/verify.ts` | `npm run verify` green again on all four runs | CI run after commit `9e466ee` |
| The pitch led with QED's older features | Deck rebuilt around the upgrade: 15 slides in 9:30 plus 8 backup slides, PDF, timed script, demo and video scripts, 24 judge questions | Slides artifact; `presentation/` | one capability, one picture, every claim a transaction | `presentation/SCRIPT.md` |
| Docs incomplete for the directive | Prior art, protocol spec, expanded security, attributions, self-review | `docs/*`, `ATTRIBUTIONS.md` | — | this repository |

Not done, honestly: the portfolio from job #1 still feeds nothing; runs remain separate deployments; the standing
policy's liveness is not enforced (K28); impact is bounded per tranche,
not cumulatively (K29); concentrated-liquidity venues; external audit; a rehearsal of the talk by the team.

## 4. Scores after the upgrade

| Dimension | Before | After | Why it moved (or not) |
|---|--:|--:|---|
| Conceptual originality | 6.0 | 8.0 | a capability we found nowhere else (PRIOR_ART §0), with a falsifiable theorem and money on it, and an on-chain over-conversion test that needs no solver (Proposition 12.9) |
| Mathematical sophistication | 7.5 | 8.5 | routing duality, closed-form venue values, a rounding-safe integer bound, a convex solver, the tranche rule (Prop. 12.8) and the concavity certificate against over-conversion (Prop. 12.9) |
| Autonomous financial capability | 4.5 | 7.5 | the agent decides whether, how much and how to convert under one owner policy, waits or stops on its own; a second process re-derives every decision and a contract enforces the policy's safety clauses even with both hot keys stolen |
| On-chain functionality | 8.0 | 8.5 | 73 more transactions, 12 more contracts, 15 more refused attacks, all receipts matched |
| Security architecture | 8.0 | 9.0 | two new on-chain layers: agent discretion in routing bounded at τ = 1 ppm, and in sizing bounded by the policy contract (no shortfall, bounds, cost, over-conversion) even with both hot keys stolen |
| Smart-contract correctness | 7.5 | 8.0 | soundness fuzzers, bit-exact cross-language parity, positive controls; still unaudited |
| Software engineering | 7.0 | 7.5 | engine and role modules, shared policy phases, typed, tested; orchestration scripts still long |
| System integration | 6.5 | 7.5 | the new module composes with the unchanged vault and co-signer; runs are still separate deployments |
| User experience | 6.5 | 7.5 | trade lifecycle lanes, accept-zone chart, nine transaction states; checked at 1366 px and 390 px, light and dark; no user testing |
| Visual design | 7.0 | 7.5 | figures that show the proof itself; dashboard and deck share one typographic system |
| Financial / commercial relevance | 5.5 | 7.0 | best execution is a legal duty; multi-currency treasuries; no traction claimed |
| Presentation | 7.0 | 8.0 | rebuilt around one capability; every slide rendered and inspected; talk timed at 9:30; not yet rehearsed by the team |
| Reproducibility | 8.5 | 9.0 | the autonomous loop now runs with dev keys and reproduces Sepolia to the raw unit; REPRODUCIBILITY.md; verify green |
| Competition readiness | 7.0 | 8.0 | every mandatory artifact exists; the video and the email are the team's steps |

**Is the improvement substantive?** Yes, on three axes a skeptical judge would check: there is a capability we
could not find elsewhere (an on-chain condition that a trade be within 1 ppm of the best route through permitted
venues), it is exercised by real transactions including attacks a slippage-only wallet would accept, and the agent
now exercises discretion that is bounded three times (co-signer recomputation, the policy contract, the chain's
proof of best execution). It is not a 10 on any axis: the venue model is constant-product only, the policy enforces
safety but not liveness, and nothing is audited.

## 5. Adversarial panel: the strongest criticism from each seat

| Seat | Strongest criticism | Our answer | What remains |
|---|---|---|---|
| Cryptographer | "Your zk setup is single-machine; your 'proof' of best execution is just arithmetic." | The setup risk is disclosed (K18). Best execution needs no cryptography: it is an exact inequality checked on public state, which is a strength. | a multi-party setup |
| Blockchain engineer | "A malicious pool in the venue set breaks everything." | Only the owner names venues; fees are cross-checked; a change voids every order (K22). | pin venues by code hash |
| Financial economist | "Your benchmark baselines are strawmen; real aggregators are near-optimal." | Agreed for average-case: small trades gain ~3 bps (B1 by size). The claim is adversarial: a *hostile* router is held to 1 ppm. | mainnet comparison with aggregators |
| Mathematician | "Path deficiency is assumed, not proved." | Correct: cited (Angeris & Chitra 2020) and tested (3,000 cases plus 4,000 on-chain fuzz runs). | a formal proof for V2 with integer rounding |
| AI researcher | "The 'AI' is an LLM parser plus convex optimisation." | Intended: probabilistic AI only proposes; decisions that move money are deterministic and provable. The agent now decides when and how much under a signed policy, plans, compares, waits and declines. | learning the policy's parameters from outcomes, still bounded by the same checks |
| Security engineer | "Cheapest attack: sandwich below the floor." | Yes, ≤ 1% of a trade (K23), the same as every slippage-protected wallet, but the agent can no longer add its own leakage on top. | private order flow; TWAP screen |
| Software architect | "Four runs, four orchestrators, a browser relay." | Each run is reproducible locally (`npm run local*`) and verified from the public chain; the relay is disclosed. | one long-lived deployment |
| Product designer | "Too much to explain in ten minutes." | The deck now leads with one capability and one picture (the accept zone). | user testing |
| FinTechathon judge | "Is anything here new and real?" | Live Sepolia transactions for each claim, 24 Sourcify-verified contracts, a theorem with money on it, and a prior-art page that says what is not ours. | — |

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

Final state, 20 Oct 2026, after the last commit. PASS means the evidence column supports the claim as stated;
PARTIAL means part of it is not done; NOT VERIFIED means we could not check it ourselves.

| Gate | Verdict | Evidence |
|---|---|---|
| Novelty | **PASS** (with stated limits) | `docs/PRIOR_ART.md` §0: no prior system found that makes the optimality of an executed route an on-chain condition of the trade; every ingredient cited |
| Correctness | **PASS** | Theorem 12.3 with proof, Proposition 12.8; 145 Solidity + 60 TypeScript tests passing; bit-exact TS ≡ Solidity parity; `npm run verify` green in CI |
| Autonomy | **PASS** | Run 4c: policy signed once; PA1 refused; PE1 impact-limited; PE2 need-limited; T3 stop; `local:execute` reproduces it. Run 4d: the policy as a contract, QA1–QA4 refused with both hot keys stolen, QE1 accepted. ARCHITECTURE §3.6 maps the twelve-step loop. Liveness is not enforced (K28) |
| Security | **PASS** | I1–I27 with tests; 48 attack transactions on Sepolia, each reverted with its designed error; honeypot keys published; K1–K29 disclosed |
| Execution | **PASS** | 196 Sepolia transactions in four runs, 196/196 receipts matched the replica; 24 contracts verified on Sourcify |
| Reproducibility | **PASS** | CI runs all four economies, the benchmarks (diffed) and `verify`; clean-clone log in TESTING.md; REPRODUCIBILITY.md |
| Innovation | **PASS** | E1 (0.17 ppm), the accept-zone attacks EA1–EA3, PE1/PE2, QA2 (over-conversion refused by concavity), ExecutionBounty unclaimed |
| UX | **PASS** (no user testing) | every dashboard section rendered at 1366 px and 390 px in light and dark: no horizontal overflow, no script errors; nine transaction states shown |
| Presentation | **PASS** | 15-slide deck + 8 backup slides, every slide rendered and inspected; vector PDF; notes timed at 9:30; demo and video scripts; 24 judge questions. The PowerPoint file is one click in the deck's export menu |
| Documentation | **PASS** | docs index maps every document the brief names; PDFs rebuilt from the final docs |
| Integration | **PARTIAL** | the module composes with the unchanged vault and co-signer, and the reserve is a QED vault; the four runs are still separate deployments, and job #1's portfolio feeds nothing |
| Submission | **PARTIAL** | all files ready (`docs/SUBMISSION_CHECKLIST.md`); recording the video and sending the email are the team's steps |
