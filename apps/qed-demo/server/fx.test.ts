/**
 * The paper FX desk (R13 section 3; R7-038): a reference rate is labelled as reference and nobody trades at it; an
 * executable paper quote states its rate, spread, fee, expiry and source; the owner approves those exact terms; an
 * expired quote is refused; the fill keeps rate, spread and fee apart; every currency balances on its own; a conversion
 * rounds once, at a stated point, under a named rule. Paper only: no real money, no network.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { AppError } from './core.ts'
import { balance, verifyLedger } from './ledger.ts'
import { makeKit } from './testkit.ts'
import { worstCase } from './valuation.ts'
import { balancesByCurrency, CBB_PEG, convertApproved, LRS_HELD_NOTE, moneyView, FX_RECORDED, prepareConversion, priceConversion, pricedTotal, referenceRates, SYNTHETIC_CROSSES } from './fx.ts'
import { money, plainMoney } from '../shared/currency.ts'
import { divRound, parseRatio, pow10, ratio } from '../shared/instrument.ts'

/** 20 Nov 2026, 10:30 IST: after the recorded reference rates (18 Nov, 13:00 IST). */
const T1 = Date.parse('2026-11-20T05:00:00Z')
const kitAt = (opts: Parameters<typeof makeKit>[0] = {}) => makeKit({ start: T1, ...opts })

function approve(k: ReturnType<typeof makeKit>, q: { approvalId: string; docHash: string }): void {
  confirmApproval(k.db, k.userId, q.approvalId, { method: 'passkey', docHash: q.docHash }, k.clock.now())
}
const assetSums = (k: ReturnType<typeof makeKit>) => k.db.all<{ asset_id: string; s: string }>('SELECT asset_id, amount_sum(amount_text) s FROM postings GROUP BY asset_id')

