/**
 * The run scheduler. Three small loops, each driven only by the database and the clock:
 *
 *   schedulerTick  claims time-driven occurrences; an occurrence whose time passed while the engine was not running
 *                  is recorded as missed and is never executed afterwards
 *   triggerTick    asks event- and market-driven programs whether an occurrence is due now
 *   runTick        moves each run forward: plan, ask or announce if the authority says so, execute, conclude
 *
 * An occurrence is claimed by inserting a row with a unique (program, occurrence) key, so two schedulers, a restart
 * or a duplicate event cannot produce a second run for the same occurrence. Each action's economic id is derived
 * from the program and the occurrence, so a run that is planned twice still executes once.
 */
import { PAUSE_REASON, pausedFor } from './dispute-pause.ts'
import { createApproval } from './approvals.ts'
import { AppError, audit, type Db, emit, ist, j, newId, notFound, parse, refused } from './core.ts'
import { createAction, notice, resolveNotices } from './execute.ts'
import { passwordWork } from './prepared.ts'
import { getProfile, TZ_VERSION, zoneOf } from './household.ts'
import { householdHome, withHome } from './home-currency.ts'
import { describeSchedule, amountText, kindSpec, loadProgram, nextDue, programEvent, type ProgramRow, rowToProgram, whenIst } from './programs.ts'
import { type Authority, type Ctx, type OrderParams, type PaymentParams, type PlannedAction, type RunState, TERMINAL_ACTION, TERMINAL_RUN } from './types.ts'
import { instrument } from './registry.ts'
import { balance } from './ledger.ts'
import { dayStart, monthStart, programUsage } from './liquidity.ts'
import { navEntitlement } from './venues.ts'
import { goalEndWords, goalReached, type GoalParams } from './goals.ts'
import { canonical } from '../shared/sha256.ts'
import { dayText, istDay } from '../shared/day-text.ts'
import { sha256hex } from './receipts.ts'

/** A scheduled time more than this far in the past was missed, not late. */
export const MISSED_AFTER_MS = 120_000
export const APPROVAL_WINDOW_MS = 24 * 3600_000
const PROTECTIVE_KINDS = new Set(['exit', 'floor'])

export interface RunRow { id: string; user_id: string; program_id: string; version: number; occurrence: string; state: RunState; trigger: Record<string, unknown>; due_at: number; created_at: number; started_at: number | null; finished_at: number | null; deadline_at: number | null; reason: string | null; decision: { plannedAt?: number; actions?: PlannedAction[]; summary?: string[]; owed?: string; neededBy?: number } }
export const runFromRow = (r: Record<string, unknown>): RunRow => ({
  id: String(r.id), user_id: String(r.user_id), program_id: String(r.program_id), version: Number(r.version), occurrence: String(r.occurrence), state: r.state as RunState,
  trigger: parse<Record<string, unknown>>(r.trigger_json, {}), due_at: Number(r.due_at), created_at: Number(r.created_at), started_at: (r.started_at as number | null) ?? null,
  finished_at: (r.finished_at as number | null) ?? null, deadline_at: (r.deadline_at as number | null) ?? null, reason: (r.reason as string | null) ?? null, decision: parse<RunRow['decision']>(r.decision_json, {}),
})

/**
 * RISK-064: a run uses the parameters and the authority stored beside a version, which the API writes together with
 * the document the owner signed. Every load compares them with that document (and the document with its hash), so
 * terms changed behind the API never run: the version is treated as missing and the owner is told once.
 */
const TERMS_DIFFER = 'Its stored terms differ from the document you signed, so nothing was done under it. Sign the instruction again to run it.'
function signedTermsDiffer(v: { params_json: string; authority_json: string; document: string; content_hash: string }): boolean {
  const doc = parse<{ params?: unknown; authority?: unknown }>(v.document, {})
  return sha256hex(v.document) !== v.content_hash || canonical(doc.params ?? null) !== canonical(parse(v.params_json, null)) || canonical(doc.authority ?? null) !== canonical(parse(v.authority_json, null))
}
function liveVersion(db: Db, p: ProgramRow, version: number | null = p.live_version): { params: Record<string, unknown>; authority: Authority; contentHash: string } | null {
  if (version === null) return null
  const v = db.get<{ params_json: string; authority_json: string; document: string; content_hash: string }>('SELECT params_json, authority_json, document, content_hash FROM program_versions WHERE program_id = ? AND version = ?', p.id, version)
  if (!v) return null
  if (signedTermsDiffer(v)) {
    const now = Date.now()
    notice(db, p.user_id, { level: 'warning', kind: 'program-terms-differ', title: `"${p.title}" will not run: its terms differ from what you signed`, body: TERMS_DIFFER, subject: p.id, dedupe: `program-terms-differ:${p.id}:${version}` }, now)
    audit(db, now, p.user_id, 'engine', 'program.terms-differ', p.id, { version })
    return null
  }
  return { params: JSON.parse(v.params_json) as Record<string, unknown>, authority: JSON.parse(v.authority_json) as Authority, contentHash: v.content_hash }
}
const termsDiffer = (db: Db, p: ProgramRow, version: number): boolean => {
  const v = db.get<{ params_json: string; authority_json: string; document: string; content_hash: string }>('SELECT params_json, authority_json, document, content_hash FROM program_versions WHERE program_id = ? AND version = ?', p.id, version)
  return !!v && signedTermsDiffer(v)
}

