# QED — Submission checklist

FinTechathon 2026 · International Track · Topic F. Deadline: **20 Oct 2026, 23:59 Beijing time (UTC+8)** =
15:59 UTC = **21:29 IST**. Submissions may be updated until then; the latest version received counts.

Status: **READY** = the file exists, is final and was checked; **TEAM STEP** = only the team can do it.

## 1. The competition's six items

| # | Item (official wording) | What we submit | Status |
|---|---|---|---|
| 01 | Technical documentation: system architecture, core algorithm description, security design | `docs/pdf/QED-Technical-Documentation.pdf` (built from ARCHITECTURE, ALGORITHMS, PROTOCOL_SPECIFICATION and the security design); sources in `docs/` | READY |
| 02 | Presentation deck, final presentation no longer than 10 minutes | The Slides artifact *QED Pitch Deck* (15 slides + 8 backup slides, speaker notes timed at 9:30); `presentation/QED-Pitch-Deck.pdf`; script `presentation/SCRIPT.md` | READY · **TEAM STEP:** fill `[Team name]` on slides 1 and 15, then export PowerPoint from the deck's menu if a .pptx is wanted |
| 03 | Demo video (optional, no longer than 5 minutes) | Shot-by-shot script with narration: `presentation/SCRIPT.md` §3 (≈ 4:55) | **TEAM STEP:** record and attach or link |
| 04 | Source code with README, GitHub repository link, deployment instructions and test cases | <https://github.com/Nightcore709/qed-agent-wallet>: `README.md`, `docs/DEPLOYMENT.md`, `docs/REPRODUCIBILITY.md`, `docs/TESTING.md` (145 Solidity + 60 TypeScript tests, all passing, CI green) | READY |
| 05 | Security self-assessment report: permission-tier implementation and known-risk list | `docs/pdf/QED-Security-Self-Assessment.pdf` (from `docs/SECURITY.md`: permission tiers §2, properties I1–I26, threat model §4, known risks K1–K29, key lifecycle, incident response) | READY |
| 06 | Execution evidence: for the on-chain topic, real on-chain transaction hashes | `docs/pdf/QED-Execution-Evidence.pdf` and `docs/EVIDENCE.md`: all 196 Ethereum Sepolia transactions with blocks, gas and errors; re-derivable with `npm run verify` | READY |

**Email** to fintechathon@ican-x.com before 21:29 IST, from the registered team: **TEAM STEP.** A ready-to-paste
email with the transaction hashes is in the submission kit.

## 2. Topic F's four outcomes, each with a public transaction

| Outcome | Transaction (Ethereum Sepolia) |
|---|---|
| O1 · a separate AI-agent key executes under an independent policy certificate | L4 `0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6` (payment) · E1 `0x56f798cd321e0d85ba6a7b1425dd7b12f04db386a81bf0e67c94374f12f19690` (trade) · PE1 `0xaaa0bacddd313493ff89f08f25f86b5f5eb294423b517bdf16c5489626a0c9ff` (agent-initiated trade) · QE1 `0x12739525e1a11bdcc6921f0eef5dffa3ab1bcb63b9fcd5bc544dda24dbb341c8` (agent-initiated, through the on-chain policy) |
| O2 · a paid-work lifecycle ends in a real escrow settlement | L6 `0x4166253f06143b2a07b3c77fb4d4603a33e84f3b6706363f0d727f485f9335f9` · Z3 `0xbb619bf09eebacd240514eab5ec4a03c189612954101b07c59a11fa56f612ec7` |
| O3 · an adversary cannot violate a protected liability or tamper with signed terms | 48 reverted attacks, e.g. EA1 `0xccd07d1790d002a173435e216c80f0c305e3a10dd0c720548b38d50cd9b54937`, QA2 `0xb49d0c4f40dbeb6e66bc764ed96f3054e701be7d3e5932c03b3e6d72cd23f9f3` (over-conversion with both hot keys stolen), X6 `0xf9a023d734d08dd2c66b20085576be74773c0d4a71ae2e7b7f655be29c63c018`; creditor paid during a pause: P3 `0x9f4a753c58da0f5831d705973f9b0b5c484fa9baa68e47b8a7dc994a46a4135d` |
| O4 · an external reviewer can reproduce everything | `npm run verify` (no keys), in CI on every push and daily; 24 contracts verified on Sourcify |

## 3. The upgrade brief's deliverables (A–L)

| | Deliverable | Where | Status |
|---|---|---|---|
| A | Upgraded repository | GitHub `main` | READY |
| B | Implementation changelog | `docs/SELF_REVIEW.md` §3 | READY |
| C | Defining innovation, with mathematics and a working demonstration | README lead section; ALGORITHMS §12; Sepolia E1, EA1–EA8, PE1–PE2; dashboard *Execution* | READY |
| D | Architecture and technical documentation | `docs/` (index: `docs/README.md`) | READY |
| E | Security report | `docs/SECURITY.md`, PDF | READY |
| F | Test evidence and a list of unverified components | `docs/TESTING.md`; CI; `docs/KNOWN_LIMITATIONS.md` §7 | READY |
| G | Blockchain evidence | `docs/EVIDENCE.md`, `evidence/`, `relay/`, PDF | READY |
| H | Interface | <https://nightcore709.github.io/qed-agent-wallet/> (also `dist/qed-proof-ledger.html`, one file, works offline) | READY |
| I | Editable PowerPoint, presentation PDF, speaker notes, timed script, judge questions | Slides artifact (exports .pptx and .pdf), `presentation/` | READY · PowerPoint export is one click (team) |
| J | Reproducibility | `docs/REPRODUCIBILITY.md` | READY |
| K | This checklist | `docs/SUBMISSION_CHECKLIST.md` | READY |
| L | Final ruthless evaluation | `docs/SELF_REVIEW.md` §4 (scores before and after) and §8 (quality gates) | READY |

## 4. Before you press send

- [ ] Team name, members and universities on slides 1 and 15 (and `[team]` in slide 1's speaker notes).
- [ ] Rehearse the talk once with a timer (target 9:30).
- [ ] Record the video from `presentation/SCRIPT.md` §3; keep it under 5:00.
- [ ] Attach the three PDFs from `docs/pdf/` and the deck (PDF, or .pptx exported from the deck).
- [ ] Paste the email from the submission kit; check the repository link opens while signed out.
- [ ] Send before 21:29 IST. A later re-send replaces the earlier one until the deadline.

## 5. Known gaps we are not hiding

The policy contract enforces safety, not liveness (K28); runs are separate
deployments; venues are constant-product only; nothing is audited. Full list: `docs/KNOWN_LIMITATIONS.md`.
