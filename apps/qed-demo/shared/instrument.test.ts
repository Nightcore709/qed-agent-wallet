import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { inr as inrRupees, inrExact } from './money.ts'

/**
 * shared/money.ts as it was before migration stage S1 (commit cefa926), frozen here as the oracle: since S1, money.ts
 * writes through formatAmount, so comparing the two would compare formatAmount with itself. These are the old integer
 * implementations, byte for byte in their arithmetic.
 */
const oldGrouping = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0, useGrouping: true })
function oldInr(p: number, opts: { paise?: boolean; sign?: 'auto' | 'always' | 'never' } = {}): string {
  if (!Number.isFinite(p)) return '₹—'
  const neg = p < 0
  const abs = Math.round(Math.abs(p))
  const body = opts.paise ? `${oldGrouping.format(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}` : oldGrouping.format(Math.floor((abs + 50) / 100))
  const zero = body === '0' || body === '0.00'
  const sign = opts.sign ?? 'auto'
  if (sign === 'never' || zero) return `₹${body}`
  if (neg) return `\u2212₹${body}`
  return sign === 'always' ? `+₹${body}` : `₹${body}`
}
function oldInrExact(p: number | bigint): string {
  if (typeof p === 'number' && !Number.isFinite(p)) return '₹—'
  const v = typeof p === 'bigint' ? p : BigInt(Math.round(p))
  const abs = v < 0n ? -v : v
  const paise = abs % 100n
  return `${v < 0n ? '\u2212' : ''}₹${oldGrouping.format(abs / 100n)}${paise === 0n ? '' : `.${String(paise).padStart(2, '0')}`}`
}
import {
  addAmounts, aggregateExposure, allocateAmount, amount, amountFromDecimal, amountFromJSON, amountToJSON, atomicRatio,
  canonicalAddress, checksumAddress, compareAmounts, conservativeValue, convert, divRound, type ExposureLine,
  formatAmount, type Instrument, invertRate, isinCheckDigit, isMicFormat, ISO4217_LIST_ONE, iso4217Entries,
  isValidIsin, makeRate, MoneyError, negateAmount, parseAccountId, parseAmount, parseInstrumentId, parseNetworkId,
  parseRatio, type Rate, ratio, Registry, ROUNDING_MODES, type RoundingMode, scaleAmount, showRatio, standardRegistry,
  subtractAmounts, sumAmounts, testTokenFixtures, toDecimalString, VENUES,
} from './instrument.ts'

// Example addresses for the four test tokens. A real run takes them from the rail's genesis record; nothing here is a
// recorded deployment.
const ADDRESSES = {
  tINR: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  tUSD: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
  tEUR: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
  tETH: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
}
const STANDARD = standardRegistry()
const FIXTURES = testTokenFixtures('eip155:31337', ADDRESSES)
const REG = STANDARD.with({ instruments: FIXTURES })
const I = (id: string): Instrument => REG.instrument(id)
const usd = I('iso4217:USD'), inr = I('iso4217:INR'), eur = I('iso4217:EUR'), jpy = I('iso4217:JPY'), kwd = I('iso4217:KWD')
const iqd = I('iso4217:IQD'), chf = I('iso4217:CHF'), cad = I('iso4217:CAD')
const [tINR, tUSD, tEUR, tETH] = FIXTURES as [Instrument, Instrument, Instrument, Instrument]
const apple = I('isin:US0378331005')
const T0 = Date.UTC(2026, 10, 23, 6, 30, 0)
const HOUR = 3_600_000

const code = (f: () => unknown): string => {
  try { f() } catch (e) { if (e instanceof MoneyError) return e.code; throw e }
  return 'no error'
}

