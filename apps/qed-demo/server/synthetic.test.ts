/** Presentation mode (N-003): synthetic market data only, on a database of its own. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock, openDb } from './core.ts'
import { Market } from './market.ts'
import { crossCheck } from './policy.ts'
import { instrument, instruments, seedRegistry } from './registry.ts'
import { assertPresentationDb, SYNTHETIC, syntheticNavThrough, SyntheticProvider, syntheticBook } from './synthetic.ts'
import { buildVenues } from './venues.ts'

const T0 = Date.parse('2026-11-23T05:00:00Z') // a Monday, 10:30 IST
function stack() {
  const db = openDb(':memory:'); seedRegistry(db, { presentation: true })
  const clock = new FakeClock(T0)
  const market = new Market(db, clock)
  return { db, clock, market, ctx: { db, clock, market, venues: buildVenues(db, market, clock) } }
}

describe('presentation mode: synthetic market data', () => {
  it('every instrument gets a synthetic value; prices hang together so the cross-check passes; funds have a past year of NAVs', () => {
    const s = stack()
    const p = new SyntheticProvider(s.market)
    p.seedHistory(T0); p.tick(T0); s.market.flush()
    const providers = s.db.all<{ provider: string }>('SELECT DISTINCT provider FROM quotes')
    expect(providers).toEqual([{ provider: SYNTHETIC }])
    // the securities desks' instruments are priced by their own synthetic feed (securities.ts, tested in securities.test.ts)
    for (const i of instruments(s.db).filter((x) => x.provider !== 'synthetic-markets')) expect(s.db.get('SELECT 1 FROM quotes WHERE instrument_id = ?', i.id), i.id).toBeDefined()
    expect(crossCheck(s.ctx, instrument(s.db, 'coindcx:BTCINR')!, T0)).toMatchObject({ ok: true, available: true })
    expect(s.db.all('SELECT DISTINCT source FROM daily_values')).toEqual([{ source: SYNTHETIC }])
    expect(s.db.get<{ n: number }>(`SELECT COUNT(*) n FROM daily_values WHERE instrument_id = 'amfi:120716'`)!.n).toBeGreaterThan(250)
    expect(s.market.book('coindcx:BTCINR')?.provider).toBe(SYNTHETIC)
    // a minute later the walk has moved, and still passes the cross-check
    s.clock.advance(60_000); p.tick(T0 + 60_000); s.market.flush()
    expect(crossCheck(s.ctx, instrument(s.db, 'coindcx:BTCINR')!, T0 + 60_000).ok).toBe(true)
  })

  it("the paper exchange's book is built from the synthetic prices on record, in either process; nothing is fetched", async () => {
    const s = stack()
    await expect(syntheticBook(s.market, instrument(s.db, 'coindcx:BTCINR')!)).rejects.toThrow(/no synthetic price/)
    new SyntheticProvider(s.market).tick(T0); s.market.flush()
    const api = new Market(s.db, s.clock) // another process: it sees only what the engine stored
    const b = await syntheticBook(api, instrument(s.db, 'coindcx:BTCINR')!)
    expect(b.provider).toBe(SYNTHETIC)
    expect(Number(b.asks[0]!.price)).toBe(Number(api.get('coindcx:BTCINR', 'ask')!.price))
    expect(b.bids).toHaveLength(10)
  })

  it('is reproducible from its seeds', () => {
    const a = stack(), b = stack()
    new SyntheticProvider(a.market).tick(T0); new SyntheticProvider(b.market).tick(T0)
    expect(a.market.get('coindcx:BTCINR', 'last')!.price).toBe(b.market.get('coindcx:BTCINR', 'last')!.price)
  })

  it('refuses a database that holds live market data or limits calibrated on it; seeds no calibrated limit itself', () => {
    const s = stack()
    expect(() => assertPresentationDb(s.db)).not.toThrow()
    expect(s.db.get<{ n: number }>(`SELECT COUNT(*) n FROM terms WHERE status = 'calibrated'`)!.n).toBe(0)
    // a synthetic figure is never set beside a provider's name
    expect(instruments(s.db).filter((i) => /\((Binance|Coinbase|ECB reference)\)/.test(i.name)).map((i) => i.name)).toEqual([])
    s.db.run(`INSERT INTO quotes (instrument_id, price_type, price, size, source_ts, source_precision, recv_ts, provider, seq) VALUES ('coindcx:BTCINR', 'last', '6600000', NULL, ?, 'ms', ?, 'coindcx', 1)`, T0, T0)
    expect(() => assertPresentationDb(s.db)).toThrow(/needs a database of its own/)
    const live = openDb(':memory:'); seedRegistry(live)
    expect(() => assertPresentationDb(live)).toThrow(/limits calibrated/)
  })
})

describe('a test stack\'s control: publish a fund\'s NAV for a day now, as the fund house would that evening', () => {
  it('honoured only on an isolated test stack with a day in the file; otherwise nothing changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-nav-through-'))
    try {
      const file = join(dir, 'nav-through')
      expect(syntheticNavThrough({ QED_TEST_STACK: '1', QED_TEST_SYNTHETIC_NAV_FILE: file })).toBeNull() // no file yet
      writeFileSync(file, '2026-11-24\n')
      expect(syntheticNavThrough({ QED_TEST_SYNTHETIC_NAV_FILE: file })).toBeNull() // not a test stack
      expect(syntheticNavThrough({ QED_TEST_STACK: '1', QED_TEST_SYNTHETIC_NAV_FILE: file })).toBe('2026-11-24')
      writeFileSync(file, 'tonight')
      expect(syntheticNavThrough({ QED_TEST_STACK: '1', QED_TEST_SYNTHETIC_NAV_FILE: file })).toBeNull() // not a day
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('publishes the asked day\'s NAV once that day has come, ahead of its evening, and labels the quote with that day; with the switch gone, the quote keeps the day its NAV is for', () => {
    // Until R13 this asked for Tuesday's NAV on Monday and saw it published on Monday: a NAV for a day that had not come,
    // which let the registrar allot units a day before their NAV existed (server/fund-days.test.ts). A NAV is the close
    // of its own day, so the control now publishes at most today's.
    const dir = mkdtempSync(join(tmpdir(), 'qed-nav-through-'))
    const was = { stack: process.env.QED_TEST_STACK, file: process.env.QED_TEST_SYNTHETIC_NAV_FILE }
    try {
      const s = stack() // Monday 23 Nov, 10:30 IST: the latest NAV is Friday's
      const p = new SyntheticProvider(s.market)
      p.seedHistory(T0); p.tick(T0); s.market.flush()
      expect(s.market.get('amfi:120716', 'nav')!.sourceTs).toBe(Date.parse('2026-11-20T00:00:00+05:30'))
      const file = join(dir, 'nav-through')
      writeFileSync(file, '2026-11-24')
      process.env.QED_TEST_STACK = '1'; process.env.QED_TEST_SYNTHETIC_NAV_FILE = file
      s.clock.advance(3000); p.tick(T0 + 3000); s.market.flush()
      // on Monday, asked for Tuesday's: Monday's is published ahead of its evening, Tuesday's is not
      expect(s.db.get('SELECT source FROM daily_values WHERE instrument_id = ? AND value_date = ?', 'amfi:120716', '2026-11-23')).toEqual({ source: SYNTHETIC })
      expect(s.db.get('SELECT 1 FROM daily_values WHERE instrument_id = ? AND value_date > ?', 'amfi:120716', '2026-11-23')).toBeUndefined()
      expect(s.market.get('amfi:120716', 'nav')!.sourceTs).toBe(Date.parse('2026-11-23T00:00:00+05:30'))
      // Tuesday has come: Tuesday's is published at once
      const tuesday = T0 + 86_400_000
      s.clock.set(tuesday); p.tick(tuesday); s.market.flush()
      expect(s.db.get('SELECT source FROM daily_values WHERE instrument_id = ? AND value_date = ?', 'amfi:120716', '2026-11-24')).toEqual({ source: SYNTHETIC })
      const q = s.market.get('amfi:120716', 'nav')!
      expect(q.sourceTs).toBe(Date.parse('2026-11-24T00:00:00+05:30'))
      expect(q.price).toBe(s.db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date = ?', 'amfi:120716', '2026-11-24')!.value)
      rmSync(file)
      s.clock.advance(3000); p.tick(tuesday + 3000); s.market.flush()
      expect(s.market.get('amfi:120716', 'nav')!.sourceTs).toBe(Date.parse('2026-11-24T00:00:00+05:30'))
    } finally {
      if (was.stack === undefined) delete process.env.QED_TEST_STACK; else process.env.QED_TEST_STACK = was.stack
      if (was.file === undefined) delete process.env.QED_TEST_SYNTHETIC_NAV_FILE; else process.env.QED_TEST_SYNTHETIC_NAV_FILE = was.file
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
