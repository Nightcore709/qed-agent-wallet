# QED — final judge Q&A

Short, evidence-based answers for the final pitch. The full technical Q&A from the original submission follows below.

## Product and claims

**1. Is the app real, or an animation?**
Real. Every action in https://qed-judges-preview-production.up.railway.app/ sends transactions to a sandbox chain running the unchanged QED contracts (QEDVault, QEDLens, QEDExecution, five venues). Each receipt shows a block and gas, and balances are read back from the chain. It is a local test chain (Anvil, chain id 31337), not Sepolia; the Sepolia evidence is historical and labelled as such. Verified from an external browser on 20 Oct: 10, 22.5 and 15 tUSD executed, 80 tUSD refused, an inferior route reverted (`docs/PROGRESS.md`).

**2. Which AI model runs it?**
Claude (`claude-sonnet-5-5`) when a model key is configured on the server; otherwise a deterministic offline parser, labelled in the top bar. Either way the AI only interprets and proposes: it holds no key, cannot change a limit, and a question never executes anything.

**3. Who is the "owner" in the app?**
A development key held by the server, so a visitor can play the owner. In production the owner signs in their own wallet. The sandbox is shared, uses valueless tokens and resets when idle. It is not multi-tenant and not for real funds.

**4. Does QED find the best price in all of DeFi?**
No. The guarantee is over the owner's approved constant-product venues: no route through them could return more than the bound B, and the trade is within one part per million of B. Other venue types (concentrated liquidity, order books) are future work.

**5. Couldn't a malicious agent send prices that make a bad route look good?**
No. Any price vector gives a valid upper bound (weak duality), so a dishonest agent can only make B larger, which makes its own trade fail. An honest agent finds the prices where B meets the optimum (strong duality). Appendix A1.

**6. What stops the agent if it is fully compromised?**
Its key alone cannot pay: every payment also needs the independent co-signer's signature and must fit the owner's signed mandate. With both hot keys stolen, Sepolia transactions X6 (`PayeeNotInMandate`) and QA2 (`OverConversion`) were refused by the contracts. Loss to any address the owner did not approve is zero; the worst case to approved payees is bounded and computed on-chain (appendix A13).

**7. How is "autonomous" different from a scheduled script?**
The agent decides each tranche itself from live state: the minimum of need, market impact, two caps and free funds. It waits when the market is too thin and stops at the target. The co-signer re-derives the same number; since Run 4d, a policy contract refuses tranches the policy does not need.

## Commercial

**8. Who pays for this?**
A hypothesis, not traction: treasuries and agent platforms paying per certified trade, or custodians licensing the verifier. We have no users, revenue or partners, and we do not claim a market size.

**9. Why now?**
Agents are starting to hold and move money: payments, procurement, treasury top-ups. The usual controls (spending limits, slippage floors, after-the-fact review) do not prove that a decision was a good one. QED makes quality a condition the chain checks before money moves.

**10. What stands between this and production?**
An external audit, key management (owner signing in real wallets, hardware-backed co-signer), per-tenant isolation, more venue types, monitoring, and a pilot with a treasury team. The mathematics and contracts are tested (145 Solidity tests including fuzzing and invariants, 60 TypeScript tests, 244 independent Sepolia checks), but tested is not audited.

**11. What if the co-signer is down?**
Then nothing executes: QED fails closed. The policy contract enforces safety, not liveness (known limitation K28).

**12. Is this a world first?**
We do not claim that. We searched and did not find a system that makes the optimality of an executed route a condition of the trade itself, in the same transaction, inside an agent's mandate. Sources and the comparison are in `docs/PRIOR_ART.md`.

---

# QED — Judge questions and answers

Short answers first, then the evidence to point at. Every number here is in the repository; if a judge asks for
something not listed, say what we measured and what we did not, and never estimate on the spot.

## Novelty and mathematics

**1. Isn't this just an aggregator with a slippage check?**
No. A slippage check accepts any output above a floor (0.5–1%). QED computes, on-chain and in the same transaction,
an upper bound on what *any* route through the owner's venues could have returned, and refuses the trade if the
measured output is more than 1 ppm below it. EA1 is a route a 1% wallet accepts (33 bps short); QED reverted it with
`NotBestExecution(17554100, 17612723)`. → slide 6; ALGORITHMS §12.

