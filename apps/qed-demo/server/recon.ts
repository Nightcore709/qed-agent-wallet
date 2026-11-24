/**
 * Reconciliation for one owner: the ledger against itself, and the ledger against each venue's own record.
 *
 * It finds, and where it safely can repairs, the cases a wallet meets in practice: a fill the venue made that never
 * reached the ledger (the report was lost), a payment the rail later reversed, a reservation left behind by an
 * action that has finished, and clearing balances that do not equal what is actually in flight. Every repair is
 * posted as a new, labelled ledger entry; nothing is edited. Anything it cannot repair stays open as a break and is
 * shown to the owner.
 */
import { fromAmountText } from '../shared/amount-text.ts'
import { type Db, emit, j, newId, parse } from './core.ts'
import { disagreementText, lastChainComparison } from './chain-books.ts'
import { notice, paymentLines, resolveNotices } from './execute.ts'
import { balance, post, releaseHold, verifyLedger } from './ledger.ts'
import { issueReceipt, verifyChain } from './receipts.ts'
import type { Ctx, PaymentParams } from './types.ts'
import { venueHolding } from './venues.ts'

export interface ReconResult { ok: boolean; checked: string[]; breaks: string[]; repaired: string[]; inFlight: string[] }

export function reconcileUser(ctx: Ctx, userId: string): ReconResult {
  const { db } = ctx
  const now = ctx.clock.now()
  const breaks: string[] = [], repaired: string[] = [], inFlight: string[] = [], checked: string[] = []

  // 1. The books on their own terms.
  checked.push('Every entry balances; balances equal the sum of postings; nothing is below zero; lots equal holdings')
  for (const b of verifyLedger(db, userId)) breaks.push(`Ledger ${b.check}: ${b.detail}`)

  // 2. Venue fills that the ledger does not have.
  checked.push('Every venue fill has a ledger entry')
  const unbooked = db.all<{ id: string; order_id: string; client_ref: string }>(
    `SELECT f.id, f.order_id, o.client_ref FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id
     WHERE f.user_id = ? AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.user_id = f.user_id AND e.ref = 'fill:' || f.id)`, userId)
  for (const f of unbooked) {
    const act = db.get<{ id: string; state: string }>('SELECT id, state FROM actions WHERE user_id = ? AND economic_id = ?', userId, f.client_ref)
    if (!act) { breaks.push(`The venue shows a fill (${f.id}) for an order the wallet never placed.`); continue }
    if (act.state === 'working' || act.state === 'submitting') { inFlight.push(`Fill ${f.id} is waiting to be booked.`); continue }
    // The action was closed without this fill. Reopen it so the normal path books it, exactly once.
    db.run(`UPDATE actions SET state = 'working', receipt_id = NULL, recon_state = 'open', error = ?, updated_at = ? WHERE id = ?`, 'Reopened by reconciliation: the venue recorded a fill the ledger did not have.', now, act.id)
    repaired.push(`A venue fill missing from the ledger was found and sent for booking (action ${act.id}).`)
  }

  // 3. Holdings: the ledger and each venue must agree once nothing is waiting to be booked.
  checked.push('Holdings in the ledger equal holdings at each venue')
  if (unbooked.length === 0) {
    const insts = db.all<{ instrument_id: string }>(`SELECT DISTINCT instrument_id FROM pv_fills WHERE user_id = ? UNION SELECT DISTINCT substr(code, 5) FROM accounts WHERE user_id = ? AND code LIKE 'pos:%'`, userId, userId)
    for (const i of insts) {
      const led = balance(db, userId, `pos:${i.instrument_id}`), ven = venueHolding(db, userId, i.instrument_id)
      if (led !== ven) breaks.push(`${i.instrument_id}: the ledger holds ${led} atoms, the venue holds ${ven}.`)
    }
  }

  // 4. Payments: what the rail says against what the ledger says.
  checked.push('Every payment on the rail matches the ledger, including reversals')
  const pays = db.all<{ client_ref: string; state: string; amount: number; reason: string | null; updated_at: number }>('SELECT client_ref, state, amount, reason, updated_at FROM pv_payments WHERE user_id = ?', userId)
  let pendingOnRail = 0n
  for (const p of pays) {
    const has = (s: string) => !!db.get('SELECT 1 FROM entries WHERE user_id = ? AND ref = ?', userId, `pay:${p.client_ref}:${s}`)
    const act = db.get<{ id: string; state: string; params_json: string }>('SELECT id, state, params_json FROM actions WHERE user_id = ? AND economic_id = ?', userId, p.client_ref)
    if (!act) { breaks.push(`The rail shows a payment (${p.client_ref}) the wallet never sent.`); continue }
    if (p.state === 'pending' || p.state === 'unknown') { pendingOnRail += BigInt(p.amount); continue }
    if ((p.state === 'settled' || p.state === 'reversed') && !has('settle')) {
      if (act.state === 'working' || act.state === 'submitting') { inFlight.push(`Payment ${p.client_ref} settled and is waiting to be booked.`); pendingOnRail += BigInt(p.amount); continue }
      breaks.push(`The rail shows payment ${p.client_ref} settled; the ledger does not.`)
      continue
    }
    if (p.state === 'failed' && !has('return')) {
      if (act.state === 'working' || act.state === 'submitting') { inFlight.push(`Payment ${p.client_ref} failed and its money is waiting to be returned.`); pendingOnRail += BigInt(p.amount); continue }
      breaks.push(`The rail shows payment ${p.client_ref} failed; the money has not been returned in the ledger.`)
      continue
    }
    if (p.state === 'reversed' && !has('reversal')) {
      // The rail took the payment back after it had settled. Book the money returning and tell the owner.
      const prm = parse<PaymentParams>(act.params_json, {} as PaymentParams)
      db.tx(() => {
        const lines = paymentLines(prm).map((l) => (l.account === 'clear:pay' ? { account: 'bank', amount: -l.amount } : { account: l.account, amount: -l.amount }))
        post(db, { userId, ts: now, effectiveTs: p.updated_at, kind: 'payment-reversed', ref: `pay:${p.client_ref}:reversal`, memo: `Payment to ${prm.payeeName} was reversed by the rail; money returned`, meta: { actionId: act.id, reason: p.reason, recoveredBy: 'reconciliation', paper: true }, lines })
        if (prm.billId) db.run(`UPDATE bills SET state = 'due', action_id = NULL WHERE id = ? AND user_id = ?`, prm.billId, userId)
        db.run('UPDATE actions SET result_json = json_set(result_json, \'$.railState\', \'reversed\', \'$.reversedAt\', ?), updated_at = ? WHERE id = ?', p.updated_at, now, act.id)
        issueReceipt(db, userId, 'reversal', act.id, { what: `Payment to ${prm.payeeName} reversed`, outcome: 'reversed', reason: p.reason, economicId: p.client_ref, amount: prm.amount, foundBy: 'reconciliation', railUpdatedAt: p.updated_at }, now)
        notice(db, userId, { level: 'action', kind: 'payment-reversed', title: `Your payment to ${prm.payeeName} came back`, body: `${p.reason ?? 'The rail reversed it.'} The money is back in your bank account${prm.billId ? ' and the bill is due again' : ''}.`, subject: act.id, dedupe: `reversal:${act.id}` }, now)
      })
      repaired.push(`A reversed payment (${p.client_ref}) was booked back to the bank account.`)
    }
  }
  checked.push('Money shown as "in progress" equals what is actually in flight')
  const clrPay = balance(db, userId, 'clear:pay')
  if (clrPay !== pendingOnRail) breaks.push(`Payments in progress show ${clrPay} paise in the ledger; the rail has ${pendingOnRail} paise in flight.`)
  // open: with the registrar, or with the fund house waiting for the NAV ('funded', since v8)
  const mfOpen = fromAmountText(db.get<{ s: string }>(`SELECT amount_sum(amount) s FROM pv_orders WHERE user_id = ? AND venue = 'paper-mf' AND side = 'buy' AND state IN ('accepted', 'funded')`, userId)?.s, 'the open fund purchases')
  const mfBookedLag = fromAmountText(db.get<{ s: string }>(
    `SELECT amount_sum(o.amount) s FROM pv_orders o WHERE o.user_id = ? AND o.venue = 'paper-mf' AND o.side = 'buy' AND o.state IN ('filled', 'rejected')
     AND EXISTS (SELECT 1 FROM actions a WHERE a.user_id = o.user_id AND a.economic_id = o.client_ref AND a.state IN ('working', 'submitting'))`, userId)?.s, 'the fund purchases still being booked')
  const clrMf = balance(db, userId, 'clear:mf')
  if (clrMf !== mfOpen + mfBookedLag) breaks.push(`Fund purchases awaiting units show ${clrMf} paise in the ledger; the registrar has ${mfOpen + mfBookedLag} paise of open orders.`)

  // 5. Reservations must belong to something still in flight, or to a payment on hold, whose money stays set aside until
  // its wait ends or it is cancelled (new-payee.ts; execute.ts hold).
  checked.push('Every reservation belongs to an order still in flight or a payment on hold')
  const holds = db.all<{ ref: string }>(`SELECT ref FROM holds WHERE user_id = ? AND released_at IS NULL AND ref LIKE 'act:%'`, userId)
  for (const h of holds) {
    const st = db.get<{ state: string }>('SELECT state FROM actions WHERE id = ?', h.ref.slice(4))?.state
    if (st === 'working' || st === 'submitting' || st === 'held') continue
    releaseHold(db, userId, h.ref, now)
    repaired.push(`A reservation left by a finished action (${h.ref.slice(4)}) was released.`)
  }
  // A request for approval whose run is no longer waiting has nothing left to ask.
  const stale = db.run(`UPDATE notices SET resolved_at = ? WHERE user_id = ? AND resolved_at IS NULL AND kind IN ('run-approval', 'run-notice') AND subject IN (SELECT id FROM runs WHERE user_id = ? AND state NOT IN ('awaiting_approval', 'objection_window'))`, now, userId, userId).changes
  if (stale > 0) repaired.push(`${stale} request${stale === 1 ? '' : 's'} for a run that was no longer waiting ${stale === 1 ? 'was' : 'were'} withdrawn.`)

  // 6. The receipt chain.
  checked.push('The receipt chain is intact')
  const chain = verifyChain(db, userId)
  if (!chain.ok) breaks.push(`The receipt chain is broken at receipt ${chain.brokenAt}.`)

  // 7. The on-chain wallet's books against the wallet service's balances, as last compared (server/chain-books.ts, which
  // compares on this same schedule and raises its own notice). A disagreement is a break here too; unknown is not.
  const onChain = lastChainComparison(db, userId)
  let chainBreak: string | null = null
  if (onChain) {
    checked.push(`The test tokens in the books equal the on-chain wallet's balances (compared ${new Date(onChain.at).toISOString()})`)
    if (onChain.state === 'disagrees') breaks.push(chainBreak = disagreementText(onChain))
    else if (onChain.state === 'unknown') inFlight.push(`The on-chain wallet was not compared: ${onChain.why ?? 'the wallet service did not answer'}`)
  }

  const ok = breaks.length === 0
  const last = db.get<{ ok: number; breaks_json: string }>('SELECT ok, breaks_json FROM recon_runs WHERE user_id = ? ORDER BY ts DESC LIMIT 1', userId)
  const changed = !last || (last.ok === 1) !== ok || last.breaks_json !== j(breaks) || repaired.length > 0
  db.run('INSERT INTO recon_runs (id, user_id, ts, ok, checked_json, breaks_json) VALUES (?, ?, ?, ?, ?, ?)', newId('rec', now), userId, now, ok ? 1 : 0, j({ checked, repaired, inFlight }), j(breaks))
  db.run(`DELETE FROM recon_runs WHERE user_id = ? AND id NOT IN (SELECT id FROM recon_runs WHERE user_id = ? ORDER BY ts DESC LIMIT 300)`, userId, userId)
  if (changed) emit(db, now, userId, 'recon', { ok, breaks: breaks.length, repaired: repaired.length })
  const venueBreaks = breaks.filter((b) => b !== chainBreak)
  if (venueBreaks.length) notice(db, userId, { level: 'action', kind: 'recon-break', title: 'Your records do not match a venue', body: venueBreaks.slice(0, 3).join(' '), dedupe: 'recon:user' }, now)
  else resolveNotices(db, userId, 'recon:user', now)
  return { ok, checked, breaks, repaired, inFlight }
}

export function lastRecon(db: Db, userId: string): { ts: number; ok: boolean; checked: string[]; repaired: string[]; inFlight: string[]; breaks: string[] } | null {
  const r = db.get<{ ts: number; ok: number; checked_json: string; breaks_json: string }>('SELECT ts, ok, checked_json, breaks_json FROM recon_runs WHERE user_id = ? ORDER BY ts DESC LIMIT 1', userId)
  if (!r) return null
  const c = parse<{ checked: string[]; repaired: string[]; inFlight: string[] }>(r.checked_json, { checked: [], repaired: [], inFlight: [] })
  return { ts: r.ts, ok: r.ok === 1, checked: c.checked, repaired: c.repaired, inFlight: c.inFlight, breaks: parse<string[]>(r.breaks_json, []) }
}
