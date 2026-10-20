# QED app — the interactive treasury on a live sandbox chain

> Development branch `qed-interactive-agent-demo-20261020`. The original submission is preserved unchanged on `main`
> and as tag `qed-original-submission-20261020` (commit `fac6910`), including the GitHub Pages proof ledger.

## What it is

`product/index.html`, served by `agent/scripts/demo-server.mjs`, is the QED product interface. When the server
starts it boots **one persistent local Anvil chain** (`agent/src/sandbox.ts`, chain id 31337, valueless test tokens)
and deploys the same best-execution economy as Sepolia Run 4: three tokens, five owner-approved constant-product
venues, the unchanged `QEDVault` (tUSD treasury and tEUR reserve), `QEDLens` and `QEDExecution`. Every action in the
app is the real QED pipeline, not an animation:

```
your words → language layer (Claude if ANTHROPIC_API_KEY is set, else the labelled offline parser) → guard
→ signed-mandate limits → owner confirmation (sandbox owner key) → independent co-signer (re-quotes, 11 checks,
signs an order) → certified route + dual prices → QEDExecution.trade on-chain → receipt → reconciliation
```

The AI never holds a key and cannot change a limit. Questions never execute anything.

| Area | Depth | What you can do |
|---|---|---|
| Agent | **LIVE** | Ask anything; "Convert 22.5 tUSD to tEUR" becomes a proposal you confirm; "Would 80 tUSD violate my mandate?" is a check, never a transaction |
| Treasury | **LIVE** | Balances, ring-fenced liabilities, blast radius; sign a new mandate (1–100 tUSD per conversion) or a standing policy as the sandbox owner; run policy ticks until the target is met |
| Execution | **LIVE** | The last trade's route, proof prices, on-chain bound, gap in ppm, baseline routers, live venue reserves |
| Security Lab | **LIVE** | Six attacks sent as real transactions from a genuine co-signed order: inferior route, skim, forged proof, single pool (`NotBestExecution`), redirect (`OrderMismatch`), stolen order (`NotOperator`) |
| Economies | **SCRIPTED** | Run the complete scripted economies (paid work and escrow, certified clearing, zero-knowledge optimality, full best-execution run) on a fresh local chain with new receipts |
| Evidence | **HISTORICAL** | The 196 Ethereum Sepolia transactions and 24 Sourcify-verified contracts, never presented as your session's transactions |

The public sandbox is shared and resets to its initial state (100 tUSD, empty reserve, mandate ≤ 25 tUSD) after
15 minutes without an operation, or on **Reset sandbox**.

## Run it locally

```bash
git switch qed-interactive-agent-demo-20261020 && npm ci
npm run demo                       # http://127.0.0.1:4173 ; needs `anvil` (Foundry 1.7.1) on PATH
# optional: live model
ANTHROPIC_API_KEY=… npm run demo
```

## API

| Method and path | Effect |
|---|---|
| `GET /api/health` | status, AI engine, sandbox status |
| `GET /api/sandbox/state` | chain, roles, contracts, balances, mandate, policy, last trade, history |
| `POST /api/agent {message}` | grounded answer, check or proposal; `execution: "none"` always |
| `POST /api/sandbox/convert {instruction}` | job: full pipeline, returns steps, receipt and reconciliation |
| `POST /api/sandbox/attack {kind}` | job: one real attack transaction |
| `POST /api/sandbox/mandate {maxPerPayment}` · `/policy {targetFree}` · `/policy-tick` · `/reset` | owner actions and policy ticks |
| `GET /api/jobs/:id` | job progress (steps stream as they happen) |
| `POST /api/run {scenario}` · `GET /api/run/:id` | scripted economies (`execution`, `economy`, `clearing`, `privacy`) |
| `GET /api/evidence` | historical Sepolia index |

Limits: 30 chain operations and 60 questions per hour per client, global caps on operations, model calls (400) and
scripted runs; chain operations run one at a time.

## Tests

```bash
npm run test:demo        # request validation (7 tests)
npm run test:sandbox     # live sandbox acceptance: 10 and 22.5 tUSD executed within 1 ppm, 80 refused before signing,
                         # inferior route mined as NotBestExecution, standing policy converts then stops at its target
npm run test:demo:e2e    # the above plus the scripted execution economy through the browser API
```

## Limits (honest)

- Sandbox keys are deterministic development keys held by the server; the "owner" button exists so a visitor can
  play the owner. In production the owner signs in their own wallet.
- One shared chain for all visitors; no per-user isolation. Valueless tokens only. Not audited.
- The certificate covers the five owner-approved constant-product venues, not all of DeFi.
- Transactions here are local sandbox transactions, never Sepolia transactions; the Sepolia evidence is historical.
