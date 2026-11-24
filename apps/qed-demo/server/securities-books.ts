/**
 * What the paper securities desks do on each engine pass that touches the books (R13): their orders fill, and a bond's
 * coupons are posted to the holders' bank accounts. Kept apart from securities.ts, which the venues import, because it
 * reads the ledger and the venues.
 */
import { audit } from './core.ts'
import { notice } from './execute.ts'
import { post } from './ledger.ts'
import { couponsDue } from './securities.ts'
import { inr } from '../shared/money.ts'
import type { Ctx } from './types.ts'
import { PaperDebtVenue, PaperExchangeVenue } from './venues.ts'

/** The two desks' ticks, then the coupons now payable. Idempotent: a coupon is posted once, by its reference. */
export async function securitiesTick(ctx: Ctx): Promise<void> {
  await (ctx.venues.exchange ??= new PaperExchangeVenue(ctx.db, ctx.market, ctx.clock)).tick()
  await (ctx.venues.debt ??= new PaperDebtVenue(ctx.db, ctx.market, ctx.clock)).tick()
  payCoupons(ctx)
}

export function payCoupons(ctx: Ctx): number {
  const now = ctx.clock.now()
  let n = 0
  for (const c of couponsDue(ctx.db, now)) {
    if (ctx.db.get('SELECT 1 FROM entries WHERE user_id = ? AND ref = ?', c.userId, c.ref)) continue
    const inst = ctx.db.get<{ name: string }>('SELECT name FROM instruments WHERE id = ?', c.instrumentId)
    const paise = c.paise
    ctx.db.tx(() => {
      post(ctx.db, { userId: c.userId, ts: now, effectiveTs: now, kind: 'coupon', ref: c.ref, memo: `Coupon on ${c.units} units of ${inst?.name ?? c.instrumentId}, ${c.date}`, meta: { instrumentId: c.instrumentId, date: c.date, units: c.units.toString(), paper: true },
        lines: [{ account: 'bank', amount: paise }, { account: 'inc:interest', amount: -paise }] })
      notice(ctx.db, c.userId, { level: 'info', kind: 'coupon', title: `${inr(Number(paise), { paise: true })} of interest arrived`, body: `The coupon on your ${inst?.name ?? 'bond'} for ${c.date}, on paper. It is interest, taxed as income; this app does not compute that tax.`, subject: c.instrumentId, dedupe: c.ref }, now)
      audit(ctx.db, now, c.userId, 'engine', 'coupon.paid', c.ref, { units: c.units.toString(), paise: paise.toString() })
    })
    n++
  }
  return n
}
