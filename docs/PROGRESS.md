# QED live progress log — October 20, 2026

> Source-of-truth branch: `qed-interactive-agent-demo-20261020` in `Nightcore709/qed-agent-wallet`. Original `main` and published Sepolia evidence preserved. This log records what is actually supported; it is not a production certification.

| Milestone | Implementation | Verification / evidence | Status |
|---|---|---|---|
| Existing smart-contract system | Unchanged original financial and cryptographic modules | Baseline user-run 145/145 Foundry tests; CI reproduced Solidity test suite on earlier branch commits | TESTED |
| Historical Sepolia execution | Existing canonical manifests and verifier | User-run 244/244 checks; CI `npm run verify` passed on earlier feature commit | VERIFIED BY PROJECT CHECKER |
| New interactive frontend | `product/index.html` | Browser render/responsiveness not yet fully inspected; user ran first real demo locally | PARTIAL |
| Browser → Anvil | `agent/scripts/demo-server.mjs`, existing `execute.ts` | User reported completed local 20 tUSD demo; GitHub Actions reproduced a fresh trade and actual EA1 revert before the first acceptance test timed out | PARTIAL |
| Variable amounts | Signed mandate limit: at most 25 tUSD per conversion; forwarded unmodified to existing QED brain and guard | New 10 tUSD E2E acceptance test created. No confirmed CI pass yet | IMPLEMENTED; NOT VERIFIED |
| Ambiguous/unsafe requests | Amount parser, permit-bound request checks, read-only `/api/chat` and limited public scenarios | New validation suite and CI test exist; latest result pending | IMPLEMENTED; NOT VERIFIED |
| Hosting | Railway `qed-fintechathon-demo` → `Nightcore709/qed-agent-wallet` development branch | Railway built Docker image with pinned Anvil and passed `/api/health`; host domain routed to deployed port 8080 | BUILD/HEALTH VERIFIED; EXTERNAL E2E NOT VERIFIED |
| Real Anthropic in public deployment | Server-only API credential supported | Hosted service deliberately runs deterministic fallback; no Anthropic key provisioned in Railway | NOT CONFIGURED |
| Persistent autonomous runtime | Existing scripts execute a finite treasury policy loop | Existing local and Sepolia policy receipts | SCRIPTED; NOT A DAEMON |
| Production authorization and isolation | Demo pre-authorized owner and deterministic development keys | Not safe for real money; public service has basic limits and no tenant-isolated wallets | PROTOTYPE ONLY |
| Competition deliverables | Existing PDF technical docs, security self-assessment, deck, scripts, evidence | Canonical files remain on main; new editable deck and visual QA not completed | EXISTING MATERIALS PRESERVED |

## Important adversarial caveats

- The model may interpret proposed instructions, but it is **not authorized to change owner mandates**, sign as arbitrary wallets or bypass the independent co-signer.
- A 10 tUSD conversion is a fresh local blockchain operation; a local transaction hash is **not** a Sepolia transaction.
- `QEDTreasuryPolicy`'s owner-approved market is a set of constant-product pools, **not the entire DeFi market**.
- Existing zero-knowledge Groth16 private-optimality proof capability is documented, but is **not a world-first claim**.
- Neither the QED contracts nor hosted backend have had an external production security audit.
- A hosted frontend and a healthy backend are necessary but **not sufficient** for calling the application ready for judges.

## Next priority gates

1. Get the latest `npm run test:demo:e2e` passing on CI with a non-20 tUSD input.
2. Verify the public Railway domain from an external client, and inspect proof/receipt state transitions.
3. Check server-side Anthropic engine and fallback labeling, and resolve API-key provisioning privately if authorized.
4. Improve real state management and independent read-only receipt verification.
5. Complete layout visual inspection and produce updated 10-minute pitch and security appendix grounded in verified results.

## Release policy

No automatic merge or replacement of the existing GitHub Pages site until all P0 regression tests, local end-to-end evidence, and deployment health checks have been verified.
