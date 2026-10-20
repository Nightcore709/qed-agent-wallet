# QED — final handoff (20 Oct 2026)

**Original submission (untouched):** `main` = tag `qed-original-submission-20261020` = `fac6910`.
**Development branch:** `qed-interactive-agent-demo-20261020` (draft PR #1). Baseline at sprint start: `076601d`.
**Live app:** https://qed-judges-preview-production.up.railway.app/ (verified end to end 13:23 UTC; see `docs/PROGRESS.md`).
**Sepolia proof ledger:** https://nightcore709.github.io/qed-agent-wallet/

## Final sprint deliverables

| Deliverable | Path | Status |
|---|---|---|
| Final pitch, editable | `presentation/QED-Final-Pitch.pptx` (11 main slides + appendix A1–A15, speaker notes, 4 sections) | DONE · validated, every main slide rendered and inspected |
| Final pitch, PDF (rendered from the PPTX, so they match) | `presentation/QED-Final-Pitch.pdf` | DONE |
| Timed script | `presentation/FINAL_SCRIPT.md` (1,259 words ≈ 9:21) | DONE |
| Judge Q&A | `presentation/FINAL_JUDGE_QA.md` (12 new product/commercial answers + the full technical Q&A) | DONE |
| Frontend | `product/index.html` | unchanged in this sprint (polished and verified at 390/1440 px earlier today) |

## Decisions

- Budget and deadline: the deck is the priority; no frontend redesign late in the day (risk to a verified, deployed app).
- Team names are not known to us: the deck carries no placeholder; add names on slides 1 and 11 if the organisers require them.

## Pitch structure

1 Opening question · 2 Problem (a floor is not a proof) · 3 Idea (AI proposes → co-signer re-derives → contract verifies → settles or reverts) · 4 Breakthrough (output ≥ (1 − τ)·B) · 5 Sepolia E1 (20 → 18.086846, bound 18.086849, 0.17 ppm) · 6 The live app (real screenshot) · 7 Autonomy (Runs 4c/4d) · 8 Three attacks with public receipts (EA1, X6, QA2) · 9 Why it matters, business hypothesis, not yet validated · 10 Prior art · 11 Close with the three links. Appendix keeps every technical slide of the original deck.

## To continue

The deck is generated from HTML slides: `scratchpad/final/build_slides.py` + `notes.json` → `topptx.mjs` (Playwright + pptxgenjs).
To edit text, open the .pptx directly in PowerPoint/Keynote/Google Slides; everything is native text, tables and shapes.