**2. What exactly is proved?**
Theorem 12.3: for every price vector ν with ν(out) = 1, OPT(A) ≤ B(ν) = ν_s·A + Σ venue terms. The contract checks
out·10⁶ ≥ B̂(ν)·(10⁶ − τ) with B̂ ≥ B (all rounding upward). Corollary: every accepted trade delivered ≥ (1 − τ)·OPT
on the state it executed against. → ALGORITHMS §12.3–12.4.

**3. Can the agent forge the proof by choosing prices?**
No. Every ν gives a valid upper bound (weak duality); a bad ν only makes the bound looser, which makes the check
harder to pass. EA3 tried exactly this on Sepolia and reverted. XA2 tried it on the bounty, with prices lowered 3%.

**4. Which step comes from the literature?**
Path deficiency of fee-charging constant-product pools (Angeris & Chitra 2020): repeated swaps on one pool never beat
one swap. We test it directly on 3,000 random cases and indirectly through the soundness fuzzers. Strong duality
(Angeris et al., EC 2022) is why an honest agent passes; it is not needed for soundness.

**5. Why 1 ppm? Is that achievable?**
Integer rounding costs at most one raw output unit per hop. Over 1,000 random markets our route lands a median
0.075 ppm from its own bound; 92.3% within 1 ppm; worst 7.4 ppm on outputs of a few units. The co-signer therefore
sets τ per order (1–100 ppm, from its own measured gap). On Sepolia: 0.17, 0.17, 0.18, 0.40 ppm. → BENCHMARKS B2.

**6. Is it new?**
We found no system, in papers, protocol docs or code, that makes the optimality of an executed route an on-chain
acceptance condition. Closest: CoW's EBBO (after the fact, by governance), on-chain routers that compute splits for
one pair (A²MM; FC 2026), an off-chain KKT certificate for routers (arXiv 2607.22540, execution still guarded by
slippage), and the duality theory itself. → PRIOR_ART §0. Say "we found no prior system", never "first ever".

**7. Why not prove it in zero knowledge?**
Not needed for soundness, and the check is cheap (O(venues)). Privacy of routes is a different goal; QED Private
(backup B8) shows we can do zk optimality when data must stay hidden.

## Security

**8. What if the agent's key is stolen?**
It can call one function, only with an owner-signed mandate and a co-signer certificate on the exact order. With
both hot keys stolen, the vault limits loss to `blastRadius` and only to owner-approved payees; best execution still
binds every trade. We published a honeypot vault's keys; its ring-fence is intact. → slide 8, backup B6.

**9. What if the co-signer is compromised too?**
Since Run 4d the policy itself is a contract and QEDExecution's only operator, so even with both keys the attacker
cannot convert when the reserve needs nothing, outside the owner's bounds, above κ against the mid price, or more than
the shortfall provably required: QA1–QA4 on Sepolia were signed with both real keys and all reverted. What is left is
the mandate's payees and caps and best execution. Revocation: `QEDTreasuryPolicy.revoke`, `bumpEpoch` or `setOperator`.

**10. Front-running and MEV?**
The proof is about the state the trade executes on, so a sandwich moves the bound with the market. The co-signed
floor (own quote − 1%) catches moves larger than 1% (EA8 on Sepolia); smaller ones are a residual risk (K23).
Mitigation in production: private order flow, size-dependent floors, a TWAP reference.

**11. Could a malicious pool fool the bound?**
Only pools the vault owner names are counted, and the module cross-checks each declared fee against the pool.
A pool whose reserves misreport its swap behaviour is a trust assumption (K22). Production: pin venues by code hash.

**12. Does the LLM control money?**
No. It reads the owner's instruction; deterministic code fills every amount; the owner signs the exact conversion or
a standing policy; the co-signer re-derives everything from the chain. The policy loop has no LLM in it at all.
Red-team: 25/25 injection attacks blocked with 0 false refusals in the guarded pipeline.