/** Claim one occurrence. Returns false when it was already claimed. */
function claim(ctx: Ctx, p: ProgramRow, version: number, occurrence: string, dueAt: number, trigger: unknown, state: RunState, reason: string | null): boolean {
  const now = ctx.clock.now()
  const id = newId('run', now)
  const terminal = TERMINAL_RUN.has(state)
  const ins = ctx.db.run(`INSERT OR IGNORE INTO runs (id, user_id, program_id, version, occurrence, state, trigger_json, due_at, created_at, finished_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, p.user_id, p.id, version, occurrence, state, j(trigger), dueAt, now, terminal ? now : null, reason)
  if (ins.changes > 0) emit(ctx.db, now, p.user_id, 'run', { id, programId: p.id, state })
  return ins.changes > 0
}

/**
 * Whether a stop holds this instruction. "Stop everything" stops everything, protective selling included, unless the
 * owner chose, when stopping, to keep protective selling running (R7-091).
 */
export function stoppedFor(db: Db, userId: string, kind: string | null): boolean {
  const u = db.get<{ stop_at: number | null; stop_protective: number }>('SELECT stop_at, stop_protective FROM users WHERE id = ?', userId)
  if (!u?.stop_at) return false
  return !(kind !== null && PROTECTIVE_KINDS.has(kind) && u.stop_protective === 1)
}

export function schedulerTick(ctx: Ctx): { claimed: number; missed: number; expired: number } {
  const { db } = ctx
  const now = ctx.clock.now()
  let claimed = 0, missed = 0, expired = 0

  // Authority that has run out ends the program, whatever its schedule says.
  for (const r of db.all<Record<string, unknown>>(`SELECT * FROM programs WHERE state IN ('active', 'paused') AND live_version IS NOT NULL`)) {
    const p = rowToProgram(r)
    const v = liveVersion(db, p)
    if (!v || v.authority.expiresAt > now) continue
    withHome(db, p.user_id, () => db.tx(() => {
      db.run(`UPDATE programs SET state = 'expired', next_due_at = NULL, updated_at = ? WHERE id = ?`, now, p.id)
      db.run(`UPDATE runs SET state = 'cancelled', reason = ?, finished_at = ? WHERE program_id = ? AND state IN ('due', 'awaiting_approval', 'objection_window')`, 'The program\'s authority ended before this run started.', now, p.id)
      programEvent(db, p.id, p.user_id, 'expired', 'engine', { expiresAt: v.authority.expiresAt }, now)
      // a goal's date has passed: what is set aside, how far short, and that it stays set aside until released (goals.ts)
      const said = p.kind === 'goal' ? goalEndWords(db, p.user_id, p.id, v.params as unknown as GoalParams, 'date') : { title: `${p.title}: authority ended`, body: `Its end date (${whenIst(v.authority.expiresAt)}) has passed. Nothing more will run. Sign a new version to continue.` }
      notice(db, p.user_id, { level: 'info', kind: 'program-expired', ...said, subject: p.id, dedupe: `expired:${p.id}` }, now)
    }))
    expired++
  }

  for (const r of db.all<Record<string, unknown>>(`SELECT * FROM programs WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at`, now)) {
    const p = rowToProgram(r)
    const v = liveVersion(db, p)
    if (!v) continue
    const schedule = kindSpec(p.kind).schedule(v.params)
    const stopped = stoppedFor(db, p.user_id, p.kind)
    let due = p.next_due_at!
    let missedHere = 0
    withHome(db, p.user_id, () => db.tx(() => {
      for (let i = 0; i < 200 && due <= now; i++) {
        const late = now - due
        const occurrence = schedule ? new Date(due).toISOString() : 'once'
        if (late > MISSED_AFTER_MS) {
          if (claim(ctx, p, p.live_version!, occurrence, due, { scheduled: due }, 'missed', `QED's engine was not running at ${whenIst(due)}. Nothing was executed for this occurrence, and it will not be executed late.`)) { missed++; missedHere++ }
        } else if (stopped) {
          claim(ctx, p, p.live_version!, occurrence, due, { scheduled: due }, 'skipped', 'You had stopped all autonomous activity.')
        } else if (db.get(`SELECT 1 FROM runs WHERE program_id = ? AND state IN ('awaiting_approval', 'objection_window')`, p.id)) {
          // An instruction that asks first asks once. Requests do not pile up behind one the owner has not answered.
          claim(ctx, p, p.live_version!, occurrence, due, { scheduled: due }, 'skipped', 'An earlier run of this instruction was still waiting for you, so this one was not started.')
        } else if (claim(ctx, p, p.live_version!, occurrence, due, { scheduled: due }, 'due', null)) claimed++
        const next = schedule ? nextDue(schedule, due) : null
        if (next === null) { due = Number.POSITIVE_INFINITY; break }
        due = next
      }
      // After a very long gap, skip ahead instead of listing every occurrence.
      if (due <= now && schedule) due = nextDue(schedule, now) ?? Number.POSITIVE_INFINITY
      db.run('UPDATE programs SET next_due_at = ?, updated_at = ? WHERE id = ?', Number.isFinite(due) ? due : null, now, p.id)
      if (missedHere > 0) {
        const day = db.get<{ n: number; first: number; last: number }>(`SELECT COUNT(*) n, MIN(due_at) first, MAX(due_at) last FROM runs WHERE program_id = ? AND state = 'missed' AND due_at > ?`, p.id, now - 86_400_000)!
        notice(db, p.user_id, { level: 'warning', kind: 'runs-missed', rolling: true, subject: p.id, dedupe: `missed:${p.id}`,
          title: `${p.title}: ${day.n} scheduled run${day.n === 1 ? ' was' : 's were'} missed in the last 24 hours`,
          body: `QED's engine was not running at ${day.n === 1 ? `the scheduled time (${whenIst(day.first)})` : `those times (${whenIst(day.first)} to ${whenIst(day.last)})`}. Nothing was executed for ${day.n === 1 ? 'it' : 'them'} and nothing will be executed late. Each is listed in the instruction's history.` }, now)
      }
    }))
  }
  return { claimed, missed, expired }
}