describe('reference rates: labelled as reference, never as a price anyone can trade at', () => {
  it('prices from the recorded FBIL rates of 18 Nov 2026, and labels the crosses it makes up as synthetic', () => {
    const k = kitAt()
    const r = referenceRates(k.market, k.clock.now())
    for (const c of ['USD', 'EUR', 'GBP', 'JPY'] as const) {
      expect(r.get(c)!.kind).toBe('reference')
      expect(r.get(c)!.label).toBe('historical')
      expect(r.get(c)!.source).toMatch(/FBIL.*18 Nov 2026/)
      expect(r.get(c)!.observedAt).toBe(FX_RECORDED.observedAt)
    }
    expect(r.get('USD')!.mid).toEqual(parseRatio('93.3558'))
    expect(r.get('JPY')!.mid).toEqual(parseRatio('0.586')) // FBIL quotes 100 yen at 58.6000
    for (const c of ['AED', 'SGD'] as const) { expect(r.get(c)!.label).toBe('synthetic'); expect(r.get(c)!.source).toMatch(/synthetic/) }
  })

  it('prices the dinar from the Central Bank of Bahrain\'s published rate (1 BHD = 2.659 USD, Decree 48 of 2001), recorded with its date and page hash', () => {
    const r = referenceRates(kitAt().market, T1)
    const bhd = r.get('BHD')!, usd = r.get('USD')!
    expect(bhd.label).toBe('historical')
    expect(bhd.source).toMatch(/Central Bank of Bahrain/)
    expect(bhd.source).toMatch(/Decree \(48\) of 2001/)
    expect(bhd.source).toMatch(/24 Nov 2026/)
    expect(bhd.source).toContain(CBB_PEG.pageSha256)
    expect(bhd.source).not.toMatch(/synthetic/)
    // the rupee value of a dinar is the dollar's reference times 2.659, exactly
    expect(bhd.mid).toEqual(ratio(usd.mid.n * 2659n, usd.mid.d * 1000n))
    expect(CBB_PEG.pageSha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('keeps the dirham and the Singapore dollar synthetic, and says why a central bank\'s figure was not used', () => {
    expect(SYNTHETIC_CROSSES.AED.words).toMatch(/Central Bank of the UAE.*403/)
    expect(SYNTHETIC_CROSSES.SGD.words).toMatch(/Monetary Authority of Singapore/)
    expect(Object.keys(SYNTHETIC_CROSSES).sort()).toEqual(['AED', 'SGD'])
  })

  it('uses a live or test reference for USD and EUR when the market has a fresh one, but never the synthetic walk', () => {
    const k = kitAt()
    k.quote('ecb:USDINR', 'reference', '84.5000')
    expect(referenceRates(k.market, k.clock.now()).get('USD')!.mid).toEqual(parseRatio('84.5'))
    k.market.update({ instrumentId: 'ecb:EURINR', type: 'reference', price: '91.0000', sourceTs: k.clock.now(), precision: 'day', recvTs: k.clock.now(), provider: 'synthetic' })
    expect(referenceRates(k.market, k.clock.now()).get('EUR')!.source).toMatch(/FBIL/)
  })
})

describe('a conversion into a held balance and the Liberalised Remittance Scheme', () => {
  it('counts toward the ceiling when the rupees are changed, and says so on the sheet and in the money view', () => {
    const k = kitAt()
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '1000.00', fixed: 'buy' })
    const line = q.lines.find((l) => l.label === 'Liberalised Remittance Scheme')!
    expect(line.note).toContain(LRS_HELD_NOTE)
    expect(LRS_HELD_NOTE).toMatch(/even when the money stays in your account here/)
    expect(LRS_HELD_NOTE).toMatch(/cautious side/)
    approve(k, q); convertApproved(k.ctx, k.userId, q.approvalId)
    const view = moneyView(k.ctx, k.userId) as { lrs: { usedText: string; heldNote: string } }
    expect(view.lrs.usedText).toBe('USD 1,000.00')
    expect(view.lrs.heldNote).toBe(LRS_HELD_NOTE)
    // converting back is not counted against the ceiling, and does not reduce what was counted: the cautious side
    const back = prepareConversion(k.ctx, k.userId, { sell: 'USD', buy: 'INR', amount: '500.00', fixed: 'sell' })
    expect(back.lrs).toBeNull()
    approve(k, back); convertApproved(k.ctx, k.userId, back.approvalId)
    expect((moneyView(k.ctx, k.userId) as { lrs: { usedText: string } }).lrs.usedText).toBe('USD 1,000.00')
  })
})

describe('an executable paper quote', () => {
  it('states its rate, spread, fee, expiry and source apart from the reference, in a document the owner approves', () => {
    const k = kitAt()
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '1000.00', fixed: 'buy' })
    const d = JSON.parse(q.document)
    expect(d.v).toBe(2)
    expect(d.kind).toBe('fx-conversion')
    expect(d.quote.rate.kind).toBe('executable')
    expect(d.quote.reference.kind).toBe('reference')
    expect(d.quote.spreadBps).toBe(50)
    // 93.3558 × 1.005 = 93.822579, stated to six places
    expect(d.quote.rate.value).toBe('93.822579')
    expect(d.quote.buy).toEqual({ instrument: 'iso4217:USD', exponent: 2, minor: '100000' })
    expect(d.quote.sell).toEqual({ instrument: 'iso4217:INR', exponent: 2, minor: '9382258' }) // ₹93,822.579 rounded up
    expect(d.quote.fee).toEqual({ instrument: 'iso4217:INR', exponent: 2, minor: '5000' })
    expect(d.quote.expiresAt).toBe(k.clock.now() + 60_000)
    expect(d.quote.rounding).toMatch(/rounded up/)
    expect(d.timeZone).toBe('Asia/Kolkata')
    expect(q.expiresAt).toBe(d.quote.expiresAt)
    expect(q.lines.map((l) => l.label)).toEqual(expect.arrayContaining(['Rate', 'Reference', 'Spread', 'Fee', 'You pay', 'You receive', 'Quote expires']))
  })

  it('fills the approved terms once: the books balance in each currency and the fill keeps rate, spread and fee apart', () => {
    const k = kitAt()
    const before = balance(k.db, k.userId, 'bank')
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'JPY', amount: '50000', fixed: 'buy' })
    approve(k, q)
    const f = convertApproved(k.ctx, k.userId, q.approvalId)
    expect(f.duplicate).toBe(false)
    expect(balance(k.db, k.userId, 'bank:JPY')).toBe(50_000n)
    const d = JSON.parse(q.document)
    expect(before - balance(k.db, k.userId, 'bank')).toBe(BigInt(d.quote.sell.minor) + 5000n)
    const row = k.db.get<Record<string, unknown>>('SELECT * FROM fx_fills WHERE quote_id = ?', d.quote.id)!
    expect(row).toMatchObject({ purpose: 'conversion', sell_ccy: 'INR', buy_ccy: 'JPY', buy_text: '50000', rate: d.quote.rate.value, spread_bps: 50, fee_text: '5000' })
    expect(BigInt(String(row.spread_text))).toBeGreaterThan(0n)
    expect(JSON.parse(String(row.reference_json))).toMatchObject({ kind: 'reference' })
    for (const s of assetSums(k)) expect(s.s).toBe('0')
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    // the same approval again moves nothing
    const again = convertApproved(k.ctx, k.userId, q.approvalId)
    expect(again).toMatchObject({ duplicate: true, fillId: f.fillId })
    expect(balance(k.db, k.userId, 'bank:JPY')).toBe(50_000n)
  })

  it('refuses an expired quote, even one approved in time, and changes nothing', () => {
    const k = kitAt()
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'BHD', amount: '100.000', fixed: 'buy' })
    approve(k, q)
    k.clock.advance(60_001)
    const before = balance(k.db, k.userId, 'bank')
    expect(() => convertApproved(k.ctx, k.userId, q.approvalId)).toThrow(expect.objectContaining({ code: 'quote_expired' }))
    expect(balance(k.db, k.userId, 'bank')).toBe(before)
    expect(balance(k.db, k.userId, 'bank:BHD')).toBe(0n)
  })

  it('refuses an unapproved quote, a pair the desk does not offer, a currency it does not hold, and more than is free', () => {
    const k = kitAt()
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '10.00', fixed: 'buy' })
    expect(() => convertApproved(k.ctx, k.userId, q.approvalId)).toThrow(expect.objectContaining({ code: 'approval_missing' }))
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'USD', buy: 'JPY', amount: '10.00', fixed: 'sell' })).toThrow(expect.objectContaining({ code: 'pair_not_offered' }))
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'KWD', amount: '10.000', fixed: 'buy' })).toThrow(expect.objectContaining({ code: 'currency_not_held' }))
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '1000000.00', fixed: 'buy' })).toThrow(expect.objectContaining({ code: 'insufficient_funds' }))
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'JPY', amount: '10.5', fixed: 'buy' })).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'USD', buy: 'INR', amount: '1.00', fixed: 'sell' })).toThrow(expect.objectContaining({ code: 'insufficient_funds' }))
  })

  it('sells a foreign balance back to rupees at the desk\'s lower rate, with the fee taken from the proceeds', () => {
    const k = kitAt()
    const buy = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '200.00', fixed: 'buy' })
    approve(k, buy); convertApproved(k.ctx, k.userId, buy.approvalId)
    const bank = balance(k.db, k.userId, 'bank')
    const sell = prepareConversion(k.ctx, k.userId, { sell: 'USD', buy: 'INR', amount: '200.00', fixed: 'sell' })
    const d = JSON.parse(sell.document)
    expect(d.quote.rate.value).toBe('92.889021') // 93.3558 × 0.995, stated to six places, rounded down
    approve(k, sell); convertApproved(k.ctx, k.userId, sell.approvalId)
    expect(balance(k.db, k.userId, 'bank:USD')).toBe(0n)
    expect(balance(k.db, k.userId, 'bank') - bank).toBe(BigInt(d.quote.buy.minor) - 5000n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
})

