# Typeset PDFs

Print-ready copies of the Markdown documentation in `docs/`, typeset from commit `02e8afe`.

| File | Contents |
|---|---|
| [QED-Technical-Documentation.pdf](QED-Technical-Documentation.pdf) | Overview, architecture, algorithms (with proofs), security design, test catalogue, deployment, and the on-chain evidence as an appendix (32 pages) |
| [QED-Security-Self-Assessment.pdf](QED-Security-Self-Assessment.pdf) | Permission tiers, security properties and how each is verified, threat model, known-risk list, incident response, red-team evaluation (8 pages) |
| [QED-Execution-Evidence.pdf](QED-Execution-Evidence.pdf) | Every transaction of both live runs on Ethereum Sepolia with hash, block, gas and decoded result, and how the transactions were produced (8 pages) |

The Markdown files are the source of truth; `npm run verify` re-derives every on-chain claim from a public node.
