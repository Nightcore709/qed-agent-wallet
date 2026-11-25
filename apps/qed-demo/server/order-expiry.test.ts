/**
 * How long a resting order stands (R14, capability 13). The owner chooses until cancelled, until the end of the day, or until
 * a time within 90 days; the choice is inside the document the passkey signs; the engine ends the order when its time comes,
 * on its tick and on start-up, frees exactly what was still reserved, once, and says so in plain words. A fill and the expiry
 * can never both apply. Orders that existed before this stay good until cancelled.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { istInstant } from './core.ts'
import { DEFAULT_OPENING } from './household.ts'
import { cancelAction, getAction, settleOrder, stepAllActions } from './execute.ts'
import { available, balance, verifyLedger } from './ledger.ts'
import { previewAction, submitApprovedAction } from './owner.ts'
import { amountText } from './programs.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'
import { TERMINAL_ORDER, PaperCryptoVenue } from './venues.ts'

const BANK = BigInt(DEFAULT_OPENING.bank)
const ID = 'coindcx:BTCINR'
const LIMIT = { kind: 'order', instrumentId: ID, side: 'buy', type: 'limit', amount: 500_000, limitPrice: '6500000' }
const UNTIL_11 = { validity: 'until', untilDate: '2026-11-18', untilTime: '11:00' } // 30 minutes after T0
const EXPIRES_11 = istInstant('2026-11-18', '11:00')

type Doc = { action: { params: Record<string, unknown> } }

async function rest(k: Kit, extra: Record<string, unknown> = {}, amount = 500_000) {
  const pv = await previewAction(k.ctx, k.userId, { ...LIMIT, amount, ...extra })
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  return { pv, act: submitApprovedAction(k.ctx, k.userId, pv.approvalId) }
}
/** What the engine does in one pass (engine.ts): act on what is due, tick the venue, act on what the venue says. */
async function pass(k: Kit): Promise<void> {
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick()
  await stepAllActions(k.ctx)
}
const sound = (k: Kit) => expect(verifyLedger(k.db, k.userId)).toEqual([])
const count = (k: Kit, sql: string, ...a: string[]): number => k.db.get<{ n: number }>(sql, ...a)!.n
const notices = (k: Kit) => k.db.all<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE kind = 'order-expired'`)

describe('the validity an owner chooses', () => {
  it('is signed: until cancelled, the end of the day, or a time, each inside the approved document', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const gtc = JSON.parse((await previewAction(k.ctx, k.userId, LIMIT)).document) as Doc
    expect(gtc.action.params.validity).toEqual({ kind: 'gtc' })
    const day = JSON.parse((await previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'day' })).document) as Doc
    expect(day.action.params.validity).toEqual({ kind: 'day', expiresAt: istInstant('2026-11-19', '00:00') })
    const until = JSON.parse((await previewAction(k.ctx, k.userId, { ...LIMIT, ...UNTIL_11 })).document) as Doc
    expect(until.action.params.validity).toEqual({ kind: 'until', expiresAt: EXPIRES_11 })
  })
  it('a different expiry is a different document, and editing it after signing stops the order', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const a = await previewAction(k.ctx, k.userId, { ...LIMIT, ...UNTIL_11 })
    const b = await previewAction(k.ctx, k.userId, { ...LIMIT, ...UNTIL_11, untilTime: '12:00' })
    const c = await previewAction(k.ctx, k.userId, LIMIT)
    expect(new Set([a.docHash, b.docHash, c.docHash]).size).toBe(3)
    confirmApproval(k.db, k.userId, a.approvalId, { method: 'passkey', docHash: a.docHash }, k.clock.now())
    const d = JSON.parse(a.document) as Doc
    d.action.params.validity = { kind: 'gtc' }
    k.db.run('UPDATE approvals SET document = ? WHERE id = ?', JSON.stringify(d), a.approvalId)
    expect(() => submitApprovedAction(k.ctx, k.userId, a.approvalId)).toThrow(/does not match its hash/)
    expect(count(k, 'SELECT COUNT(*) n FROM actions')).toBe(0)
  })
  it('the sheet says in words how long it stands', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, { ...LIMIT, ...UNTIL_11 })
    expect(pv.lines.find((l) => l.label === 'Stands until')?.value).toMatch(/18 Nov 2026, 11:00 IST/)
    expect((await previewAction(k.ctx, k.userId, LIMIT)).lines.find((l) => l.label === 'Stands until')?.value).toMatch(/cancel/i)
  })
  it('must be in the future, within 90 days, well formed, and only for an order that rests', async () => {
    const k = makeKit(); k.btc(6_600_000)
    await expect(previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'until', untilDate: '2026-11-18', untilTime: '10:00' })).rejects.toThrow(/future/)
    await expect(previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'until', untilDate: '2027-02-17', untilTime: '10:31' })).rejects.toThrow(/90 days/)
    await expect(previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'until', untilDate: '2026-13-40', untilTime: '25:99' })).rejects.toThrow(/date and time/)
    for (const untilDate of ['2026-13-01', '2026-02-32', '2026-02-30', '2026-00-10', '2026-11-00']) {
      await expect(previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'until', untilDate, untilTime: '11:00' })).rejects.toMatchObject({ status: 400 })
    }
    await expect(previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'forever' })).rejects.toThrow(/Choose how long/)
    await expect(previewAction(k.ctx, k.userId, { ...LIMIT, type: 'market', limitPrice: undefined, ...UNTIL_11 })).rejects.toThrow(/resting/)
    // the last allowed minute is allowed
    const ok = await previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'until', untilDate: '2027-02-16', untilTime: '10:30' })
    expect((JSON.parse(ok.document) as Doc).action.params.validity).toMatchObject({ kind: 'until' })
  })
})

describe('a validity on an order that cannot rest', () => {
  it('is refused for a coin market order, a fund, a share and an ETF alike, and a plain until-cancelled is not', async () => {
    const k = makeKit(); k.btc(6_600_000)
    for (const id of ['amfi:120716', 'xchg:NIFTYBEES', 'gsec:TB91']) {
      await expect(previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: id, side: 'buy', amount: 500_000, validity: 'day' })).rejects.toThrow(/resting/)
      await expect(previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: id, side: 'buy', amount: 500_000, validity: 'forever' })).rejects.toThrow(/Choose how long/)
    }
  })
})

describe('an order that stands until a time', () => {
  it('untouched: expires at its time, frees the whole reservation, says so, reconciles', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('working')
    expect(available(k.db, k.userId, 'bank')).toBe(BANK - 500_000n)
    k.clock.set(EXPIRES_11 - 1); await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('working')
    k.clock.set(EXPIRES_11); await pass(k)
    const done = getAction(k.db, act.id)!
    expect(done.state).toBe('expired')
    expect(k.venues.crypto.get(done.economic_id)!.state).toBe('expired')
    expect(available(k.db, k.userId, 'bank')).toBe(BANK)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(done.recon_state).toBe('reconciled')
    expect(done.receipt_id).not.toBeNull()
    expect(done.error).toMatch(/nothing had filled/i)
    const n = notices(k)
    expect(n).toHaveLength(1)
    expect(n[0]!.body).toContain('Nothing had filled')
    expect(n[0]!.body).toContain(amountText(500_000, 2))
    expect(n[0]!.body).toMatch(/free again/)
    expect(done.result).toMatchObject({ expired: true, releasedPaise: '500000', expiredAt: EXPIRES_11 })
    expect(count(k, `SELECT COUNT(*) n FROM audit WHERE action = 'action.expired'`)).toBe(1)
    sound(k)
  })
  it('partly filled: only the unfilled remainder is released, and the fill stays', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    // sellers now offer a little at the limit price: 0.0005 BTC, ₹3,250 plus the fee
    k.book(ID, [['6490000', '1']], [['6500000', '0.0005'], ['6600000', '1']])
    await pass(k)
    const mid = getAction(k.db, act.id)!
    expect(mid.state).toBe('working')
    const fill = k.venues.crypto.get(mid.economic_id)!.fills[0]!
    expect(fill.amount).toBe(325_000n)
    const spent = fill.amount + fill.fee // what the venue's own fill cost, fee included (the fee rate is the terms', not this test's)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - spent)
    expect(available(k.db, k.userId, 'bank')).toBe(BANK - 500_000n) // the rest is still reserved
    k.clock.set(EXPIRES_11); await pass(k)
    const done = getAction(k.db, act.id)!
    // it moved money, so it is a partly done order, as a cancel after a part fill is; the venue's own order is `expired`
    expect(done.state).toBe('partial')
    expect(k.venues.crypto.get(done.economic_id)!.state).toBe('expired')
    expect(done.result).toMatchObject({ expired: true, expiredAt: EXPIRES_11 })
    expect(done.error).toMatch(/what had filled stays/i)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - spent)
    expect(available(k.db, k.userId, 'bank')).toBe(BANK - spent) // only the 5,000 less what the fill cost came back, nothing more
    expect(done.result).toMatchObject({ releasedPaise: String(500_000n - spent), filledQty: '50000' })
    const n = notices(k)[0]!
    expect(n.body).toContain(amountText(spent, 2))
    expect(n.body).toContain(amountText(500_000n - spent, 2))
    expect(done.recon_state).toBe('reconciled')
    sound(k)
  })
  it('a sell frees only the quantity still unsold', async () => {
    const k = makeKit({ opening: { ...DEFAULT_OPENING } }); k.btc(6_600_000)
    // buy first so there is something to sell
    const buy = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: ID, side: 'buy', type: 'market', amount: 2_000_000 })
    confirmApproval(k.db, k.userId, buy.approvalId, { method: 'passkey', docHash: buy.docHash }, k.clock.now())
    submitApprovedAction(k.ctx, k.userId, buy.approvalId)
    await pass(k); await pass(k)
    const held = balance(k.db, k.userId, `pos:${ID}`)
    expect(held).toBeGreaterThan(0n)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: ID, side: 'sell', type: 'limit', qty: '0.001', limitPrice: '7000000', ...UNTIL_11 })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const act = submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    await pass(k)
    expect(available(k.db, k.userId, `pos:${ID}`)).toBe(held - 100_000n)
    k.clock.set(EXPIRES_11); await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('expired')
    expect(available(k.db, k.userId, `pos:${ID}`)).toBe(held)
    expect(notices(k)[0]!.body).toMatch(/0\.001 BTC/)
    sound(k)
  })
  it('until the end of the day ends at midnight India time', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, { validity: 'day' })
    await pass(k)
    k.clock.set(istInstant('2026-11-19', '00:00') - 1); await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('working')
    k.clock.set(istInstant('2026-11-19', '00:00')); await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('expired')
    expect(available(k.db, k.userId, 'bank')).toBe(BANK)
  })
  it('says the end of the day it was placed, not the instant after it', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, { ...LIMIT, validity: 'day' })
    expect(pv.lines.find((l) => l.label === 'Stands until')?.value).toBe('The end of 18 Nov 2026 (midnight IST)')
    expect(pv.lines.find((l) => l.label === 'Stands until')?.value).not.toMatch(/19 Nov/)
  })
})

describe('a fill and the expiry never both apply', () => {
  it('a book that would fill at the very moment the order expires: the expiry wins, nothing is bought', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    k.clock.set(EXPIRES_11)
    k.book(ID, [['6490000', '1']], [['6500000', '5']])
    await pass(k)
    const done = getAction(k.db, act.id)!
    expect(done.state).toBe('expired')
    expect(k.venues.crypto.get(done.economic_id)!.fills).toHaveLength(0)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(balance(k.db, k.userId, `pos:${ID}`)).toBe(0n)
  })
  it('a fill working from an order read before it expired is refused inside its transaction', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    const ref = getAction(k.db, act.id)!.economic_id
    const stale = k.venues.crypto.get(ref)!
    k.book(ID, [['6490000', '1']], [['6500000', '5']])
    k.clock.set(EXPIRES_11 - 5)
    expect(k.venues.crypto.expire(ref, EXPIRES_11 - 5)).toBe(false) // not due yet
    // another process ends it between the read and the write
    k.db.run(`UPDATE pv_orders SET state = 'expired' WHERE id = ?`, stale.id)
    await (k.venues.crypto as unknown as { work(o: unknown): Promise<void> }).work(stale)
    expect(k.venues.crypto.get(ref)!.fills).toHaveLength(0)
    expect(k.venues.crypto.get(ref)!.state).toBe('expired')
  })
  it('an order that filled in full cannot then be expired', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    k.book(ID, [['6490000', '1']], [['6500000', '5']])
    await pass(k)
    const done = getAction(k.db, act.id)!
    expect(done.state).toBe('done')
    expect(k.venues.crypto.expire(done.economic_id, EXPIRES_11 + 1)).toBe(false)
    expect(k.venues.crypto.get(done.economic_id)!.state).toBe('filled')
    expect(k.venues.crypto.expireDue()).toBe(0)
  })
  it('expired is final: a later book moves nothing and a cancel is refused', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    k.clock.set(EXPIRES_11); await pass(k)
    expect(TERMINAL_ORDER.has('expired')).toBe(true)
    k.book(ID, [['6490000', '1']], [['6500000', '5']])
    await pass(k)
    expect(k.venues.crypto.get(getAction(k.db, act.id)!.economic_id)!.fills).toHaveLength(0)
    expect(getAction(k.db, act.id)!.state).toBe('expired')
    expect(k.venues.crypto.cancel(getAction(k.db, act.id)!.economic_id)!.state).toBe('expired')
  })
})

describe('two settles at the same moment', () => {
  it('the second, working from a copy read earlier, changes nothing and the expiry fields stay', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    const early = getAction(k.db, act.id)! // read before the venue expired it, as a second process would hold it
    k.clock.set(EXPIRES_11)
    k.venues.crypto.expireDue()
    const first = settleOrder(k.ctx, early)
    expect(first.result).toMatchObject({ expired: true, expiredAt: EXPIRES_11, releasedPaise: '500000' })
    const audits = count(k, `SELECT COUNT(*) n FROM audit WHERE subject = ?`, act.id)
    const second = settleOrder(k.ctx, early)
    expect(second.state).toBe('expired')
    expect(second.result).toMatchObject({ expired: true, expiredAt: EXPIRES_11, releasedPaise: '500000' })
    expect(count(k, `SELECT COUNT(*) n FROM audit WHERE subject = ?`, act.id)).toBe(audits)
    expect(notices(k)).toHaveLength(1)
    expect(() => cancelAction(k.ctx, k.userId, act.id)).toThrow(/already finished/)
  })
})

describe('start-up after downtime', () => {
  it('catches up an order that expired while nothing ran, once, however many passes follow', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const { act } = await rest(k, UNTIL_11)
    await pass(k)
    // the engine is down for five hours, then a new process starts with a new venue object over the same database
    k.clock.set(EXPIRES_11 + 5 * 3_600_000)
    k.venues.crypto = new PaperCryptoVenue(k.db, k.market, k.clock, (k.venues.crypto as unknown as { fetchBook: ConstructorParameters<typeof PaperCryptoVenue>[3] }).fetchBook)
    await pass(k)
    const first = k.db.get<{ released_at: number }>('SELECT released_at FROM holds WHERE ref = ?', `act:${act.id}`)!.released_at
    const updated = getAction(k.db, act.id)!.updated_at
    k.clock.advance(60_000)
    await pass(k); await pass(k)
    expect(getAction(k.db, act.id)!.state).toBe('expired')
    expect(getAction(k.db, act.id)!.updated_at).toBe(updated)
    expect(k.db.get<{ released_at: number }>('SELECT released_at FROM holds WHERE ref = ?', `act:${act.id}`)!.released_at).toBe(first)
    expect(notices(k)).toHaveLength(1)
    expect(count(k, 'SELECT COUNT(*) n FROM receipts WHERE subject = ?', act.id)).toBe(1)
    expect(count(k, `SELECT COUNT(*) n FROM audit WHERE action = 'action.expired'`)).toBe(1)
    expect(available(k.db, k.userId, 'bank')).toBe(BANK)
    sound(k)
  })
})

describe('orders from before this existed stay good until cancelled', () => {
  it('an order with no stated validity is never expired, however long it rests', async () => {
    const k = makeKit(); k.btc(6_600_000)
    // the shape of every resting order placed before expiry existed: no validity in its terms, tif GTC in the venue's record
    const legacy = k.venues.crypto.submit({ clientRef: 'legacy-1', userId: k.userId, instrumentId: ID, side: 'buy', type: 'limit', amount: 500_000n, limitPrice: '6000000' })
    k.db.run(`UPDATE pv_orders SET meta_json = '{"tif":"GTC"}' WHERE id = ?`, legacy.id)
    expect(legacy.state).toBe('accepted')
    k.clock.advance(200 * 86_400_000)
    expect(k.venues.crypto.expireDue()).toBe(0)
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('legacy-1')!.state).toBe('accepted')
  })
  it('an action whose terms carry no validity runs as before and keeps resting', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, LIMIT)
    const d = JSON.parse(pv.document) as Doc
    expect(d.action.params.validity).toEqual({ kind: 'gtc' })
    // as an older document would have been: the term absent
    const { createAction } = await import('./execute.ts')
    const params = { ...d.action.params }; delete params.validity
    const act = createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: 'old-doc', params: params as never, approvalId: k.approveOwner('action:old-doc') })
    await pass(k)
    k.clock.advance(200 * 86_400_000)
    await k.venues.crypto.tick()
    await stepAllActions(k.ctx)
    expect(getAction(k.db, act.id)!.state).toBe('working')
    expect(k.venues.crypto.get('old-doc')!.state).toBe('accepted')
  })
  it('the schema needs no new column: the expiry is part of the venue order record and the signed terms', () => {
    const k = makeKit()
    const cols = k.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('pv_orders')`).map((c) => c.name)
    expect(cols).not.toContain('expires_at')
    expect(cols).toContain('meta_json')
  })
})

describe('the venue refuses an expiry already past', () => {
  it('rejects an order whose time has gone by the moment it is placed', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const o = k.venues.crypto.submit({ clientRef: 'late', userId: k.userId, instrumentId: ID, side: 'buy', type: 'limit', amount: 500_000n, limitPrice: '6000000', expiresAt: T0 })
    expect(o.state).toBe('rejected')
    expect(o.rejectReason).toMatch(/already passed/)
  })
})