**13. Is it audited?**
No. 145 Solidity tests (unit, fuzz, ≈350 k-call invariants), 60 TypeScript tests, 48 on-chain attacks, three funded
bounties, and an independent verifier anyone can run. Not a substitute for an audit; stated on every page.

## Autonomy

**14. What does the agent actually decide?**
Under a standing policy: whether to convert, how much, and how to route. Tranche = min(need, impact, policy cap,
mandate cap, free funds); wait below the minimum. On Sepolia it chose 19.535234 (impact-limited) then 8.835281
(need-limited), then stopped. → slide 7; ALGORITHMS §12.8.

**14b. How can a contract tell that the agent converted too much without solving the routing problem?**
Concavity. The best output OPT(x) is concave with OPT(0) = 0, so for a smaller tranche a', OPT(a') ≥ out·a'/a. If
that lower bound already covers the shortfall, the agent provably over-converted; the contract checks it in one
integer inequality (ALGORITHMS §12.9, Proposition 12.9). On Sepolia, QA2 (14.93 tUSD when 11.94 sufficed) reverted
with `OverConversion`.

**15. Isn't that a hard-coded script?**
The rule is deterministic on purpose, so a second process can re-derive it; the inputs are live chain state, and
different states give different decisions (with `POLICY_IMPACT_BPS=50` the same agent waits instead of trading).
What is hard-coded is the owner's objective, which is the point.

**16. The 12-step loop?**
ARCHITECTURE §3.6 maps receive objective → observe → interpret constraints → generate actions → evaluate →
apply the proof → decide → construct an authorised transaction → execute → verify the state change → record → explain,
each to code and to a Sepolia step.

## Evidence and engineering

**17. Why were transactions relayed through a browser?**
Our build sandbox had no RPC egress. Every transaction was signed in the sandbox against a replica of Sepolia, and the
identical bytes were broadcast; all 196 public receipts matched the replica's status and logs. The hashes are of the
exact bytes, so nothing could be changed in transit. Two early failed attempts are disclosed. → EVIDENCE.md, K12.

**18. How do I check a claim without trusting you?**
`npm run verify` (no keys): bytecode of 24 contracts, every receipt, every revert replayed on archive state, every
accepted trade's bound recomputed from the pre-trade reserves and its route replayed, the policy target, bounty pools.
It runs in CI on every push and daily. Sourcify shows the source of all 24 contracts.

**19. Gas cost?**
E1 used 1,122,781 gas (cold storage, four hops, five venues bounded); E2 and the policy trades about 668 k. At
Sepolia's 0.01 gwei that is about 0.00001 ETH. The bound is O(venues); MAX_VENUES = 16, MAX_HOPS = 32.

**20. Why only constant-product pools?**
Their per-venue term has the closed form on slide 3. Concentrated liquidity has a piecewise closed form and stable
swaps a numeric one; neither is implemented (K26). That is the main engineering step to production venues.

## Business and impact

**21. Who pays for this?**
Treasuries that delegate conversion to an agent (businesses, DAOs, AI services), regulated firms that must evidence
best execution, and intent protocols that could accept fillers on a proof. We claim no users or revenue.

**22. Why does a bank care (WeBank context)?**
Cross-border settlement converts currency constantly, and best execution is a regulatory duty. QED turns "trust our
report" into "recompute it from public state", per trade, while the agent operates autonomously within signed limits.

**23. How do the benchmarks compare with 1inch or CoW?**
They don't: our baselines are simple policies (single pool, equal split, optimal direct-only split) on synthetic
markets. Production aggregators would sit closer to the optimum. The claim is the *guarantee*: whatever router the
agent uses, it cannot leak more than τ. For small trades in deep markets a good router is already within ~3 bps.

**24. What would you build next?**
Concentrated-liquidity venues; liveness guarantees for the policy (K28); a cumulative impact budget
with a TWAP reference (K29); a co-signer quorum; an external audit.

## Backup slides

B1 authority · B2 solvency · B3 paid work on a KKT certificate · B4 one business cycle · B5 the 19 attacks of Run 1 ·
B6 bounded loss and the honeypot · B7 certified clearing · B8 zero-knowledge optimality.
