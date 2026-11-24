/**
 * Payments abroad on paper routes (R13 section 4; R10-003): a foreign payee with its account checked in its own scheme; a
 * payment with its route, fee, value date and what the payee receives; an unsupported route refused with the reason and
 * never rerouted; India's Liberalised Remittance Scheme ceiling from the RBI text, labelled modelled; tax collected at
 * source not computed without its primary source; a duplicate held for confirmation; the money in transit until its value
 * date, then credited on paper, and the books reconciled with the payment's record. Paper only.
 */
import { describe, expect, it } from 'vitest'
import { abroadTick, addAbroadPayee, ibanWithCheckDigits, isValidAba, isValidIban, payAbroad, paymentView, prepareAbroad, reconcileAbroad, ROUTES, tcsFor, TCS_NOT_COMPUTED, TCS_RULE } from './abroad.ts'
import { confirmApproval } from './approvals.ts'
import { DEFAULT_OPENING } from './household.ts'
import { convertApproved, prepareConversion } from './fx.ts'
import { balance, verifyLedger } from './ledger.ts'
import { makeKit } from './testkit.ts'

/** Wednesday 25 Nov 2026, 10:30 IST: an India business day, before the cut-off. */
const T1 = Date.parse('2026-11-25T05:00:00Z')
type Kit = ReturnType<typeof makeKit>
const kitAt = (opts: Parameters<typeof makeKit>[0] = {}) => makeKit({ start: T1, ...opts })
const approve = (k: Kit, p: { approvalId: string; docHash: string }) => confirmApproval(k.db, k.userId, p.approvalId, { method: 'passkey', docHash: p.docHash }, k.clock.now())
const sums = (k: Kit) => k.db.all<{ asset_id: string; s: string }>('SELECT asset_id, amount_sum(amount_text) s FROM postings GROUP BY asset_id')

const usPayee = (k: Kit) => addAbroadPayee(k.db, k.userId, { name: 'Anita Rao', country: 'US', currency: 'USD', routing: '021000021', account: '123456789' }, k.clock.now())
const jpPayee = (k: Kit) => addAbroadPayee(k.db, k.userId, { name: 'Kenji Sato', country: 'JP', currency: 'JPY', bank: 'MHCBJPJT', account: '1234567' }, k.clock.now())
const bhPayee = (k: Kit) => addAbroadPayee(k.db, k.userId, { name: 'Layla Hasan', country: 'BH', currency: 'BHD', account: ibanWithCheckDigits('BH', 'BMAG00001299123456') }, k.clock.now())

