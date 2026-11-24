/**
 * The payment journey (src/screens/Pay.tsx) shows the route, when the money arrives, the charge and what stays free
 * before the server prepares the terms; the approval sheet then shows the server's own figures. These tests hold the
 * journey's rules to the server's, on the real server in memory (server/testkit.ts), so that the sheet opens with the
 * figures the journey showed: the same rail for every amount and preference, read from the same terms register
 * (PaperRail.chooseRail); the same words for the route and its timing (previewAction's "Sent by" line); the same
 * prepayment charge; and the same answer to "what stays free" and "does this take money kept for what is due" as the
 * reserve check (staysLiquid) and the approval document's acknowledgement.
 */
import { describe, expect, it } from 'vitest'
import { liquidity, staysLiquid } from '../../server/liquidity.ts'
import { previewAction } from '../../server/owner.ts'
import { type Kit, makeKit } from '../../server/testkit.ts'
import { ARRIVES, chargeFor, freeAfter, newPayeeRule, RAIL_NAME, railLimits, routeFor, sentTo } from './Pay.tsx'
import { HOLD_CHOICES } from './Safeguards.tsx'
import { HOLD_HOURS } from '../../server/new-payee.ts'
import type { ActionView } from '../lib/types.ts'

const DAY = 86_400_000
const termsOf = (k: Kit) => k.db.all<{ id: string; value_json: string }>('SELECT id, value_json FROM terms').map((t) => ({ id: t.id, value: JSON.parse(t.value_json) as Record<string, unknown> }))
/** A payee the household has had for a month: these tests are about the route and the reserve, not a new payee's first day. */
const payee = (k: Kit, handle: string): string => { const id = `pye_${handle.replace(/\W/g, '')}`; k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, 'Corner Shop', handle, 'shopping', k.clock.now() - 30 * DAY, k.clock.now()); return id }
const paise = (text: string): number => Math.round(Number(text.replace(/[₹,\s]/g, '')) * 100)

describe('the route a payment takes, before the terms are prepared', () => {
  it('is the server rail\'s own choice for every amount, preference and kind of payee, from the same register', () => {
    const k = makeKit()
    for (const upi of [10_000_000, 5_000_000]) {
      // the register drives both: a lower UPI limit on record moves the same amounts to IMPS on both sides
      k.db.run("UPDATE terms SET value_json = ? WHERE id = 'rail.upi.limit'", JSON.stringify({ amount: upi }))
      const lim = railLimits(termsOf(k))
      for (const amount of [1, 100, 4_999_999, 5_000_000, 5_000_001, 9_999_999, 10_000_000, 10_000_001, 19_999_999, 20_000_000, 20_000_001, 49_999_999, 50_000_000, 50_000_001, 900_000_000]) {
        for (const preferred of ['', 'upi', 'imps', 'neft', 'rtgs']) {
          for (const own of [false, true]) {
            const server = k.venues.rail.chooseRail(BigInt(amount), own ? 'card@paperbank' : 'shop@okbank', preferred ? (preferred as 'upi') : undefined)
            expect(routeFor(amount, own, preferred, lim), `${amount} paise, ${preferred || 'QED chooses'}, ${own ? 'own account' : 'payee'}`).toEqual(server.error ? { rail: server.rail, error: server.error } : { rail: server.rail })
          }
        }
      }
    }
  })

  it('reads the server\'s defaults when the register cannot be read', () => {
    expect(railLimits(undefined)).toEqual({ upi: 10_000_000, imps: 50_000_000, rtgsMin: 20_000_000 })
  })

  it('is named, with when it arrives, in the words of the terms the passkey signs', async () => {
    const k = makeKit()
    const lim = railLimits(termsOf(k))
    const to = payee(k, 'corner@okbank')
    for (const [amount, rail] of [[245_000, ''], [15_000_000, ''], [245_000, 'neft'], [30_000_000, 'rtgs'], [245_000, 'imps']] as const) {
      const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: to, amount, ...(rail ? { rail } : {}) })
      const r = routeFor(amount, false, rail, lim)
      const sent = pv.lines.find((l) => l.label === 'Sent by')!
      expect(sent.value, `${amount} ${rail}`).toBe(RAIL_NAME[r.rail])
      expect(sent.note!.startsWith(`${ARRIVES[r.rail]}.`), sent.note).toBe(true)
      expect(paise(pv.lines.find((l) => l.label === 'Leaves your bank')!.value)).toBe(amount)
    }
    const card = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'card', amount: 100_000 })
    const sent = card.lines.find((l) => l.label === 'Sent by')!
    expect(sent.value).toBe(RAIL_NAME[routeFor(100_000, true, '', lim).rail])
    expect(sent.note!.startsWith(`${ARRIVES.internal}.`)).toBe(true)
  })
})

describe('the charge on prepaying the personal loan', () => {
  it('is the server\'s, to the paisa, and what leaves the bank includes it', async () => {
    const k = makeKit()
    const terms = termsOf(k)
    for (const amount of [100_000, 33_333, 1_234_567]) {
      const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'loan:personal', amount })
      const charge = chargeFor('loan:personal', amount, terms)
      expect(paise(pv.lines.find((l) => l.label === 'Prepayment charge')!.value), String(amount)).toBe(charge)
      expect(paise(pv.lines.find((l) => l.label === 'Leaves your bank')!.value)).toBe(amount + charge)
    }
    expect(chargeFor('spend', 100_000, terms)).toBe(0)
    expect(chargeFor('loan:home', 100_000, terms)).toBe(0)
    expect(chargeFor('loan:personal', 33_333, [{ id: 'rate.loan.personal', value: { prepayCharge: '0.02' } }])).toBe(667)
  })
})

