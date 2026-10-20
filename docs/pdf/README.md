# Typeset PDFs

Print-ready copies of the Markdown documentation in `docs/`, typeset from commit `4df0e4b`.

| File | Contents |
|---|---|
| [QED-Technical-Documentation.pdf](QED-Technical-Documentation.pdf) | Overview, architecture (with the twelve-step autonomous loop), algorithms with proofs (including best execution, §12), protocol specification, security design, benchmarks, prior art, test catalogue, reproducibility, deployment, known limitations, and the on-chain evidence as an appendix (71 pages) |
| [QED-Security-Self-Assessment.pdf](QED-Security-Self-Assessment.pdf) | Permission tiers, 26 security properties and how each is verified, threat model, 29 known risks, key lifecycle, incident response, red-team evaluation (11 pages) |
| [QED-Execution-Evidence.pdf](QED-Execution-Evidence.pdf) | Every transaction of all four live runs on Ethereum Sepolia (188) with hash, block, gas and decoded result, and how the transactions were produced (15 pages) |

The pitch deck's PDF is in [`presentation/`](../../presentation/). The Markdown files are the source of truth;
`npm run verify` re-derives every on-chain claim from a public node.