describe('a payee abroad', () => {
  it('checks the account in its own scheme: IBAN check digits, a US routing number\'s checksum, a BIC\'s country', () => {
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true) // the example IBAN widely published for the UK
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(isValidIban('GB82WEST12345698765431')).toBe(false)
    expect(ibanWithCheckDigits('GB', 'WEST12345698765432')).toBe('GB82WEST12345698765432')
    expect(isValidAba('021000021')).toBe(true)
    expect(isValidAba('021000022')).toBe(false)
    const k = kitAt()
    expect(usPayee(k)).toMatchObject({ name: 'Anita Rao', country: 'US', currency: 'USD', scheme: 'aba' })
    expect(() => addAbroadPayee(k.db, k.userId, { name: 'X Y', country: 'GB', currency: 'GBP', account: 'GB82WEST12345698765431' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => addAbroadPayee(k.db, k.userId, { name: 'X Y', country: 'GB', currency: 'GBP', account: 'DE89370400440532013000' }, k.clock.now())).toThrow(/Germany/)
    expect(() => addAbroadPayee(k.db, k.userId, { name: 'X Y', country: 'JP', currency: 'JPY', bank: 'DBSSSGSG', account: '1234567' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => addAbroadPayee(k.db, k.userId, { name: 'X Y', country: 'KW', currency: 'KWD', account: 'KW00' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'currency_not_held' }))
    expect(() => usPayee(k)).toThrow(expect.objectContaining({ code: 'exists' }))
  })
})

describe('a payment abroad on a paper route', () => {
  it('from rupees at a quote: states the route, fee, value date and what the payee receives; in transit, then credited on paper; reconciled', () => {
    const k = kitAt()
    const p = usPayee(k)
    const pv = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '1000.00', purpose: 'family', from: 'INR' })
    const d = JSON.parse(pv.document)
    expect(d).toMatchObject({ v: 2, kind: 'xb-payment', route: { id: 'paper-usd-us' }, receives: { instrument: 'iso4217:USD', exponent: 2, minor: '100000' }, purpose: 'family', timeZone: 'Asia/Kolkata', calendar: 'US' })
    expect(d.quote.fee).toEqual({ instrument: 'iso4217:INR', exponent: 2, minor: '50000' }) // the route's fee, in place of the desk's
    expect(d.valueDate).toBe('2026-11-26')
    expect(d.tcs).toMatchObject({ computed: true, amount: { minor: '0' } }) // ₹1,000 is under the ten-lakh threshold
    expect(pv.lines.map((l) => l.label)).toEqual(expect.arrayContaining(['To', 'Route', 'They receive', 'Rate', 'Reference', 'Spread', 'Fee', 'Tax collected at source', 'Liberalised Remittance Scheme', 'Value date', 'Quote expires']))
    expect(new Set(pv.lines.map((l) => l.label)).size).toBe(pv.lines.length) // each term once on the sheet
    expect(pv.warnings).toEqual([])
    expect(d.acknowledged).toEqual({ belowFloor: false, intoReserve: false })
    approve(k, pv)
    const bankBefore = balance(k.db, k.userId, 'bank')
    const paid = payAbroad(k.ctx, k.userId, pv.approvalId)
    expect(paid).toMatchObject({ state: 'in_transit', amountText: 'USD 1,000.00', valueDate: '2026-11-26', duplicate: false })
    expect(bankBefore - balance(k.db, k.userId, 'bank')).toBe(BigInt(d.quote.sell.minor) + 50_000n)
    expect(balance(k.db, k.userId, 'xb:USD')).toBe(100_000n)
    const rec = reconcileAbroad(k.db, k.userId, paid.id)
    expect(rec).toMatchObject({ state: 'reconciled', breaks: [] })
    // said in money at each currency's precision, never in raw minor units
    expect(rec.checks).toContain('On its way in USD: USD 1,000.00, as recorded')
    expect(rec.checks.join(' ')).not.toMatch(/\d{5,}/)
    // paying the same approval again moves nothing
    expect(payAbroad(k.ctx, k.userId, pv.approvalId)).toMatchObject({ id: paid.id, duplicate: true })
    abroadTick(k.ctx)
    expect(paymentView(k.db, k.userId, paid.id)!.state).toBe('in_transit')
    k.clock.set(Date.parse('2026-11-26T05:00:00Z')) // the value date has begun in New York
    abroadTick(k.ctx); abroadTick(k.ctx)
    const after = paymentView(k.db, k.userId, paid.id)!
    expect(after.state).toBe('credited')
    expect(after.finality).toMatch(/Final on paper/)
    expect(balance(k.db, k.userId, 'xb:USD')).toBe(0n)
    expect(balance(k.db, k.userId, 'exp:abroad:USD')).toBe(100_000n)
    expect(reconcileAbroad(k.db, k.userId, paid.id)).toMatchObject({ state: 'reconciled' })
    for (const s of sums(k)) expect(s.s).toBe('0')
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('from a balance held in the currency, at three precisions: yen, dollars and dinars', () => {
    const k = kitAt()
    for (const [c, amount] of [['JPY', '40000'], ['BHD', '20.000']] as const) {
      const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: c, amount, fixed: 'buy' })
      approve(k, q); convertApproved(k.ctx, k.userId, q.approvalId)
    }
    const jp = jpPayee(k), bh = bhPayee(k)
    const a = prepareAbroad(k.ctx, k.userId, { payeeId: jp.id, amount: '30000', purpose: 'gift', from: 'JPY' })
    expect(JSON.parse(a.document).quote).toBeUndefined()
    expect(JSON.parse(a.document).valueDate).toBe('2026-11-27') // two business days in Tokyo
    approve(k, a); payAbroad(k.ctx, k.userId, a.approvalId)
    const b = prepareAbroad(k.ctx, k.userId, { payeeId: bh.id, amount: '12.345', purpose: 'education', from: 'BHD' })
    approve(k, b); const pb = payAbroad(k.ctx, k.userId, b.approvalId)
    expect(pb.amountText).toBe('BHD 12.345')
    expect(balance(k.db, k.userId, 'bank:JPY')).toBe(10_000n)
    expect(balance(k.db, k.userId, 'bank:BHD')).toBe(7_655n)
    expect(() => prepareAbroad(k.ctx, k.userId, { payeeId: jp.id, amount: '1.5', purpose: 'gift', from: 'JPY' })).toThrow(expect.objectContaining({ code: 'invalid' }))
    for (const s of sums(k)) expect(s.s).toBe('0')
  })

  it('refuses an unsupported route with its reason, and never reroutes it', () => {
    const k = kitAt()
    const de = addAbroadPayee(k.db, k.userId, { name: 'Jonas Weber', country: 'DE', currency: 'USD', account: 'DE89370400440532013000' }, k.clock.now())
    try { prepareAbroad(k.ctx, k.userId, { payeeId: de.id, amount: '10.00', purpose: 'family', from: 'INR' }); expect.unreachable() } catch (e) {
      expect(e).toMatchObject({ code: 'route_not_offered' })
      expect((e as Error).message).toMatch(/No paper route sends USD to Germany.*does not change the route or the currency/)
    }
    const us = usPayee(k)
    expect(() => prepareAbroad(k.ctx, k.userId, { payeeId: us.id, amount: '10.00', purpose: 'margin', from: 'INR' })).toThrow(/margins or margin calls.*RBI/)
    expect(() => prepareAbroad(k.ctx, k.userId, { payeeId: us.id, amount: '10.00', purpose: 'investment', from: 'INR' })).toThrow(expect.objectContaining({ code: 'purpose_not_offered' }))
    expect(() => prepareAbroad(k.ctx, k.userId, { payeeId: us.id, amount: '10.00', purpose: 'lottery', from: 'INR' })).toThrow(expect.objectContaining({ code: 'purpose_not_offered' }))
    expect(() => prepareAbroad(k.ctx, k.userId, { payeeId: us.id, amount: '10.00', purpose: 'family', from: 'EUR' })).toThrow(expect.objectContaining({ code: 'route_not_offered' }))
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals')!.n).toBe(0)
    for (const r of ROUTES) expect(r.offer.offeredIn).toEqual(['IN'])
    const uk = makeKit({ start: T1, profile: { jurisdiction: 'UK' } })
    const p = usPayee(uk)
    expect(() => prepareAbroad(uk.ctx, uk.userId, { payeeId: p.id, amount: '10.00', purpose: 'family', from: 'INR' })).toThrow(expect.objectContaining({ code: 'not_offered_here' }))
  })

  it('refuses what would pass the Liberalised Remittance Scheme\'s ceiling for the financial year, citing the RBI text', () => {
    const k = kitAt({ opening: { ...DEFAULT_OPENING, bank: 4_000_000_000 } }) // ₹4 crore of paper money
    const p = usPayee(k)
    const first = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '200000.00', purpose: 'education', from: 'INR' })
    approve(k, first); payAbroad(k.ctx, k.userId, first.approvalId)
    try { prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '50000.01', purpose: 'education', from: 'INR' }); expect.unreachable() } catch (e) {
      expect(e).toMatchObject({ code: 'lrs_ceiling' })
      expect((e as Error).message).toMatch(/USD 2,50,000\.01.*Liberalised Remittance Scheme.*RBI.*6 Sep 2024.*not advice/)
    }
    expect(prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '50000.00', purpose: 'education', from: 'INR' }).approvalId).toBeTruthy()
  })

  it('holds a duplicate of a recent payment for the owner\'s confirmation, and goes only once confirmed', () => {
    const k = kitAt()
    const p = usPayee(k)
    const one = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.00', purpose: 'gift', from: 'INR' })
    approve(k, one); const first = payAbroad(k.ctx, k.userId, one.approvalId)
    k.clock.advance(3_600_000)
    let held: unknown
    try { prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.00', purpose: 'gift', from: 'INR' }) } catch (e) { held = e }
    expect(held).toMatchObject({ status: 409, code: 'held_duplicate', fields: { duplicateOf: first.id } })
    expect((held as Error).message).toMatch(/Held for your confirmation.*USD 100\.00 to Anita Rao/)
    const two = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.00', purpose: 'gift', from: 'INR', confirmDuplicateOf: first.id })
    expect(JSON.parse(two.document).confirmedNotDuplicateOf).toBe(first.id)
    approve(k, two)
    expect(payAbroad(k.ctx, k.userId, two.approvalId)).toMatchObject({ duplicateOf: first.id })
    // a different amount is not a duplicate; nor is the same one a day later
    expect(prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.01', purpose: 'gift', from: 'INR' }).approvalId).toBeTruthy()
    k.clock.advance(24 * 3_600_000 + 1) // the window's edge counts (the domestic rule, duplicates.ts), so one millisecond past it
    expect(prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.00', purpose: 'gift', from: 'INR' }).approvalId).toBeTruthy()
  })

  it('a duplicate approved twice in parallel is held at the moment of paying, not only when previewed', () => {
    const k = kitAt()
    const p = usPayee(k)
    const a = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '75.00', purpose: 'gift', from: 'INR' })
    const b = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '75.00', purpose: 'gift', from: 'INR' })
    approve(k, a); approve(k, b)
    payAbroad(k.ctx, k.userId, a.approvalId)
    expect(() => payAbroad(k.ctx, k.userId, b.approvalId)).toThrow(expect.objectContaining({ code: 'held_duplicate' }))
    expect(balance(k.db, k.userId, 'xb:USD')).toBe(7_500n)
  })

  it('refuses an expired quote for a payment, and moves nothing', () => {
    const k = kitAt()
    const p = usPayee(k)
    const pv = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '10.00', purpose: 'travel', from: 'INR' })
    approve(k, pv)
    k.clock.advance(61_000)
    expect(() => payAbroad(k.ctx, k.userId, pv.approvalId)).toThrow(expect.objectContaining({ code: 'quote_expired' }))
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM xb_payments')!.n).toBe(0)
  })
})

