/** Limits calibrated by experiment X9, as the wallet loads them (server/limits.calibrated.json via scripts/import-limits.ts). */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInstrumentId, standardRegistry } from '../shared/instrument.ts'
import { openDb } from './core.ts'
import { ASSETS, assetInstrumentId, CALIBRATED, FUND_UNITS, INSTRUMENTS, SECURITY_UNITS, seedRegistry, term } from './registry.ts'

const fresh = () => { const db = openDb(':memory:'); seedRegistry(db); return db }

describe('canonical instrument ids (ADR-0012; stage S2 of the global money model)', () => {
  it('every asset has a canonical id that shared/instrument.ts parses and validates, and no two assets share one', () => {
    const db = fresh()
    const seeded = db.all<{ id: string; scale: number }>('SELECT id, scale FROM assets ORDER BY rowid')
    // The registry's own lists are what a database holds: thirteen assets (eight currencies since R13), the units of nine funds (a money-market fund was added in R13) and seven securities.
    expect([...ASSETS, ...FUND_UNITS, ...SECURITY_UNITS].map((a) => a.id)).toEqual(seeded.map((a) => a.id))
    expect(seeded).toHaveLength(29)
    const standard = standardRegistry()
    const owner = new Map<string, string>()
    for (const asset of seeded) {
      const id = assetInstrumentId(asset.id)
      // The one exception: PCT is the unit SOFR and EFFR are quoted in, not an instrument, and nothing is held in it.
      if (asset.id === 'PCT') { expect(id).toBeNull(); continue }
      expect(id, asset.id).not.toBeNull()
      const parsed = parseInstrumentId(id!)
      expect(parsed.id, `${asset.id}: ${id} is not canonical`).toBe(id)
      // A currency must be in ISO 4217 List One, with the asset's scale as its minor unit; anything else is a claim.
      if (parsed.kind === 'fiat') expect(standard.instrument(id!).exponent, asset.id).toBe(asset.scale)
      else expect(parsed.kind, asset.id).toBe('claim')
      expect(owner.get(id!), `${id} is given to two assets`).toBeUndefined()
      owner.set(id!, asset.id)
    }
    expect(owner.size).toBe(28) // 20 before the money-market fund and the seven securities
    // An id the registry does not know is no id at all, rather than a guess.
    expect(assetInstrumentId('XYZ')).toBeNull()
    expect(assetInstrumentId('MF:999999')).toBeNull()
  })

  it('gives the rupee its ISO 4217 id, and what the paper venues hold claim ids on those venues', () => {
    expect(Object.fromEntries([...ASSETS, ...FUND_UNITS, ...SECURITY_UNITS].map((a) => [a.id, a.instrumentId]))).toEqual({
      INR: 'iso4217:INR', USD: 'iso4217:USD', EUR: 'iso4217:EUR', PCT: null,
      GBP: 'iso4217:GBP', AED: 'iso4217:AED', SGD: 'iso4217:SGD', JPY: 'iso4217:JPY', BHD: 'iso4217:BHD',
      BTC: 'claim:paper-crypto/BTC', ETH: 'claim:paper-crypto/ETH', USDT: 'claim:paper-crypto/USDT', PAXG: 'claim:binance/PAXG',
      'MF:120716': 'claim:paper-mf/120716', 'MF:120684': 'claim:paper-mf/120684', 'MF:122639': 'claim:paper-mf/122639', 'MF:148381': 'claim:paper-mf/148381',
      'MF:119788': 'claim:paper-mf/119788', 'MF:118701': 'claim:paper-mf/118701', 'MF:119110': 'claim:paper-mf/119110', 'MF:119771': 'claim:paper-mf/119771', 'MF:118719': 'claim:paper-mf/118719',
      'EQ:NIFTYBEES': 'claim:paper-exchange/NIFTYBEES', 'EQ:GOLDBEES': 'claim:paper-exchange/GOLDBEES', 'EQ:RELIANCE': 'claim:paper-exchange/RELIANCE', 'EQ:TCS': 'claim:paper-exchange/TCS', 'EQ:HDFCBANK': 'claim:paper-exchange/HDFCBANK',
      'GS:TB91': 'claim:paper-gsec/TB91', 'GS:GS2036': 'claim:paper-gsec/GS2036',
    })
  })

  it('what is bought on a venue is a claim on that venue, and it is paid for in rupees', () => {
    const tradable = INSTRUMENTS.filter((i) => i.tradable)
    expect(tradable).toHaveLength(19) // three crypto pairs, nine funds, five exchange-traded, two government securities
    for (const i of tradable) {
      expect(parseInstrumentId(assetInstrumentId(i.base)!), i.id).toMatchObject({ kind: 'claim', venue: i.venue })
      expect(assetInstrumentId(i.quote), i.id).toBe('iso4217:INR')
    }
  })
})

