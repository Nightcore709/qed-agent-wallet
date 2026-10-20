# QED documentation index

Each document below reflects the code in this repository and the transactions on Ethereum Sepolia. Where the
competition brief names a document we do not keep as a separate file, the right-hand column says where its
content lives, so nothing is duplicated.

| Brief asks for | Where it is |
|---|---|
| README | [`../README.md`](../README.md): purpose, the defining innovation, the four outcomes with transaction hashes, reproduce commands |
| ARCHITECTURE | [`ARCHITECTURE.md`](ARCHITECTURE.md): components, key flows, the twelve-step autonomous loop (§3.6), defence in depth (§3.7), data model, topology, gas |
| MATHEMATICAL_SPECIFICATION | [`ALGORITHMS.md`](ALGORITHMS.md): every theorem with its proof: the vault's solvency invariant (§2–3), ε-optimality certificates (§4.4), netting maximality (§9.2), private optimality (§10.3), best execution (§12.3), the tranche rule (§12.8) |
| CORE_ALGORITHMS | [`ALGORITHMS.md`](ALGORITHMS.md): the certifying solvers (§5, §9.4, §12.6), the co-signer policy (§7), the conversational state machine (§8) |
| PROTOCOL_SPECIFICATION | [`PROTOCOL_SPECIFICATION.md`](PROTOCOL_SPECIFICATION.md): every signed message, struct, hash, check order and error |
| SECURITY_SELF_ASSESSMENT | [`SECURITY.md`](SECURITY.md): permission tiers, properties I1–I26 with their tests, proven vs assumed, known risks K1–K29, key lifecycle, oracles, MEV, availability, administration, incident response, compliance controls |
| THREAT_MODEL | [`SECURITY.md` §4](SECURITY.md#4-threat-model): assets, fourteen adversaries with the evidence of each outcome, STRIDE |
| PRIOR_ART_AND_NOVELTY | [`PRIOR_ART.md`](PRIOR_ART.md): what exists (agent wallets, intents, solver auctions, CFMM routing theory, verifiable computation) and what we found no prior system doing |
| DEPLOYMENT | [`DEPLOYMENT.md`](DEPLOYMENT.md): 24 live contracts, prerequisites, local and public-network runs, operations runbook |
| TESTING | [`TESTING.md`](TESTING.md): the 145 Solidity and 60 TypeScript tests, end-to-end runs, clean-clone reproduction log |
| BENCHMARKS | [`BENCHMARKS.md`](BENCHMARKS.md): B1–B5 against the original QED, baselines, prior techniques and ablations, with failures reported |
| REPRODUCIBILITY | [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md): exact commands to build, test, run, verify and re-derive every published number |
| KNOWN_LIMITATIONS | [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md): what QED does not do, what is assumed, and what is unverified |
| SUBMISSION_CHECKLIST | [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md): every required and optional item, with its status |
| ATTRIBUTIONS | [`../ATTRIBUTIONS.md`](../ATTRIBUTIONS.md): libraries, papers and generated code, with licences |
| Execution evidence | [`EVIDENCE.md`](EVIDENCE.md) (generated from the manifests): all 196 Sepolia transactions, with blocks, gas and the error of every reverted attack |
| Audit, decisions, changelog, expert review, quality gates, before/after scores | [`SELF_REVIEW.md`](SELF_REVIEW.md) |
| Presentation | [`../presentation/SCRIPT.md`](../presentation/SCRIPT.md) (timed talk and demo script), [`../presentation/JUDGE_QA.md`](../presentation/JUDGE_QA.md) |
| PDFs for the submission email | [`pdf/`](pdf/): technical documentation, security self-assessment, execution evidence |

## Reading paths

* **Ten minutes:** the README's first section, then the dashboard's *Execution* section
  (<https://nightcore709.github.io/qed-agent-wallet/>), then ALGORITHMS §12.3.
* **A security reviewer:** SECURITY §1–5, then `contracts/src/QEDExecution.sol` and `contracts/src/QEDVault.sol`,
  then run `npm run verify`.
* **A researcher:** ALGORITHMS §12, PRIOR_ART, BENCHMARKS, then `agent/test/execution.test.ts`.
* **An engineer reproducing the work:** REPRODUCIBILITY, top to bottom.