export function triggerTick(ctx: Ctx): number {
  const { db } = ctx
  const now = ctx.clock.now()
  let claimed = 0
  for (const r of db.all<Record<string, unknown>>(`SELECT * FROM programs WHERE state = 'active' AND kind IN ('bills', 'exit', 'floor', 'split')`)) {
    const p = rowToProgram(r)
    const spec = kindSpec(p.kind)
    const v = liveVersion(db, p)
    if (!spec.due || !v) continue
    if (stoppedFor(db, p.user_id, p.kind)) continue
    let hits
    try { hits = withHome(db, p.user_id, () => spec.due!(ctx, p, v.params, p.live_version!, now)) } catch (e) { notice(db, p.user_id, { level: 'warning', kind: 'trigger-error', title: `${p.title} could not be checked`, body: e instanceof Error ? e.message : String(e), subject: p.id, dedupe: `trigger-error:${p.id}` }, now); continue }
    for (const h of hits) {
      withHome(db, p.user_id, () => db.tx(() => {
        if (h.memo) db.run('UPDATE programs SET memo_json = ? WHERE id = ?', j(h.memo), p.id)
        if (typeof h.trigger.unevaluable === 'string') {
          notice(db, p.user_id, { level: 'warning', kind: 'not-watching', title: `${p.title} is not being evaluated`, body: `${h.trigger.unevaluable} Nothing will be sold on stale or unconfirmed prices. This clears by itself when fresh prices return.`, subject: p.id, dedupe: `blind:${p.id}` }, now)
        } else resolveNotices(db, p.user_id, `blind:${p.id}`, now)
        if (!h.occurrence) return
        if (claim(ctx, p, p.live_version!, h.occurrence, now, h.trigger, 'due', null)) {
          claimed++
          if (typeof h.trigger.billId === 'string') db.run(`UPDATE bills SET state = 'scheduled' WHERE id = ? AND state = 'due'`, h.trigger.billId)
        }
      }))
    }
  }
  return claimed
}