describe('the protections a payment has', () => {
  it('says, before it is approved, when a conversion goes below the floor or takes money needed for what is due', () => {
    const k = kitAt()
    const calm = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '100.00', fixed: 'buy' })
    expect(calm.warnings).toEqual([])
    expect(JSON.parse(calm.document).acknowledged).toEqual({ belowFloor: false, intoReserve: false })
    // what a conversion keeps counts too (the dollars bought count at 90% of their value), so only its cost, the haircut and the fee, lowers the worst case: put the floor just above it
    const w = worstCase(k.db, k.market, k.userId, k.clock.now())
    k.db.run(`UPDATE users SET profile_json = json_set(profile_json, '$.line', ?) WHERE id = ?`, Math.round(w.gHat) - 1_000_000, k.userId)
    const deep = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '2100.00', fixed: 'buy' })
    expect(deep.warnings.join(' ')).toMatch(/below your floor of ₹[\d,]+\.00\. You may do it yourself; QED's instructions may not\. The worst case counts money held in other currencies at its reference rate less 10%/)
    expect(JSON.parse(deep.document).acknowledged.belowFloor).toBe(true)
    const all = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '750000.00', fixed: 'sell' })
    expect(all.warnings[0]).toMatch(/^This leaves ₹49,950\.00 in your bank account, and ₹[\d,.]+ is needed for what is due/)
    expect(JSON.parse(all.document).acknowledged.intoReserve).toBe(true)
  })
})

