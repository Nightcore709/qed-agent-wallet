/**
 * Money-model stage S5 (shared/chain-assets.ts): the chain's test tokens for the paper bank's eight currencies, a
 * workspace's currency set, and the exact arithmetic that carries amounts between test tokens of 0, 2, 3, 6 and 18
 * decimals. Properties: no conversion at the genesis rates creates value (floor both ways, split or whole), every
 * decimal text reads back to the same base units, the venue plan's pools agree with the genesis rates, and the owner's
 * signed configuration binds every field it names.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { minorUnit, PAPER_CURRENCIES, type Currency } from './currency.ts'
import {
  AssetSetError, assetSetDigest, assetSetDocument, CHAIN_CURRENCIES, CHAIN_TOKENS, checkAssetSet, convertAtGenesis, convertRaw, DEFAULT_ASSET_SET, fromInr, genesisRaw, isDefaultSet,
  parseUnits, referenceBandOf, tokenBySymbol, unitsText, venuePlan,
} from './chain-assets.ts'

const DECIMALS = [0, 2, 3, 6, 18] as const
const currency = fc.constantFrom(...PAPER_CURRENCIES)
const raw = fc.bigInt({ min: 0n, max: 10n ** 30n })
/** A token of any of the tested decimals at a synthetic rate per tUSD between 0.001 and 100,000. */
const spec = fc.record({ decimals: fc.constantFrom(...DECIMALS), perUsd: fc.tuple(fc.integer({ min: 1, max: 100_000_000 }), fc.constantFrom(1, 10, 100, 1000)).map(([n, d]) => `${n / d}`) })
const set = fc.uniqueArray(currency, { minLength: 3, maxLength: 3 }).map(([treasury, reserve, route]) => ({ treasury: treasury!, reserve: reserve!, route: route! }))

describe('the chain\'s test tokens for the eight currencies', () => {
  it('has one test token per currency: tINR, tUSD and tEUR keep their decimals, the five added take their ISO 4217 minor unit', () => {
    expect([...CHAIN_CURRENCIES]).toEqual([...PAPER_CURRENCIES])
    expect(Object.keys(CHAIN_TOKENS)).toEqual([...PAPER_CURRENCIES])
    expect(Object.values(CHAIN_TOKENS).map((t) => [t.symbol, t.decimals, t.origin])).toEqual([
      ['tINR', 2, 'wallet'], ['tUSD', 6, 'release'], ['tEUR', 6, 'release'], ['tGBP', 2, 'added'], ['tAED', 2, 'added'], ['tSGD', 2, 'added'], ['tJPY', 0, 'added'], ['tBHD', 3, 'added'],
    ])
    for (const t of Object.values(CHAIN_TOKENS).filter((x) => x.origin === 'added')) expect(t.decimals).toBe(minorUnit(t.currency))
    // what a person reads is the currency's minor unit, whatever the token's decimals (tUSD and tEUR carry six)
    for (const t of Object.values(CHAIN_TOKENS)) expect(t.minor, t.symbol).toBe(minorUnit(t.currency))
    expect(new Set(Object.values(CHAIN_TOKENS).map((t) => t.symbol)).size).toBe(8)
    // the release's tETH is a venue token only: known by symbol for display, never a workspace's currency
    expect(tokenBySymbol('tETH')).toMatchObject({ decimals: 18, currency: null })
    expect(tokenBySymbol('tJPY')).toMatchObject({ decimals: 0, currency: 'JPY', many: 'test yen' })
    expect(tokenBySymbol('tXYZ')).toBeNull()
  })

  it('the default set is the one every workspace has had: a tINR treasury, a tUSD reserve, routes through tEUR', () => {
    expect(DEFAULT_ASSET_SET).toEqual({ treasury: 'INR', reserve: 'USD', route: 'EUR' })
    expect(isDefaultSet(undefined)).toBe(true)
    expect(isDefaultSet({ treasury: 'INR', reserve: 'USD', route: 'EUR' })).toBe(true)
    expect(isDefaultSet({ treasury: 'EUR', reserve: 'JPY', route: 'BHD' })).toBe(false)
  })

  it('a currency set is three different currencies of the eight, and nothing else', () => {
    fc.assert(fc.property(set, (s) => { expect(checkAssetSet({ ...s })).toEqual(s) }))
    for (const bad of [null, [], 'INR', { treasury: 'INR', reserve: 'INR', route: 'EUR' }, { treasury: 'INR', reserve: 'USD' }, { treasury: 'KWD', reserve: 'USD', route: 'EUR' }, { treasury: 'INR', reserve: 'USD', route: 'EUR', extra: 1 }, { treasury: 'inr', reserve: 'USD', route: 'EUR' }]) {
      expect(() => checkAssetSet(bad), JSON.stringify(bad)).toThrow(AssetSetError)
    }
  })
})