function finish(ctx: Ctx, run: RunRow, p: ProgramRow, state: RunState, reason: string | null): void {
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    db.run('UPDATE runs SET state = ?, reason = ?, finished_at = ? WHERE id = ?', state, reason, now, run.id)
    emit(db, now, run.user_id, 'run', { id: run.id, programId: p.id, state })
    programEvent(db, p.id, p.user_id, `run-${state}`, 'engine', { runId: run.id, occurrence: run.occurrence, reason }, now)
    resolveNotices(db, run.user_id, `run:${run.id}`, now)
    // a run that has ended takes its open request for approval with it: nothing can be approved, or kept open, for it (review L6)
    db.run('UPDATE approvals SET cancelled_at = ? WHERE user_id = ? AND subject = ? AND confirmed_at IS NULL AND cancelled_at IS NULL', now, run.user_id, `run:${run.id}`)
    if (typeof run.trigger.billId === 'string' && state !== 'done') db.run(`UPDATE bills SET state = 'due' WHERE id = ? AND state = 'scheduled'`, run.trigger.billId)
    if (state === 'failed' || state === 'blocked' || state === 'partial') {
      const word = state === 'partial' ? 'only partly completed' : state === 'blocked' ? 'refused' : 'failed'
      const day = db.get<{ n: number }>('SELECT COUNT(*) n FROM runs WHERE program_id = ? AND state = ? AND due_at > ?', p.id, state, now - 86_400_000)!.n
      notice(db, run.user_id, { level: 'warning', kind: `run-${state}`, rolling: true, subject: p.id, dedupe: `run-end:${p.id}:${state}`,
        title: day > 1 ? `${p.title}: ${day} runs ${state === 'partial' ? 'were only partly completed' : `were ${word}`} in the last 24 hours` : `${p.title}: ${word}`,
        body: `${day > 1 ? `The latest, due ${whenIst(run.due_at)}: ` : ''}${reason ?? ''}` }, now)
    }
    if (state === 'skipped' && typeof run.trigger.billId === 'string') notice(db, run.user_id, { level: 'action', kind: 'bill-waiting', title: 'A bill is waiting for you', body: reason ?? '', subject: String(run.trigger.billId), dedupe: `bill-waiting:${run.trigger.billId}` }, now)

    const live = db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', p.id)
    if (live?.state !== 'active') return
    const spec = kindSpec(p.kind)
    const v = liveVersion(db, p, run.version)
    const complete = (why: string) => { db.run(`UPDATE programs SET state = 'completed', next_due_at = NULL, updated_at = ? WHERE id = ?`, now, p.id); programEvent(db, p.id, p.user_id, 'completed', 'engine', { why }, now) }
    const succeeded = state === 'done' || state === 'partial'
    if (p.kind === 'goal' && v && goalReached(db, p.user_id, p.id, v.params as unknown as GoalParams)) {
      // the target is set aside: nothing more is moved, and the money stays until the owner releases it (goals.ts)
      complete('The goal was reached.')
      const said = goalEndWords(db, p.user_id, p.id, v.params as unknown as GoalParams, 'reached')
      notice(db, run.user_id, { level: 'info', kind: 'goal-reached', ...said, subject: p.id, dedupe: `goal-reached:${p.id}` }, now)
    } else if (p.kind === 'paydown') complete(succeeded ? 'It ran once, as signed.' : `It was to run once and ended as: ${state}.`)
    else if (p.kind === 'exit' && succeeded) complete('The protective sale ran.')
    else if (p.kind === 'exit') {
      // A sale that was refused or failed may be attempted again when the trigger still holds.
      const memo = parse<Record<string, unknown>>(db.get<{ memo_json: string }>('SELECT memo_json FROM programs WHERE id = ?', p.id)?.memo_json, {})
      db.run('UPDATE programs SET memo_json = ? WHERE id = ?', j({ ...memo, attempt: (typeof memo.attempt === 'number' ? memo.attempt : 0) + 1 }), p.id)
    } else if (v) {
      const schedule = spec.schedule(v.params)
      if (schedule?.type === 'once') complete('It was scheduled to run once.')
      else if (v.authority.maxRuns !== null && succeeded) {
        const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND version = ? AND state IN ('done', 'partial')`, p.id, run.version)!.n
        if (n >= v.authority.maxRuns) complete(`It reached its limit of ${v.authority.maxRuns} runs.`)
      }
    }
  })
}

function startExecuting(ctx: Ctx, run: RunRow, p: ProgramRow, actions: PlannedAction[], approvalId: string | null): void {
  const { db } = ctx
  const now = ctx.clock.now()
  // a pause begun after the run was planned (while it waited for the person) holds it too
  if (actions.some((a) => a.kind === 'payment' && pausedFor(db, run.user_id, a.venue))) return finish(ctx, run, p, 'cancelled', PAUSE_REASON)
  db.tx(() => {
    actions.forEach((a, i) => createAction(ctx, { userId: run.user_id, runId: run.id, programId: p.id, origin: 'program', kind: a.kind, venue: a.venue, economicId: `${p.id}#${run.occurrence}#${i}`, params: a.params, approvalId }))
    db.run(`UPDATE runs SET state = 'executing', started_at = ? WHERE id = ?`, now, run.id)
    resolveNotices(db, run.user_id, `run:${run.id}`, now)
    emit(db, now, run.user_id, 'run', { id: run.id, programId: p.id, state: 'executing' })
  })
}