describe('rounding once, under a named rule, at precisions 0, 2 and 3', () => {
  const ref = (mid: string) => ({ mid: parseRatio(mid), source: 'test', label: 'fixture' as const, observedAt: 0, kind: 'reference' as const })
  it('the owner receives the floor and pays the ceiling of the exact amount at the stated rate, within one minor unit', () => {
    fc.assert(fc.property(
      fc.constantFrom('JPY', 'USD', 'BHD'), fc.constantFrom<'buy' | 'sell'>('buy', 'sell'), fc.boolean(),
      fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 1_000, max: 400_000_000 }),
      (c, fixed, ownerBuysForeign, n, midMicro) => {
        const mid = (midMicro / 1e6).toFixed(6)
        const sell = ownerBuysForeign ? 'INR' : c, buy = ownerBuysForeign ? c : 'INR'
        const p = priceConversion({ sell, buy, amount: n, fixed, reference: ref(mid), spreadBps: 50 })
        const e = { INR: 2, USD: 2, JPY: 0, BHD: 3 } as const
        const rate = parseRatio(p.rate)
        const foreign = ownerBuysForeign ? p.buy : p.sell, rupees = ownerBuysForeign ? p.sell : p.buy
        // the exact rupees (in paise) of x foreign minor units at the stated rate are worth(x) / den
        const den = rate.d * pow10(e[c as keyof typeof e])
        const worth = (x: bigint) => x * rate.n * pow10(e.INR)
        if (ownerBuysForeign) {
          expect(rupees * den >= worth(foreign)).toBe(true) // what is paid covers what is bought
          if (fixed === 'buy') expect((rupees - 1n) * den < worth(foreign)).toBe(true) // rupees rounded up, by less than a paisa
          else expect(rupees * den < worth(foreign + 1n)).toBe(true) // the currency rounded down, by less than its minor unit
        } else {
          expect(rupees * den <= worth(foreign)).toBe(true) // what is received is no more than what is sold is worth
          if (fixed === 'sell') expect((rupees + 1n) * den > worth(foreign)).toBe(true) // rupees rounded down, by less than a paisa
          else expect(rupees * den > worth(foreign - 1n)).toBe(true) // the currency rounded up, by less than its minor unit
        }
        expect(fixed === 'buy' ? p.buy : p.sell).toBe(n)
        // the stated rate is the reference moved by the spread against the owner, within one millionth
        const m = parseRatio(mid), s = ownerBuysForeign ? 10_050n : 9_950n
        const target = divRound(m.n * s * 1_000_000n, m.d * 10_000n, ownerBuysForeign ? 'ceil' : 'floor')
        expect(BigInt(p.rate.replace('.', ''))).toBe(target)
      }), { numRuns: 500 })
  })

  it('conserves every currency, and changing money there and back never creates value', () => {
    fc.assert(fc.property(fc.constantFrom('JPY', 'USD', 'BHD', 'GBP', 'AED', 'SGD', 'EUR'), fc.integer({ min: 100, max: 2_000_000 }), (c, rupees) => {
      const k = kitAt()
      const start = balance(k.db, k.userId, 'bank')
      let a: ReturnType<typeof prepareConversion>
      try { a = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: c, amount: (rupees / 100).toFixed(2), fixed: 'sell' }) } catch (e) {
        if ((e as AppError).code === 'too_small') return // less than one minor unit of the currency: refused, never filled at zero
        throw e
      }
      const got = BigInt(JSON.parse(a.document).quote.buy.minor)
      approve(k, a); convertApproved(k.ctx, k.userId, a.approvalId)
      let back: ReturnType<typeof prepareConversion>
      try { back = prepareConversion(k.ctx, k.userId, { sell: c, buy: 'INR', amount: plainMoney(money(c, got)), fixed: 'sell' }) } catch (e) {
        if ((e as AppError).code === 'too_small') return // the fee would take all the proceeds: refused, never filled at a loss of more than was sold
        throw e
      }
      approve(k, back); convertApproved(k.ctx, k.userId, back.approvalId)
      expect(balance(k.db, k.userId, `bank:${c}`)).toBe(0n)
      expect(balance(k.db, k.userId, 'bank')).toBeLessThanOrEqual(start - 10_000n) // two fees at least
      for (const s of assetSums(k)) expect(s.s).toBe('0')
    }), { numRuns: 30 })
  })
})

