# QED verification and submission matrix — 2026-10-20

Meaning of statuses: **VERIFIED** = cryptographic/on-chain evidence rechecked via existing project verifier or confirmed CI, **TESTED** = observed passing local or CI tests, **IMPLEMENTED** = source exists but exact feature unproven, **PARTIAL** = incomplete or outstanding QA, **NOT VERIFIED** = evidence not supplied.

| Requirement | Status | Evidence | Required next gate |
|---|---|---|---|
| Preserve `Nightcore709/qed-agent-wallet` and Git history | VERIFIED | Feature branch and draft PR #1 preserve `main` | Review diff before merge |
| Original 145 Solidity tests | TESTED | Earlier local run and GitHub Actions full Solidity job | Confirm final head SHA check |
| Original 60 TypeScript tests | TESTED | Earlier local and CI runs | Confirm final head SHA check |
| Historical Sepolia verification | VERIFIED BY QED CHECKER | Existing `npm run verify`: 244/244 checks, repeated in CI | Keep original manifest immutable |
| Real local trade and co-signer | TESTED BASELINE | Original run and first new browser E2E CI log: E1 mined success | Re-run non-default quantity acceptance |
| Genuine refused attack receipt | TESTED BASELINE | Existing EA1 Sepolia evidence and new live local CI EA1 revert | Check final head SHA |
| UI natural-language questions | IMPLEMENTED | New read-only `/api/chat`, real QED brain and guard | API test, model fallback and visual QA |
| UI variable trade amounts ≤25 tUSD | IMPLEMENTED | Request parser, signed mandate, adaptive ring fence | New 10 tUSD E2E gate |
| Amounts >25 tUSD refused | IMPLEMENTED | API rejects before signer with signed cap explanation | Validate 80 tUSD, malformed/multi-amount cases |
| Safe independent authority | TESTED BASELINE | Original vault, co-signer and policy contracts | Threat-model public backend separately |
| Real Anthropic integration on host | NOT VERIFIED | Existing Anthropic client; no hosted key | Privately configure key and test real call |
| Public HTTPS application | PARTIAL | Railway Docker build + /api/health healthcheck and generated domain | External browser E2E |
| Tenant isolation/production readiness | NOT VERIFIED | Current public bounded demo reuses deterministic test keys | External security audit / key management / per-session chain |
| UI design accessibility, responsive QA | PARTIAL | New frontend implementation | Screenshots at desktop/mobile, functional checks |
| Novelty and prior art | PARTIAL | Existing `docs/PRIOR_ART.md` | Validate incremental claims; do not assert world first |
| Final deck, script and PDF | EXISTING ASSETS ONLY | Canonical materials on original `main` | Update screenshots, revise any new claims |
| Security assessment | EXISTING ASSET ONLY | Original `docs/SECURITY.md`, self-assessment PDF | Add interactive-service threat model |
| Submission action | NOT VERIFIED | No actual competition portal submission evidence | Team must submit before 23:59 Beijing |

Never present local Anvil transactions as new Sepolia receipts, a hosted offline model as live Anthropic, or a static dashboard as unrestricted financial execution.