describe('tax collected at source', () => {
  it('records the Income-tax Act 2025 rule as read in the Gazette: ten lakh rupees, 2% for education and medical (Finance Act 2026), 20% otherwise', () => {
    expect(TCS_RULE).not.toBeNull()
    expect(TCS_RULE!.thresholdPaise).toBe(100_000_000n)
    expect(TCS_RULE!.rateBps).toEqual({ education: 200, medical: 200, family: 2_000, gift: 2_000, travel: 2_000 })
    expect(TCS_RULE!.effectiveFromMs).toBe(Date.parse('2026-03-31T18:30:00Z')) // 1 April 2026, 00:00 IST
    expect(TCS_RULE!.source).toMatch(/section 394\(1\).*Sl\. No\. 7.*Finance Act 2026, section 85\(e\)/)
  })

  it('charges the rate only on what passes ten lakh rupees in the year, at the rate of the purpose', () => {
    const k = kitAt()
    const now = k.clock.now()
    expect(tcsFor(k.db, k.userId, 'education', 100_000_000n, now)).toMatchObject({ computed: true, paise: 0n }) // exactly ₹10,00,000: not exceeding
    expect(tcsFor(k.db, k.userId, 'education', 120_000_000n, now)).toMatchObject({ computed: true, paise: 400_000n }) // 2% of ₹2,00,000
    expect(tcsFor(k.db, k.userId, 'medical', 120_000_000n, now)).toMatchObject({ computed: true, paise: 400_000n })
    expect(tcsFor(k.db, k.userId, 'family', 120_000_000n, now)).toMatchObject({ computed: true, paise: 4_000_000n }) // 20% of ₹2,00,000
    expect(tcsFor(k.db, k.userId, 'gift', 120_000_000n, now)).toMatchObject({ computed: true, paise: 4_000_000n })
    expect(tcsFor(k.db, k.userId, 'travel', 100_000_001n, now)).toMatchObject({ computed: true, paise: 1n }) // 20% of one paisa, rounded up
    expect(tcsFor(k.db, k.userId, 'investment', 120_000_000n, now)).toMatchObject({ computed: false })
  })

  it('does not compute a payment before 1 April 2026, and says which rule it holds and that the earlier Act is not recorded', () => {
    const k = kitAt()
    const r = tcsFor(k.db, k.userId, 'family', 120_000_000n, Date.parse('2026-03-31T10:00:00Z'))
    expect(r).toMatchObject({ computed: false })
    expect((r as { why: string }).why).toMatch(/before 2026-04-01.*Income-tax Act 2025.*1961 Act.*not recorded/)
    expect(TCS_NOT_COMPUTED).toMatch(/not computed.*Income-tax Act 2025.*from 1 April 2026.*not tax or legal advice/)
  })

  it('collects it on a payment abroad that passes the threshold, books it to the tcs account, and the books reconcile', () => {
    const k = kitAt({ opening: { ...DEFAULT_OPENING, bank: 4_000_000_000 } })
    const p = usPayee(k)
    const pv = prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '15000.00', purpose: 'family', from: 'INR' })
    const d = JSON.parse(pv.document)
    expect(d.tcs.computed).toBe(true)
    expect(BigInt(d.tcs.amount.minor)).toBeGreaterThan(0n)
    approve(k, pv)
    const paid = payAbroad(k.ctx, k.userId, pv.approvalId)
    expect(balance(k.db, k.userId, 'tcs')).toBe(BigInt(d.tcs.amount.minor))
    expect(reconcileAbroad(k.db, k.userId, paid.id)).toMatchObject({ state: 'reconciled' })
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
})
