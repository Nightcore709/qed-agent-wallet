# QED Interactive Agent — implementation preview

> **Status: development branch / local demonstration.**
> The original public GitHub Pages proof ledger remains intact. This new frontend is
> served by the local Node backend and must not be mistaken for a hosted AI-wallet service.

## Start in one command

Prerequisites: Node 22.x, npm, Foundry 1.7.1 with \`anvil\` and \`forge\` on PATH.

On a Mac where QED is already cloned:

\`\`\`bash
cd ~/Desktop/qed-agent-wallet
git fetch origin
git switch qed-interactive-agent-demo-20261020
npm ci
forge build
npm run test:demo
npm run demo
\`\`\`

Open **http://127.0.0.1:4173** in the same computer's browser. Use **Execute permitted scenario**.

This is a **fresh, real, disposable Anvil blockchain run** with deterministic dev identities
and valueless synthetic tokens. The existing QED execution script deploys actual Solidity
contracts, consumes the natural-language input through the genuine QED brain and guard,
obtains the co-signer certificate, executes optimal conversions and replays deliberate
reverted attacks. Live events are read from its *newly generated* manifest as the run
progresses. The interface distinguishes off-chain refusals, mined reverts and accepted
local transactions. Local transaction hashes cannot be looked up on Sepolia Etherscan.

**The owner mandate is deliberately constrained**: only a 20 tUSD conversion into the
approved euro reserve is accepted. This is an operator-controlled demonstration, not a
general-purpose financial assistant or a chat app that can authorize arbitrary transfers.
The user-supplied text is interpreted by QED's real brain; subsequent scenario phases
are scripted. The execution process and short policy loop end automatically; this is not
a persistent wallet scheduler.

At most one execution may run at a time. Four runs per hour are allowed per connecting
IP. Only use locally by default. This server is **not hardened for exposure to the
public internet**; do not set \`QED_PUBLIC_DEMO=1\` or expose its signing process
without adding authentication, isolated tenant chains, stronger abuse prevention,
a cloud secret manager, and explicit public-demo authorization.

## Optional real Anthropic API

If \`ANTHROPIC_API_KEY\` is set in the **same terminal that starts** \`npm run demo\`,
QED's existing brain attempts real Anthropic interpretation of the supported request.
If no API key is configured, it uses the transparently labeled offline deterministic
parser. If the API call fails, the original QED fallback is recorded explicitly
as \`offline-fallback (...)\`.

Do not paste the key into GitHub, browser JavaScript, issues, chat messages, logs or
screenshots. Do not put it into \`product/index.html\` or the dashboard. An Anthropic
API key pays for API calls; a chat subscription does not substitute for it.

## Historical vs. fresh evidence

- **Fresh local execution:** results are generated under \`evidence/demo-runs/<run-id>/\`,
  which is excluded from Git. The frontend shows these receipts as Anvil 31337.
- **Historical public execution:** source \`evidence/ethereum-sepolia/\` and the
  original GitHub Pages dashboard. The new site presents curated direct Etherscan
  links as public historical evidence, never as freshly submitted transactions.
- **Independent public checks:** \`npm run verify\`, requiring a suitable public Sepolia RPC.

Existing source contracts, mathematical algorithms, canonical evidence, and the original
GitHub Pages site are deliberately unchanged.

## API (localhost only)

- \`GET /api/health\` — server readiness and non-secret model configuration
- \`GET /api/config\` — supported demonstration environments
- \`POST /api/run\` — start a preapproved local workflow
- \`GET /api/run/:id\` — run status, recorded transaction receipts, policy decisions
- \`GET /api/run/:id/events\` — SSE progress (replay of buffered events for reconnect)

A supported request is:

\`\`\`json
{"scenario":"execution","instruction":"Move 20 tUSD into the euro reserve.","impact":150}
\`\`\`

The endpoint is **not** a general execution or remote signing API. Unsupported amount,
payee and policy changes are rejected before launching a blockchain process.

## Verification and limits

Run:

\`\`\`bash
npm run test:demo
npm run test:ts
npm run typecheck
forge test
\`\`\`

The new demo tests validate input restrictions but they are **not substitutes for
a browser-to-smart-contract acceptance run**. See results in actual CI and local
testing before describing this branch as verified.

The baseline existing project has 145 Solidity tests and 60 TypeScript tests, plus
244 Sepolia verification checks in the earlier documented run. The new application has
not been deployed as a hosted public service, and the UI is not yet connected to a
persistent off-chain scheduler. Keep all those limitations explicit to judges.

The UI is an **interactive local runnable prototype** with direct execution logs,
not a production-ready agent wallet, not a financial product for real funds, and
not externally audited.