describe('balances by currency, and a total only with a priced conversion', () => {
  it('keeps each currency apart, and a total names each rate, its source and its time', () => {
    const k = kitAt()
    for (const [c, amount] of [['USD', '100.00'], ['JPY', '20000'], ['BHD', '10.500']] as const) {
      const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: c, amount, fixed: 'buy' })
      approve(k, q); convertApproved(k.ctx, k.userId, q.approvalId)
    }
    const b = balancesByCurrency(k.db, k.userId)
    expect(b.map((x) => x.currency)).toEqual(['INR', 'USD', 'JPY', 'BHD'])
    expect(b.find((x) => x.currency === 'BHD')!.balance).toEqual(money('BHD', 10_500n))
    const t = pricedTotal(b, referenceRates(k.market, k.clock.now()), k.clock.now())
    expect(t.total).not.toBeNull()
    expect(t.lines.filter((l) => l.currency !== 'INR').every((l) => l.rate && l.source && l.observedAt)).toBe(true)
    expect(t.rule).toMatch(/rounded once/)
    // the exact sum of every line, rounded once: within half a paisa of the exact total
    const sum = t.lines.reduce((s, l) => { const n = BigInt(l.exact.n), d = BigInt(l.exact.d); return { n: s.n * d + n * s.d, d: s.d * d } }, { n: 0n, d: 1n })
    const diff = t.total!.minor * sum.d - sum.n
    expect((diff < 0n ? -diff : diff) * 2n <= sum.d).toBe(true)
  })

  it('gives no total when a currency has no rate, and says which', () => {
    const k = kitAt()
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'SGD', amount: '10.00', fixed: 'buy' })
    approve(k, q); convertApproved(k.ctx, k.userId, q.approvalId)
    const rates = referenceRates(k.market, k.clock.now())
    rates.delete('SGD')
    const t = pricedTotal(balancesByCurrency(k.db, k.userId), rates, k.clock.now())
    expect(t.total).toBeNull()
    expect(t.why).toMatch(/SGD/)
  })

  it('a refusal is an AppError with a reason the owner reads', () => {
    const k = kitAt()
    try { prepareConversion(k.ctx, k.userId, { sell: 'USD', buy: 'JPY', amount: '1.00', fixed: 'sell' }); expect.unreachable() } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).message).toMatch(/rupees and one other currency/)
    }
  })
})
