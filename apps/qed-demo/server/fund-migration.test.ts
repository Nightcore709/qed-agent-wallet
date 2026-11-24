/**
 * Schema v8 (R12 task comparison, gap 17): a fund purchase's money reaching the fund house is a state of the paper
 * registrar's own ('funded', at pv_orders.funds_at). A v7 database's fund orders migrate without losing a state or sending
 * anything again: before v8 the money was treated as arriving with the order, so that is when it is recorded as received;
 * a purchase still waiting becomes funded and keeps its NAV day, then is allotted by the same order when the NAV comes. As
 * every migration, it runs only after an encrypted, verified copy is sealed with keys made for this run, never the owner's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmApproval, createApproval } from './approvals.ts'
import { listManifests, restoreBackup } from './backup.ts'
import { type Db, FakeClock, openDb, SCHEMA_VERSION } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { Market } from './market.ts'
import { seedRegistry } from './registry.ts'
import { T0 } from './testkit.ts'
import type { Ctx, OrderParams } from './types.ts'
import { buildVenues } from './venues.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v8-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const USER = 'usr_fund'
const LATE = T0 + 12 * 3600_000 + 60_000 // Wednesday 18 Nov, 22:31 IST: after the 15:00 cut-off, so Thursday's NAV
const columns = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

/** The wallet as the engine runs it, on a file database, with a clock the test moves. */
function contextOn(db: Db, at: number): Ctx & { clock: FakeClock } {
  const clock = new FakeClock(at)
  const market = new Market(db, clock)
  return { db, clock, market, venues: buildVenues(db, market, clock) }
}
function nav(ctx: Ctx, date: string, value: string): void {
  ctx.db.run('INSERT OR REPLACE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', 'amfi:120716', date, value, ctx.clock.now(), 'test')
  ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: value, sourceTs: Date.parse(`${date}T00:00:00+05:30`), precision: 'day', recvTs: ctx.clock.now(), provider: 'test' })
}
function order(ctx: Ctx, eid: string, params: Omit<OrderParams, 'instrumentId' | 'type' | 'purpose'>) {
  const now = ctx.clock.now()
  const ap = createApproval(ctx.db, USER, { purpose: 'action', subject: `action:${eid}`, document: `Test approval for ${eid}`, requiresStepUp: false }, now)
  confirmApproval(ctx.db, USER, ap.id, { method: 'session', docHash: ap.doc_hash }, now)
  return createAction(ctx, { userId: USER, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid, params: { instrumentId: 'amfi:120716', type: 'nav', purpose: 'manual', ...params } as OrderParams, approvalId: ap.id })
}
async function run(ctx: Ctx & { clock: FakeClock }, seconds = 6): Promise<void> {
  for (let i = 0; i < seconds; i++) { await stepAllActions(ctx); await ctx.venues.funds.tick(); await stepAllActions(ctx); ctx.clock.advance(1000) }
}
const orderRow = (db: Db, ref: string) => db.get<{ id: string; state: string; funds_at: number | null; created_at: number; meta_json: string }>('SELECT id, state, funds_at, created_at, meta_json FROM pv_orders WHERE client_ref = ?', ref)!

/**
 * A database as schema v7 left it, made by this build's own paths and then put back into v7's shape: one purchase
 * allotted, one waiting for its NAV, one refused by the registrar, one redemption waiting; the v8 column taken out, the
 * pay-in each v8 order carries removed, and a purchase whose money had arrived written back as 'accepted', as v7 kept it.
 * `alsoV8` leaves one more purchase exactly as a v8 build writes it, waiting for its pay-in, to show the step leaves it alone.
 */
async function v7Database(alsoV8 = false): Promise<{ path: string; waiting: string; done: string }> {
  const path = join(tempFolder('qed-v8-'), 'qed.db')
  const db = openDb(path)
  seedRegistry(db)
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', USER, 'fund-owner', 'Fund Owner', 'x', T0)
  openHousehold(db, USER, DEFAULT_OPENING, {}, T0)
  const ctx = contextOn(db, T0)
  nav(ctx, '2026-11-17', '178.8713')
  const done = order(ctx, 'mf-allotted', { side: 'buy', amount: '500000' })
  await run(ctx)
  ctx.clock.set(T0 + 12 * 3600_000)
  nav(ctx, '2026-11-18', '180.0000')
  await run(ctx)
  expect(getAction(db, done.id)!.state).toBe('done')
  ctx.clock.set(LATE)
  const waiting = order(ctx, 'mf-waiting', { side: 'buy', amount: '300000' })
  order(ctx, 'mf-redeem', { side: 'sell', qty: '5000' })
  ctx.venues.funds.submit({ clientRef: 'mf-refused', userId: USER, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 5_000n }) // under the ₹100 minimum
  await run(ctx)
  expect(orderRow(db, 'mf-waiting').state).toBe('funded')
  expect(orderRow(db, 'mf-redeem').state).toBe('accepted')
  expect(orderRow(db, 'mf-refused').state).toBe('rejected')
  if (alsoV8) { order(ctx, 'mf-v8', { side: 'buy', amount: '200000' }); await stepAllActions(ctx) }
  db.close()
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    raw.exec(`UPDATE pv_orders SET state = 'accepted' WHERE state = 'funded'`)
    raw.exec(`UPDATE pv_orders SET meta_json = json_remove(meta_json, '$.fundsDueAt') WHERE client_ref != 'mf-v8'`)
    raw.exec(`UPDATE actions SET result_json = json_remove(result_json, '$.registrarAt', '$.fundsAt', '$.allottedAt', '$.navDate') WHERE economic_id != 'mf-v8'`)
    raw.exec(`UPDATE actions SET result_json = json_set(result_json, '$.venueState', 'accepted') WHERE json_extract(result_json, '$.venueState') = 'funded'`)
    raw.exec('ALTER TABLE pv_orders DROP COLUMN funds_at')
    raw.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } finally { raw.close() }
  return { path, waiting: waiting.id, done: done.id }
}

