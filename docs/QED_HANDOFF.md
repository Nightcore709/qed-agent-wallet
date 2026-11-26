# QED engineering handoff — current source of truth

Repository: `Nightcore709/qed-agent-wallet`. Development: `qed-interactive-agent-demo-20261020`. Mainline preserved.

## Purpose

QED is a proof-carrying autonomous on-chain treasury. Language models interpret financial requests but cannot safely be the authority that controls money. Owner-signed mandates, independent co-signer certificates, deterministic financial optimization, and Solidity contracts enforce limits regardless of the model's behavior.

## Existing verified foundation

- QEDVault: owner EIP-712 authorizations, per-payment/daily/lifetime limits, protected creditor funds, replay protection, pause/revocation.
- QEDExecution: multi-venue constant-product route optimization with price-vector upper-bound certificate checked in the execution transaction.
- QEDTreasuryPolicy: signed standing target and on-chain constraint enforcement; finite autonomous local and Sepolia sequences.
- Escrow, certified portfolio optimization, zero-knowledge private optimum, multilateral clearing, economic bounties.
- 145 Solidity tests and 60 TypeScript tests previously reproduced; independent QED checker reported 244/244 historical Sepolia checks.
- Original public dashboard: `https://nightcore709.github.io/qed-agent-wallet/`, showing primarily historical proofs.

## Interactive migration

New preview: `product/index.html` served by `agent/scripts/demo-server.mjs`.

Modes are carefully separated:

1. Local Anvil execution: fresh dev keys and contract receipts, with bounded requests up to the signed 25 tUSD mandate.
2. Read-only QED natural-language interpretation: `POST /api/chat`, not a transaction-authorizing path.
3. Historical public Sepolia proof ledger: previously mined hashes, never misrepresented as a new live transaction.

The first conversion amount is passed to existing `agent/scripts/execute.ts`, interpreted by the existing brain and guard, reviewed by the original co-signer and proved on chain. Subsequent red-team and policy phases remain scripted.

## Known blockers

- The public demo does not yet have a real Anthropic API credential configured on Railway; offline deterministic mode is explicitly labeled.
- The hosted public endpoint has not been independently verified to complete a browser-originated financial run after its latest code update.
- Public deployment runs a single shared disposable Anvil per execution and uses known deterministic test keys; **never real funds**. Tenant isolation, key management, auth, metering, observability, audit and operational controls remain incomplete.
- A finite scripted scenario is not an unconstrained autonomous financial operating system.
- External audit, circuit formal verification and independent novelty review are missing.
- UI requires genuine cross-viewport visual and accessibility review.
- Editable revised pitch deck is not yet built for the interactive upgrade.

## Supporting documents

- `docs/PROGRESS.md`: implementation and CI status.
- `docs/VERIFICATION_MATRIX.md`: explicit evidence gate status.
- `docs/INTERACTIVE_DEMO.md`: local startup and API.
- `docs/KNOWN_LIMITATIONS.md`: broader existing limitations.
- `docs/PRIOR_ART.md`: prior-work comparisons; no absolute world-first claim.
- `docs/SECURITY.md`: original system threat model.
- `docs/REPRODUCIBILITY.md`: historical evidence reproduction.

## Non-negotiable

Never represent a successful Anvil transaction as a new Sepolia hash; never conflate an Anthropic engine configured in process memory with successful model inference; do not silently lower the owner mandate's authorization requirements.
