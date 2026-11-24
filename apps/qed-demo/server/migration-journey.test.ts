/**
 * The combined migration from schema v6 (the review database's version) to v8, on a database shaped like one in use
 * (R13 sections 1 and 4: "Reconcile the combined schema migration against databases actually in use. Verify first
 * execution, repeated execution, interrupted execution and restoration. Idempotence alone does not establish correct
 * financial semantics." and "Migration causes no resubmission, duplicate postings or changed financial meaning").
 *
 * The database is written by this build's own paths and put back into v6's shape (server/schema-fixture.ts), with the
 * state a household in use has: payments settled and one still on the rail, a fund purchase waiting for its NAV (as v6
 * kept it, with no money state of its own) and one allotted, a run waiting for the owner's approval with its request
 * open, a goal with money set aside, a hold for something in flight, receipts, and recovery requests (one open with its
 * reference secret, one open from before v4 without one, one completed). What it means financially is read before and
 * after: every balance, entry and posting, the receipts and their chain, open actions and holds, the rail's and the
 * registrar's records, runs, approvals, instructions and their next runs. Every run of the migration uses keys made for
 * this test, never the owner's, and never touches the review database.
 *
 * The escrow part of the v8 step (deadlines for work in review) belongs to the escrow's own review (R13 section 2) and is
 * not exercised here: this household has no escrow.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { listManifests, restoreBackup } from './backup.ts'
import { type Db, FakeClock, istInstant, openDb, SCHEMA_VERSION } from './core.ts'
import { stepAllActions } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { verifyLedger } from './ledger.ts'
import { Market } from './market.ts'
import { addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { checkPayeeName } from './name-check.ts'

/** The payee check acknowledged as the owner would after seeing it (R13: anything but a match needs that confirmation). */
const ack = (name: string, handle: string): { nameCheckAccepted?: string } => { const o = checkPayeeName(name, handle).outcome; return o === 'match' ? {} : { nameCheckAccepted: o } }
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { seedRegistry } from './registry.ts'
import { requestRunApproval, runTick, schedulerTick, triggerTick } from './runner.ts'
import { toSchemaV6 } from './schema-fixture.ts'
import type { Ctx } from './types.ts'
import { buildVenues } from './venues.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v6v8-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const USER = 'usr_journey'
const T0 = istInstant('2026-11-18', '10:30') // Wednesday
const LATE = istInstant('2026-12-02', '15:30') // a Wednesday after the 15:00 cut-off: the purchase waits for Thursday's NAV
type Row = Record<string, unknown>

function contextOn(db: Db, at: number): Ctx & { clock: FakeClock } {
  const clock = new FakeClock(at)
  const market = new Market(db, clock)
  return { db, clock, market, venues: buildVenues(db, market, clock) }
}
function nav(ctx: Ctx, date: string, value: string): void {
  ctx.db.run('INSERT OR REPLACE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', 'amfi:120716', date, value, ctx.clock.now(), 'test')
  ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: value, sourceTs: Date.parse(`${date}T00:00:00+05:30`), precision: 'day', recvTs: ctx.clock.now(), provider: 'test' })
}
async function pass(ctx: Ctx & { clock: FakeClock }, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    schedulerTick(ctx); triggerTick(ctx); runTick(ctx)
    await stepAllActions(ctx); await ctx.venues.rail.tick(); await ctx.venues.funds.tick(); await stepAllActions(ctx); runTick(ctx)
    ctx.clock.advance(1000)
  }
}
async function byHand(ctx: Ctx & { clock: FakeClock }, what: Record<string, unknown>): Promise<void> {
  const pv = await previewAction(ctx, USER, what)
  confirmApproval(ctx.db, USER, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, ctx.clock.now())
  submitApprovedAction(ctx, USER, pv.approvalId)
}