describe('amounts between test tokens of 0, 2, 3, 6 and 18 decimals', () => {
  it('decimal text reads back to the same base units at every precision, and more decimals than the token has are refused', () => {
    fc.assert(fc.property(raw, fc.constantFrom(...DECIMALS), (x, d) => {
      const text = unitsText(x, d)
      expect(parseUnits(text, d)).toBe(x)
      if (d > 0) expect(text).toMatch(new RegExp(`^\\d+\\.\\d{${d}}$`))
      else expect(text).toMatch(/^\d+$/)
    }))
    expect(unitsText(1234n, 3)).toBe('1.234')
    expect(unitsText(1500n, 0)).toBe('1500')
    expect(unitsText(5n, 18)).toBe('0.000000000000000005')
    expect(parseUnits('1.5', 0)).toBeNull()
    expect(parseUnits('1.2345', 3)).toBeNull()
    expect(parseUnits('12', 3)).toBe(12_000n)
    for (const bad of ['', '-1', '1e3', '01.5x', '.5', '1.', ' 1']) expect(parseUnits(bad, 2), bad).toBeNull()
  })

  it('a conversion at the genesis rates never creates value: there and back, rounded down both ways, returns at most what left', () => {
    fc.assert(fc.property(raw, spec, spec, (x, a, b) => {
      const there = convertRaw(x, a, b, 'floor')
      expect(convertRaw(there, b, a, 'floor')).toBeLessThanOrEqual(x)
      // rounding up instead never gives less than the exact value
      expect(convertRaw(x, a, b, 'ceil')).toBeGreaterThanOrEqual(there)
      expect(convertRaw(x, a, b, 'ceil') - there).toBeLessThanOrEqual(1n)
    }))
  })

  it('splitting an amount never creates value: the parts converted add up to at most the whole converted, and at most one base unit less per part', () => {
    fc.assert(fc.property(raw, raw, spec, spec, (x, y, a, b) => {
      const whole = convertRaw(x + y, a, b, 'floor'), parts = convertRaw(x, a, b, 'floor') + convertRaw(y, a, b, 'floor')
      expect(parts).toBeLessThanOrEqual(whole)
      expect(whole - parts).toBeLessThanOrEqual(1n)
    }))
  })

  it('is monotone, the identity on one token, and exact where the rates allow', () => {
    fc.assert(fc.property(raw, raw, spec, spec, (x, y, a, b) => {
      const [lo, hi] = x <= y ? [x, y] : [y, x]
      expect(convertRaw(lo, a, b, 'floor')).toBeLessThanOrEqual(convertRaw(hi, a, b, 'floor'))
      expect(convertRaw(x, a, a, 'floor')).toBe(x)
    }))
    // 1 tUSD (6 decimals) is 150 tJPY (0 decimals) and 0.376 tBHD (3 decimals) at genesis
    expect(convertAtGenesis(1_000_000n, 'USD', 'JPY')).toBe(150n)
    expect(convertAtGenesis(1_000_000n, 'USD', 'BHD')).toBe(376n)
    expect(convertRaw(10n ** 18n, { decimals: 18, perUsd: '1' }, { decimals: 6, perUsd: '1' }, 'floor')).toBe(1_000_000n)
  })

  it('the operator\'s figures in tINR are unchanged for a tINR treasury, and carried into another currency rounded down, never above their value', () => {
    for (const paise of [1_000n, 1_000_000n, 10_000_000n, 100_000n, 25_000n, 20_000n, 200_000n]) expect(fromInr(paise, 'INR')).toBe(paise)
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), currency, (paise, c) => {
      const x = fromInr(paise, c)
      // valued back in paise at the same rates (rounded up, the generous direction), it is never more than it was
      expect(convertAtGenesis(x, c, 'INR', 'ceil')).toBeLessThanOrEqual(paise)
    }))
    // the authority budget's base, 10.00 tINR, in the five added tokens and the release's two
    expect(['USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'].map((c) => [c, fromInr(1_000n, c as Currency)])).toEqual([['USD', 119_047n], ['EUR', 109_523n], ['GBP', 9n], ['AED', 43n], ['SGD', 15n], ['JPY', 17n], ['BHD', 44n]])
  })
})