describe('the source itself', () => {
  // A tool once wrote this module's escapes as the characters themselves, bidirectional controls included (the
  // "Trojan Source" pattern). Code points are listed as numbers so that no escape here can be turned back.
  const invisible = (cp: number): boolean =>
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || cp === 0xa0 || cp === 0xad || cp === 0x061c ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff
  it.each(['instrument.ts', 'instrument.test.ts'])('%s holds no invisible or bidirectional control character', (name) => {
    const text = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    const found = [...text].map((c, i) => [c.codePointAt(0)!, i] as const).filter(([cp]) => invisible(cp)).map(([cp, i]) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} at ${i}`)
    expect(found).toEqual([])
  })
})

describe('reference data', () => {
  it('holds ISO 4217 List One as published on 2026-09-17: 178 codes, each minor unit as the list gives it', () => {
    const list = iso4217Entries()
    expect(ISO4217_LIST_ONE.published).toBe('2026-09-17')
    expect(list).toHaveLength(178)
    expect(new Set(list.map((e) => e.code)).size).toBe(178)
    const by = new Map(list.map((e) => [e.code, e]))
    const minor = (c: string) => by.get(c)?.minorUnit
    expect([minor('JPY'), minor('KRW'), minor('ISK'), minor('CLP'), minor('VND')]).toEqual([0, 0, 0, 0, 0])
    expect([minor('KWD'), minor('BHD'), minor('IQD'), minor('JOD'), minor('LYD'), minor('OMR'), minor('TND')]).toEqual([3, 3, 3, 3, 3, 3, 3])
    expect([minor('CLF'), minor('UYW')]).toEqual([4, 4])
    expect([minor('INR'), minor('USD'), minor('EUR'), minor('GBP')]).toEqual([2, 2, 2, 2])
    expect([minor('XAU'), minor('XDR'), minor('XTS'), minor('XXX')]).toEqual([null, null, null, null])
    expect([by.get('INR')?.numeric, by.get('USD')?.numeric, by.get('EUR')?.numeric, by.get('JPY')?.numeric, by.get('KWD')?.numeric]).toEqual(['356', '840', '978', '392', '414'])
    expect(by.get('CLF')?.fund).toBe(true)
  })

  it('makes every currency with a minor unit an instrument, and refuses an amount of one without', () => {
    expect(STANDARD.instruments.filter((i) => i.kind === 'fiat')).toHaveLength(165)
    expect(jpy.exponent).toBe(0)
    expect(kwd.exponent).toBe(3)
    expect(code(() => STANDARD.instrument('iso4217:XAU'))).toBe('no-minor-unit')
    expect(code(() => STANDARD.instrument('iso4217:ZZZ'))).toBe('unknown-instrument')
  })

  it('keeps tINR, tUSD, tEUR and tETH as labelled fixtures on the local chain, never as ISO currencies', () => {
    expect(FIXTURES.map((f) => [f.kind === 'token' ? f.symbol : '', f.exponent])).toEqual([['tINR', 2], ['tUSD', 6], ['tEUR', 6], ['tETH', 18]])
    for (const f of FIXTURES) {
      expect(f.id.startsWith('eip155:31337/erc20:0x')).toBe(true)
      expect(f.fixture).toMatch(/not money/)
    }
    expect(code(() => parseInstrumentId('iso4217:tINR'))).toBe('invalid-id')
    // tINR is not rupees: the two are different instruments, and adding them is refused.
    expect(code(() => addAmounts(amount(tINR, 100n), amount(inr, 100n)))).toBe('instrument-mismatch')
  })

  it('names each network\'s gas asset, which on the local chain is not the tETH test token', () => {
    const local = REG.network('eip155:31337')
    expect(local.gasAsset).toBe('eip155:31337/slip44:60')
    expect(local.gasAsset).not.toBe(tETH.id)
    expect(I(local.gasAsset).exponent).toBe(18)
    expect(local.finality).toEqual({ kind: 'confirmations', depth: 2 })
    expect(REG.network('eip155:1').finality).toEqual({ kind: 'finalized-checkpoint' })
  })
})

describe('identities', () => {
  it('reads CAIP-2 chain ids as the specification writes them, and refuses malformed ones', () => {
    for (const ok of ['eip155:1', 'eip155:11155111', 'bip122:000000000019d6689c085ae165831e93', 'cosmos:cosmoshub-3', 'cosmos:Binance-Chain-Tigris', 'starknet:SN_GOERLI', 'chainstd:8c3444cf8970a9e41a706fab93e7a6c4']) {
      expect(parseNetworkId(ok).id).toBe(ok)
    }
    for (const bad of ['EIP155:1', 'ab:1', 'eip155', 'eip155:', 'eip155:01', 'eip155:0x1', 'toolongnamespace:1', `cosmos:${'a'.repeat(33)}`]) {
      expect(code(() => parseNetworkId(bad))).toBe('invalid-id')
    }
  })

  it('checks EIP-55 checksums with the specification\'s own test cases', () => {
    const cases = [
      '0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
      '0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]
    for (const c of cases) expect(checksumAddress(c.toLowerCase())).toBe(c)
    // One letter's case flipped: a mixed-case address that fails its checksum is refused, not silently lowercased.
    expect(code(() => canonicalAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'))).toBe('bad-checksum')
    expect(canonicalAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
  })

  it('reads CAIP-10 accounts and gives each EVM address one canonical form', () => {
    const spec = 'eip155:1:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'
    expect(parseAccountId(spec).id).toBe(spec)
    expect(parseAccountId(spec.toLowerCase().replace('eip155', 'eip155')).id).toBe(spec)
    expect(code(() => parseAccountId('eip155:1:0xAb16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'))).toBe('bad-checksum')
    expect(parseAccountId('bip122:000000000019d6689c085ae165831e93:128Lkh3S7CkDTBZ8W7BbpsN3YYizJMp8p6').address).toBe('128Lkh3S7CkDTBZ8W7BbpsN3YYizJMp8p6')
    expect(code(() => parseAccountId('eip155:1'))).toBe('invalid-id')
  })

  it('reads CAIP-19 asset types: native assets by SLIP-44, ERC-20 tokens by contract, one id whatever the input case', () => {
    expect(parseInstrumentId('eip155:1/slip44:60')).toMatchObject({ kind: 'token', namespace: 'slip44', reference: '60', network: 'eip155:1' })
    expect(parseInstrumentId('bip122:000000000019d6689c085ae165831e93/slip44:0').kind).toBe('token')
    const lower = parseInstrumentId('eip155:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f')
    const checked = parseInstrumentId('eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F')
    expect(lower.id).toBe(checked.id)
    expect(lower.id).toBe('eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F')
    expect(code(() => parseInstrumentId('eip155:1/erc721:0x06012c8cf97BEaD5deAe237070F9587f8E7A266d'))).toBe('invalid-id')
    expect(code(() => parseInstrumentId('eip155:1/erc721:0x06012c8cf97BEaD5deAe237070F9587f8E7A266d/771769'))).toBe('invalid-id')
    expect(code(() => parseInstrumentId('cosmos:cosmoshub-3/erc20:0x6b175474e89094c44da98b954eedeac495271d0f'))).toBe('invalid-id')
    expect(code(() => parseInstrumentId('USDC'))).toBe('invalid-id')
  })

  it('checks ISIN check digits (ISO 6166) and catches any single changed digit (property)', () => {
    for (const ok of ['US0378331005', 'GB0002634946', 'AU0000XVGZA3']) expect(isValidIsin(ok)).toBe(true)
    for (const bad of ['US0378331006', 'US037833100', 'us0378331005', 'U10378331005']) expect(isValidIsin(bad)).toBe(false)
    expect(code(() => parseInstrumentId('isin:US0378331006'))).toBe('bad-checksum')
    const alnum = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    const letter = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    fc.assert(fc.property(fc.tuple(letter, letter), fc.array(alnum, { minLength: 9, maxLength: 9 }), fc.nat(), fc.integer({ min: 1, max: 9 }), (cc, nsin, pick, delta) => {
      const first11 = cc.join('') + nsin.join('')
      const isin = first11 + String(isinCheckDigit(first11))
      expect(isValidIsin(isin)).toBe(true)
      const digitAt = [...isin].map((c, i) => (/[0-9]/.test(c) && i >= 2 ? i : -1)).filter((i) => i >= 0)
      const at = digitAt[pick % digitAt.length]!
      const changed = isin.slice(0, at) + String((Number(isin[at]) + delta) % 10) + isin.slice(at + 1)
      expect(isValidIsin(changed)).toBe(false)
    }))
  })

  it('keeps venues by MIC, segment apart from operating MIC, and refuses listings on unknown venues', () => {
    expect(REG.venue('XNGS').operatingMic).toBe('XNAS')
    expect(REG.venue('XTKS').operatingMic).toBe('XJPX')
    expect(VENUES.every((v) => isMicFormat(v.mic) && isMicFormat(v.operatingMic))).toBe(true)
    expect(apple.kind === 'security' && apple.listings[0]).toEqual({ mic: 'XNGS', currency: 'iso4217:USD', localCode: 'AAPL' })
    expect(code(() => new Registry({ venues: [{ mic: 'XNGS', operatingMic: 'XNAS', name: '', country: 'US', timeZone: 'America/New_York', source: '' }] }))).toBe('unknown-venue')
    const listedNowhere = { ...apple, listings: [{ mic: 'XXXX', currency: 'iso4217:USD' }] } as Instrument
    expect(code(() => new Registry({ venues: VENUES, instruments: [usd, listedNowhere] }))).toBe('unknown-venue')
  })

  it('refuses duplicate ids, tokens on unregistered networks and ids that are not canonical', () => {
    expect(code(() => REG.with({ instruments: [usd] }))).toBe('duplicate')
    const elsewhere = testTokenFixtures('eip155:8453', ADDRESSES)
    expect(code(() => STANDARD.with({ instruments: elsewhere }))).toBe('unknown-network')
    const lowerId = { ...tUSD, id: `eip155:31337/erc20:${ADDRESSES.tUSD}` } as Instrument
    expect(code(() => STANDARD.with({ instruments: [lowerId] }))).toBe('invalid-id')
  })

  it('reads custodial claims, claim:<venue-id>/<asset-code>: a balance on a venue\'s own ledger, not the coin or currency it tracks', () => {
    expect(parseInstrumentId('claim:paper-crypto/BTC')).toEqual({ kind: 'claim', venue: 'paper-crypto', code: 'BTC', id: 'claim:paper-crypto/BTC' })
    expect(parseInstrumentId('claim:paper-mf/120716')).toEqual({ kind: 'claim', venue: 'paper-mf', code: '120716', id: 'claim:paper-mf/120716' })
    expect(parseInstrumentId('claim:binance/PAXG').id).toBe('claim:binance/PAXG')
    // Ether owed by an exchange and ether on a chain are two instruments (stage S2 of the migration, the note's section 4.2).
    expect(parseInstrumentId('claim:paper-crypto/ETH').id).not.toBe(parseInstrumentId('eip155:1/slip44:60').id)
    // One spelling only: the venue in lower case with single hyphens, the venue's code in upper case, nothing around them.
    for (const bad of ['claim:Paper-Crypto/BTC', 'claim:paper-crypto/btc', 'claim:paper-crypto/', 'claim:/BTC', 'claim:paper-crypto', 'claim:paper crypto/BTC',
      'claim:paper-crypto/BTC/ETH', 'claim:-paper/BTC', 'claim:paper-/BTC', 'claim:paper--crypto/BTC', 'claim:paper-crypto/BTC.', 'claim:paper-crypto/.BTC',
      'claim:paper-mf/MF:120716', ' claim:paper-crypto/BTC', 'claim:paper-crypto/BTC ', `claim:${'a'.repeat(33)}/BTC`, `claim:paper-crypto/${'B'.repeat(33)}`, 'CLAIM:paper-crypto/BTC']) {
      expect(code(() => parseInstrumentId(bad))).toBe('invalid-id')
    }
    // The prefix belongs to claims: a CAIP-19 shape after it is refused, not read as a token on a network named "claim".
    expect(code(() => parseInstrumentId('claim:paper-crypto/slip44:0'))).toBe('invalid-id')
  })

  it('reads back every well-formed claim id as itself, and refuses it with any letter of its code in lower case (property)', () => {
    const word = (chars: string) => fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 6 }).map((a) => a.join(''))
    const venue = fc.array(word('abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 1, maxLength: 3 }).map((a) => a.join('-'))
    const assetCode = fc.tuple(word('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), fc.array(fc.tuple(fc.constantFrom('.', '_', '-'), word('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')), { maxLength: 2 }))
      .map(([head, rest]) => head + rest.map(([sep, w]) => sep + w).join(''))
    fc.assert(fc.property(venue, assetCode, (v, c) => {
      const id = `claim:${v}/${c}`
      expect(parseInstrumentId(id)).toEqual({ kind: 'claim', venue: v, code: c, id })
      if (/[A-Z]/.test(c)) expect(code(() => parseInstrumentId(`claim:${v}/${c.toLowerCase()}`))).toBe('invalid-id')
    }))
  })
})

describe('rounding', () => {
  const exact = (n: bigint, d: bigint) => ({ n, d })
  it('rounds n/d by each ECMA-402 mode to an integer within one unit, half modes within half a unit (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.boolean(), (n, dAbs, flip) => {
      const d = flip ? -dAbs : dAbs
      const x = exact(d < 0n ? -n : n, dAbs) // the same value with a positive denominator
      for (const mode of ROUNDING_MODES) {
        const r = divRound(n, d, mode)
        const err = r * x.d - x.n // (r − n/d)·d
        expect(err > -x.d && err < x.d).toBe(true)
        if (mode.startsWith('half')) expect(2n * (err < 0n ? -err : err) <= x.d).toBe(true)
      }
      const fl = divRound(n, d, 'floor'), ce = divRound(n, d, 'ceil')
      expect(fl * x.d <= x.n && x.n <= ce * x.d).toBe(true)
      expect(divRound(n, d, 'trunc')).toBe(x.n < 0n ? ce : fl)
      expect(divRound(n, d, 'expand')).toBe(x.n % x.d === 0n ? fl : x.n < 0n ? fl : ce)
    }))
  })

  it('breaks ties as each mode says', () => {
    const t = (mode: RoundingMode) => [divRound(5n, 2n, mode), divRound(-5n, 2n, mode), divRound(7n, 2n, mode), divRound(-7n, 2n, mode)]
    expect(t('halfEven')).toEqual([2n, -2n, 4n, -4n])
    expect(t('halfExpand')).toEqual([3n, -3n, 4n, -4n])
    expect(t('halfTrunc')).toEqual([2n, -2n, 3n, -3n])
    expect(t('halfCeil')).toEqual([3n, -2n, 4n, -3n])
    expect(t('halfFloor')).toEqual([2n, -3n, 3n, -4n])
    expect(code(() => divRound(1n, 0n, 'floor'))).toBe('division-by-zero')
  })

  it('agrees with Intl.NumberFormat\'s own rounding modes, an independent implementation, ties included (property)', () => {
    // Random digits almost never land on a tie, so a third of the cases are exact ties and a third sit one unit off one.
    const value = fc.tuple(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), fc.integer({ min: 1, max: 8 }), fc.constantFrom('tie', 'near', 'any'), fc.bigInt({ min: 0n, max: 10n ** 8n }), fc.constantFrom(-1n, 1n))
      .map(([m, k, shape, any, off]) => {
        const unit = 10n ** BigInt(k), half = unit / 2n
        const frac = shape === 'tie' ? half : shape === 'near' ? half + off : any % unit
        return [m * unit + (m < 0n ? -frac : frac), k] as const
      })
    fc.assert(fc.property(fc.oneof(value, fc.tuple(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), fc.constant(0))), ([n, k]) => {
      const neg = n < 0n, s = (neg ? -n : n).toString().padStart(k + 1, '0')
      const text = `${neg ? '-' : ''}${s.slice(0, s.length - k)}${k ? `.${s.slice(s.length - k)}` : ''}`
      for (const mode of ROUNDING_MODES) {
        const intl = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: false, roundingMode: mode }).format(text as `${number}`)
        expect(BigInt(intl.replace('-0', '0'))).toBe(divRound(n, 10n ** BigInt(k), mode))
      }
    }), { numRuns: 300 })
  })
})

describe('exact ratios', () => {
  it('reads n/d and decimals exactly, in the "n/d" form the rail\'s authority budget writes', () => {
    expect(showRatio(parseRatio('1.0850'))).toBe('217/200')
    expect(showRatio(parseRatio('84'))).toBe('84')
    expect(showRatio(parseRatio('-6/4'))).toBe('-3/2')
    expect(showRatio(ratio(10n, -4n))).toBe('-5/2')
    expect(code(() => parseRatio('1e3'))).toBe('unexpected-text')
  })
})

describe('amounts', () => {
  it('adds, subtracts and compares only like with like', () => {
    const a = amount(usd, 1_050n), b = amount(usd, 25n)
    expect(addAmounts(a, b).minor).toBe(1_075n)
    expect(subtractAmounts(b, a).minor).toBe(-1_025n)
    expect(negateAmount(a).minor).toBe(-1_050n)
    expect(compareAmounts(a, b)).toBe(1)
    expect(sumAmounts(usd, [a, b, b]).minor).toBe(1_100n)
    expect(code(() => addAmounts(a, amount(eur, 1n)))).toBe('instrument-mismatch')
    expect(code(() => addAmounts(a, { ...a, exponent: 3 }))).toBe('exponent-mismatch')
    expect(code(() => amount(usd, 0.5))).toBe('not-an-integer')
    expect(code(() => amount(usd, 2 ** 53))).toBe('not-an-integer')
    expect(amount(usd, 2 ** 53 - 1).minor).toBe(9_007_199_254_740_991n)
  })

  it('writes and reads its canonical decimal text exactly, at every exponent (property)', () => {
    const pool = [jpy, usd, kwd, I('iso4217:CLF'), tUSD, tETH, apple]
    fc.assert(fc.property(fc.constantFrom(...pool), fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }), (inst, minor) => {
      const a = amount(inst, minor)
      const text = toDecimalString(a)
      expect(amountFromDecimal(inst, text)).toEqual(a)
      expect(text.split('.')[1]?.length ?? 0).toBe(inst.exponent)
    }))
    expect(toDecimalString(amount(tETH, 1n))).toBe('0.000000000000000001')
    expect(toDecimalString(amount(jpy, -1234n))).toBe('-1234')
  })

  it('refuses more decimal places than the instrument has, unless they are zeros or a rounding mode is named', () => {
    expect(amountFromDecimal(usd, '1.230').minor).toBe(123n)
    expect(code(() => amountFromDecimal(usd, '1.235'))).toBe('too-precise')
    expect(amountFromDecimal(usd, '1.235', 'halfEven').minor).toBe(124n)
    expect(amountFromDecimal(usd, '-1.235', 'floor').minor).toBe(-124n)
    expect(amountFromDecimal(usd, '-1.235', 'trunc').minor).toBe(-123n)
    expect(code(() => amountFromDecimal(jpy, '10.5'))).toBe('too-precise')
    expect(code(() => amountFromDecimal(usd, '1e3'))).toBe('unexpected-text')
  })

  it('splits an amount without creating or losing a minor unit (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.array(fc.bigInt({ min: 0n, max: 10n ** 6n }), { minLength: 1, maxLength: 8 }).filter((w) => w.some((x) => x > 0n)), (minor, weights) => {
      const whole = amount(kwd, minor)
      const parts = allocateAmount(whole, weights)
      expect(sumAmounts(kwd, parts)).toEqual(whole)
      const total = weights.reduce((s, w) => s + w, 0n)
      parts.forEach((p, i) => {
        const err = p.minor * total - minor * weights[i]! // (part − ideal)·total
        expect(err > -total && err < total).toBe(true)
      })
    }))
    expect(allocateAmount(amount(jpy, 100n), [1n, 1n, 1n]).map((p) => p.minor)).toEqual([34n, 33n, 33n])
    expect(code(() => allocateAmount(amount(jpy, 100n), [-1n, 2n]))).toBe('invalid-argument')
    expect(code(() => allocateAmount(amount(jpy, 100n), [0n, 0n]))).toBe('division-by-zero')
  })

  it('scales by an exact ratio with the rounding named', () => {
    const fee = ratio(5n, 1000n) // 0.5%
    expect(scaleAmount(amount(usd, 1_001n), fee, 'ceil').minor).toBe(6n)
    expect(scaleAmount(amount(usd, 1_001n), fee, 'floor').minor).toBe(5n)
  })

  it('crosses JSON as an integer string with its exponent, and is refused at another exponent', () => {
    const a = amount(tETH, 123_456_789_012_345_678_901n)
    const j = amountToJSON(a)
    expect(j).toEqual({ instrument: tETH.id, exponent: 18, minor: '123456789012345678901' })
    expect(amountFromJSON(JSON.parse(JSON.stringify(j)), REG)).toEqual(a)
    expect(code(() => amountFromJSON({ ...j, exponent: 8 }, REG))).toBe('exponent-mismatch')
  })
})

describe('formatting', () => {
  it('writes every digit of any amount, without floating point', () => {
    expect(formatAmount(amount(tETH, 123_456_789_123_456_789_012_345_678n), tETH, { locale: 'en-US' })).toBe('123,456,789.123456789012345678 tETH')
    expect(formatAmount(amount(inr, 123_456_789_012_345_678n), inr, { locale: 'en-IN' })).toBe('₹1,23,45,67,89,01,23,456.78')
    expect(formatAmount(amount(usd, 900_719_925_474_099_312n), usd, { locale: 'en-US' })).toBe('$9,007,199,254,740,993.12')
  })

  it('takes the decimal places from ISO 4217, not from the locale data (IQD has three; CLDR gives it none)', () => {
    expect(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'IQD' }).resolvedOptions().maximumFractionDigits).toBe(0)
    expect(formatAmount(amount(iqd, 1_234_567n), iqd, { locale: 'en-US' })).toBe('IQD\u00A01,234.567')
    expect(formatAmount(amount(jpy, 1_234_567n), jpy, { locale: 'en-US' })).toBe('¥1,234,567')
    expect(formatAmount(amount(kwd, 1_234_567n), kwd, { locale: 'en-US', display: 'code' })).toBe('KWD\u00A01,234.567')
  })

  it('refuses a locale tag that is not one, rather than guess', () => {
    expect(() => formatAmount(amount(usd, 1n), usd, { locale: 'not a locale!' })).toThrow(RangeError)
    expect(() => parseAmount('1', usd, { locale: 'not a locale!' })).toThrow(RangeError)
    expect(code(() => formatAmount(amount(usd, 1n), eur, { locale: 'en-US' }))).toBe('instrument-mismatch')
  })

  it('never writes a figure whose digits are split by words, even when Intl does', () => {
    // ICU 78.3 formats UYW by name in Turkish as "UYW 0,000 UYW0"; the module falls back to the ISO code display.
    const uyw = I('iso4217:UYW')
    const text = formatAmount(amount(uyw, 12_345n), uyw, { locale: 'tr-TR', display: 'name' })
    expect(text).toMatch(/\d,\d{4}(?!\d)/)
    expect(text.replace(/[^0-9,]/g, '')).toBe('1,2345')
    expect(parseAmount(text, uyw, { locale: 'tr-TR' }).minor).toBe(12_345n)
  })

  it('needs a rounding mode to write fewer decimal places than the instrument has', () => {
    const a = amount(tETH, 1_234_500_000_000_000_000n)
    expect(code(() => formatAmount(a, tETH, { locale: 'en-US', fractionDigits: 2 }))).toBe('rounding-required')
    expect(formatAmount(a, tETH, { locale: 'en-US', fractionDigits: 3, rounding: 'halfEven' })).toBe('1.234 tETH')
    expect(formatAmount(a, tETH, { locale: 'en-US', fractionDigits: 3, rounding: 'halfExpand' })).toBe('1.235 tETH')
    expect(formatAmount(amount(usd, -4n), usd, { locale: 'en-US', fractionDigits: 1, rounding: 'halfExpand' })).toBe('$0.0')
  })

  it('writes rupees exactly as shared/money.ts does, so callers can move over without a visible change (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (p) => {
      const a = amount(inr, p)
      const ours = p % 100n === 0n
        ? formatAmount(a, inr, { locale: 'en-IN', fractionDigits: 0, rounding: 'trunc', typographicMinus: true })
        : formatAmount(a, inr, { locale: 'en-IN', typographicMinus: true })
      expect(ours).toBe(oldInrExact(p))
      expect(inrExact(p)).toBe(oldInrExact(p)) // stage S1 changed no text
    }))
  })

  it('can stand in for shared/money.ts inr() with every sign option, the precondition of migration stage S1 (property)', () => {
    // inr() rounds whole rupees as Math.floor((abs + 50) / 100) (shared/money.ts:28): within 50 paise of 2^53 the sum
    // is no longer exact, so the comparison stops there. Below, the exact answer at the top of the safe range.
    const exactLimit = Number.MAX_SAFE_INTEGER - 50
    const signs = { auto: 'auto', always: 'exceptZero', never: 'never' } as const
    fc.assert(fc.property(fc.integer({ min: -exactLimit, max: exactLimit }), fc.constantFrom('auto', 'always', 'never'), fc.boolean(), (p, sign, paise) => {
      const ours = formatAmount(amount(inr, p), inr, { locale: 'en-IN', typographicMinus: true, sign: signs[sign], ...(paise ? {} : { fractionDigits: 0, rounding: 'halfExpand' as const }) })
      expect(ours).toBe(oldInr(p, { sign, paise }))
      expect(inrRupees(p, { sign, paise })).toBe(oldInr(p, { sign, paise })) // stage S1 changed no text below 2^53 - 50
    }), { numRuns: 300 })
  })

  it('rounds whole rupees exactly at the top of the safe-integer range, where inr() is off by one rupee', () => {
    // ₹90,071,992,547,409.49 rounds to ₹90,071,992,547,409. inr(-9007199254740949) writes ...410 (found by the property above).
    const a = amount(inr, -9_007_199_254_740_949n)
    expect(formatAmount(a, inr, { locale: 'en-IN', fractionDigits: 0, rounding: 'halfExpand', typographicMinus: true })).toBe('−₹9,00,71,99,25,47,409')
    expect(formatAmount(a, inr, { locale: 'en-IN', typographicMinus: true })).toBe('−₹9,00,71,99,25,47,409.49')
    // since stage S1, shared/money.ts writes it exactly too (GM-9); the old arithmetic wrote ...410
    expect(inrRupees(-9_007_199_254_740_949)).toBe('−₹9,00,71,99,25,47,409')
    expect(oldInr(-9_007_199_254_740_949)).toBe('−₹9,00,71,99,25,47,410')
  })

  it('reads back whatever it writes, in every locale and instrument tried (property)', () => {
    // A 20,000-case run of this property over the same 35 locales found three faults, all fixed: fr-CH writes currency
    // with "." but plain numbers with ","; Turkish name display writes a symbol and a name; ICU split UYW's digits.
    const locales = ['en-US', 'en-IN', 'en-GB', 'de-DE', 'de-CH', 'de-AT', 'fr-FR', 'fr-CH', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'pt-PT',
      'sv-SE', 'nb-NO', 'pl-PL', 'cs-CZ', 'tr-TR', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'ar-KW', 'ar-EG', 'ar-SA', 'he-IL', 'fa-IR',
      'hi-IN-u-nu-deva', 'bn-BD', 'th-TH-u-nu-thai', 'ru-RU', 'uk-UA', 'id-ID', 'vi-VN', 'en-ZA']
    const pool = [usd, inr, eur, jpy, kwd, iqd, chf, I('iso4217:CLF'), I('iso4217:BHD'), I('iso4217:VND'), I('iso4217:UYW'), tINR, tUSD, tEUR, tETH, apple]
    fc.assert(fc.property(fc.constantFrom(...locales), fc.constantFrom(...pool), fc.bigInt({ min: -(10n ** 22n), max: 10n ** 22n }), fc.constantFrom('symbol', 'code', 'name', 'none'), fc.boolean(), fc.boolean(), (locale, inst, minor, display, minus, grouping) => {
      const shown = inst.kind === 'fiat' ? display : display === 'name' ? 'none' : display === 'symbol' && inst.kind === 'security' ? 'code' : display
      const a = amount(inst, minor)
      const text = formatAmount(a, inst, { locale, display: shown as 'symbol', typographicMinus: minus, grouping })
      expect(parseAmount(text, inst, { locale })).toEqual(a)
    }), { numRuns: 400 })
  })
})

describe('parsing what a person types', () => {
  const ok: [string, Instrument, string, bigint][] = [
    ['₹1,00,000.50', inr, 'en-IN', 10_000_050n],
    ['1,00,000', inr, 'en-IN', 10_000_000n],
    ['−₹1,744.20', inr, 'en-IN', -174_420n],
    ['1.234,56 €', eur, 'de-DE', 123_456n],
    ['1 234,56 €', eur, 'fr-FR', 123_456n],
    ['1234,56', eur, 'fr-FR', 123_456n],
    ["CHF-1'234.50", chf, 'de-CH', -123_450n],
    ['CHF 1’234.50', chf, 'de-CH', 123_450n],
    ['¥1,234', jpy, 'ja-JP', 1_234n],
    ['１２３４円', jpy, 'ja-JP', 1_234n],
    ['١٬٢٣٤٫٥٦٧ د.ك.', kwd, 'ar-KW', 1_234_567n],
    ['१,२३,४५६.७८', inr, 'hi-IN-u-nu-deva', 12_345_678n],
    ['12.5 USD', usd, 'en-US', 1_250n],
    ['.5', usd, 'en-US', 50n],
    ['+3 tETH', tETH, 'en-US', 3_000_000_000_000_000_000n],
    ['0.000000000000000001 tETH', tETH, 'en-US', 1n],
    ['250.75 tINR', tINR, 'en-IN', 25_075n],
    ['10 US0378331005', apple, 'en-US', 10n],
    ["1'234.50 $US", usd, 'fr-CH', 123_450n], // fr-CH's currency style: "." for decimals
    ["1'234,50", usd, 'fr-CH', 123_450n], // and its plain style: ","
    ['€ 1.234,50', eur, 'de-AT', 123_450n], // de-AT groups currency with "."
    ['$1.234,50 ABD doları', usd, 'tr-TR', 123_450n], // a symbol and a name together
  ]
  it.each(ok)('reads %s', (text, inst, locale, minor) => {
    expect(parseAmount(text, inst, { locale })).toEqual(amount(inst, minor))
  })

  const refused: [string, Instrument, string, string][] = [
    ['', usd, 'en-US', 'empty'],
    ['   ', usd, 'en-US', 'empty'],
    ['1.5', eur, 'de-DE', 'bad-grouping'], // in German "." groups thousands; "1.5" is neither 15 nor 1.5
    ['1,5', usd, 'en-US', 'bad-grouping'],
    ['12,34,567', usd, 'en-US', 'bad-grouping'], // Indian grouping is not US grouping
    ['1234,567', usd, 'en-US', 'bad-grouping'],
    ['1 234.56', usd, 'en-US', 'bad-grouping'],
    ['$100', cad, 'en-US', 'wrong-instrument'], // "$" alone names US dollars in en-US; Canadian dollars are "CA$"
    ['100 USD', eur, 'en-US', 'wrong-instrument'],
    ['€5', usd, 'en-US', 'wrong-instrument'],
    ['5 tUSD', tINR, 'en-US', 'unexpected-text'],
    ['1e5', usd, 'en-US', 'unexpected-text'],
    ['1€234', eur, 'fr-FR', 'unexpected-text'],
    ['(1,234.56)', usd, 'en-US', 'unexpected-text'],
    ['--5', usd, 'en-US', 'unexpected-text'],
    ['-5-', usd, 'en-US', 'bad-sign'],
    ['1.2345', kwd, 'en-US', 'too-precise'],
    ['10.5', jpy, 'en-US', 'too-precise'],
    ['1'.repeat(129), usd, 'en-US', 'unexpected-text'],
  ]
  it.each(refused)('refuses %j', (text, inst, locale, want) => {
    expect(code(() => parseAmount(text, inst, { locale }))).toBe(want)
  })

  it('refuses text that is two different numbers in a locale whose number and currency conventions conflict', () => {
    // ICU 78.3 (CLDR 48): en-DE writes plain numbers "1.234.567,5" and currency "$1,234,567.50"; 12 more English
    // locales of Europe do the same (en-NL, en-BE, en-IT, en-ES, …).
    expect(code(() => parseAmount('1.234', kwd, { locale: 'en-DE' }))).toBe('ambiguous') // 1234 or 1.234
    expect(code(() => parseAmount('1.234', usd, { locale: 'en-DE' }))).toBe('ambiguous') // too precise as 1.234 is still a reading
    expect(parseAmount('1.234,56', usd, { locale: 'en-DE' }).minor).toBe(123_456n)
    expect(parseAmount('US$1,234.56', usd, { locale: 'en-DE' }).minor).toBe(123_456n) // en-DE's symbol for USD
    expect(code(() => parseAmount('$1,234.56', usd, { locale: 'en-DE' }))).toBe('wrong-instrument') // a bare "$" is not it there
    expect(parseAmount('1234', usd, { locale: 'en-DE' }).minor).toBe(123_400n)
    expect(parseAmount('1,5', usd, { locale: 'en-DE' }).minor).toBe(150n)
  })

  it('in such a locale, reading back what it wrote gives the same amount or a refusal, never another amount (property)', () => {
    const locales = ['en-DE', 'en-NL', 'en-BE', 'en-IT', 'en-ES', 'en-PT', 'en-FI']
    fc.assert(fc.property(fc.constantFrom(...locales), fc.constantFrom(usd, kwd, jpy, tETH, apple), fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.boolean(), (locale, inst, minor, grouping) => {
      const a = amount(inst, minor)
      const text = formatAmount(a, inst, { locale, display: inst.kind === 'security' ? 'code' : 'symbol', grouping })
      try { expect(parseAmount(text, inst, { locale })).toEqual(a) } catch (e) {
        if (!(e instanceof MoneyError) || e.code !== 'ambiguous') throw e
      }
    }), { numRuns: 300 })
  })

  it('rounds extra decimal places only when told how', () => {
    expect(parseAmount('1.2345', kwd, { locale: 'en-US', rounding: 'halfEven' }).minor).toBe(1_234n)
    expect(parseAmount('1.2345', kwd, { locale: 'en-US', rounding: 'halfExpand' }).minor).toBe(1_235n)
    expect(parseAmount('-10.5', jpy, { locale: 'en-US', rounding: 'floor' }).minor).toBe(-11n)
  })
})

describe('rates and conversion', () => {
  const rate = (over: Partial<Parameters<typeof makeRate>[0]> = {}): Rate => makeRate({
    base: usd.id, quote: jpy.id, kind: 'indicative', lo: '155.10', mid: '155.20', hi: '155.30',
    source: 'example quote', label: 'fixture', observedAt: T0, validUntil: T0 + HOUR, ...over,
  })

  it('refuses a rate without its two sides, an ordered band, a source and a validity window', () => {
    expect(code(() => rate({ quote: usd.id }))).toBe('invalid-rate')
    expect(code(() => rate({ lo: '155.40' }))).toBe('invalid-rate')
    expect(code(() => rate({ lo: '0', mid: '0', hi: '0' }))).toBe('invalid-rate')
    expect(code(() => rate({ kind: 'fill' }))).toBe('invalid-rate')
    expect(rate({ kind: 'fill', lo: '155.2', hi: '155.2' }).kind).toBe('fill')
    expect(code(() => rate({ kind: 'projection' }))).toBe('invalid-rate')
    expect(code(() => rate({ scenario: 'base case' }))).toBe('invalid-rate')
    expect(code(() => rate({ validUntil: T0 - 1 }))).toBe('invalid-rate')
    expect(code(() => rate({ source: ' ' }))).toBe('invalid-rate')
  })

  it('converts across exponents (2 to 0, 3 to 2) with the rounding named, and records what rounding removed', () => {
    const c = convert(amount(usd, 1_001n), rate(), usd, jpy, { at: T0, use: 'valuation', bound: 'mid', rounding: 'halfEven' })
    expect(c.to).toEqual(amount(jpy, 1_554n)) // 10.01 × 155.20 = 1553.552
    expect(showRatio(c.exact)).toBe('194194/125')
    expect(showRatio(c.remainder)).toBe('-56/125') // 1553.552 − 1554
    expect(convert(amount(usd, 1_001n), rate(), usd, jpy, { at: T0, use: 'valuation', bound: 'mid', rounding: 'floor' }).to.minor).toBe(1_553n)
    const kwdUsd = makeRate({ base: kwd.id, quote: usd.id, kind: 'valuation', mid: '3.2550', source: 'example', label: 'fixture', observedAt: T0, validUntil: T0 + HOUR })
    expect(convert(amount(kwd, 1_000n), kwdUsd, kwd, usd, { at: T0, use: 'valuation', bound: 'mid', rounding: 'halfEven' }).to.minor).toBe(326n) // 325.5 → even
    expect(convert(amount(kwd, 1_000n), kwdUsd, kwd, usd, { at: T0, use: 'valuation', bound: 'mid', rounding: 'floor' }).to.minor).toBe(325n)
  })

  it('uses a rate quoted the other way round by inverting it exactly, band ends swapped', () => {
    const c = convert(amount(jpy, 155_200n), rate(), jpy, usd, { at: T0, use: 'valuation', bound: 'mid', rounding: 'halfEven' })
    expect(c.inverted).toBe(true)
    expect(c.to.minor).toBe(100_000n)
    const inv = invertRate(rate())
    expect(showRatio(inv.lo)).toBe(showRatio(ratio(10n, 1553n)))
    expect(invertRate(inv)).toEqual(rate())
  })

  it('refuses a stale rate, a rate observed after the decision, and a kind of figure the use does not allow', () => {
    const go = (r: Rate, at: number, use: Parameters<typeof convert>[4]['use']) => code(() => convert(amount(usd, 100n), r, usd, jpy, { at, use, bound: 'mid', rounding: 'floor' }))
    expect(go(rate(), T0 + HOUR + 1, 'valuation')).toBe('stale-rate')
    expect(go(rate(), T0 - 1, 'valuation')).toBe('rate-from-the-future')
    expect(go(rate(), T0, 'execution')).toBe('kind-not-allowed') // an indicative price is not an executable quote
    expect(go(rate(), T0, 'settlement')).toBe('kind-not-allowed')
    expect(go(rate({ kind: 'projection', scenario: 'base case' }), T0, 'authority')).toBe('kind-not-allowed')
    expect(go(rate({ kind: 'projection', scenario: 'base case' }), T0, 'valuation')).toBe('kind-not-allowed')
    expect(go(rate({ kind: 'executable' }), T0, 'execution')).toBe('no error')
    expect(go(rate(), T0, 'display')).toBe('no error')
  })

  it('creates no value by converting there and back conservatively (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.bigInt({ min: 0n, max: 10n ** 7n }), fc.constantFrom<[Instrument, Instrument]>([usd, jpy], [kwd, usd], [tETH, tUSD], [jpy, kwd], [tINR, tUSD]), (minor, midN, spread, [a, b]) => {
      const mid = ratio(midN, 10_000n), lo = ratio(midN * 10_000n, 10_000n * (10_000n + spread)), hi = ratio(midN * (10_000n + spread), 10_000n * 10_000n)
      const r = makeRate({ base: a.id, quote: b.id, kind: 'valuation', lo, mid, hi, source: 'generated', label: 'fixture', observedAt: T0, validUntil: T0 + HOUR })
      const there = conservativeValue(amount(a, minor), r, a, b, T0)
      const back = conservativeValue(there.to, r, b, a, T0)
      expect(back.to.minor <= minor).toBe(true)
      const up = convert(amount(a, minor), r, a, b, { at: T0, use: 'valuation', bound: 'lo', rounding: 'ceil' })
      expect(there.to.minor <= up.to.minor && up.to.minor - there.to.minor <= 1n).toBe(true)
    }))
  })

  it('reproduces R7 D7\'s reference band of tUSD in tINR exactly, as a labelled fixture rate', () => {
    // chain/rail/host.ts referenceBand(): the deep pool of INR_VENUES, 8,400,000 tINR to 100,000 tUSD, ± 50 bps.
    const ra = 8_400_000n, rb = 100_000n, w = 50n
    const band = makeRate({
      base: tUSD.id, quote: tINR.id, kind: 'reference',
      lo: ratio(ra * (10_000n - w), rb * 10_000n), mid: ratio(ra, rb), hi: ratio(ra * (10_000n + w), rb * 10_000n),
      source: 'the test market\'s genesis rate ± 0.5% (chain/rail/host.ts referenceBand)', label: 'fixture', observedAt: T0, validUntil: Number.MAX_SAFE_INTEGER,
    })
    expect(showRatio(band.mid)).toBe('84')
    const n = ra * 10n ** 2n, d = rb * 10n ** 6n // host.ts: tINR base units per tUSD base unit
    expect(atomicRatio(band, 'lo', tUSD, tINR)).toEqual(ratio(n * (10_000n - w), d * 10_000n))
    expect(atomicRatio(band, 'mid', tUSD, tINR)).toEqual(ratio(n, d))
    expect(atomicRatio(band, 'hi', tUSD, tINR)).toEqual(ratio(n * (10_000n + w), d * 10_000n))
    // A payment of 1 tUSD charged to a tINR authority budget at the upper reference, rounded up (D7's rule for payments).
    expect(convert(amount(tUSD, 1_000_000n), band, tUSD, tINR, { at: T0, use: 'authority', bound: 'hi', rounding: 'ceil' }).to.minor).toBe(8_442n)
  })
})

describe('exposure across instruments and rails', () => {
  const quote = (base: Instrument, lo: string, mid: string, hi: string, at = T0): Rate =>
    makeRate({ base: base.id, quote: usd.id, kind: 'valuation', lo, mid, hi, source: `example ${base.id}`, label: 'fixture', observedAt: at, validUntil: at + HOUR })
  const usdJpy = makeRate({ base: usd.id, quote: jpy.id, kind: 'indicative', lo: '155.00', mid: '155.20', hi: '155.40', source: 'example USD/JPY', label: 'fixture', observedAt: T0, validUntil: T0 + HOUR })
  const rates = [usdJpy, quote(eur, '1.0800', '1.0850', '1.0900'), quote(tETH, '3000', '3010', '3020'), quote(kwd, '3.2500', '3.2550', '3.2600')]
  const lines: ExposureLine[] = [
    { amount: amount(usd, 100_000n), rail: 'bank:example' },
    { amount: amount(jpy, 1_554_000n), rail: 'broker:example' },
    { amount: amount(tETH, 2_000_000_000_000_000_000n), rail: 'chain:eip155:31337' },
    { amount: amount(eur, -50_000n), rail: 'card:example' },
    { amount: amount(kwd, 1_000n), rail: 'bank:example' },
  ]

  it('values each line at the worse end of its band for its sign, rounded down, and sums by rail and instrument', () => {
    const r = aggregateExposure(lines, { numeraire: usd, at: T0, rates, registry: REG })
    // 1,000.00 USD; 1,554,000 JPY at 1/155.40 = 10,000.00 USD; 2 tETH at 3,000 = 6,000.00; −500.00 EUR at 1.09 = −545.00; 1 KWD at 3.25 = 3.25
    expect(r.lines.map((l) => l.value?.minor)).toEqual([100_000n, 1_000_000n, 600_000n, -54_500n, 325n])
    expect(r.total.minor).toBe(1_645_825n)
    expect(r.complete).toBe(true)
    expect(r.byRail.get('bank:example')?.minor).toBe(100_325n)
    expect(r.byInstrument.get(eur.id)?.minor).toBe(-54_500n)
    // A 1% haircut lowers each asset and deepens the liability: −545.00 becomes −550.45.
    const cut = aggregateExposure(lines, { numeraire: usd, at: T0, rates, registry: REG, haircutBps: () => 100 })
    expect(cut.lines.map((l) => l.value?.minor)).toEqual([99_000n, 990_000n, 594_000n, -55_045n, 321n])
    expect(cut.total.minor).toBe(1_628_276n)
  })

  it('counts an asset with no usable rate as nothing, and calls the total incomplete when a liability has none', () => {
    const stale = [usdJpy, quote(eur, '1.0800', '1.0850', '1.0900', T0 - 2 * HOUR), quote(tETH, '3000', '3010', '3020'), quote(kwd, '3.2500', '3.2550', '3.2600')]
    const r = aggregateExposure(lines, { numeraire: usd, at: T0, rates: stale, registry: REG })
    expect(r.complete).toBe(false)
    expect(r.lines[3]!.value).toBeNull()
    const assetsOnly = aggregateExposure(lines.filter((l) => l.amount.minor > 0n), { numeraire: usd, at: T0, rates: rates.filter((x) => x.base !== tETH.id), registry: REG })
    expect(assetsOnly.complete).toBe(true)
    expect(assetsOnly.lines[2]!.value).toBeNull()
    expect(assetsOnly.total.minor).toBe(100_000n + 1_000_000n + 325n)
  })

  it('is conservative, monotone in haircuts and blind to order (property)', () => {
    const arbLine = fc.record({
      inst: fc.constantFrom(usd, jpy, eur, tETH, kwd),
      minor: fc.bigInt({ min: -(10n ** 21n), max: 10n ** 21n }),
      rail: fc.constantFrom('bank:a', 'broker:b', 'chain:eip155:31337'),
      cut: fc.integer({ min: 0, max: 5_000 }),
    })
    fc.assert(fc.property(fc.array(arbLine, { maxLength: 8 }), fc.integer({ min: 0, max: 5_000 }), (raw, extra) => {
      const ls = raw.map((x) => ({ amount: amount(x.inst, x.minor), rail: x.rail, cut: x.cut }))
      const base = aggregateExposure(ls, { numeraire: usd, at: T0, rates, registry: REG })
      const cut = aggregateExposure(ls, { numeraire: usd, at: T0, rates, registry: REG, haircutBps: (l) => (l as typeof ls[number]).cut })
      const more = aggregateExposure(ls, { numeraire: usd, at: T0, rates, registry: REG, haircutBps: (l) => Math.min(10_000, (l as typeof ls[number]).cut + extra) })
      const reversed = aggregateExposure([...ls].reverse(), { numeraire: usd, at: T0, rates, registry: REG })
      // At mid, rounded down: never below the conservative total.
      let atMid = 0n
      for (const l of ls) {
        const inst = REG.instrument(l.amount.instrument)
        atMid += inst.id === usd.id ? l.amount.minor : rates.filter((r) => r.base === inst.id || r.quote === inst.id).map((r) => convert(l.amount, r, inst, usd, { at: T0, use: 'valuation', bound: 'mid', rounding: 'floor' }).to.minor).reduce((m, v) => (v < m ? v : m))
      }
      expect(base.total.minor <= atMid).toBe(true)
      expect(cut.total.minor <= base.total.minor).toBe(true)
      expect(more.total.minor <= cut.total.minor).toBe(true)
      expect(reversed.total).toEqual(base.total)
      // Line by line: a haircut never raises a value, and it deepens any liability large enough to feel it.
      base.lines.forEach((l, i) => {
        const v = l.value!.minor, c = cut.lines[i]!.value!.minor, h = BigInt(ls[i]!.cut)
        expect(c <= v).toBe(true)
        if (v < 0n && h > 0n && -v * h >= 10_000n) expect(c < v).toBe(true)
      })
    }))
  })
})
