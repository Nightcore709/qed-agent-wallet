/**
 * A fund order's states (R12 task comparison, gap 17, T4-d): "Sent" covered everything until units arrived. The paper
 * registrar now records three: the order with the registrar (accepted), the money received by the fund house (funded,
 * with its time, which sets the NAV day), and the units allotted (filled, at the NAV for that day). Each reaches the
 * order's record (the action's result) and is announced, so Home and the record follow it as it happens.
 */
import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { previewAction } from './owner.ts'
import { reconcileUser } from './recon.ts'
import { makeKit, settle, type Kit } from './testkit.ts'
import { FUND_PAY_IN_MS, fundEntitlement, PaperFundVenue } from './venues.ts'
import type { OrderParams } from './types.ts'

const buy = (k: Kit, eid: string, amount = '500000', instrumentId = 'amfi:120716') => createAction(k.ctx, {
  userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid,
  params: { instrumentId, side: 'buy', type: 'nav', amount, purpose: 'manual' } satisfies OrderParams, approvalId: k.approveOwner(`action:${eid}`),
})
const events = (k: Kit, id: string) => k.db.all<{ payload_json: string }>(`SELECT payload_json FROM events WHERE type = 'action' ORDER BY id`).map((e) => JSON.parse(e.payload_json) as { id: string; state: string; venueState?: string }).filter((e) => e.id === id)

describe('the paper registrar: with the registrar, money received, units allotted', () => {
  it('a purchase is with the registrar at once, its money reaches the fund house two seconds later, and its units come when that day\'s NAV is published', async () => {
    const k = makeKit() // Wednesday 18 Nov, 10:30 IST
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const t0 = k.clock.now()
    const o = k.venues.funds.submit({ clientRef: 'f1', userId: k.userId, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 500_000n })
    expect(o).toMatchObject({ state: 'accepted', fundsAt: null, createdAt: t0 })
    expect(o.meta).toMatchObject({ fundsDueAt: t0 + FUND_PAY_IN_MS, minNavDate: '2026-11-18' })
    await k.venues.funds.tick()
    expect(k.venues.funds.get('f1')!.state).toBe('accepted') // the money is still on its way

    // the venue runs later than the money arrives: the money is recorded at the time it arrived, not when it was seen
    k.clock.advance(9000)
    await k.venues.funds.tick()
    expect(k.venues.funds.get('f1')).toMatchObject({ state: 'funded', fundsAt: t0 + FUND_PAY_IN_MS })

    k.clock.advance(12 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '180.0000')
    await k.venues.funds.tick()
    const f = k.venues.funds.get('f1')!
    expect(f.state).toBe('filled')
    expect(f.fundsAt).toBe(t0 + FUND_PAY_IN_MS)
    expect(f.fills[0]!.effectiveDate).toBe('2026-11-18')
  })

  it('the pay-in is counted from the very instant the order was accepted, on a clock that moves between readings (found by the browser journey: 1,999 ms)', () => {
    const k = makeKit()
    let t = k.clock.now()
    const moving = { now: () => t++ } // a real clock moves between two readings in one request
    const venue = new PaperFundVenue(k.db, moving)
    const o = venue.submit({ clientRef: 'tick', userId: k.userId, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 500_000n })
    expect(Number(o.meta.fundsDueAt) - o.createdAt).toBe(FUND_PAY_IN_MS)
  })

  it('the NAV day follows the money: an order a second before the cut-off whose money arrives after it gets the next business day\'s NAV', () => {
    const k = makeKit({ start: istInstant('2026-11-18', '14:59') + 59_000 }) // 14:59:59 IST
    const index = k.inst('amfi:120716')
    expect(fundEntitlement(index, 'buy', k.clock.now()).minNavDate).toBe('2026-11-19')
    expect(fundEntitlement(index, 'buy', istInstant('2026-11-18', '14:59')).minNavDate).toBe('2026-11-18')
    // a redemption needs no money: the request's own time sets its day
    expect(fundEntitlement(index, 'sell', k.clock.now()).minNavDate).toBe('2026-11-18')
    const o = k.venues.funds.submit({ clientRef: 'late', userId: k.userId, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 500_000n })
    expect(o.meta.minNavDate).toBe('2026-11-19')
    expect(String(o.meta.rule)).toMatch(/fund house receives the money/)
  })

  it('the order\'s record carries each state with its time, and each move is announced while the action is still working', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const a = buy(k, 'mf-states')
    await stepAllActions(k.ctx)
    const sent = getAction(k.db, a.id)!
    expect(sent.state).toBe('working')
    expect(sent.result).toMatchObject({ venueState: 'accepted', registrarAt: k.clock.now(), fundsAt: null, allottedAt: null, navEntitledFrom: '2026-11-18', cutoff: '15:00', beforeCutoff: true })
    // the check the record shows names the NAV's day in words (it said "is for 2026-11-17")
    expect((sent.policy.checks as { name: string; detail: string }[]).find((c) => c.name === 'nav-on-record')!.detail).toBe('Latest NAV 178.8713 is for Tue 17 Nov. The order executes at a later published NAV.')

    await settle(k) // six seconds of the venue and the engine
    const funded = getAction(k.db, a.id)!
    expect(funded.state).toBe('working')
    expect(funded.result).toMatchObject({ venueState: 'funded', fundsAt: sent.result.registrarAt as number + FUND_PAY_IN_MS, allottedAt: null })
    expect(events(k, a.id).map((e) => e.venueState ?? e.state)).toContain('funded')

    k.clock.advance(12 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '180.0000')
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect(done.state).toBe('done')
    expect(done.result).toMatchObject({ venueState: 'filled', fundsAt: funded.result.fundsAt, navDate: '2026-11-18', navPrice: '180.0000' })
    expect(done.result.allottedAt).toBeGreaterThan(funded.result.fundsAt as number)
  })

  it('reconciliation counts money with the fund house as open while it waits for units: no break', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    buy(k, 'mf-recon')
    await settle(k)
    expect(k.db.get<{ state: string }>(`SELECT state FROM pv_orders WHERE client_ref = 'mf-recon'`)!.state).toBe('funded')
    const r = reconcileUser(k.ctx, k.userId)
    expect(r.breaks).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('a redemption stays with the registrar until its NAV, then is redeemed and paid out: no money state of its own', async () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    buy(k, 'lb', '10000000', 'amfi:118701')
    await settle(k)
    const s = createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: 'ls', params: { instrumentId: 'amfi:118701', side: 'sell', type: 'nav', sellAll: true, purpose: 'manual' }, approvalId: k.approveOwner('action:ls') })
    await settle(k)
    expect(k.venues.funds.get('ls')).toMatchObject({ state: 'accepted', fundsAt: null })
    k.clock.advance(20 * 3600_000)
    k.nav('amfi:118701', '2026-11-18', '7034.7000')
    await settle(k)
    const mid = getAction(k.db, s.id)!
    expect(mid.result).toMatchObject({ venueState: 'filled', fundsAt: null, navDate: '2026-11-18' })
    expect(events(k, s.id).map((e) => e.venueState ?? e.state)).toContain('filled') // redeemed, money not yet paid: announced
  })
})

