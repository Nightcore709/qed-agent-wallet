/**
 * The on-chain wallet in the household's books (R13; RISK-084 and F-068; server/chain-books.ts), against a stand-in of the
 * wallet service's HTTP contract (server/rail-fake.ts, FakeChain). chain/test/movements.test.ts reads the same movements
 * from a real chain. What is checked here:
 *   - every final movement is booked once, balanced, with the block's time as its effective time and the posting as its
 *     entry time; a movement with fewer than two confirmations waits;
 *   - booking is idempotent by transaction hash and log index across a repeat, a restart and two syncs at once;
 *   - a conversion books the venue's fee apart and records the spread against the pool's price before it, or says they
 *     cannot be separated; escrow funding, settlement, refund and earnings each go where their names say;
 *   - a block that is reorganised away is reversed by a new entry, never deleted, and a transfer mined again is booked once;
 *   - the comparison with the wallet service's balances: in flight counted, a mismatch stored as an error state with its
 *     figures, raised, kept beside later agreement and never corrected; an unanswered service is not a mismatch;
 *   - the backfill of a household with history, marked by the v7 to v8 step and done once at the next sync.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { canonicalAddress } from '../shared/instrument.ts'
import { chainBooksSchedule, chainBooksView, chainClosings, closeReplacedChain, closingPreview, compareChainBooks, lastChainComparison, prepareClosing, syncChainBooks, TEST_TOKEN_WORDS } from './chain-books.ts'
import { confirmApproval } from './approvals.ts'
import { openDb, type Db } from './core.ts'
import { openHousehold, DEFAULT_OPENING } from './household.ts'
import { balance, listEntries, verifyLedger, type EntryView } from './ledger.ts'
import { saveVault } from './rail.ts'
import { FakeChain, FakeRail } from './rail-fake.ts'
import { reconcileUser } from './recon.ts'
import { assetInstrumentId, seedRegistry } from './registry.ts'
import { toSchemaV7 } from './schema-fixture.ts'
import { makeKit, T0, type Kit } from './testkit.ts'
import { testKeys } from './key-fixture.ts'

const fake = new FakeRail()
const CFG = { dbPath: '/nowhere/qed.db' }
const folders: string[] = []
const folder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
const keys = testKeys(folder('qed-chainbooks-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(async () => { process.env.QED_KEY_DIR = keys.dir; await fake.start() })
afterAll(async () => { await fake.stop(); if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore; for (const d of folders) rmSync(d, { recursive: true, force: true }) })
beforeEach(() => fake.reset())

const PLACES = ['treasury', 'reserve', 'owner'] as const
/** A vault for the household, on the fake service, and its chain. */
function vaultFor(db: Db, userId: string, now: number, railId = 'qed-books-000001'): FakeChain {
  saveVault(db, userId, { railId, request: { workspaceId: railId, owner: { signers: [], threshold: 1 }, rpIdHash: `0x${'00'.repeat(32)}`, origin: 'http://localhost:5175' }, credentialIds: [], createdAt: now, createdBy: userId })
  return fake.addChain(railId, Math.floor(now / 1000) - 3600)
}
const assetOf = (c: FakeChain, s: 'tINR' | 'tUSD'): string => `eip155:31337/erc20:${canonicalAddress(c.tokens[s]!.address)}`
/** What the books say the wallet holds of a token: its three holders together. */
const held = (db: Db, userId: string, c: FakeChain, s: 'tINR' | 'tUSD'): bigint => PLACES.reduce((t, p) => t + balance(db, userId, `chain:${p}:${assetOf(c, s)}`), 0n)
/** What the chain holds of a token, all three holders. */
const onChain = (c: FakeChain, s: 'tINR' | 'tUSD'): bigint => c.balance(s, 'treasury') + c.balance(s, 'reserve') + c.balance(s, 'owner-account')
const chainEntries = (db: Db, userId: string): EntryView[] => listEntries(db, userId, { limit: 500 }).filter((e) => e.kind.startsWith('chain-')).reverse()
const sumsByAsset = (e: EntryView): Map<string, bigint> => { const m = new Map<string, bigint>(); for (const l of e.lines) m.set(l.asset, (m.get(l.asset) ?? 0n) + BigInt(l.amount_text)); return m }
const line = (e: EntryView, code: string): bigint => BigInt(e.lines.find((l) => l.code === code)?.amount_text ?? '0')
const sync = (k: { db: Db; userId: string; clock: Kit['clock'] }) => syncChainBooks(CFG, k.db, k.userId, k.clock.now())
/** A history: the opening grant, a payment, a withdrawal into the wallet's own account. */
function history(c: FakeChain): { grant: string; pay: string; withdraw: string } {
  const grant = c.tx([c.grant('treasury', 100_000n), c.grant('owner-account', 50_000n)], { jobId: 'job-provision' })
  const pay = c.tx([c.pay(350n)], { jobId: 'job-pay' })
  const withdraw = c.tx([c.own('treasury', 'owner-account', 125n)], { jobId: 'job-withdraw' })
  return { grant, pay, withdraw }
}

