/**
 * The verification kernel: its one entry point (K2; apps/qed-demo/KERNEL.md states the boundary, the guarantees and
 * what it does not guarantee).
 *
 * The kernel is the deterministic rules that decide whether money may move: pure functions of what they are given,
 * exact where money is counted, with no clock, network, database, chain, model or randomness of their own. Its callers
 * turn their own records into the rules' inputs and act on the verdicts:
 *
 *   the server  plan checks: Checker A (the X5 exact checker) and Checker B (the independently written X7 checker)
 *               decide whether a household plan may be signed (server/programs.ts, server/household.ts);
 *   the lab     guarantee-or-abstain certificates (server/lab.ts);
 *   the co-signer  the authority budget of check C12: R7 decision D7 with K1's earned-authority netting and caps,
 *               replayed from the chain by chain/rail/authority-ledger.ts, which the co-signer, the payment preview
 *               and the escrow's job view share.
 *
 * Everything here is re-exported unchanged from the module that defines it: the same function objects, so a caller that
 * moves to this entry point behaves exactly as before (shared/kernel/index.test.ts checks it).
 */

// ── plan checks (the server) ──
export { exactCheck, ledger as planLedger, scenarios as planScenarios, validatePlan, DEBT_KEYS, PLAN_KEYS, X5_DEFAULT, ZERO_PLAN } from './x5.ts'
export type { DebtKey, LedgerResult, Plan, PlanKey, Scenario, ScenarioOutcome, Shock, X5Model, X5Verdict } from './x5.ts'
export { CHECKER_B_AVAILABLE, checkerB } from './checkerB.ts'
export type { CheckerBVerdict } from './checkerB.ts'

// ── guarantee-or-abstain certificates (the lab) ──
export { check as checkCoverage, CHECKER_VERSION as COVERAGE_CHECKER_VERSION, dayNum, isoOf, requestHash as coverageRequestHash } from './coverage.ts'
export type { Level as CoverageLevel, Outcome as CoverageOutcome, Reason as CoverageReason, Request as CoverageRequest } from './coverage.ts'

// ── the authority budget (the co-signer's check C12) ──
export { addQ, AuthorityBudget, band, ceilQ, CIRCULAR_KINDS, cmpQ, exactBand, floorQ, mulQ, NUMERAIRE, parseQ, q, RAISING_KINDS, Refused, replay as replayAuthority, scaleQ, showQ, subQ, UNVALUED } from '../../chain/rail/authority.ts'
export type { Band, Entry as AuthorityEntry, Params as AuthorityParams, Q } from '../../chain/rail/authority.ts'
export { checkCap as checkEarnedCap, DEFAULT_EARNED_CAP, defaultEarnedCap, EarnedLedger } from '../../chain/rail/earned-authority.ts'
export type { EarnedCap, EarnedCredit } from '../../chain/rail/earned-authority.ts'