function processRun(ctx: Ctx, run: RunRow): void {
  const { db } = ctx
  const now = ctx.clock.now()
  const pr = db.get<Record<string, unknown>>('SELECT * FROM programs WHERE id = ?', run.program_id)
  if (!pr) return
  const p = rowToProgram(pr)
  const spec = kindSpec(p.kind)
  const v = liveVersion(db, p, run.version)

  if (run.state === 'due') {
    if (p.state === 'active' && p.live_version === run.version && !v && termsDiffer(db, p, run.version)) return finish(ctx, run, p, 'cancelled', TERMS_DIFFER)
    if (p.state !== 'active' || p.live_version !== run.version || !v) return finish(ctx, run, p, 'cancelled', `The instruction was ${p.state === 'active' ? 'replaced by a newer version' : p.state} before this run started.`)
    if (v.authority.expiresAt <= now) return finish(ctx, run, p, 'cancelled', 'The instruction\'s authority ended before this run started.')
    if (v.authority.maxRuns !== null) {
      // "At most N runs in all" counts runs that are done and runs still in progress or waiting for the owner. Counting
      // only finished runs let a purchase that takes a day to complete be started again and again meanwhile.
      const used = db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND version = ? AND id <> ? AND state IN ('done', 'partial', 'executing', 'awaiting_approval', 'objection_window')`, p.id, run.version, run.id)!.n
      if (used >= v.authority.maxRuns) return finish(ctx, run, p, 'skipped', `This instruction may run ${v.authority.maxRuns} time${v.authority.maxRuns === 1 ? '' : 's'} in all, and ${used} ${used === 1 ? 'run is' : 'runs are'} done or still in progress. Nothing was started.`)
    }
    const plan = spec.plan(ctx, p, v.params, v.authority, run.trigger, now)
    if (plan.memo) db.run('UPDATE programs SET memo_json = ? WHERE id = ?', j({ ...p.memo, ...plan.memo }), p.id)
    if (plan.skip || plan.actions.length === 0) {
      // a withdrawal that could not be made leaves money not withdrawn: the owner is told, as for a run that ends partly done
      if (plan.owed) notice(db, run.user_id, { level: 'warning', kind: 'run-owed', title: `${p.title}: nothing was withdrawn`, body: plan.owed, subject: p.id, dedupe: `run-owed:${run.id}` }, now)
      finish(ctx, run, p, 'skipped', plan.skip ?? 'Nothing needed doing.')
      // A withdrawal plan with no units left anywhere: told once, and the plan is finished, so it does not skip in silence
      // for ever. It ends only if it is still active (finish may have found it revoked meanwhile).
      if (plan.exhausted && db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', p.id)?.state === 'active') {
        db.run(`UPDATE programs SET state = 'completed', next_due_at = NULL, updated_at = ? WHERE id = ?`, now, p.id)
        programEvent(db, p.id, p.user_id, 'completed', 'engine', { why: 'No units were left in any of its funds.' }, now)
        notice(db, run.user_id, { level: 'info', kind: 'swp-finished', title: `${p.title}: finished, no units left`, body: `${plan.skip ?? 'You hold no units of the funds in this plan.'} The plan is finished: nothing more will be withdrawn, and nothing was withdrawn on this run. Sign a new plan if you buy units again.`, subject: p.id, dedupe: `swp-finished:${p.id}` }, now)
      }
      return
    }
    // a reported problem holds QED's own payments on that rail, until the person releases the pause (dispute-pause.ts)
    if (plan.actions.some((a) => a.kind === 'payment' && pausedFor(db, run.user_id, a.venue))) return finish(ctx, run, p, 'skipped', PAUSE_REASON)
    const summary = [...plan.actions.map((a) => a.summary), ...(plan.owed ? [plan.owed] : [])]
    db.run('UPDATE runs SET decision_json = ? WHERE id = ?', j({ plannedAt: now, actions: plan.actions, summary, ...(plan.owed ? { owed: plan.owed } : {}), ...(plan.neededBy !== undefined ? { neededBy: plan.neededBy } : {}) }), run.id)
    if (v.authority.runMode === 'auto') return startExecuting(ctx, run, p, plan.actions, null)
    if (v.authority.runMode === 'approve') {
      db.run(`UPDATE runs SET state = 'awaiting_approval', deadline_at = ? WHERE id = ?`, now + APPROVAL_WINDOW_MS, run.id)
      notice(db, run.user_id, { level: 'action', kind: 'run-approval', title: `${p.title}: approve this run?`, body: `${summary.join('; ')}. It does nothing until you approve, and lapses at ${whenIst(now + APPROVAL_WINDOW_MS)}.`, subject: run.id, dedupe: `run:${run.id}` }, now)
    } else {
      const at = now + v.authority.noticeSec * 1000
      db.run(`UPDATE runs SET state = 'objection_window', deadline_at = ? WHERE id = ?`, at, run.id)
      notice(db, run.user_id, { level: 'action', kind: 'run-notice', title: `${p.title} will run at ${whenIst(at)}`, body: `${summary.join('; ')}. It goes ahead unless you object before then.`, subject: run.id, dedupe: `run:${run.id}` }, now)
    }
    emit(db, now, run.user_id, 'run', { id: run.id, programId: p.id, state: v.authority.runMode === 'approve' ? 'awaiting_approval' : 'objection_window' })
    return
  }

  if (run.state === 'awaiting_approval' || run.state === 'objection_window') {
    if (p.state !== 'active' || p.live_version !== run.version) return finish(ctx, run, p, 'cancelled', `The instruction was ${p.state === 'active' ? 'replaced by a newer version' : p.state} before this run started.`)
    const actions = run.decision.actions ?? []
    if (run.state === 'awaiting_approval') {
      // an approval counts only if it was given before the run's deadline (the adversarial review of R12, N6)
      const ap = db.get<{ id: string }>(`SELECT id FROM approvals WHERE user_id = ? AND subject = ? AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND confirmed_at <= expires_at AND confirmed_at <= ${run.deadline_at ?? 'confirmed_at'} ORDER BY confirmed_at DESC LIMIT 1`, run.user_id, `run:${run.id}`)
      if (ap) return startExecuting(ctx, run, p, actions, ap.id)
      if (run.deadline_at !== null && now > run.deadline_at) return finish(ctx, run, p, 'expired', 'You did not answer within 24 hours, so this run lapsed. Nothing was done.')
      return
    }
    if (run.deadline_at !== null && now >= run.deadline_at) return startExecuting(ctx, run, p, actions, null)
    return
  }

  if (run.state === 'executing') {
    const acts = db.all<{ state: string; error: string | null; receipt_id: string | null }>('SELECT state, error, receipt_id FROM actions WHERE run_id = ?', run.id)
    if (acts.length === 0 || acts.some((a) => !TERMINAL_ACTION.has(a.state as never) || !a.receipt_id)) return
    const ok = acts.filter((a) => a.state === 'done').length
    const part = acts.filter((a) => a.state === 'partial').length
    const firstError = acts.find((a) => a.error)?.error ?? null
    // a run that sold all it planned but could not do all it was asked says what is still owed (the withdrawal plan: a fund it could
    // not use, or a reserve it keeps), and ends partial so that the owner is told
    const owed = run.decision.owed ?? null
    if (ok === acts.length) return owed ? finish(ctx, run, p, 'partial', owed) : finish(ctx, run, p, 'done', null)
    if (ok + part > 0) return finish(ctx, run, p, 'partial', [firstError ?? 'Some steps did not complete.', owed].filter(Boolean).join(' '))
    if (acts.every((a) => a.state === 'blocked')) return finish(ctx, run, p, 'blocked', firstError ?? 'Refused by your limits.')
    return finish(ctx, run, p, 'failed', firstError ?? 'No step completed.')
  }
}

export function runTick(ctx: Ctx): number {
  const rows = ctx.db.all<Record<string, unknown>>(`SELECT * FROM runs WHERE state IN ('due', 'awaiting_approval', 'objection_window', 'executing') ORDER BY created_at LIMIT 500`)
  for (const r of rows) {
    const run = runFromRow(r)
    try { withHome(ctx.db, run.user_id, () => processRun(ctx, run)) }
    catch (e) {
      if (run.state === 'due') {
        const p = rowToProgram(ctx.db.get<Record<string, unknown>>('SELECT * FROM programs WHERE id = ?', run.program_id)!)
        withHome(ctx.db, run.user_id, () => finish(ctx, run, p, e instanceof AppError ? 'blocked' : 'failed', e instanceof Error ? e.message : String(e)))
      }
    }
  }
  return rows.length
}

// ------------------------------------------------------------------------------------------------ owner actions on a run

export function loadRun(db: Db, userId: string, runId: string): RunRow {
  const r = db.get<Record<string, unknown>>('SELECT * FROM runs WHERE id = ? AND user_id = ?', runId, userId)
  if (!r) throw notFound('That run')
  return runFromRow(r)
}

const RAIL_WORDS: Record<string, string> = { upi: 'UPI', imps: 'IMPS', neft: 'NEFT', rtgs: 'RTGS', internal: 'between your own accounts' }
/**
 * Each action of a run as the approval shows it: to whom, how much, what asset, by which route, and what follows once
 * approved (R12 section 4). Signed with the rest of the document, so the passkey signs what the sheet shows. Paper only.
 */
/** What a run's payments and purchases take out of the bank (fees and charges included); sales take nothing. */
const outflowOf = (actions: { kind: string; params: unknown }[]): number => actions.reduce((t, a) => {
  const p = a.params as { amount?: string; charge?: string; side?: string }
  return a.kind === 'payment' || (a.kind === 'order' && p.side === 'buy') ? t + Number(p.amount ?? 0) + Number(p.charge ?? 0) : t
}, 0)
/**
 * A run's limits as the record shows them afterwards, on the sheet before it is approved (R12 task comparison, gap 6):
 * this run against the most a run may move, and what the instruction has used today and this month, before this run
 * and with it, against its limits. Actions of earlier runs that were refused, failed or cancelled do not count.
 */
function runLimits(db: Db, programId: string, a: Authority | null, out: number, now: number): { label: string; value: string }[] {
  if (!a || out <= 0) return []
  // over a limit is said as over, with what happens: the part beyond it is refused when it is sent (review of R12, L10)
  const over = (with_: number, limit: number): string => (with_ > limit ? `: over by ${amountText(with_ - limit)}, so what goes over it is refused when it is sent` : '')
  const rows = [{ label: 'This run', value: `${amountText(out)}, of at most ${amountText(a.maxPerRun)} a run${over(out, a.maxPerRun)}` }]
  if (a.maxPerDay) { const used = Number(programUsage(db, programId, dayStart(now))); rows.push({ label: 'Today', value: `${amountText(used)} used before this run, ${amountText(used + out)} with it, of at most ${amountText(a.maxPerDay)}${over(used + out, a.maxPerDay)}` }) }
  const month = Number(programUsage(db, programId, monthStart(now)))
  rows.push({ label: 'This month', value: `${amountText(month)} used before this run, ${amountText(month + out)} with it, of at most ${amountText(a.maxPerMonth)}${month + out > a.maxPerMonth ? over(month + out, a.maxPerMonth) : `: ${amountText(a.maxPerMonth - month - out)} left after it`}` })
  return rows
}

export function runActionLines(db: Db, actions: { kind: string; venue: string; params: unknown }[], now = Date.now()): { to: string; amount: string; asset: string; route: string; once: string; nav?: string }[] {
  return actions.map((a) => {
    if (a.kind === 'payment') {
      const p = a.params as PaymentParams
      if (p.purpose === 'goal') return { to: `The set-aside for ${p.payeeName}, inside your own bank (${p.payeeHandle})`, amount: amountText(Number(p.amount)), asset: 'Indian rupees, from your bank account', route: 'Between your own accounts in the paper bank; it leaves the bank for no one', once: 'It is set aside at once, on paper. No instruction can spend it; only you can release it, with your passkey.' }
      return { to: `${p.payeeName} (${p.payeeHandle})`, amount: amountText(Number(p.amount)), asset: 'Indian rupees, from your bank account', route: `${p.rail ? RAIL_WORDS[p.rail] ?? p.rail : 'The rail QED chooses'}, on the paper bank`, once: 'It leaves your bank on paper when the run is sent; a payment that has gone is not recalled.' }
    }
    if (a.kind === 'order') {
      const p = a.params as OrderParams
      const inst = instrument(db, p.instrumentId)
      const fund = inst?.kind === 'mutual_fund'
      const amount = p.amount ? amountText(Number(p.amount)) : p.sellAll ? 'everything held' : p.qty && inst ? `${Number(p.qty) / 10 ** inst.baseScale} ${fund ? 'units' : inst.base_asset}` : 'as planned'
      // the NAV day a fund order is entitled to if it is sent now, by the same rule the order sheet states
      const ent = fund && inst ? navEntitlement(inst, p.side, now) : null
      const weekend = [0, 6].includes(ist(now).weekday)
      const nav = ent ? { nav: `${dayText(ent.minNavDate, istDay(now))}, or the next one published (${weekend ? 'sent on a weekend, so the next business day counts' : `sent ${ent.beforeCutoff ? 'before' : 'after'} the ${ent.cutoff} IST cut-off`})` } : {}
      return { to: fund ? 'The fund house, on paper' : "CoinDCX's order book, on paper", amount, asset: inst?.name ?? p.instrumentId, route: 'A paper venue on this QED installation: no exchange, fund house or bank is contacted', once: fund ? (p.side === 'buy' ? 'Units are allotted at the NAV for the applicable day; it cannot be cancelled after the cut-off.' : 'Units are redeemed at the NAV for the applicable day; it cannot be cancelled after the cut-off.') : (p.side === 'sell' ? 'It sells against the book at once, no worse than its worst price; a sale cannot be undone.' : 'It buys against the book at once, no worse than its worst price; a fill cannot be undone.'), ...nav }
    }
    return { to: a.venue, amount: '', asset: '', route: 'On paper', once: 'Carried out once, as planned.' }
  })
}

/** The document the owner approves for one run: the exact actions, bound to the program version that planned them. */
export function requestRunApproval(ctx: Ctx, userId: string, runId: string): { approvalId: string; document: string; docHash: string; expiresAt: number; nonce: string; requiresStepUp: boolean } {
  const { db } = ctx
  const now = ctx.clock.now()
  const run = loadRun(db, userId, runId)
  if (run.state !== 'awaiting_approval') throw refused('not_waiting', `That run is ${run.state.replace('_', ' ')}; it is not waiting for approval.`)
  if (run.deadline_at !== null && run.deadline_at - now < 1000) throw refused('lapsed', 'This run is lapsing: it can no longer be approved. Nothing was done.')
  const p = loadProgram(db, userId, run.program_id)
  const v = liveVersion(db, p, run.version)
  // QED planned this run under a signed instruction, so who opens its approval prepared nothing; the bills and payees it
  // pays may have been added in a password session, and the document says so (RISK-076).
  const pays = (run.decision.actions ?? []).map((a) => a.params as { payeeHandle?: unknown; billId?: unknown })
  const prepared = passwordWork(db, userId, { payeeHandles: pays.map((x) => x.payeeHandle).filter((h): h is string => typeof h === 'string'), billIds: pays.map((x) => x.billId).filter((b): b is string => typeof b === 'string') }, now)
  const doc = canonical({
    // format 2: the currency its figures are in and the household's zone (a format 1 document means rupees, India's zone)
    v: 2, kind: 'run-approval', currency: householdHome(db, userId), timeZone: zoneOf(getProfile(db, userId)), tzVersion: TZ_VERSION, program: p.title, programId: p.id, version: run.version, versionHash: v?.contentHash ?? null, runId: run.id, occurrence: run.occurrence,
    willDo: run.decision.summary ?? [], actions: (run.decision.actions ?? []).map((a) => ({ kind: a.kind, venue: a.venue, params: a.params })),
    lines: runActionLines(db, run.decision.actions ?? [], now),
    // what the record shows afterwards, before approving: the limits used and left, and the bank before and after
    limits: runLimits(db, p.id, v?.authority ?? null, outflowOf(run.decision.actions ?? []), now),
    ...(outflowOf(run.decision.actions ?? []) > 0 ? { bank: { now: amountText(Number(balance(db, userId, 'bank'))), after: amountText(Number(balance(db, userId, 'bank')) - outflowOf(run.decision.actions ?? [])) } } : {}),
    lapsesAt: run.deadline_at, note: 'Approving lets QED carry out exactly these actions once, checked against your limits and your floor at the moment each is sent. Execution is on paper.',
    ...(prepared.length ? { prepared } : {}),
  })
  // A small run under an authority the owner already signed is confirmed with a tap; a large one asks for the password.
  const size = (run.decision.actions ?? []).reduce((s, x) => s + Number((x.params as { amount?: string }).amount ?? 0), 0)
  const a = createApproval(db, userId, { purpose: 'run', subject: `run:${run.id}`, document: doc, ttlMs: Math.min(10 * 60_000, (run.deadline_at ?? now + 10 * 60_000) - now), requiresStepUp: size >= 1_000_000, sizePaise: size }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, nonce: a.nonce, requiresStepUp: a.requires_stepup === 1 }
}

/** The owner declines a run that is waiting for approval, or objects to one that was announced. Nothing executes. */
export function cancelRun(ctx: Ctx, userId: string, runId: string): RunRow {
  const run = loadRun(ctx.db, userId, runId)
  if (run.state !== 'awaiting_approval' && run.state !== 'objection_window' && run.state !== 'due') throw refused('too_late', `That run is already ${run.state.replace('_', ' ')}.`)
  const p = loadProgram(ctx.db, userId, run.program_id)
  finish(ctx, run, p, 'cancelled', run.state === 'objection_window' ? 'You objected before it ran.' : 'You declined this run.')
  audit(ctx.db, ctx.clock.now(), userId, 'owner', 'run.cancel', runId)
  return loadRun(ctx.db, userId, runId)
}

/** Emergency stop: no program starts a new run, except those that only sell to protect you. */
/** A pause someone other than the person made (a saved code, a recovery contact): its reason is said in place of "you". */
export const pausedByOther = (reason: string | null | undefined): boolean => !!reason && !/^(Paused|Stopped) by you$/.test(reason)
/**
 * Pause everything QED does on its own, or all but protective selling. A pause already in force is never loosened and
 * is not paused again: a stricter request (protective selling too) tightens it, anything else changes nothing and posts
 * nothing (the adversarial review of R12, L4: a second request used to announce what it did not do). The answer is the
 * state that holds afterwards.
 */
export function setStop(ctx: Ctx, userId: string, reason: string, keepProtective = false): { keptProtective: boolean; already: boolean } {
  const { db } = ctx
  const now = ctx.clock.now()
  const cancel = (onlyProtective: boolean, why: string) => {
    const waiting = db.all<Record<string, unknown>>(`SELECT r.* FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.user_id = ? AND r.state IN ('due', 'awaiting_approval', 'objection_window')${onlyProtective ? ` AND p.kind IN ('exit', 'floor')` : keepProtective ? ` AND p.kind NOT IN ('exit', 'floor')` : ''}`, userId)
    for (const r of waiting) finish(ctx, runFromRow(r), loadProgram(db, userId, String(r.program_id)), 'cancelled', why)
  }
  return db.tx(() => {
    const cur = db.get<{ stop_at: number | null; stop_protective: number; stop_reason: string | null }>('SELECT stop_at, stop_protective, stop_reason FROM users WHERE id = ?', userId)
    if (cur?.stop_at != null) {
      if (keepProtective || cur.stop_protective === 0) return { keptProtective: cur.stop_protective === 1, already: true }
      db.run('UPDATE users SET stop_protective = 0 WHERE id = ?', userId)
      cancel(true, 'You stopped protective selling too.')
      audit(db, now, userId, 'owner', 'stop.tighten', null, { reason })
      emit(db, now, userId, 'stop', { on: true })
      notice(db, userId, { level: 'warning', kind: 'stopped', title: 'Everything QED does on its own is stopped', body: 'Protective selling is stopped too now. No instruction will start a new run until you resume. Payments and orders already sent cannot be recalled.', dedupe: 'stop' }, now)
      return { keptProtective: false, already: true }
    }
    db.run('UPDATE users SET stop_at = ?, stop_reason = ?, stop_protective = ? WHERE id = ?', now, reason.slice(0, 200), keepProtective ? 1 : 0, userId)
    const other = pausedByOther(reason)
    // a plain pause holds protective selling too, so its waiting runs are cancelled with the rest, as the sheet says (claims review F9)
    cancel(false, other ? `${reason}: QED is paused.` : 'You stopped all autonomous activity.')
    audit(db, now, userId, 'owner', 'stop.set', null, { reason })
    emit(db, now, userId, 'stop', { on: true })
    notice(db, userId, keepProtective
      ? { level: 'warning', kind: 'stopped', title: 'Stopped, except protective selling', body: `${other ? `${reason}. ` : ''}No instruction will start a new run until you resume, except the ones that sell to hold your floor or when a price falls${other ? ', which keep running' : ': you chose to keep those running'}. Payments and orders already sent cannot be recalled.`, dedupe: 'stop' }
      : { level: 'warning', kind: 'stopped', title: 'Everything QED does on its own is stopped', body: `${other ? `${reason}. ` : ''}No instruction will start a new run until you resume, protective selling included. Payments and orders already sent cannot be recalled.`, dedupe: 'stop' }, now)
    return { keptProtective: keepProtective, already: false }
  })
}
export function clearStop(ctx: Ctx, userId: string): void {
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    db.run('UPDATE users SET stop_at = NULL, stop_reason = NULL, stop_protective = 0 WHERE id = ?', userId)
    resolveNotices(db, userId, 'stop', now)
    audit(db, now, userId, 'owner', 'stop.clear', null)
    emit(db, now, userId, 'stop', { on: false })
  })
}

export { describeSchedule, amountText }