describe('booking the wallet\'s movements', () => {
  it('books every final movement once, balanced in each asset, effective at its block\'s time and entered when QED posted it', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    const h = history(c)
    c.mine(1) // the withdrawal's block now has two confirmations
    k.clock.advance(60_000)
    const r = await sync(k)
    expect(r).toMatchObject({ state: 'synced', posted: 4, reversed: 0 })
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    const es = chainEntries(k.db, k.userId)
    expect(es.map((e) => [e.kind, e.meta.txHash, e.meta.logIndex])).toEqual([['chain-grant', h.grant, 0], ['chain-grant', h.grant, 1], ['chain-payment', h.pay, 0], ['chain-own-transfer', h.withdraw, 0]])
    for (const e of es) {
      for (const [asset, s] of sumsByAsset(e)) expect(s, `${e.ref} in ${asset}`).toBe(0n)
      const blockTs = Number(e.meta.blockTimestamp)
      expect(e.effective_ts).toBe(blockTs * 1000)
      expect(e.ts).toBe(k.clock.now())
      expect(e.ref).toBe(`chain:eip155:31337:${String(e.meta.txHash)}:${String(e.meta.logIndex)}@${String(e.meta.blockHash)}`)
      expect(e.lines.every((l) => l.asset.startsWith('eip155:31337/erc20:'))).toBe(true)
    }
    expect(line(es[2]!, `chain:treasury:${assetOf(c, 'tINR')}`)).toBe(-350n)
    expect(line(es[2]!, `chain:paid:${assetOf(c, 'tINR')}`)).toBe(350n)
    expect(es[2]!.meta).toMatchObject({ counterparty: { kind: 'payee', label: 'CloudCo' }, jobId: 'job-pay' })
    expect(held(k.db, k.userId, c, 'tINR')).toBe(onChain(c, 'tINR'))
    expect(balance(k.db, k.userId, `chain:owner:${assetOf(c, 'tINR')}`)).toBe(50_125n)
  })

  it('a movement with one confirmation waits; the next block makes it final and it is booked then', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    const r1 = await sync(k)
    expect(r1.posted).toBe(3) // the withdrawal, in the latest block, has one confirmation
    expect(r1.pending.map((p) => p.confirmations)).toEqual([1])
    expect(chainEntries(k.db, k.userId).some((e) => e.kind === 'chain-own-transfer')).toBe(false)
    c.mine(1)
    k.clock.advance(5_000)
    expect((await sync(k)).posted).toBe(1)
    expect(chainEntries(k.db, k.userId).map((e) => e.kind)).toContain('chain-own-transfer')
  })

  it('is idempotent by transaction hash and log index: a repeat, a restart and two syncs at once book nothing twice', async () => {
    const dir = folder('qed-chainbooks-idem-')
    const path = join(dir, 'qed.db')
    const db1 = openDb(path)
    seedRegistry(db1)
    db1.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_i', 'idem', 'Idem', 'x', T0)
    openHousehold(db1, 'usr_i', DEFAULT_OPENING, {}, T0)
    const c = vaultFor(db1, 'usr_i', T0)
    history(c)
    c.tx(c.convert({ amountIn: 84_000n, rIn: 840_000_000n, rOut: 100_000_000_000n }), { jobId: 'job-convert' })
    c.mine(2)
    const db2 = openDb(path) // a second connection: the engine and the API are two processes
    // two at once: one of them books, the other finds the household busy or nothing left to book
    const [a, b] = await Promise.all([syncChainBooks(CFG, db1, 'usr_i', T0 + 1000), syncChainBooks(CFG, db2, 'usr_i', T0 + 1000)])
    expect(a.posted + b.posted).toBe(6)
    const count = (db: Db) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE user_id = 'usr_i' AND kind LIKE 'chain-%'`)!.n
    expect(count(db1)).toBe(6)
    // again, on each connection, and after a restart
    expect((await syncChainBooks(CFG, db1, 'usr_i', T0 + 2000)).posted).toBe(0)
    expect((await syncChainBooks(CFG, db2, 'usr_i', T0 + 2000)).posted).toBe(0)
    db1.close(); db2.close()
    const db3 = openDb(path)
    try {
      // a cursor lost or behind (an interrupted sync) asks the service again from the start: still once each
      db3.run(`UPDATE chain_books SET cursor_block = -1, cursor_hash = NULL WHERE user_id = 'usr_i'`)
      expect((await syncChainBooks(CFG, db3, 'usr_i', T0 + 3000)).posted).toBe(0)
      expect(count(db3)).toBe(6)
      expect(db3.get<{ n: number }>(`SELECT COUNT(*) n FROM chain_movements WHERE user_id = 'usr_i' AND reversed_at IS NULL`)!.n).toBe(6)
      // and the database refuses a second live booking of one log even if a writer skipped the checks
      const one = db3.get<{ tx_hash: string; log_index: number }>(`SELECT tx_hash, log_index FROM chain_movements WHERE user_id = 'usr_i' LIMIT 1`)!
      expect(() => db3.run(`INSERT INTO chain_movements (user_id, network, tx_hash, log_index, block_number, block_hash, block_ts, kind, asset_id, amount_text, entry_id, posted_at, source) VALUES ('usr_i', 'eip155:31337', ?, ?, 99, '0xother', 0, 'chain-payment', 'x', '1', 'ent_x', 0, 'sync')`, one.tx_hash, one.log_index)).toThrow(/UNIQUE/)
      expect(verifyLedger(db3, 'usr_i')).toEqual([])
    } finally { db3.close() }
  })
})

describe('what each movement is booked as', () => {
  it('a conversion books the venue\'s fee apart from what was converted and records the spread against the pool\'s price before it', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    c.tx([c.grant('treasury', 100_000n)])
    const rIn = 840_000_000n, rOut = 100_000_000_000n // 84 test rupees to one test dollar, as INR_VENUES' deep pool
    const conv = c.tx(c.convert({ amountIn: 84_000n, rest: 1_000n, rIn, rOut }), { jobId: 'job-convert' })
    c.mine(1)
    await sync(k)
    const legs = chainEntries(k.db, k.userId).filter((e) => e.meta.txHash === conv)
    expect(legs.map((e) => e.kind)).toEqual(['chain-conversion-out', 'chain-conversion-in', 'chain-conversion-in'])
    const [out, back, into] = legs as [EntryView, EntryView, EntryView]
    const A = assetOf(c, 'tINR'), U = assetOf(c, 'tUSD')
    // the pool's fee is 30 basis points of what went into it (83,000 paise): 249 paise, booked as a fee
    expect([line(out, `chain:treasury:${A}`), line(out, `chain:fee:${A}`), line(out, `chain:conversion:${A}`)]).toEqual([-84_000n, 249n, 83_751n])
    expect([line(back, `chain:treasury:${A}`), line(back, `chain:conversion:${A}`)]).toEqual([1_000n, -1_000n])
    const spent = 83_000n, inWithFee = spent * 9_970n, got = (inWithFee * rOut) / (rIn * 10_000n + inWithFee)
    expect([line(into, `chain:reserve:${U}`), line(into, `chain:conversion:${U}`)]).toEqual([got, -got])
    // the spread: what the net input was worth at the pool's price before the trade, less what came out, rounded down
    const spread = (inWithFee * rOut - got * rIn * 10_000n) / (rIn * 10_000n)
    expect(out.meta.conversion).toMatchObject({ fee: { asset: A, amount: '249', rounding: 'down' }, spread: [{ asset: U, amount: spread.toString(), rounding: 'down', against: 'the pool\'s own price just before the trade' }] })
    expect(spread).toBeGreaterThan(0n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('a conversion whose pool records the chain does not give: no fee line, and the books say the fee and the spread cannot be separated', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    c.tx([c.grant('treasury', 100_000n)])
    const conv = c.tx(c.convert({ amountIn: 8_400n, rIn: 840_000_000n, rOut: 100_000_000_000n, hops: false }))
    c.mine(1)
    await sync(k)
    const out = chainEntries(k.db, k.userId).find((e) => e.meta.txHash === conv && e.kind === 'chain-conversion-out')!
    expect(out.lines.map((l) => l.code).sort()).toEqual([`chain:conversion:${assetOf(c, 'tINR')}`, `chain:treasury:${assetOf(c, 'tINR')}`])
    expect(out.meta.conversion).toMatchObject({ fee: null, spread: [], inseparable: expect.stringMatching(/cannot be separated/) })
  })

  it('escrow work: the client\'s funding is held by the escrow, its settlement is paid for work, a refund comes back; the provider\'s earnings are money received for work, not booked as income', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now(), 'qed-books-client1')
    c.tx([c.grant('treasury', 100_000n), c.grant('owner-account', 1_000n)])
    c.tx([c.own('treasury', 'owner-account', 2_551n), c.escrowFund(2_551n, '7')], { jobId: 'job-fund' })
    c.tx([c.escrowSettledForClient(2_551n, '7')])
    c.tx([c.own('treasury', 'owner-account', 400n), c.escrowFund(400n, '8')], { jobId: 'job-fund-2' })
    c.tx([c.escrowRefund(400n, '8')])
    c.mine(1)
    await sync(k)
    const A = assetOf(c, 'tINR')
    const kinds = chainEntries(k.db, k.userId).map((e) => e.kind)
    expect(kinds).toEqual(['chain-grant', 'chain-grant', 'chain-own-transfer', 'chain-escrow-fund', 'chain-escrow-settled', 'chain-own-transfer', 'chain-escrow-fund', 'chain-escrow-refund'])
    expect(balance(k.db, k.userId, `chain:escrow:${A}`)).toBe(0n) // nothing left held: one paid, one back
    expect(balance(k.db, k.userId, `chain:work-paid:${A}`)).toBe(2_551n)
    expect(held(k.db, k.userId, c, 'tINR')).toBe(onChain(c, 'tINR'))

    const p = makeKit({ user: false })
    p.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_p', 'prov', 'Provider', 'x', T0)
    openHousehold(p.db, 'usr_p', DEFAULT_OPENING, {}, T0)
    const pc = vaultFor(p.db, 'usr_p', T0, 'qed-books-provider1')
    pc.tx([pc.escrowEarning(2_551n, '7')], { jobId: 'job-deliver' })
    pc.mine(1)
    await syncChainBooks(CFG, p.db, 'usr_p', T0 + 1000)
    const earned = chainEntries(p.db, 'usr_p').find((e) => e.kind === 'chain-escrow-earning')!
    const code = `chain:work-received:${assetOf(pc, 'tINR')}`
    expect(line(earned, code)).toBe(-2_551n)
    const acc = p.db.get<{ kind: string; name: string; meta_json: string }>('SELECT kind, name, meta_json FROM accounts WHERE user_id = ? AND code = ?', 'usr_p', code)!
    expect(acc.name).toMatch(/^Money received for work/)
    expect(acc.kind).not.toBe('income') // whether it is income is the owner's question Q-075
    expect(JSON.parse(acc.meta_json)).toMatchObject({ classification: 'undecided', question: 'Q-075' })
    expect(earned.meta).toMatchObject({ escrow: { jobId: '7', event: 'settled', role: 'provider' }, jobId: 'job-deliver' })
  })

  it('test tokens are assets of their own, named by chain and contract, never rupees; a token on a real network is not booked', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    await sync(k)
    const assets = k.db.all<{ id: string; kind: string; name: string; scale: number }>(`SELECT id, kind, name, scale FROM assets WHERE id LIKE 'eip155:%' ORDER BY scale`)
    expect(assets.map((a) => [a.id, a.kind, a.scale])).toEqual([[assetOf(c, 'tINR'), 'test_token', 2]])
    expect(assets[0]!.name).toMatch(/tINR.*test.*no value/i)
    const accounts = k.db.all<{ code: string; asset_id: string; instrument_id: string; name: string }>(`SELECT code, asset_id, instrument_id, name FROM accounts WHERE user_id = ? AND code LIKE 'chain:%'`, k.userId)
    expect(accounts.length).toBeGreaterThan(0)
    for (const a of accounts) {
      expect(a.asset_id).not.toBe('INR')
      expect(a.instrument_id).toBe(a.asset_id)
      expect(a.name, a.code).toMatch(/test (rupees|dollars)/)
    }
    expect(assetInstrumentId(assetOf(c, 'tINR'))).toBe(assetOf(c, 'tINR'))
    expect(assetInstrumentId(`eip155:1/erc20:${canonicalAddress(c.tokens.tINR!.address)}`)).toBeNull()
    expect(TEST_TOKEN_WORDS).toBe('valueless test tokens on a local chain')
  })
})

describe('a reorganisation', () => {
  it('a booked block that is no longer on the chain: the entry is reversed by a new entry, the owner is told, and the transfer mined again is booked once', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    c.tx([c.grant('treasury', 100_000n)])
    const pay = c.tx([c.pay(350n)], { jobId: 'job-pay' })
    c.mine(2)
    await sync(k)
    const first = chainEntries(k.db, k.userId).find((e) => e.meta.txHash === pay)!
    const payBlock = Number(first.meta.blockNumber)
    // the chain is replaced from the payment's block: the payment is gone
    c.reorg(payBlock)
    c.mine(3)
    k.clock.advance(10_000)
    const r = await sync(k)
    expect(r).toMatchObject({ reversed: 1, posted: 0 })
    const rev = chainEntries(k.db, k.userId).find((e) => e.kind === 'chain-reversal')!
    expect(rev.meta).toMatchObject({ reverses: first.ref, txHash: pay })
    for (const l of first.lines) expect(line(rev, l.code)).toBe(-BigInt(l.amount_text))
    expect(rev.effective_ts).toBe(k.clock.now()) // effective when QED found the block gone
    expect(chainEntries(k.db, k.userId).find((e) => e.id === first.id)).toBeDefined() // nothing deleted
    expect(k.db.get<{ reversed_at: number | null }>('SELECT reversed_at FROM chain_movements WHERE entry_id = ?', first.id)!.reversed_at).toBe(k.clock.now())
    expect(k.db.get(`SELECT level, kind FROM notices WHERE user_id = ? AND kind = 'chain-reorganised' AND resolved_at IS NULL`, k.userId)).toMatchObject({ level: 'warning' })
    expect(held(k.db, k.userId, c, 'tINR')).toBe(onChain(c, 'tINR'))

    // replaced again, with the payment mined once more in a new block: booked once, live once
    const k2 = makeKit()
    const c2 = vaultFor(k2.db, k2.userId, k2.clock.now(), 'qed-books-000002')
    c2.tx([c2.grant('treasury', 100_000n)])
    const pay2 = c2.tx([c2.pay(350n)])
    c2.mine(2)
    await sync(k2)
    c2.reorg(Number(chainEntries(k2.db, k2.userId).find((e) => e.meta.txHash === pay2)!.meta.blockNumber), [pay2])
    c2.mine(2)
    k2.clock.advance(10_000)
    expect(await sync(k2)).toMatchObject({ reversed: 1, posted: 1 })
    expect(k2.db.get<{ n: number }>(`SELECT COUNT(*) n FROM chain_movements WHERE user_id = ? AND tx_hash = ? AND reversed_at IS NULL`, k2.userId, pay2)!.n).toBe(1)
    expect(held(k2.db, k2.userId, c2, 'tINR')).toBe(onChain(c2, 'tINR'))
    expect((await sync(k2)).posted).toBe(0)
    expect(verifyLedger(k2.db, k2.userId)).toEqual([])
  })
})

describe('reconciling the books with the wallet service\'s balances', () => {
  it('agrees when the chain\'s balances equal the books plus what is still in flight', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c) // the withdrawal is in flight (one confirmation): it moves money between the wallet's own holders
    c.tx([c.pay(200n)]) // and a payment in flight
    const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(cmp.state).toBe('agrees')
    const tinr = cmp.assets.find((a) => a.symbol === 'tINR')!
    expect(tinr).toMatchObject({ books: String(149_650n), inFlight: '-200', chain: String(149_450n), difference: '0', words: 'test rupees' })
    expect(cmp.block).toBe(c.head.number)
    expect(lastChainComparison(k.db, k.userId)).toMatchObject({ state: 'agrees' })
  })

  it('a mismatch is stored as an error state with its figures, raised to the owner and recorded by reconciliation; nothing is corrected, and a later agreement is kept beside it', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    const before = { entries: chainEntries(k.db, k.userId).length, held: held(k.db, k.userId, c, 'tINR') }
    c.stateOffset.tINR = -500n // the wallet service reports five test rupees less than the books hold
    k.clock.advance(30_000)
    const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(cmp.state).toBe('disagrees')
    expect(cmp.assets.find((a) => a.symbol === 'tINR')).toMatchObject({ books: String(before.held), chain: String(before.held - 500n), inFlight: '0', difference: '-500' })
    const row = k.db.get<{ state: string; figures_json: string; block_number: number; ts: number }>(`SELECT state, figures_json, block_number, ts FROM chain_recon WHERE user_id = ? ORDER BY ts DESC LIMIT 1`, k.userId)!
    expect(row).toMatchObject({ state: 'disagrees', block_number: c.head.number, ts: k.clock.now() })
    expect(JSON.parse(row.figures_json)).toEqual(cmp.assets)
    expect(k.db.get(`SELECT kind, level, title FROM notices WHERE user_id = ? AND kind = 'chain-books-disagree' AND resolved_at IS NULL`, k.userId)).toMatchObject({ level: 'action', title: 'Your books and your on-chain wallet disagree' })
    // never corrected: no entry was posted and no balance moved
    expect({ entries: chainEntries(k.db, k.userId).length, held: held(k.db, k.userId, c, 'tINR') }).toEqual(before)
    // the error state cannot be edited away
    expect(() => k.db.run(`UPDATE chain_recon SET state = 'agrees' WHERE user_id = ?`, k.userId)).toThrow(/append-only/)
    expect(() => k.db.run('DELETE FROM chain_recon WHERE user_id = ?', k.userId)).toThrow(/append-only/)
    // the scheduled reconciliation records it as a break, under its own words, without a second notice for it
    const rec = reconcileUser(k.ctx, k.userId)
    expect(rec.ok).toBe(false)
    expect(rec.breaks.some((b) => /books and your on-chain wallet disagree/.test(b) && /5\.00/.test(b))).toBe(true)
    expect(k.db.get(`SELECT 1 x FROM notices WHERE user_id = ? AND kind = 'recon-break' AND resolved_at IS NULL`, k.userId)).toBeUndefined()

    // the chain agrees again: a new row, the old one kept, the notice resolved
    c.stateOffset = {}
    k.clock.advance(30_000)
    expect((await compareChainBooks(CFG, k.db, k.userId, k.clock.now())).state).toBe('agrees')
    expect(k.db.all<{ state: string }>(`SELECT state FROM chain_recon WHERE user_id = ? ORDER BY ts`, k.userId).map((r) => r.state)).toEqual(['agrees', 'disagrees', 'agrees'])
    expect(k.db.get(`SELECT 1 x FROM notices WHERE user_id = ? AND kind = 'chain-books-disagree' AND resolved_at IS NULL`, k.userId)).toBeUndefined()
    expect(reconcileUser(k.ctx, k.userId).ok).toBe(true)
  })

  it('an unanswered wallet service is not a mismatch: nothing is booked and the comparison says it is unknown', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    fake.up = false
    const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(cmp.state).toBe('unknown')
    expect(cmp.why).toMatch(/did not answer/)
    expect(chainEntries(k.db, k.userId)).toEqual([])
    expect(k.db.get(`SELECT 1 x FROM notices WHERE user_id = ? AND kind = 'chain-books-disagree'`, k.userId)).toBeUndefined()
    expect(reconcileUser(k.ctx, k.userId).breaks.filter((b) => /on-chain wallet/.test(b))).toEqual([])
  })

  it('a wallet service on a different chain (its data folder replaced): nothing is booked or reversed, and the books and the chain are said to disagree', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    const n = chainEntries(k.db, k.userId).length
    c.genesisId = 'genesis-replaced'
    c.tx([c.pay(100n)])
    c.mine(2)
    const r = await syncChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(r.state).toBe('chain-replaced')
    const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(cmp.state).toBe('disagrees')
    expect(cmp.why).toMatch(/different chain/)
    expect(chainEntries(k.db, k.userId).length).toBe(n)
  })
})

describe('closing the books of a replaced chain (R13): on the owner\'s passkey approval of the shown preview, never automatically', () => {
  it('closes what the books held on the old chain with one entry, takes its bookings out of the live set, keeps the books against the new chain, and records it; then the books agree again', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    const before = { inr: held(k.db, k.userId, c, 'tINR'), entries: chainEntries(k.db, k.userId).length }
    expect(before.inr).toBeGreaterThan(0n)
    expect(await closingPreview(CFG, k.db, k.userId)).toBeNull()
    await expect(prepareClosing(CFG, k.db, k.userId, k.clock.now())).rejects.toMatchObject({ code: 'not_replaced' })

    // the wallet service's data folder is replaced: another chain, with a history of its own
    c.genesisId = 'genesis-replaced'
    c.reorg(1)
    c.tx([c.grant('treasury', 70_000n)], { jobId: 'job-provision-2' })
    c.mine(2)
    k.clock.advance(60_000)
    expect((await compareChainBooks(CFG, k.db, k.userId, k.clock.now())).state).toBe('disagrees')
    // never automatic: syncing and comparing again close nothing
    expect((await syncChainBooks(CFG, k.db, k.userId, k.clock.now())).state).toBe('chain-replaced')
    expect(chainEntries(k.db, k.userId).length).toBe(before.entries)

    const p = (await closingPreview(CFG, k.db, k.userId))!
    expect([p.oldGenesis, p.newGenesis]).toEqual([`genesis-${c.seed}`, 'genesis-replaced'])
    expect(p.accounts.reduce((t, a) => t + (a.asset === assetOf(c, 'tINR') ? BigInt(a.amount) : 0n), 0n)).toBe(before.inr)
    expect(p.movements).toBeGreaterThan(0)
    expect(p.words).toMatch(/Nothing is deleted, and nothing moves on any chain/)

    // only a passkey-confirmed approval of this preview closes
    const ap = await prepareClosing(CFG, k.db, k.userId, k.clock.now())
    expect(ap.requiresStepUp).toBe(true)
    await expect(closeReplacedChain(CFG, k.db, k.userId, k.userId, ap.approvalId, k.clock.now())).rejects.toMatchObject({ code: 'passkey_required' })
    confirmApproval(k.db, k.userId, ap.approvalId, { method: 'password', docHash: ap.docHash }, k.clock.now())
    await expect(closeReplacedChain(CFG, k.db, k.userId, k.userId, ap.approvalId, k.clock.now())).rejects.toMatchObject({ code: 'passkey_required' })
    const ap2 = await prepareClosing(CFG, k.db, k.userId, k.clock.now())
    confirmApproval(k.db, k.userId, ap2.approvalId, { method: 'passkey', docHash: ap2.docHash }, k.clock.now())
    // the service moved to yet another chain after the approval: what was approved is not what closing would do
    c.genesisId = 'genesis-replaced-again'
    await expect(closeReplacedChain(CFG, k.db, k.userId, k.userId, ap2.approvalId, k.clock.now())).rejects.toMatchObject({ code: 'preview_changed' })
    c.genesisId = 'genesis-replaced'
    const out = await closeReplacedChain(CFG, k.db, k.userId, k.userId, ap2.approvalId, k.clock.now())
    expect(out.movements).toBe(p.movements)
    await expect(closeReplacedChain(CFG, k.db, k.userId, k.userId, ap2.approvalId, k.clock.now())).rejects.toBeTruthy()

    // the closing entry: balanced per token, the holders at nothing, nothing deleted
    const closing = chainEntries(k.db, k.userId).find((e) => e.kind === 'chain-closing')!
    expect([...sumsByAsset(closing).values()].every((x) => x === 0n)).toBe(true)
    expect(held(k.db, k.userId, c, 'tINR')).toBe(0n)
    expect(chainEntries(k.db, k.userId).length).toBe(before.entries + 1)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    const rec = chainClosings(k.db, k.userId)
    expect(rec.map((r) => [r.oldGenesis, r.newGenesis, r.entryId, r.movements])).toEqual([[p.oldGenesis, 'genesis-replaced', closing.id, p.movements]])
    expect(() => k.db.run('UPDATE chain_closings SET movements = 0')).toThrow(/append-only/)
    expect(() => k.db.run('DELETE FROM chain_closings')).toThrow(/append-only/)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE action = 'chain-books.closed'`)!.n).toBe(1)

    // the books now follow the new chain from its first block, as a late history, and agree with it
    k.clock.advance(60_000)
    const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    expect(cmp.state).toBe('agrees')
    expect(held(k.db, k.userId, c, 'tINR')).toBe(onChain(c, 'tINR'))
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
})