/** A household in use, written by this build, then put back into the shape schema v6 left. */
async function v6Database(): Promise<{ path: string; slowRef: string; waitingRef: string; runId: string }> {
  const path = join(tempFolder('qed-v6-journey-'), 'qed.db')
  const db = openDb(path)
  seedRegistry(db)
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', USER, 'journey', 'Journey Owner', 'x', T0)
  openHousehold(db, USER, DEFAULT_OPENING, {}, T0)
  const ctx = contextOn(db, T0)
  nav(ctx, '2026-11-17', '178.8713')
  // settled payments by hand, and a fund purchase allotted: receipts on a chain
  const power = addPayee(db, USER, { name: 'City Power', handle: 'power@upi', category: 'utilities', ...ack('City Power', 'power@upi') }, T0)
  await byHand(ctx, { kind: 'payment', purpose: 'spend', payeeId: power.id, amount: 250_000 })
  await byHand(ctx, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 500_000 })
  await pass(ctx)
  ctx.clock.set(istInstant('2026-11-18', '21:00')); nav(ctx, '2026-11-18', '179.5000'); await pass(ctx)
  // a goal that asks first, signed; money set aside for it by hand
  const g = saveDraft(ctx, USER, { kind: 'goal', params: { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }, authority: {} })
  const req = requestProgramApproval(ctx, USER, g.programId)
  confirmApproval(db, USER, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, ctx.clock.now())
  activateProgram(ctx, USER, g.programId, req.approvalId)
  await byHand(ctx, { kind: 'payment', purpose: 'goal', goalId: g.programId, amount: 300_000 })
  await pass(ctx)
  // its contribution day: the run waits for the owner, with its request open
  ctx.clock.set(istInstant('2026-12-02', '10:00') + 1000); await pass(ctx, 1)
  const run = db.get<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'awaiting_approval'`, g.programId)!
  requestRunApproval(ctx, USER, run.id)
  // after the cut-off: a fund purchase whose money has reached the fund house, waiting for Thursday's NAV
  ctx.clock.set(LATE)
  await byHand(ctx, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 400_000 })
  await pass(ctx, 3)
  // a payment still on the rail: slow@paper stays pending for 90 seconds
  const slow = addPayee(db, USER, { name: 'Slow Payee', handle: 'slow@paper', category: 'other', ...ack('Slow Payee', 'slow@paper') }, ctx.clock.now())
  await byHand(ctx, { kind: 'payment', purpose: 'spend', payeeId: slow.id, amount: 120_000 })
  await stepAllActions(ctx)
  const slowRef = db.get<{ e: string }>(`SELECT economic_id e FROM actions WHERE json_extract(params_json, '$.payeeHandle') = 'slow@paper'`)!.e
  const waitingRef = db.get<{ e: string }>(`SELECT a.economic_id e FROM actions a JOIN pv_orders o ON o.client_ref = a.economic_id WHERE o.state = 'funded'`)!.e
  expect(db.get<{ state: string }>('SELECT state FROM pv_payments WHERE client_ref = ?', slowRef)!.state).toBe('pending')
  // recovery requests: open with its reference secret, open from before v4 without one, and completed
  const rq = (id: string, secret: string | null, completed: number | null) => db.run('INSERT INTO recovery_requests (id, person_id, code_id, started_at, available_at, completed_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)', id, USER, `rcv_${id}`, T0, T0 + 72 * 3600_000, completed, secret)
  rq('rec_open', sha256hex('secret'), null); rq('rec_old', null, null); rq('rec_done', sha256hex('s2'), T0 + 80 * 3600_000)
  expect(verifyLedger(db, USER)).toEqual([])
  db.close()
  // into v6's shape: the registrar's money state did not exist (fund-migration.test.ts), nor what v7 and v8 added
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    raw.exec(`UPDATE pv_orders SET state = 'accepted' WHERE state = 'funded'`)
    raw.exec(`UPDATE pv_orders SET meta_json = json_remove(meta_json, '$.fundsDueAt')`)
    raw.exec(`UPDATE actions SET result_json = json_remove(result_json, '$.registrarAt', '$.fundsAt', '$.allottedAt', '$.navDate')`)
    raw.exec(`UPDATE actions SET result_json = json_set(result_json, '$.venueState', 'accepted') WHERE json_extract(result_json, '$.venueState') = 'funded'`)
    raw.exec('COMMIT')
  } finally { raw.close() }
  toSchemaV6(path)
  return { path, slowRef, waitingRef, runId: run.id }
}

/** What the books and the work in flight mean, read on a read-only connection. */
function meaning(path: string): Record<string, Row[] | string> {
  const d = new DatabaseSync(path, { readOnly: true })
  const rows = (sql: string): Row[] => (d.prepare(sql).all() as Row[]).map((r) => ({ ...r }))
  try {
    return {
      version: String((d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value),
      balances: rows('SELECT a.user_id, a.code, b.amount_text FROM accounts a JOIN balances b ON b.account_id = a.id ORDER BY a.user_id, a.code'),
      entries: rows('SELECT user_id, seq, ref, kind, ts, effective_ts, meta_json FROM entries ORDER BY user_id, seq'),
      postings: rows('SELECT entry_id, account_id, amount_text FROM postings ORDER BY id'),
      receipts: rows('SELECT user_id, seq, hash, prev_hash, body_json FROM receipts ORDER BY user_id, seq'),
      actions: rows('SELECT id, state, kind, params_json, economic_id, attempt, approval_id, run_id FROM actions ORDER BY id'),
      holds: rows('SELECT ref, amount_text, released_at FROM holds ORDER BY ref'),
      payments: rows('SELECT client_ref, state, amount, rail, resolve_at FROM pv_payments ORDER BY client_ref'),
      orders: rows(`SELECT client_ref, side, state, amount, created_at, json_extract(meta_json, '$.minNavDate') nav FROM pv_orders ORDER BY client_ref`),
      fills: rows('SELECT order_id, qty, price, effective_date FROM pv_fills ORDER BY id'),
      runs: rows('SELECT id, state, deadline_at, decision_json FROM runs ORDER BY id'),
      approvals: rows('SELECT id, subject, doc_hash, expires_at, confirmed_at, consumed_at, cancelled_at FROM approvals ORDER BY id'),
      programs: rows('SELECT id, state, live_version, next_due_at FROM programs ORDER BY id'),
      recovery: rows('SELECT id, cancelled_at, cancelled_by, completed_at FROM recovery_requests ORDER BY id'),
    }
  } finally { d.close() }
}
/** The same, with what the migration is meant to change set aside: a waiting purchase's money state, and a pre-v4 recovery closed at v7 (its time is the migration's own). */
function expectedAfter(before: Record<string, Row[] | string>, waitingRef: string): Record<string, Row[] | string> {
  return {
    ...before, version: SCHEMA_VERSION,
    orders: (before.orders as Row[]).map((o) => (o.client_ref === waitingRef ? { ...o, state: 'funded' } : o)),
    recovery: (before.recovery as Row[]).map((r) => (r.id === 'rec_old' ? { ...r, cancelled_at: '(the migration\'s time)', cancelled_by: 'closed at schema v7: no reference secret' } : r)),
  }
}
const timeless = (m: Record<string, Row[] | string>): Record<string, Row[] | string> => ({ ...m, recovery: (m.recovery as Row[]).map((r) => (r.id === 'rec_old' && r.cancelled_at !== null ? { ...r, cancelled_at: '(the migration\'s time)' } : r)) })

describe('schema v6 to v8 on a household in use', () => {
  it('first execution: a copy is sealed first, and nothing of financial meaning changes; only what the steps are meant to change does', async () => {
    const { path, waitingRef } = await v6Database()
    const before = meaning(path)
    expect(before.version).toBe('6')
    // the household is in use: each kind of state in flight is there before the migration
    const has = (k: string, f: (r: Row) => boolean): number => (before[k] as Row[]).filter(f).length
    expect(has('payments', (r) => r.state === 'pending')).toBe(1)
    expect(has('orders', (r) => r.client_ref === waitingRef && r.state === 'accepted' && r.nav === '2026-12-03')).toBe(1)
    expect(has('actions', (r) => r.state === 'working')).toBe(2)
    expect(has('runs', (r) => r.state === 'awaiting_approval')).toBe(1)
    expect(has('approvals', (r) => String(r.subject).startsWith('run:') && r.confirmed_at === null)).toBe(1)
    expect(has('balances', (r) => String(r.code).startsWith('goal:') && r.amount_text === '300000')).toBe(1)
    expect(has('receipts', () => true)).toBeGreaterThanOrEqual(3)
    expect(has('recovery', () => true)).toBe(3)
    const db = openDb(path)
    db.close()
    const after = meaning(path)
    expect(timeless(after)).toEqual(expectedAfter(before, waitingRef))
    // the waiting purchase keeps its NAV day and its money is recorded as received when the order was placed, as v6 had it
    const o = new DatabaseSync(path, { readOnly: true })
    try { expect(o.prepare('SELECT state, funds_at = created_at same FROM pv_orders WHERE client_ref = ?').get(waitingRef)).toEqual({ state: 'funded', same: 1 }) } finally { o.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  }, 60_000)

  it('after it, the engine sends nothing again: the payment on the rail settles once, the purchase is allotted once at its NAV, the waiting run is approved and runs once', async () => {
    const { path, slowRef, waitingRef, runId } = await v6Database()
    const db = openDb(path)
    try {
      const ctx = contextOn(db, LATE + 5 * 60_000)
      const count = (sql: string, ...a: string[]): number => db.get<{ n: number }>(sql, ...a)!.n
      const entriesBefore = count('SELECT COUNT(*) n FROM entries WHERE user_id = ?', USER)
      await pass(ctx, 4)
      // the payment that was on the rail: settled, once
      expect(count('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', slowRef)).toBe(1)
      expect(db.get<{ state: string }>('SELECT state FROM actions WHERE economic_id = ?', slowRef)!.state).toBe('done')
      expect(count('SELECT COUNT(*) n FROM entries WHERE ref IN (?, ?)', `pay:${slowRef}:out`, `pay:${slowRef}:settle`)).toBe(2)
      // the run that waited for the owner: approved after the migration (its first request had lapsed after ten minutes, as
      // it would have without one), it runs once and its contribution is set aside once
      ctx.clock.set(istInstant('2026-12-03', '09:00'))
      const req = requestRunApproval(ctx, USER, runId)
      confirmApproval(db, USER, req.approvalId, { method: 'passkey', docHash: req.docHash }, ctx.clock.now())
      await pass(ctx, 4)
      expect(db.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', runId)!.state).toBe('done')
      expect(count(`SELECT COUNT(*) n FROM actions WHERE run_id = ?`, runId)).toBe(1)
      expect(count(`SELECT COUNT(*) n FROM entries e JOIN actions a ON a.id = json_extract(e.meta_json, '$.actionId') WHERE a.run_id = ? AND e.kind = 'payment-settled'`, runId)).toBe(1)
      // the purchase that waited for its NAV: allotted on Thursday at Thursday's NAV, once
      ctx.clock.set(istInstant('2026-12-03', '21:00')); nav(ctx, '2026-12-03', '181.0000'); await pass(ctx, 4)
      expect(count('SELECT COUNT(*) n FROM pv_orders WHERE client_ref = ?', waitingRef)).toBe(1)
      expect(db.get<{ state: string }>('SELECT state FROM actions WHERE economic_id = ?', waitingRef)!.state).toBe('done')
      expect(count(`SELECT COUNT(*) n FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id WHERE o.client_ref = ?`, waitingRef)).toBe(1)
      expect(count(`SELECT COUNT(*) n FROM entries WHERE ref = ?`, `mf:${waitingRef}:pay`)).toBe(1)
      // every reference posted once, the books and the chain sound
      expect(count('SELECT COUNT(*) n FROM (SELECT ref FROM entries GROUP BY user_id, ref HAVING COUNT(*) > 1)')).toBe(0)
      expect(count('SELECT COUNT(*) n FROM entries WHERE user_id = ?', USER)).toBeGreaterThan(entriesBefore)
      expect(verifyLedger(db, USER)).toEqual([])
      expect(verifyChain(db, USER).ok).toBe(true)
    } finally { db.close() }
  }, 60_000)

  it('repeated execution: opening it again changes nothing at all, and seals no second copy', async () => {
    const { path } = await v6Database()
    openDb(path).close()
    const once = meaning(path)
    openDb(path).close(); openDb(path).close()
    expect(meaning(path)).toEqual(once)
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  }, 60_000)

  it('interrupted execution: a step that fails, or a process killed in the middle of the migration, leaves v6 as it was; the next start migrates to the same result', async () => {
    const { path, waitingRef } = await v6Database()
    const before = meaning(path)
    // (a) a failure inside the migration's transaction, after every step has run: the version cannot be written
    const failing = join(tempFolder('qed-v6-fail-'), 'qed.db')
    copyFileSync(path, failing)
    const raw = new DatabaseSync(failing)
    raw.exec(`CREATE TRIGGER r13_interrupt BEFORE UPDATE ON meta WHEN NEW.value = '${SCHEMA_VERSION}' BEGIN SELECT RAISE(ABORT, 'interrupted by the test'); END`)
    raw.close()
    expect(() => openDb(failing)).toThrow(/interrupted by the test/)
    const unchanged = new DatabaseSync(failing)
    unchanged.exec('DROP TRIGGER r13_interrupt')
    unchanged.close()
    expect(meaning(failing)).toEqual(before)
    openDb(failing).close()
    expect(timeless(meaning(failing))).toEqual(expectedAfter(before, waitingRef))

    // (b) the process killed in the middle: after both steps' changes to the tables, before the schema and the fills
    const killed = join(tempFolder('qed-v6-kill-'), 'qed.db')
    copyFileSync(path, killed)
    const script = join(tempFolder('qed-v6-kill-script-'), 'kill.ts')
    writeFileSync(script, [
      `import { Db, openDb } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'core.ts')).href)}`,
      'const exec = Db.prototype.exec',
      'Db.prototype.exec = function (sql: string) { if (sql.includes("CREATE TABLE IF NOT EXISTS")) process.kill(process.pid, "SIGKILL"); return exec.call(this, sql) }',
      'openDb(process.argv[2]!)',
    ].join('\n'))
    const r = spawnSync(process.execPath, [script, killed], { env: { ...process.env, QED_KEY_DIR: keys.dir }, encoding: 'utf8', timeout: 60_000 })
    expect(r.signal).toBe('SIGKILL')
    // the next start recovers the journal: still v6, as it was
    const rec = new DatabaseSync(killed)
    rec.exec('PRAGMA journal_mode = WAL')
    rec.close()
    expect(meaning(killed)).toEqual(before)
    expect(existsSync(join(dirname(killed), 'migration-copies'))).toBe(true) // the copy was sealed before anything changed
    openDb(killed).close()
    expect(timeless(meaning(killed))).toEqual(expectedAfter(before, waitingRef))
  }, 120_000)

  it('restoration: the sealed copy restores to the v6 database exactly, and migrating the restored copy gives the same result', async () => {
    const { path, waitingRef } = await v6Database()
    const before = meaning(path)
    openDb(path).close()
    const migrated = timeless(meaning(path))
    const manifests = listManifests(join(dirname(path), 'migration-copies'))
    expect(manifests).toHaveLength(1)
    const target = join(tempFolder('qed-v6-restored-'), 'qed.db')
    expect(restoreBackup({ manifest: manifests[0]!, keyring: openKeyring('migration-copy'), target }).manifest.migration).toEqual({ from: '6', to: SCHEMA_VERSION })
    expect(meaning(target)).toEqual(before)
    openDb(target).close()
    expect(timeless(meaning(target))).toEqual(migrated)
    expect(migrated).toEqual(expectedAfter(before, waitingRef))
  }, 60_000)
})
