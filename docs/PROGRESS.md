# QED live progress log — 20 October 2026

Branch `qed-interactive-agent-demo-20261020`. The original submission is preserved unchanged: `main` = tag
`qed-original-submission-20261020` = `fac6910` (145 Solidity + 60 TS tests, 196 Sepolia transactions, verify 244/244,
deck and PDFs, GitHub Pages ledger). Statuses: PASS / PARTIAL / FAIL / BLOCKED / NOT VERIFIED.

| Milestone | What changed | Evidence | Status |
|---|---|---|---|
| Original backup | Tag `qed-original-submission-20261020` → `fac6910`; `main` not modified | `git rev-parse main origin/main` = `fac6910` | PASS |
| Live sandbox chain | `agent/src/sandbox.ts`: one persistent Anvil chain with the unchanged QEDVault, QEDLens, QEDExecution and five venues; every app action is a real transaction | Local run: blocks, receipts, balances read back from the chain | PASS (local) |
| Variable amounts | Any amount within the signed mandate; the owner's number governs; amounts in words read by Claude are confirmed as a canonical instruction | `npm run test:sandbox`: 10 and 22.5 tUSD executed, each ≤ 1 ppm below the on-chain bound; treasury −32.5 tUSD, reserve up | PASS (local) |
| Refusals | Over-limit amounts refused before any signature; the co-signer's reserve buffer is shown in the pre-check | 80 tUSD refused, no transaction; co-signer C10 refusal observed in the browser | PASS (local) |
| Inferior route | Security Lab: six attacks from a genuine co-signed order | `inferior-route` and `skim` mined as `NotBestExecution`, `redirect` as `OrderMismatch` | PASS (local) |
| Treasury policy | Sandbox owner signs a target; ticks convert until met, then stop | Target 45 tEUR: tick 1 converted (limited by need), ticks 2–3 "target met", no transaction | PASS (local) |
| Sandbox-owner mandate | Owner can sign a new per-conversion limit (1–100 tUSD); the AI cannot | Mandate v3 ≤ 40 tUSD signed, then 35 tUSD executed | PASS (local) |
| Real AI | Claude (`claude-sonnet-5-5`) when `ANTHROPIC_API_KEY` is set; labelled deterministic fallback otherwise | Local with key: "twenty two and a half dollars" → 22.5 tUSD proposal; prompt injection refused with flags; grounded explanation of the last trade | PASS (local) · hosted: NOT CONFIGURED |
| Questions vs transactions | `/api/agent` never executes; proposals need the owner's confirmation | API returns `execution: "none"` for every answer, check and proposal | PASS |
| Scripted economies | Run paid work/escrow, clearing, zero-knowledge, full execution on a fresh chain | `privacy` scenario through the API: exit 0, 21 steps, 16 s | PASS (local) |
| UI | Responsive fixes (no horizontal scroll at 390 px in any view), buttons, formula, suggestion row | Playwright screenshots at 1440 and 390 px of all seven views; agent flow driven in a browser | PASS (local render) |
| Public deployment | Railway `qed-judges-preview-production.up.railway.app`, redeployed from the branch | 13:23 UTC, from an external browser: new UI served; `/api/health` sandbox ready; question → check (no execution); 10 and 22.5 tUSD executed (blocks 34–35); 80 refused; inferior route reverted `NotBestExecution`; policy target 40 → tick converted, next tick stopped; scripted clearing economy exit 0 (31 steps, 7 reverts); UI flow "Convert 15 tUSD" confirmed on-chain; sandbox reset afterwards | PASS (offline parser; no model key on Railway) |
| CI | `test:demo:e2e` runs the sandbox test and the scripted e2e one at a time; agent job pins Foundry 1.7.1 (as the Docker image) | `690e416`: agent job PASS (type-check, 60 TS tests, `test:demo`, `test:demo:e2e`, all four local economies, benchmarks); Sepolia verify PASS; Solidity job PASS on earlier branch commits with unchanged contracts. Cause of the earlier red: CI installed a newer Foundry than 1.7.1 | PASS |

## Remaining

1. Done: Railway redeployed and verified end to end (see table).
2. Optional: add `ANTHROPIC_API_KEY` as a Railway service variable for live Claude (capped at 400 calls).
3. Done: CI green on `690e416` (agent + verify; Solidity unchanged).