describe('the books\' own view of the wallet', () => {
  it('lists each entry with both its times, in the order it was entered, which is block order; labels the tokens; gives each asset\'s books', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.tx(c.convert({ amountIn: 8_400n, rIn: 840_000_000n, rOut: 100_000_000_000n }))
    c.mine(1)
    k.clock.advance(90_000)
    await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
    const v = chainBooksView(k.db, k.userId, k.clock.now())
    expect(v.words).toBe(TEST_TOKEN_WORDS)
    expect(v.ordering).toMatch(/entered/)
    expect(v.assets.map((a) => [a.symbol, a.words])).toEqual([['tINR', 'test rupees'], ['tUSD', 'test dollars']])
    expect(v.assets[0]!.books).toBe(String(held(k.db, k.userId, c, 'tINR')))
    expect(v.entries.length).toBe(chainEntries(k.db, k.userId).length)
    const blocks = v.entries.map((e) => [Number(e.blockNumber), Number(e.logIndex)])
    expect(blocks).toEqual([...blocks].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)) // entered in block order
    for (const e of v.entries) {
      expect(e.effectiveTs).toBe(Number(e.blockTimestamp) * 1000)
      expect(e.entryTs).toBe(k.clock.now())
      expect(e.effectiveTs).toBeLessThanOrEqual(e.entryTs)
    }
    expect(v.comparison).toMatchObject({ state: 'agrees' })
  })
})

