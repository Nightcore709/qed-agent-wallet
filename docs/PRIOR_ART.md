# QED — Prior Art and What Is Actually New

This page lists, for every claim QED could be accused of overstating, the closest prior work we know of and
the precise difference. It was written to be read by someone who knows the literature. Where our contribution
is an application or an integration rather than a new idea, it says so.

Scale used below: **new** = we found no prior system doing this; **specialisation** = a known technique applied to a
setting where we found no prior deployment; **integration** = known parts combined; **known** = standard practice we use.

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
money is conditioned on a statement the chain itself can check** — carried through four places where agent
finance normally relies on trust: who may pay (signatures), what may never be spent (an invariant), whether paid
work is any good (an optimality certificate, public or zero-knowledge), and whether a clearing operator was honest
(a duality certificate). Its mathematics is classical and stated with proofs; its novelty lies in where those proofs
are enforced, and in being falsifiable on-chain for money.

Searches were run on 20 Oct 2026 across arXiv, IACR ePrint, USENIX and project sites. The absence of a prior
system in our search is not proof that none exists; if a reviewer knows of one, the comparison above is where it belongs.
