/**
 * Test support (R13 S8): one household's journey (salary, a goal saved for, a payment, a draft instruction) read through the
 * same view functions the screens' routes call, flattened to the text a person reads. Used to prove that moving every money
 * call to the home-currency formatter leaves an Indian household's text byte for byte as it was (the golden file is the
 * text written by the build before the move), and to read a household's figures in another home currency.
 */
import { confirmApproval } from './approvals.ts'
import { istInstant } from './core.ts'
import { stepAllActions } from './execute.ts'
import { liquidity, authorityEnvelope } from './liquidity.ts'
import { addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { goalsView } from './goals.ts'
import { householdHome } from './home-currency.ts'
import { moneyView } from './fx.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { statement } from './statement.ts'
import { type Kit } from './testkit.ts'
import { homeView, listActions, listPrograms, needsYou, noticesView, passbook } from './views.ts'
import { periodOf } from '../shared/period.ts'

async function cycle(k: Kit): Promise<void> {
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}

export interface Journey { goalId: string; paid: string }
/** Opening, a goal signed, a payment to a payee paid and settled, and one draft instruction. */
export async function runJourney(k: Kit, opts: { goal?: Record<string, unknown>; pay?: number } = {}): Promise<Journey> {
  const goal = saveDraft(k.ctx, k.userId, { kind: 'goal', params: opts.goal ?? { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }, authority: { runMode: 'auto' } })
  const req = requestProgramApproval(k.ctx, k.userId, goal.programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, goal.programId, req.approvalId)
  const payee = addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, k.clock.now())
  const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: opts.pay ?? 150_000 })
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  submitApprovedAction(k.ctx, k.userId, pv.approvalId)
  await cycle(k); k.clock.advance(3000); await cycle(k)
  k.clock.advance(Math.max(0, istInstant('2026-12-02', '10:00') + 1000 - k.clock.now())); await cycle(k); await cycle(k)
  return { goalId: goal.programId, paid: pv.approvalId }
}

/** Every screen's server text for the household, read at the kit's clock. */
export function screenViews(k: Kit): Record<string, unknown> {
  const now = k.clock.now()
  return {
    home: homeView(k.db, k.market, k.userId, now),
    liquidity: liquidity(k.db, k.userId, now),
    envelope: authorityEnvelope(k.db, k.userId, now),
    passbook: passbook(k.db, k.userId, now, 200),
    statement: statement(k.db, k.userId, now, periodOf('all', now), 200),
    needs: needsYou(k.db, k.userId, now),
    notices: noticesView(k.db, k.userId, now),
    goals: goalsView(k.db, k.userId, now),
    programs: listPrograms(k.db, k.userId, now),
    actions: listActions(k.db, k.userId, { limit: 50, now }),
    ...(householdHome(k.db, k.userId) === 'INR' ? { money: moneyView(k.ctx, k.userId) } : {}),
  }
}

const MASKS: [RegExp, string][] = [[/\b(?:usr|acc|act|prg|prv|run|apr|ntc|ent|rcp|pay|bil|gol|ord|cnv)_[0-9a-z]{6,}\b/g, '<id>'], [/\b[0-9a-f]{24,}\b/g, '<hash>'], [/\b[a-z]{2,4}_[0-9a-z]{12,}\b/g, '<id>'], [/PAPER\d+/g, 'PAPER<n>'], [/document [0-9a-f]{12}…/g, 'document <hash>…']]
/** One line per leaf, "path = text", ids and hashes masked: a stable, readable form to compare byte for byte. */
export function flatten(v: unknown, path = '$', out: string[] = []): string[] {
  if (v === null || v === undefined) out.push(`${path} = null`)
  else if (Array.isArray(v)) { if (!v.length) out.push(`${path} = []`); v.forEach((x, i) => flatten(x, `${path}[${i}]`, out)) }
  else if (typeof v === 'object') { const o = v as Record<string, unknown>; const ks = Object.keys(o).sort(); if (!ks.length) out.push(`${path} = {}`); for (const key of ks) flatten(o[key], `${path}.${key}`, out) }
  else { let s = typeof v === 'string' ? JSON.stringify(v) : String(v); for (const [re, to] of MASKS) s = s.replace(re, to); out.push(`${path} = ${s}`) }
  return out
}