describe('the venue plan and the reference band of a currency set', () => {
  it('five venues in the default market\'s order: deep, thin, the two legs of the route, and the off-market decoy, at the genesis rates', () => {
    fc.assert(fc.property(set, (s) => {
      const v = venuePlan(s)
      expect(v.map((x) => [x.role, x.a, x.b, x.feeBps])).toEqual([
        ['deep', s.treasury, s.reserve, 30], ['thin', s.treasury, s.reserve, 5], ['route-in', s.treasury, s.route, 30], ['route-out', s.reserve, s.route, 30], ['off-market', s.treasury, s.reserve, 100],
      ])
      for (const x of v) {
        expect(x.rawA > 0n && x.rawB > 0n).toBe(true)
        expect(x.rawA < 2n ** 112n && x.rawB < 2n ** 112n).toBe(true)
      }
      // the deep pool holds the same value on both sides, at the genesis rate, to within a base unit of rounding
      const deep = v[0]!
      expect(deep.rawA).toBe(genesisRaw(s.treasury, 100_000n))
      expect(deep.rawB).toBe(genesisRaw(s.reserve, 100_000n))
      // the decoy prices the reserve about 1% dearer, so it never beats the deep pool before fees
      const off = v[4]!
      expect(off.rawB * deep.rawA * 100n).toBeLessThan(off.rawA * deep.rawB * 100n)
    }))
  })

  it('the band is the deep pool\'s genesis ratio ± the configured half-width; for the default set it is the band the rail has always used', () => {
    // chain/rail/host.ts before S5: n = 8,400,000 × 10², d = 100,000 × 10⁶, lo = n(10⁴ − w)/(d·10⁴), reduced
    expect(referenceBandOf(840_000_000n, 100_000_000_000n, 50)).toEqual({ lo: '4179/500000', mid: '21/2500', hi: '4221/500000' })
    fc.assert(fc.property(set, fc.integer({ min: 1, max: 2000 }), (s, w) => {
      const deep = venuePlan(s)[0]!, b = referenceBandOf(deep.rawA, deep.rawB, w)
      const q = (t: string) => { const [n, d] = t.split('/').map(BigInt); return [n!, d ?? 1n] as const }
      const [ln, ld] = q(b.lo), [mn, md] = q(b.mid), [hn, hd] = q(b.hi)
      expect(ln * md < mn * ld && mn * hd < hn * md).toBe(true)
      expect(mn * deep.rawB).toBe(md * deep.rawA)
    }))
  })
})

describe('the owner\'s signed currency configuration', () => {
  const base = { workspaceId: 'ws-eur-jpy', rpIdHash: `0x${'ab'.repeat(32)}`, origin: 'http://localhost:5175', members: [{ x: `0x${'01'.repeat(32)}`, y: `0x${'02'.repeat(32)}` }], threshold: 1, adminThreshold: 1, currencies: { treasury: 'EUR', reserve: 'JPY', route: 'BHD' } as const }

  it('names the workspace, the owner\'s keys, the three test tokens with their decimals, and that no real money is involved', () => {
    const d = assetSetDocument(base)
    expect(d.kind).toBe('qed/workspace-currencies/v1')
    expect(d.realMoney).toBe(false)
    expect(d.tokens).toEqual([
      { role: 'treasury', currency: 'EUR', symbol: 'tEUR', decimals: 6, kind: 'test-token' },
      { role: 'reserve', currency: 'JPY', symbol: 'tJPY', decimals: 0, kind: 'test-token' },
      { role: 'route', currency: 'BHD', symbol: 'tBHD', decimals: 3, kind: 'test-token' },
    ])
    expect(d.statement).toMatch(/valueless test tokens/)
    expect(assetSetDigest(d)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('one digest per configuration: the same content in another spelling gives the same digest, any change of substance another', () => {
    const digest = assetSetDigest(assetSetDocument(base))
    // keys written with upper-case hex or without leading zeros are the same key
    const respelt = { ...base, members: [{ x: `0x${'01'.repeat(32).toUpperCase()}`, y: `0x${'02'.repeat(32).replace(/^0+/, '')}` }], rpIdHash: base.rpIdHash.toUpperCase().replace('0X', '0x') }
    expect(assetSetDigest(assetSetDocument(respelt))).toBe(digest)
    const changes = [
      { workspaceId: 'ws-eur-jpz' }, { origin: 'http://localhost:5174' }, { rpIdHash: `0x${'ac'.repeat(32)}` }, { threshold: 2, members: [...base.members, { x: `0x${'03'.repeat(32)}`, y: `0x${'04'.repeat(32)}` }] },
      { adminThreshold: 2, members: [...base.members, { x: `0x${'03'.repeat(32)}`, y: `0x${'04'.repeat(32)}` }] }, { currencies: { treasury: 'EUR', reserve: 'BHD', route: 'JPY' } as const },
    ]
    const seen = new Set([digest])
    for (const c of changes) {
      const d = assetSetDigest(assetSetDocument({ ...base, ...c }))
      expect(seen.has(d), JSON.stringify(c)).toBe(false)
      seen.add(d)
    }
  })
})