describe('what stays free after a payment by hand', () => {
  it('is what the reserve check leaves: free money first, then money kept for what is due', () => {
    const k = makeKit()
    const now = k.clock.now()
    const l = liquidity(k.db, k.userId, now)
    const free = l.free, kept = Math.min(l.available, l.need)
    expect(free).toBeGreaterThan(0)
    for (const out of [1, Math.floor(free / 2), free, free + 1, free + Math.floor(kept / 2), free + kept]) {
      const a = freeAfter(free, kept, out)
      const s = staysLiquid(k.db, k.userId, now, out)
      expect(s.ok, `${out}: takes nothing kept`).toBe(a.fromKept === 0)
      expect(s.leftAfter - Math.min(s.leftAfter, s.needAfter), `${out}: free after`).toBe(a.free)
      expect(Math.min(s.leftAfter, s.needAfter), `${out}: kept after`).toBe(a.kept)
      expect(a.fromFree + a.fromKept).toBe(out)
    }
  })

  it('takes money kept for what is due exactly when the terms say the owner accepted it', async () => {
    const k = makeKit()
    const to = payee(k, 'corner@okbank')
    const l = liquidity(k.db, k.userId, k.clock.now())
    for (const amount of [l.free, l.free + 100]) {
      const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: to, amount })
      const doc = JSON.parse(pv.document) as { acknowledged: { intoReserve: boolean }; basis: string[] }
      expect(doc.acknowledged.intoReserve, String(amount)).toBe(freeAfter(l.free, Math.min(l.available, l.need), amount).fromKept > 0)
      // the sheet's "Your bank" row is this sentence of the signed document
      expect(doc.basis.some((b) => b.startsWith('Bank reserve: '))).toBe(true)
    }
  })

  it('is not used to pay a bill already counted in what is kept, which is paid from money kept for it', () => {
    const k = makeKit()
    const to = payee(k, 'power@okbank')
    const due = k.clock.now() + 2 * DAY, id = 'bil_test'
    k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, '', 'due', ?)", id, k.userId, to, 245_000, due, k.clock.now())
    const l = liquidity(k.db, k.userId, k.clock.now())
    // the journey says so when the bill falls due by the date what is kept is worked out to
    expect(new Date(due + 19_800_000).toISOString().slice(0, 10) <= l.binding!.date).toBe(true)
    const s = staysLiquid(k.db, k.userId, k.clock.now(), 245_000, { paysBillId: id })
    expect(s.ok).toBe(true)
    expect(s.leftAfter - s.needAfter).toBe(l.free)
  })

  it('never goes below nothing, and takes no more than there is', () => {
    expect(freeAfter(1000, 500, 0)).toEqual({ fromFree: 0, fromKept: 0, free: 1000, kept: 500 })
    expect(freeAfter(1000, 500, 1200)).toEqual({ fromFree: 1000, fromKept: 200, free: 0, kept: 300 })
    expect(freeAfter(1000, 500, 5000)).toEqual({ fromFree: 1000, fromKept: 500, free: 0, kept: 0 })
    expect(freeAfter(0, 500, 100)).toEqual({ fromFree: 0, fromKept: 100, free: 0, kept: 400 })
    expect(freeAfter(1000, 500, -5)).toEqual({ fromFree: 0, fromKept: 0, free: 1000, kept: 500 })
  })
})

describe('a new payee\'s first day, as Spend and Safeguards say it (server/new-payee.ts decides)', () => {
  it('Safeguards offers exactly the waits the server accepts', () => {
    expect([...HOLD_CHOICES]).toEqual([...HOLD_HOURS])
  })
  it('counts what has gone or is on its way to the payee as the server does, leaving out what ended with nothing sent', () => {
    const pay = (state: string, amount: number, payeeHandle = 'ravi.kumar@upi') => ({ kind: 'payment', state, params: { payeeHandle, amount: String(amount) } }) as unknown as ActionView
    expect(sentTo([pay('done', 600_000), pay('held', 100_000), pay('working', 50_000), pay('failed', 900_000), pay('cancelled', 900_000), pay('blocked', 1), pay('done', 7, 'other@upi')], 'ravi.kumar@upi')).toBe(750_000)
  })
  it('says the household\'s amount and wait, and a test stack\'s shortened wait as such', () => {
    expect(newPayeeRule({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24 }, null)).toEqual({ above: 1_000_000, wait: '24 hours', short: '24 hours', off: false })
    expect(newPayeeRule({ newPayeeHoldAbove: 0, newPayeeHoldHours: 1 }, 20_000)).toEqual({ above: 0, wait: '20 seconds (shortened on this test installation; set to 1 hour)', short: '20 seconds', off: false })
    // switched off in Safeguards: nothing waits, whatever a test stack's shortening says
    expect(newPayeeRule({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 0 }, 20_000)).toMatchObject({ off: true })
  })
})
