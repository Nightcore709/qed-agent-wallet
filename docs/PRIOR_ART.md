# QED — Prior Art and What Is Actually New

This page lists, for every claim QED could be accused of overstating, the closest prior work we know of and
the precise difference. It was written to be read by someone who knows the literature. Where our contribution
is an application or an integration rather than a new idea, it says so.

Scale used below: **new** = we found no prior system doing this; **specialisation** = a known technique applied to a
setting where we found no prior deployment; **integration** = known parts combined; **known** = standard practice we use.

## 0. Best execution proved at the instant of the trade (`QEDExecution`) — the upgrade's defining claim

The claim: *a smart contract refuses an agent's conversion unless the output, measured as a balance change, is within
τ (1 ppm on Sepolia) of a rigorous upper bound on what **any** route through the owner's venues could have returned,
computed on-chain from live reserves in the same transaction, from a dual price vector the agent supplies.*

| Closest prior art | What it does | Difference from QED |
|---|---|---|
| Angeris, Agrawal, Evans, Chitra, Boyd, [*Optimal Routing for Constant Function Market Makers*](https://arxiv.org/abs/2204.05238), EC 2022; Diamandis, Resnick, Chitra, Angeris, [*An Efficient Algorithm for Optimal Routing Through CFMMs*](https://www.researchgate.net/publication/376131386_An_Efficient_Algorithm_for_Optimal_Routing_Through_Constant_Function_Market_Makers) (2023) | Routing as a convex program; dual decomposition; the dual gives a bound used to *solve* | The mathematics QED's bound rests on (we cite it, §12.5). These papers compute routes off-chain; they do not make the dual bound an on-chain acceptance condition |
| Angeris & Chitra, *Improved Price Oracles: CFMMs* (2020) | Path deficiency of fee-charging CFMMs | The one step of Theorem 12.3 we take from the literature (tested, §12.3) |
| Zhavoronkov, [*Multi-Path Routing in DEX Networks: Convex Allocation and an Improving-Path Certificate*](https://pith.science/paper/2607.22540) (arXiv 2607.22540, 2026) | Off-chain router; a KKT multiplier certifies that no omitted path improves the candidate allocation | Certificate checked off-chain by the router; "execution is protected by an on-chain slippage tolerance" — exactly the gap QED closes |
| Jiang, Li, Wen, [*Transfer algorithm for on-chain one-hop routing*](https://fc26.ifca.ai/preproceedings/5.pdf), FC 2026 preproceedings | *Computes* a one-hop split across several AMMs fully on-chain, to a price-gap tolerance | Computes, approximately, for parallel pools of one pair; no bound, no certificate, no multi-hop. QED *verifies* in O(venues), for any route shape over any token graph |
| Zhou, Qin, Gervais, [*A²MM*](https://arxiv.org/abs/2106.07371) (2021) | Closed-form optimal split between two constant-product pools, executed atomically on-chain | Two pools in closed form; a heuristic beyond two; no proof for general graphs |
| CoW Protocol [EBBO rule](https://docs.cow.fi/cow-protocol/reference/core/auctions/competition-rules) | Solvers must give prices at least as good as baseline AMMs; "not enforced by the smart contract", monitored afterwards, solvers slashed by governance | After-the-fact, social, against baseline pools. QED: in-transaction, by code, against the *optimum* over all owner venues |
| Intent protocols and aggregators (UniswapX, 1inch Fusion, ERC-7683 cross-chain intents, Paraswap, 0x) | Fillers or routers compete; the contract enforces a minimum output (Dutch-auction decay or slippage limit) | A floor bounds loss to the tolerance; QED bounds it to τ of the optimum. Floors and proofs compose: QED keeps a co-signed floor for market risk |
| Tangle Solve problem [*Certified approximate optimal DeFi execution*](https://github.com/tangle-solve/problem-4b97096d-08eb-4c7f-9ae0-7d2da0275ab2) (2026, open problem statement, no code) | Asks for an ε-certificate (e.g. a dual bound) of near-optimal DeFi execution, "independently checkable without trusting the solver" | Frames the open problem; we found no implementation there. QED is one for CFMM routing, checked by the chain at execution time |
| Yaish et al., *Suboptimality in DeFi* (IACR ePrint 2023/892); MiFID II art. 27, FINRA 5310 | Measure sub-optimal execution after the fact; legal duty of best execution evidenced by periodic reports | Motivation: QED turns the duty into a precondition |

**Assessment: new, as far as our searches reach.** Every ingredient is known: CFMM routing duality, path deficiency,
fixed-point rounding. What we did not find, in papers, protocol documentation, or code, is a contract that accepts
a trade *only if* its measured output is within a stated tolerance of an on-chain-computed duality bound over all
permitted venues, so that an agent, solver or filler with full routing discretion cannot leak more than τ. We also
found no prior system that combines this with an AI agent's spending authority (the bound is checked inside the
same transaction that draws funds from a mandate-limited vault) or that stakes money on the bound
(`ExecutionBounty`, 1,000 tUSD, unclaimed). A reviewer who knows of one should hold us to this paragraph.

## 1. Payment that settles only on an on-chain-checked optimality certificate (`ProofEscrow` + `MinVarianceVerifier`)

| Closest prior art | What it does | Difference from QED |
|---|---|---|
| Certifying algorithms — McConnell, Mehlhorn, Näher, Schweitzer, *Computer Science Review* 5(2), 2011 | Algorithms that output a witness a simple checker can validate | QED uses exactly this idea; the checker is a smart contract and its verdict releases payment |
| TrueBit — Teutsch & Reitwießner, [*A scalable verification solution for blockchains*](https://arxiv.org/pdf/1908.04756) | Pays solvers for off-chain computation; correctness enforced by an interactive verification game with challengers and deposits | TrueBit checks that a program was **executed correctly**, optimistically and with an incentive layer; QED checks, in one transaction and with no challenger, that an answer is **optimal** for its problem |
| Ofelimos — Fitzi, Kiayias, Panagiotakos, Russell, [Crypto 2022](https://eprint.iacr.org/2021/1379) | Proof-of-useful-work consensus in which miners run combinatorial-optimisation local search | Rewards progress of a search inside consensus; no per-job optimality guarantee to a paying client |
| LP / QP certificate checking in exact arithmetic (e.g. VIPR; [CGAL QP solver certificates](https://doc.cgal.org/Manual/3.6.1/examples/QP_solver/optimality_certificate.cpp)) | Verifies KKT / duality certificates of solver output | Off-chain correctness tooling; not a payment condition |
| CoW Protocol solver competition | Solvers propose batch settlements; the best one wins by surplus | Ranking among submitted solutions, not a proof that no better solution exists |

**Assessment: specialisation.** KKT conditions and certifying algorithms are classical. What we did not find
elsewhere is an escrow whose *acceptance condition* is an exact-integer optimality certificate for a convex QP
(including a Cholesky convexity witness) with a stated ε-optimality theorem for the fixed-point tolerances
(ALGORITHMS §4.4), deployed and exercised on a public chain against a dishonest provider.

## 2. Proof-gated multilateral netting (`QEDClearing`)

| Closest prior art | What it does | Difference from QED |
|---|---|---|
| Liquidity-saving mechanisms and multilateral netting in payment systems (BIS/CPSS literature since the 1990s) | Offset mutual obligations to save liquidity | Run by a trusted operator |
| Fleischman & Dini (2021), Multilateral Trade Credit Set-off; [Cycles Protocol](https://arxiv.org/pdf/2507.22309) — Buchman, Dini, Ahmed, Miller, Fleischman (2024–25) | Min-cost max-flow clearing of obligation graphs; on a Cosmos chain; a TEE computes the solution on encrypted intents and a ZK proof shows the output is **valid** (balanced, from submitted obligations) | The Cycles paper states that **optimality depends on the TEE**. QED makes maximality itself publicly checkable: an exact LP-duality certificate (Σx = Σd·y, totally unimodular) verified on-chain, so anyone, including an interested member, can be the solver |
| Goldberg & Tarjan (1989), Karp (1978) | Minimum-mean cycle cancelling; minimum-mean cycle | The algorithms our off-chain solver uses |

**Assessment: specialisation, with one genuine difference** (trustless *optimality*, not only validity). Not ours:
the netting objective, the algorithms, and privacy — Cycles keeps obligations private; QEDClearing does not.

## 3. Optimality proven in zero knowledge (`PrivateMinVarianceVerifier`)

| Closest prior art | What it does | Difference from QED |
|---|---|---|
| Otti — Angel, Blumberg, Ioannidis, Woods, [*Efficient Representation of Numerical Optimization Problems for SNARKs*](https://eprint.iacr.org/2021/1436), USENIX Security 2022 | Compiles LP, SDP and SGD problems into R1CS so that a SNARK proves the solution is optimal | The core technique (prove a certificate check inside a SNARK instead of the solver) is Otti's. QED applies it to a fixed-point min-variance QP and adds what a market needs: vendor attestation of committed data, a binding to the proving provider, a Solidity verifier, and settlement through an unmodified escrow |
| Tan, Gascón, Meiklejohn, Raykova, Wang, Luo, [*Founding Zero-Knowledge Proofs of Training on Optimum Vicinity*](https://eprint.iacr.org/2025/053) (2025) | Proves a trained model is within a bounded distance of the optimum of a convex training problem | Same family of statements for ML training; no payment or on-chain settlement |
| zkML frameworks (EZKL and others) | Prove inference / computation of a model in ZK | Prove *computation*, not *optimality* |

**Assessment: specialisation / integration.** We do not claim a new cryptographic technique.

## 4. Theorems with money on them (`OptimalityBounty`, `MaximalityBounty`)

| Closest prior art | What it does | Difference from QED |
|---|---|---|
| Peter Todd's [hash-collision bounties](https://gnusha.org/pi/bitcoindev/20130913060758.GC4242@savin/T) (2013) | Bitcoin P2SH scripts that pay anyone presenting a collision; the SHA-1 bounty was collected on 23 Feb 2017 after SHAttered | Same mechanism — a self-adjudicating, script-checked refutation bounty — applied to a cryptographic assumption |
| Optimistic-rollup fault proofs | On-chain adjudication of a disputed state transition | Adjudicate execution claims, funded by bonds |
| Bug-bounty platforms | Human-adjudicated rewards for vulnerabilities | Not self-adjudicating |

**Assessment: specialisation.** The idea of a contract paying for a counterexample is Todd's. Pointing it at the
*economic optimality theorem* of a deployed financial verifier (and at a clearing house's maximality rule), with
positive-control tests proving the payout path works, is the part we did not find before.

## 5. The agent wallet itself (`QEDVault`, co-signer, guard)

| QED element | Closest prior art | Assessment |
|---|---|---|
| Owner-signed EIP-712 mandate + independent co-signer certificate | Multisig and co-signing services (Safe, BitGo 2-of-3), policy engines (Fireblocks, Turnkey), agent wallets with spending policies ([overview of agentic wallets](https://www.cobo.com/post/the-definitive-comparison-of-top-agentic-wallets-for-active-crypto-traders)), programmable signers (Lit Protocol), session keys (ERC-4337 / ERC-7579) | **integration** |
| Ring-fenced liabilities that only the creditor can receive, even from the owner | Escrow and allowance modules (Safe Allowance module), payment-streaming contracts | **integration**; the invariant proof and the "pause stops the AI, never the creditor" rule are careful engineering, not a new idea |
| Worst-case loss under total hot-key compromise computed by an on-chain view (`QEDLens.blastRadius`) and fuzzed as an upper bound | Rate limits and daily caps (Argent, Safe modules) | **specialisation**: we found caps everywhere but not a published, on-chain-computed bound tested as an invariant |
| Honeypot vault with published agent and co-signer keys | Public "steal this" demonstrations exist in security folklore | **demonstration device**, not an invention |
| LLM reads language; deterministic code fills every money field; guard; owner signature on the exact instruction | Dual-LLM pattern; CaMeL — Debenedetti et al., [*Defeating Prompt Injections by Design*](https://arxiv.org/abs/2503.18813) (2025) | **known** design principle, applied |

## 6. What an expert should take away

QED's defensible contribution is not any single primitive. It is a consistent design rule — **every movement of
money is conditioned on a statement the chain itself can check** — carried through five places where agent
finance normally relies on trust: who may pay (signatures), what may never be spent (an invariant), whether paid
work is any good (an optimality certificate, public or zero-knowledge), whether a clearing operator was honest
(a duality certificate), and whether a conversion got the best price any route could (a duality bound checked at
execution). Its mathematics is classical and stated with proofs; its novelty lies in where those proofs
are enforced, and in being falsifiable on-chain for money.

Searches were run on 20 Oct 2026 across arXiv, IACR ePrint, USENIX, Financial Cryptography 2026 preproceedings, protocol documentation (CoW, UniswapX, 1inch, ERC-7683) and GitHub. The absence of a prior
system in our search is not proof that none exists; if a reviewer knows of one, the comparison above is where it belongs.