describe('schema v8: a fund purchase\'s money received is a state of its own', () => {
  it('a v7 database migrates after its copy is sealed: every fund order keeps its state and its NAV day, and each purchase gains the time its money was treated as received', async () => {
    expect(SCHEMA_VERSION).toBe('8')
    const { path } = await v7Database()
    const before = new DatabaseSync(path, { readOnly: true })
    const was = new Map((before.prepare('SELECT client_ref, state, created_at, meta_json FROM pv_orders').all() as { client_ref: string; state: string; created_at: number; meta_json: string }[]).map((r) => [r.client_ref, r]))
    try { expect(columns(before, 'pv_orders')).not.toContain('funds_at') } finally { before.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: '8' })
      const allotted = orderRow(db, 'mf-allotted'), waiting = orderRow(db, 'mf-waiting'), redeem = orderRow(db, 'mf-redeem'), refused = orderRow(db, 'mf-refused')
      expect(allotted).toMatchObject({ state: 'filled', funds_at: was.get('mf-allotted')!.created_at })
      expect(waiting).toMatchObject({ state: 'funded', funds_at: was.get('mf-waiting')!.created_at })
      expect(JSON.parse(waiting.meta_json).minNavDate).toBe('2026-11-19') // the NAV day it was promised
      expect(waiting.meta_json).toBe(was.get('mf-waiting')!.meta_json)
      expect(redeem).toMatchObject({ state: 'accepted', funds_at: null }) // a redemption has no money to receive
      expect(refused).toMatchObject({ state: 'rejected', funds_at: null }) // its money was returned, never received
    } finally { db.close() }
    // the copy sealed first restores to the v7 database as it was
    const manifests = listManifests(join(dirname(path), 'migration-copies'))
    expect(manifests).toHaveLength(1)
    const target = join(tempFolder('qed-v8-restored-'), 'qed.db')
    expect(restoreBackup({ manifest: manifests[0]!, keyring: openKeyring('migration-copy'), target }).manifest.migration).toEqual({ from: '7', to: '8' })
    const restored = new DatabaseSync(target, { readOnly: true })
    try {
      expect((restored.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('7')
      expect(columns(restored, 'pv_orders')).not.toContain('funds_at')
    } finally { restored.close() }
  })

  it('nothing is sent again: the action in flight reads its order as funded, and the same order is allotted when its NAV comes', async () => {
    const { path, waiting } = await v7Database()
    const db = openDb(path)
    try {
      const ctx = contextOn(db, LATE + 60_000)
      const attempts = getAction(db, waiting)!.attempt
      await run(ctx)
      const a = getAction(db, waiting)!
      expect(a).toMatchObject({ state: 'working', attempt: attempts })
      expect(a.result).toMatchObject({ venueState: 'funded', fundsAt: orderRow(db, 'mf-waiting').created_at, navEntitledFrom: '2026-11-19' })
      ctx.clock.set(Date.parse('2026-11-19T16:00:00Z'))
      nav(ctx, '2026-11-19', '181.2500')
      await run(ctx)
      const finished = getAction(db, waiting)!
      expect(finished).toMatchObject({ state: 'done', attempt: attempts, recon_state: 'reconciled' })
      expect(finished.result).toMatchObject({ venueState: 'filled', navDate: '2026-11-19' })
      expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders WHERE client_ref = 'mf-waiting'`)!.n).toBe(1)
      expect(orderRow(db, 'mf-redeem').state).toBe('filled') // the redemption went on as before
    } finally { db.close() }
  })

  it('leaves an order a v8 build wrote alone (its money is still on its way), and migrates once', async () => {
    const { path } = await v7Database(true)
    openDb(path).close()
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: '8' })
      expect(orderRow(db, 'mf-v8')).toMatchObject({ state: 'accepted', funds_at: null })
      expect(typeof JSON.parse(orderRow(db, 'mf-v8').meta_json).fundsDueAt).toBe('number')
    } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })
})
