# QED verification matrix — 20 October 2026

PASS = observed with the stated evidence; PARTIAL = some evidence, gaps listed; BLOCKED = cannot be done from this
session; NOT VERIFIED = no evidence. "Local" means a local Anvil chain, never Sepolia.

| Requirement | Status | Evidence |
|---|---|---|
| Original submission preserved | PASS | tag `qed-original-submission-20261020` = `main` = `fac6910` |
| 145 Solidity tests | PASS | CI on `e06b48b` (Solidity job success); contracts unchanged on this branch |
| 60 TypeScript tests | PASS | CI `c688445` agent job success; no engine changes since |
| Historical Sepolia verification (244 checks) | PASS | CI verify job success on `e06b48b` |
| Convert 10 tUSD (live) | PASS (local) | `test:sandbox`; tx mined, gap 0.329 ppm |
| Convert a different amount (22.5 tUSD) | PASS (local) | `test:sandbox`; gap 0.200 ppm |
| Policy-cap refusal (80 tUSD) | PASS (local) | refused before signing, no tx |
| Real co-signer decision | PASS (local) | 11 checks, signed order with floor; a C10 buffer refusal observed |
| Certified route + real receipt + changed reserve | PASS (local) | receipt status success; reserve and treasury reconciled |
| Inferior-route rejection | PASS (local) | `NotBestExecution` revert mined |
| Treasury policy stops at target | PASS (local) | tick → executed, next ticks → no action |
| Live Claude interpretation | PASS (local) / NOT CONFIGURED (hosted) | engine `anthropic:claude-sonnet-5-5` in responses |
| Fallback honestly labelled | PASS | engine field and top-bar chip show "offline parser" |
| UI responsive, no horizontal scroll | PASS (local) | Playwright at 390 px, all views |
| Public HTTPS app serves the new build | PASS | title "QED — AI can decide…", `/api/health` `"sandbox":"ready"`, 13:23 UTC |
| Public end-to-end (browser → receipt) | PASS | external browser: 10, 22.5 and 15 tUSD executed with receipts; 80 refused; `NotBestExecution` revert; policy stop; scripted clearing run exit 0 |
| `test:demo:e2e` on CI | PASS | agent job success on `690e416` after pinning Foundry 1.7.1 |
| Multi-tenant isolation, key management, audit | NOT VERIFIED | shared sandbox, dev keys, not audited — testnet prototype only |