describe('the order sheet names the NAV day as a person reads it, and why (T4-a)', () => {
  const iso = /\b\d{4}-\d{2}-\d{2}\b/
  it('a purchase: "the NAV for Wed 18 Nov, or the next one published", because the money arrives before the cut-off; no database date anywhere on it', async () => {
    const k = makeKit() // Wednesday 18 Nov, 10:30 IST
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 2_500_000 })
    const at = pv.lines.find((l) => l.label === 'Executes at')!
    expect(at.value).toBe('the NAV for Wed 18 Nov, or the next one published')
    expect(at.note).toMatch(/^On paper the money reaches the fund house about 2 seconds after you approve, before the 15:00 India time cut-off\. The NAV of the business day on which the fund house receives the money before the cut-off/)
    for (const l of pv.lines) expect(`${l.value} ${l.note ?? ''}`).not.toMatch(iso)
    const basis = (JSON.parse(pv.document) as { basis?: string[] }).basis ?? []
    expect(basis.join(' ')).toMatch(/Latest NAV 178\.8713 is for Tue 17 Nov, published by AMFI and received 18 Nov 2026, 10:30 IST/)
    expect(basis.join(' ')).not.toMatch(iso)
  })

  it('after the cut-off it is the next business day\'s; a redemption says when its money would arrive, in words', async () => {
    const k = makeKit({ start: istInstant('2026-11-20', '16:00') }) // Friday, after the cut-off
    k.nav('amfi:120716', '2026-11-19', '178.8713')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 2_500_000 })
    expect(pv.lines.find((l) => l.label === 'Executes at')).toMatchObject({ value: 'the NAV for Mon 23 Nov, or the next one published', note: expect.stringMatching(/after the 15:00 India time cut-off/) })
    k.db.run(`INSERT INTO accounts (id, user_id, code, kind, asset_id, instrument_id, name, nonneg, meta_json) SELECT 'acc_pos', ?, 'pos:amfi:120716', 'asset', 'MF:120716', 'claim:paper-mf/120716', 'Units', 1, '{}'`, k.userId)
    k.db.run(`INSERT INTO balances (account_id, amount, amount_text) VALUES ('acc_pos', 10000, '10000')`)
    const out = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:120716', side: 'sell', type: 'nav', qty: '5' })
    expect(out.lines.find((l) => l.label === 'Executes at')!.note).toMatch(/^The request reaches the registrar when you approve, after the 15:00 India time cut-off\./)
    expect(out.lines.find((l) => l.label === 'Money reaches your bank')!.note).toBe('If it is the NAV for Mon 23 Nov: 25 Nov 2026, 10:00 IST')
    for (const l of [...pv.lines, ...out.lines]) expect(`${l.value} ${l.note ?? ''}`).not.toMatch(iso)
  })

  it('in presentation mode the sheet says its NAV is synthetic, never AMFI\'s', async () => {
    const k = makeKit()
    k.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: '101.2345', sourceTs: Date.parse('2026-11-17T00:00:00+05:30'), precision: 'day', recvTs: k.clock.now(), provider: 'synthetic' })
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 2_500_000 })
    const said = [...pv.lines.map((l) => `${l.value} ${l.note ?? ''}`), ...((JSON.parse(pv.document) as { basis?: string[] }).basis ?? [])].join(' ')
    expect(said).toMatch(/synthetic NAV generated on this QED installation \(presentation mode\)/)
    expect(said).not.toMatch(/AMFI/)
  })
})