describe('the backfill of a household with history', () => {
  it('the v7 to v8 step marks a household that has a vault; the next sync books its whole history once, entered late, and records that it did', async () => {
    const path = join(folder('qed-chainbooks-backfill-'), 'qed.db')
    let db = openDb(path)
    seedRegistry(db)
    db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_h', 'hist', 'History', 'x', T0)
    db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_n', 'novault', 'No vault', 'x', T0)
    for (const u of ['usr_h', 'usr_n']) openHousehold(db, u, DEFAULT_OPENING, {}, T0)
    const c = vaultFor(db, 'usr_h', T0)
    const entriesBefore = db.get<{ n: number }>('SELECT COUNT(*) n FROM entries')!.n
    db.close()
    toSchemaV7(path)
    // the wallet's history on the chain, from before the books knew of it
    history(c)
    c.tx(c.convert({ amountIn: 84_000n, rIn: 840_000_000n, rOut: 100_000_000_000n }))
    c.tx([c.own('treasury', 'owner-account', 2_551n), c.escrowFund(2_551n, '3')])
    c.tx([c.escrowSettledForClient(2_551n, '3')])
    c.mine(2)
    db = openDb(path) // migrates to v8
    try {
      expect(db.all(`SELECT user_id, backfill, cursor_block FROM chain_books ORDER BY user_id`)).toEqual([{ user_id: 'usr_h', backfill: 'needed', cursor_block: -1 }])
      expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM entries')!.n).toBe(entriesBefore) // the step itself books nothing and moves no money
      const at = T0 + 7 * 86_400_000
      const r = await syncChainBooks(CFG, db, 'usr_h', at)
      expect(r.posted).toBe(9) // the grant (2), the payment, the withdrawal, the conversion (2), the funding (2), the settlement
      expect(db.get(`SELECT backfill, backfill_at FROM chain_books WHERE user_id = 'usr_h'`)).toEqual({ backfill: 'done', backfill_at: at })
      const es = chainEntries(db, 'usr_h')
      expect(es.every((e) => e.ts === at && e.effective_ts < at && e.meta.recordedLate === true && e.meta.source === 'backfill')).toBe(true)
      expect(db.get(`SELECT action, detail_json FROM audit WHERE user_id = 'usr_h' AND action = 'chain-books.backfill'`)).toMatchObject({ action: 'chain-books.backfill' })
      expect(held(db, 'usr_h', c, 'tINR')).toBe(onChain(c, 'tINR'))
      expect(held(db, 'usr_h', c, 'tUSD')).toBe(onChain(c, 'tUSD'))
      expect(verifyLedger(db, 'usr_h')).toEqual([])
      expect((await syncChainBooks(CFG, db, 'usr_h', at + 1000)).posted).toBe(0)
    } finally { db.close() }
    db = openDb(path) // a restart: nothing again
    try {
      expect((await syncChainBooks(CFG, db, 'usr_h', T0 + 8 * 86_400_000)).posted).toBe(0)
      expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE user_id = 'usr_h' AND kind LIKE 'chain-%'`)!.n).toBe(9)
    } finally { db.close() }
  })

  it('the schedule syncs and compares every household with a vault, on the reconciliation\'s cadence, and one without a vault is left alone', async () => {
    const k = makeKit()
    const c = vaultFor(k.db, k.userId, k.clock.now())
    history(c)
    c.mine(1)
    k.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_other', 'other', 'Other', 'x', T0)
    const said = await chainBooksSchedule(CFG, k.db, k.clock.now())
    expect(said).toMatch(/1 wallet/)
    expect(lastChainComparison(k.db, k.userId)).toMatchObject({ state: 'agrees' })
    expect(lastChainComparison(k.db, 'usr_other')).toBeNull()
  })
})