describe('calibrated limits', () => {
  it('a new database has the 13 limits X9 marked loadable; the rest keep their illustrative values', () => {
    const db = fresh()
    expect(CALIBRATED).toHaveLength(13)
    for (const t of CALIBRATED) { expect(t.status).toBe('calibrated'); expect(t.source).toMatch(/not a worst case/) }
    expect(term(db, 'limit.amfi:122639')).toMatchObject({ status: 'calibrated', value: { fall: '0.1156', horizon: expect.any(String), confidence: '0.9999' } })
    expect(term(db, 'limit.coindcx:BTCINR')).toMatchObject({ status: 'calibrated', value: { fall: '0.4536' } })
    // validation rejected (Nifty 50), tail not identifiable (liquid), not settled (USDT/INR): illustrative as before
    for (const id of ['limit.amfi:120716', 'limit.amfi:118701', 'limit.coindcx:USDTINR']) expect(term(db, id)?.status).toBe('modelled')
  })

  it('a stored placeholder is upgraded once, with the change in the audit log; a sourced term is left alone', () => {
    const db = fresh()
    db.run(`UPDATE terms SET value_json = ?, source = ?, status = 'modelled' WHERE id = ?`, JSON.stringify({ fall: '0.25', window: 'not calibrated' }), 'Illustrative placeholder (D-048)', 'limit.amfi:122639')
    db.run(`UPDATE terms SET value_json = ?, source = ?, status = 'verified' WHERE id = ?`, JSON.stringify({ fall: '0.2' }), 'A sourced figure', 'limit.amfi:148381')
    seedRegistry(db); seedRegistry(db)
    expect(term(db, 'limit.amfi:122639')).toMatchObject({ status: 'calibrated', value: { fall: '0.1156' } })
    expect(db.get(`SELECT COUNT(*) n FROM audit WHERE action = 'term.calibrated' AND subject = ?`, 'limit.amfi:122639')).toEqual({ n: 1 })
    expect(term(db, 'limit.amfi:148381')).toMatchObject({ status: 'verified', value: { fall: '0.2' } })
  })

  it('the imported file is the one the experiment produced, by hash', () => {
    const imported = JSON.parse(readFileSync(join(import.meta.dirname, 'limits.calibrated.json'), 'utf8')) as { source: string; sourceSha256: string }
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', imported.source))
    expect(createHash('sha256').update(src).digest('hex')).toBe(imported.sourceSha256)
  })
})

describe('terms read from a primary source since an older database was seeded (R13)', () => {
  it('replaces an old unverified seed once, writes the change to the audit log, and leaves a row someone sourced alone', () => {
    const db = fresh()
    // an older database: the 0.00297% seed, unverified
    db.run(`UPDATE terms SET value_json = ?, source = ?, status = 'unverified', as_of = '2026-11-24' WHERE id = 'fee.exchange.charges'`, JSON.stringify({ txnRate: '0.0000297', sebiRate: '0.000001', gstOnFee: '0.18' }), 'NSE and SEBI published charges as QED remembers them; NOT VERIFIED, no circular read')
    db.run(`UPDATE terms SET status = 'unverified', source = 'The Indian Stamp Act schedule, as QED remembers it; NOT VERIFIED' WHERE id = 'tax.stamp.exchange'`)
    seedRegistry(db)
    expect(term(db, 'fee.exchange.charges')).toMatchObject({ status: 'verified', value: { txnRate: '0.0000307' } })
    expect(term(db, 'tax.stamp.exchange')).toMatchObject({ status: 'verified', value: { buyRate: '0.00015' } })
    expect(db.get(`SELECT COUNT(*) n FROM audit WHERE action = 'term.sourced' AND subject = ?`, 'fee.exchange.charges')).toEqual({ n: 1 })
    seedRegistry(db) // once: a second seeding changes nothing and writes nothing
    expect(db.get(`SELECT COUNT(*) n FROM audit WHERE action = 'term.sourced' AND subject = ?`, 'fee.exchange.charges')).toEqual({ n: 1 })
    // a row already verified by someone with a different source is not overwritten
    db.run(`UPDATE terms SET status = 'verified', source = 'A counsel-checked figure', value_json = ? WHERE id = 'tax.stt'`, JSON.stringify({ 'equity-delivery': '0.002' }))
    seedRegistry(db)
    expect(term(db, 'tax.stt')).toMatchObject({ status: 'verified', source: 'A counsel-checked figure', value: { 'equity-delivery': '0.002' } })
  })
})
