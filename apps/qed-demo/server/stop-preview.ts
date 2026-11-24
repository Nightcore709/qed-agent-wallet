/**
 * What pausing QED changes in the next two weeks, for the pause sheet (R12 task comparison, T6-b; the adversarial
 * review of R12, L2): every scheduled run of every instruction in force that would fall in them (investing, parking idle
 * cash, rebalancing: each occurrence, not only the next) and every bill an instruction would pay, none of which happen
 * while paused; the bills no instruction pays, which stay the person's to pay whatever QED does; and what happens anyway
 * because QED does not do it (the bank's own loan instalments). Protective selling only watches, so it has no
 * occurrences to list; the sheet says what becomes of it.
 */
import { type Db, parse } from './core.ts'
import { KINDS } from './programs.ts'
import { nextDue } from './schedule.ts'
import type { Schedule } from './types.ts'
import { commitments } from './valuation.ts'

export interface StopItem { label: string; amount: number | null; dueAt: number; why: string }
const HORIZON_MS = 14 * 86_400_000
/** At most this many occurrences of one instruction are listed (a run every hour would be hundreds). */
const MAX_EACH = 31

export function stopPreview(db: Db, userId: string, now: number): { skipped: StopItem[]; yours: StopItem[]; continues: StopItem[]; horizonDays: number } {
  const until = now + HORIZON_MS
  const skipped: StopItem[] = [], yours: StopItem[] = [], continues: StopItem[] = []
  const progs = db.all<{ title: string; kind: string; next_due_at: number; params_json: string; authority_json: string }>(
    `SELECT p.title, p.kind, p.next_due_at, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version
     WHERE p.user_id = ? AND p.state = 'active' AND p.next_due_at IS NOT NULL AND p.next_due_at <= ?`, userId, until)
  for (const g of progs) {
    const params = parse<Record<string, unknown>>(g.params_json, {})
    const schedule = (KINDS as unknown as Record<string, { schedule?: (p: never) => Schedule | undefined }>)[g.kind]?.schedule?.(params as never)
    const why = parse<{ runMode?: string }>(g.authority_json, {}).runMode === 'approve' ? 'Not asked for while paused' : 'Does not run while paused'
    const amount = typeof params.amount === 'number' ? params.amount : null
    let at: number | null = g.next_due_at
    for (let n = 0; at !== null && at <= until && n < MAX_EACH; n++) { skipped.push({ label: g.title, amount, dueAt: at, why }); at = schedule ? nextDue(schedule, at) : null }
  }
  for (const c of commitments(db, userId, now, HORIZON_MS)) {
    if (c.kind === 'bill' && c.by) skipped.push({ label: c.label, amount: c.amount, dueAt: c.dueAt, why: `"${c.by.title}" does not pay it while paused` })
    else if (c.kind === 'bill') yours.push({ label: c.label, amount: c.amount, dueAt: c.dueAt, why: 'No instruction pays it, paused or not' })
    else if (c.kind === 'emi') continues.push({ label: c.label, amount: c.amount, dueAt: c.dueAt, why: 'Your bank takes it whether QED is paused or not' })
  }
  const byDay = (a: StopItem, b: StopItem) => a.dueAt - b.dueAt
  return { skipped: skipped.sort(byDay), yours: yours.sort(byDay), continues: continues.sort(byDay), horizonDays: HORIZON_MS / 86_400_000 }
}
