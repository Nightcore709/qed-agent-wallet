/**
 * A payee that is new (R12 task comparison, gap 4, criteria T2-c and T2-e; and its first-payment caution).
 *
 *   - The caution "Added today, and never paid before. Check the address with them yourself before you send." is in the
 *     payment's signed terms, shown on the sheet, not only under the payee.
 *   - What goes to a payee in its first 24 hours waits, once it comes to more than the household's amount (₹10,000 unless
 *     changed in Safeguards): the payment waits a stated time (24 hours unless changed) before it is sent. The reason and
 *     the time it is sent are in the terms the passkey signs. Splitting a payment does not get round it: what has gone, or
 *     is on its way, to the payee since it was added counts.
 *   - The paper bank's name check is a line of every payment's terms to a payee.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { whenIst } from './core.ts'
import { getProfile, saveProfile } from './household.ts'
import { DEFAULT_HOLD_ABOVE, DEFAULT_HOLD_HOURS, holdFor, NEW_FOR_MS, testHoldMs } from './new-payee.ts'
import { addBill, addPayee, previewAction } from './owner.ts'
import { makeKit, T0 } from './testkit.ts'

const H = 3600_000
type Doc = { action: { params: { hold?: { until: number; why: string } } }; warnings: string[]; estimate: { label: string; value: string; note?: string }[] }
const newPayee = (k: ReturnType<typeof makeKit>, name = 'Ravi Kumar', handle = 'ravi.kumar@upi') => addPayee(k.db, k.userId, { name, handle, category: 'family' }, k.clock.now())
const actionTo = (k: ReturnType<typeof makeKit>, handle: string, amount: number, state: string) => k.db.run(`INSERT INTO actions (id, user_id, origin, kind, venue, economic_id, state, params_json, created_at, updated_at) VALUES (?, ?, 'owner', 'payment', 'paper-rail', ?, ?, ?, ?, ?)`,
  `act_${state}_${amount}_${Math.random().toString(36).slice(2)}`, k.userId, `e_${Math.random().toString(36).slice(2)}`, state, JSON.stringify({ payeeHandle: handle, payeeName: 'x', amount: String(amount), purpose: 'spend' }), k.clock.now(), k.clock.now())

describe('the rule: what goes to a payee in its first 24 hours waits, once it comes to more than the household\'s amount', () => {
  const envBefore = { stack: process.env.QED_TEST_STACK, sec: process.env.QED_NEW_PAYEE_HOLD_SEC }
  afterEach(() => { for (const [k, v] of [['QED_TEST_STACK', envBefore.stack], ['QED_NEW_PAYEE_HOLD_SEC', envBefore.sec]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v })

  it('defaults to ₹10,000 and 24 hours, as the household\'s own settings', () => {
    const k = makeKit()
    expect([DEFAULT_HOLD_ABOVE, DEFAULT_HOLD_HOURS, NEW_FOR_MS]).toEqual([1_000_000, 24, 24 * H])
    expect(getProfile(k.db, k.userId)).toMatchObject({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24 })
  })

  it('more than the amount waits; exactly the amount does not; a payee a day old is no longer new', () => {
    const k = makeKit(); newPayee(k)
    const p = getProfile(k.db, k.userId)
    expect(holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 1_000_000n, k.clock.now())).toBeNull()
    const h = holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 1_000_100n, k.clock.now())!
    expect(h.until).toBe(k.clock.now() + 24 * H)
    expect(h.why).toMatch(/^Ravi Kumar was added today at 10:30, and in a payee's first 24 hours what you send it above ₹10,000 waits 24 hours before it is sent, as set in Safeguards\.$/)
    k.clock.advance(NEW_FOR_MS - 1)
    expect(holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 5_000_000n, k.clock.now())).not.toBeNull()
    k.clock.advance(1)
    expect(holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 5_000_000n, k.clock.now())).toBeNull()
  })

  it('splitting does not get round it: what has gone or is on its way since the payee was added counts; what failed or was cancelled does not', () => {
    const k = makeKit(); newPayee(k)
    const p = getProfile(k.db, k.userId)
    actionTo(k, 'ravi.kumar@upi', 600_000, 'done')
    actionTo(k, 'ravi.kumar@upi', 900_000, 'failed'); actionTo(k, 'ravi.kumar@upi', 900_000, 'cancelled'); actionTo(k, 'ravi.kumar@upi', 900_000, 'blocked')
    expect(holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 400_000n, k.clock.now())).toBeNull()
    const h = holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 400_100n, k.clock.now())!
    expect(h.why).toMatch(/With the ₹6,000 already paid or on its way to Ravi Kumar since then, this comes to ₹10,001\./)
    actionTo(k, 'ravi.kumar@upi', 100_000, 'held')
    expect(holdFor(k.db, k.userId, p, 'ravi.kumar@upi', 300_100n, k.clock.now())).not.toBeNull()
  })

  it('never applies to the household\'s own accounts at its bank', () => {
    const k = makeKit()
    expect(holdFor(k.db, k.userId, getProfile(k.db, k.userId), 'card@paperbank', 99_00_000n, k.clock.now())).toBeNull()
  })

  it('the household\'s amount and wait are its own: a lower amount and a longer wait apply to the next payment', () => {
    const k = makeKit(); newPayee(k)
    saveProfile(k.db, k.userId, { newPayeeHoldAbove: 0, newPayeeHoldHours: 48 })
    const h = holdFor(k.db, k.userId, getProfile(k.db, k.userId), 'ravi.kumar@upi', 100n, k.clock.now())!
    expect(h.until).toBe(k.clock.now() + 48 * H)
    expect(h.why).toMatch(/above ₹0 waits 48 hours before it is sent/)
  })

  it('a test stack, and only a test stack, may shorten the wait, and it says so', () => {
    process.env.QED_NEW_PAYEE_HOLD_SEC = '20'
    delete process.env.QED_TEST_STACK
    expect(testHoldMs()).toBeNull()
    process.env.QED_TEST_STACK = '1'
    expect(testHoldMs()).toBe(20_000)
    const k = makeKit(); newPayee(k)
    const h = holdFor(k.db, k.userId, getProfile(k.db, k.userId), 'ravi.kumar@upi', 5_000_000n, k.clock.now())!
    expect(h.until).toBe(k.clock.now() + 20_000)
    expect(h.why).toMatch(/waits 20 seconds \(shortened on this test installation; set to 24 hours\)/)
  })

  it('the settings are checked: a whole amount from nothing upwards, and a wait from the list', () => {
    const k = makeKit()
    expect(() => saveProfile(k.db, k.userId, { newPayeeHoldHours: 5 })).toThrow(/not valid/)
    expect(() => saveProfile(k.db, k.userId, { newPayeeHoldAbove: -1 })).toThrow(/not valid/)
    expect(() => saveProfile(k.db, k.userId, { newPayeeHoldAbove: 1.5 })).toThrow(/not valid/)
  })
})

describe('the payment\'s terms: the name check, the first-payment caution, and the wait with its reason', () => {
  it('a first payment above the amount to a payee added today waits; its time and reason are in what the passkey signs', async () => {
    const k = makeKit()
    // added with the name the household typed, after confirming the close match the paper bank answered
    const y = addPayee(k.db, k.userId, { name: 'Ravi Kumaar', handle: 'ravi.kumar@upi', category: 'family', nameCheckAccepted: 'close' }, k.clock.now())
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 1_500_000 })
    const doc = JSON.parse(pv.document) as Doc
    const until = T0 + 24 * H
    // bound to the payee it was signed for (R13 section 4): one removed, added again or renamed while it waits is not paid
    expect(doc.action.params.hold).toEqual({ until, why: expect.stringMatching(/^Ravi Kumaar was added today at 10:30, /), payeeId: expect.stringMatching(/^pye_/) })
    expect(pv.lines.map((l) => l.label).slice(0, 4)).toEqual(['To', 'Name check', 'Leaves your bank', 'Sent'])
    expect(pv.lines.find((l) => l.label === 'Name check')?.value).toBe('Close match: the paper bank holds Ravi Kumar for this address')
    expect(pv.lines.find((l) => l.label === 'Sent')).toMatchObject({ value: `Not before ${whenIst(until)}`, basis: 'exact', note: expect.stringMatching(/The money is set aside from when you approve until then/) })
    expect(pv.lines.at(-1)).toMatchObject({ label: 'Once you approve', value: `It waits until ${whenIst(until)}, then leaves your bank on paper` })
    expect(pv.warnings).toContain('Added today, and never paid before. Check the address with them yourself before you send.')
    expect(pv.warnings.find((w) => /^It is sent at /.test(w))).toBe(`It is sent at ${whenIst(until)}, not before: Ravi Kumaar was added today at 10:30, and in a payee's first 24 hours what you send it above ₹10,000 waits 24 hours before it is sent, as set in Safeguards. Until then you can cancel it on its record.`)
    expect(doc.warnings).toEqual(pv.warnings)
    expect(doc.estimate).toEqual(pv.lines)
  })

  it('a small first payment does not wait, but still carries the caution and the name check', async () => {
    const k = makeKit(); const y = newPayee(k)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 50_000 })
    const doc = JSON.parse(pv.document) as Doc
    expect(doc.action.params.hold).toBeUndefined()
    expect(pv.lines.find((l) => l.label === 'Sent')).toBeUndefined()
    expect(pv.lines.find((l) => l.label === 'Name check')?.value).toBe('Matches the name the paper bank holds for this address: Ravi Kumar')
    expect(pv.warnings).toContain('Added today, and never paid before. Check the address with them yourself before you send.')
  })

  it('the caution says yesterday across midnight, and only "not paid before" once the payee is older', async () => {
    const k = makeKit({ start: Date.parse('2026-11-18T18:00:00Z') }) // 23:30 IST
    const y = newPayee(k)
    k.clock.advance(H) // 00:30 IST the next day
    expect((await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 50_000 })).warnings).toContain('Added yesterday, and never paid before. Check the address with them yourself before you send.')
    k.clock.advance(24 * H)
    expect((await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 50_000 })).warnings).toContain('You have not paid this payee before. Check the address with them yourself before you send.')
  })

  it('a payee paid before carries no caution', async () => {
    const k = makeKit(); const y = newPayee(k)
    actionTo(k, 'ravi.kumar@upi', 50_000, 'done')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 50_000 })
    expect(pv.warnings.filter((w) => /never paid|not paid this payee/.test(w))).toEqual([])
  })

  it('a bill from a new payee, paid by hand, waits the same way', async () => {
    const k = makeKit(); const y = newPayee(k)
    const bill = addBill(k.db, k.userId, { payeeId: y.id, amount: 1_200_000, dueAt: k.clock.now() + 3 * 24 * H, memo: 'Deposit' }, k.clock.now())
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', billId: bill.id, amount: 1_200_000 })
    expect((JSON.parse(pv.document) as Doc).action.params.hold?.until).toBe(T0 + 24 * H)
    expect(pv.lines.at(-1)?.value).toBe(`It waits until ${whenIst(T0 + 24 * H)}, then leaves your bank on paper, and the bill is marked paid when the payment settles`)
  })

  it('a payee added before names were checked says so in the terms', async () => {
    const k = makeKit()
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pye_old', ?, 'Old Landlord', 'old.landlord@upi', 'rent', ?)`, k.userId, k.clock.now() - 40 * 24 * H)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: 'pye_old', amount: 50_000 })
    expect(pv.lines.find((l) => l.label === 'Name check')?.value).toBe('Not checked: this payee was added before QED checked names')
  })
})
