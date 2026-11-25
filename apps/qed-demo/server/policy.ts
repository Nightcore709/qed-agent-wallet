/**
 * Authority enforcement. Every action passes decide() immediately before it is submitted to a venue. The decision is
 * a pure function of recorded state: the program's signed authority, the ledger, recorded prices and their age.
 * No model output and nothing the interface claims is an input here.
 */
import { approvalLapsed, LAPSED_TEXT } from './approvals.ts'
import { mandateVerdict } from './commerce-mandate.ts'
import { simServices } from './commerce-sim.ts'
import { type Db, parse, whenIst } from './core.ts'
import { repeatOf, repeatWords } from './duplicates.ts'
import { getProfile } from './household.ts'
import { available, balance } from './ledger.ts'
import { dayStart, monthStart, programUsage, runUsage, staysLiquid } from './liquidity.ts'
import { freshness } from './market.ts'
import { holdFor, isThirdParty, payeeByHandle } from './new-payee.ts'
import { type Instrument, instrument } from './registry.ts'
import type { ActionRow, Authority, Check, Ctx, Decision, OrderParams, PaymentParams } from './types.ts'
import { limitFor, worstCase } from './valuation.ts'
import { mulDiv, notional, parsePrice, priceToNumber } from '../shared/fixed.ts'
import { homeMoneyMinor } from '../shared/home-money.ts'
import { dayText, istDay } from '../shared/day-text.ts'
import { closedText, DATA_LABEL, isSecurity, sessionOf } from './securities.ts'
import { payoutAt } from './withdrawal.ts'

const big = (s: string | undefined): bigint => BigInt(s ?? '0')
/** A sum in the text of a check, always to the paisa, through the one formatter (shared/money.ts). */

/** Rupee size of an order for caps and funds checks: the stated amount, or quantity at the current ask (buy) or bid (sell). */
export function orderSize(ctx: Ctx, inst: Instrument, p: OrderParams): bigint | null {
  if (p.amount) return big(p.amount)
  if (p.swpPaise) return big(p.swpPaise)
  const type = inst.kind === 'mutual_fund' ? 'nav' : p.side === 'buy' ? 'ask' : 'bid'
  const t = ctx.market.get(inst.id, type)
  if (!t || !p.qty) return null
  return notional(big(p.qty), inst.baseScale, parsePrice(t.price), inst.quoteScale, 'up')
}

/** Compare an INR price with an independent source converted through USDT/INR. Returns the divergence in basis points. */
export function crossCheck(ctx: Ctx, inst: Instrument, now: number): { ok: boolean; available: boolean; divergenceBps: number | null; detail: string } {
  const cc = inst.meta.crossCheck
  if (!cc) return { ok: true, available: false, divergenceBps: null, detail: 'No independent price is configured for this instrument.' }
  const refInst = instrument(ctx.db, cc.instrumentId)
  const viaInst = cc.via ? instrument(ctx.db, cc.via) : undefined
  const mid = (i: Instrument): number | null => {
    const b = ctx.market.get(i.id, 'bid'), a = ctx.market.get(i.id, 'ask')
    if (!b || !a || freshness(b, i, now).stale || freshness(a, i, now).stale) return null
    return (priceToNumber(parsePrice(b.price)) + priceToNumber(parsePrice(a.price))) / 2
  }
  const own = mid(inst), ref = refInst ? mid(refInst) : null, via = viaInst ? mid(viaInst) : 1
  if (own === null) return { ok: false, available: false, divergenceBps: null, detail: 'This instrument has no fresh two-sided price.' }
  if (ref === null || via === null) return { ok: false, available: false, divergenceBps: null, detail: `The independent price (${refInst?.name ?? cc.instrumentId}${viaInst ? ` converted through ${viaInst.name}` : ''}) is not fresh.` }
  const implied = ref * via
  const div = Math.abs(own - implied) / implied * 10_000
  // Two prices this function works out (midpoints, one of them converted), set side by side: both to the paisa.
  const priceText = (v: number): string => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return { ok: div <= cc.maxDivergenceBps, available: true, divergenceBps: Math.round(div), detail: `${priceText(own)} here against ${priceText(implied)} from ${refInst?.name ?? cc.instrumentId}${viaInst ? ` converted through ${viaInst.name}` : ''}: ${(div / 100).toFixed(2)}% apart; the limit is ${+(cc.maxDivergenceBps / 100).toFixed(2)}%.` }
}

export { programUsage }

export interface ApprovalRow { id: string; user_id: string; purpose: string; subject: string; doc_hash: string; expires_at: number; confirmed_at: number | null; consumed_at: number | null; cancelled_at: number | null; method: string | null }
export function approvalState(db: Db, userId: string, approvalId: string | null, subject: string, now: number): { ok: boolean; detail: string; row?: ApprovalRow } {
  if (!approvalId) return { ok: false, detail: 'No approval is attached.' }
  const a = db.get<ApprovalRow>('SELECT id, user_id, purpose, subject, doc_hash, expires_at, confirmed_at, consumed_at, cancelled_at, method FROM approvals WHERE id = ?', approvalId)
  if (!a || a.user_id !== userId) return { ok: false, detail: 'The approval does not exist for this owner.' }
  if (a.subject !== subject) return { ok: false, detail: 'The approval was given for something else.', row: a }
  if (a.cancelled_at) return { ok: false, detail: 'The approval was withdrawn.', row: a }
  if (!a.confirmed_at) return { ok: false, detail: 'The approval has not been confirmed.', row: a }
  if (a.confirmed_at > a.expires_at) return { ok: false, detail: 'The approval was confirmed after it expired.', row: a }
  if (approvalLapsed(a, now)) return { ok: false, detail: LAPSED_TEXT, row: a }
  return { ok: true, detail: `Confirmed by ${a.method ?? 'the owner'}; document ${a.doc_hash.slice(0, 12)}…`, row: a }
}

const ago = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 3_600_000).toFixed(1)} hours`)
const qtyText = (atoms: bigint, inst: Instrument): string => `${(Number(atoms) / 10 ** inst.baseScale).toLocaleString('en-IN', { maximumFractionDigits: inst.baseScale })} ${inst.kind === 'mutual_fund' ? 'units' : inst.base_asset}`

/** An order or payment not started within this time of being asked for is refused, not sent late. */
export const START_BY_MS = 150_000

export function decide(ctx: Ctx, a: ActionRow, now: number): Decision {
  const { db } = ctx
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string, transient = false) => { checks.push({ name, ok, detail, ...(transient && !ok ? { transient: true } : {}) }) }
  const user = db.get<{ stop_at: number | null; stop_protective: number }>('SELECT stop_at, stop_protective FROM users WHERE id = ?', a.user_id)
  const order = a.kind === 'order' ? (a.params as OrderParams) : null
  const pay = a.kind === 'payment' ? (a.params as PaymentParams) : null
  const inst = order ? instrument(db, order.instrumentId) : undefined
  const protective = !!order?.protective && order.side === 'sell'
  const isBuy = order?.side === 'buy'
  let needsApproval = false
  // What the owner was shown, and accepted, when they approved an action of their own: that it goes below the floor,
  // that it takes what must stay in the bank. Read from the approved document; an approval that says nothing of
  // either accepted neither.
  const acknowledged = { belowFloor: false, intoReserve: false }
  if (a.origin === 'owner' && a.approval_id) {
    const doc = parse<{ acknowledged?: { belowFloor?: unknown; intoReserve?: unknown } }>(db.get<{ document: string }>('SELECT document FROM approvals WHERE id = ? AND user_id = ?', a.approval_id, a.user_id)?.document, {})
    acknowledged.belowFloor = doc.acknowledged?.belowFloor === true
    acknowledged.intoReserve = doc.acknowledged?.intoReserve === true
  }

  // ---- who is asking, and is the authority still in force
  let authority: Authority | null = null
  if (a.origin === 'program') {
    const prog = db.get<{ state: string; live_version: number | null; kind: string }>('SELECT state, live_version, kind FROM programs WHERE id = ? AND user_id = ?', a.program_id, a.user_id)
    const run = db.get<{ version: number }>('SELECT version FROM runs WHERE id = ?', a.run_id)
    const ver = prog && run ? db.get<{ state: string; authority_json: string; params_json: string }>('SELECT state, authority_json, params_json FROM program_versions WHERE program_id = ? AND version = ?', a.program_id, run.version) : undefined
    add('program-active', !!prog && prog.state === 'active', prog ? `The instruction is ${prog.state}.` : 'The instruction no longer exists.')
    add('version-live', !!ver && ver.state === 'live' && prog?.live_version === run?.version, ver ? `Run belongs to version ${run?.version}; live version is ${prog?.live_version ?? 'none'}.` : 'The signed version is missing.')
    authority = ver ? parse<Authority | null>(ver.authority_json, null) : null
    if (authority) {
      add('authority-in-date', authority.expiresAt > now, `Its authority ends ${whenIst(authority.expiresAt)}.`)
      if (!protective) {
        const size = order && inst ? orderSize(ctx, inst, order) : pay ? big(pay.amount) + big(pay.charge) : null
        if (size === null) add('size-known', false, 'The rupee size cannot be worked out without a current price.', true)
        else if (!(order && order.side === 'sell' && prog?.kind !== 'swp')) {
          // the limit is per run, not per action: a run of several actions (a split's shares) is held to it as a whole
          // (adversarial review of R12, H1); this run's other actions count as programUsage counts them
          const runSoFar = a.run_id ? runUsage(db, a.run_id, a.id) : 0n
          add('within-run-limit', runSoFar + size <= BigInt(authority.maxPerRun), runSoFar > 0n ? `${homeMoneyMinor(runSoFar)} already in this run plus ${homeMoneyMinor(size)} against ${homeMoneyMinor(authority.maxPerRun)} per run.` : `${homeMoneyMinor(size)} in this run against ${homeMoneyMinor(authority.maxPerRun)} per run.`)
          const usedMonth = programUsage(db, a.program_id!, monthStart(now), a.id)
          add('within-month-limit', usedMonth + size <= BigInt(authority.maxPerMonth), `${homeMoneyMinor(usedMonth)} used this month plus ${homeMoneyMinor(size)} against ${homeMoneyMinor(authority.maxPerMonth)}.`)
          if (authority.maxPerDay !== null) {
            const usedDay = programUsage(db, a.program_id!, dayStart(now), a.id)
            add('within-day-limit', usedDay + size <= BigInt(authority.maxPerDay), `${homeMoneyMinor(usedDay)} used today plus ${homeMoneyMinor(size)} against ${homeMoneyMinor(authority.maxPerDay)}.`)
          }
        }
        if (authority.maxRuns !== null && run) {
          // Runs that are done, and runs still in progress, both count: a purchase that waits a day for its price
          // has used one of the runs that were signed for.
          const others = db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND version = ? AND id <> ? AND state IN ('done', 'partial', 'executing')`, a.program_id!, run.version, a.run_id!)!.n
          add('within-run-count', others < authority.maxRuns, `${others} other run${others === 1 ? '' : 's'} of this instruction ${others === 1 ? 'is' : 'are'} done or in progress, against ${authority.maxRuns} in all.`)
        }
        const scope = parse<{ instrumentId?: string; alsoFrom?: string[]; legs?: { instrumentId: string }[]; payeeHandles?: string[]; plan?: unknown; rules?: { instrumentId?: string }[] }>(ver!.params_json, {})
        if (order) {
          const allowed = new Set<string>([scope.instrumentId, ...(scope.alsoFrom ?? []), ...(scope.legs ?? []).map((l) => l.instrumentId), ...(scope.rules ?? []).map((r) => r.instrumentId)].filter((x): x is string => !!x))
          if (prog?.kind !== 'floor' && prog?.kind !== 'paydown') add('instrument-in-scope', allowed.has(order.instrumentId), `${inst?.name ?? order.instrumentId} ${allowed.has(order.instrumentId) ? 'is' : 'is not'} named in the signed instruction.`)
          // a withdrawal's reserve and its needed-by day are tested again when each sale is sent, not only when the run was planned: a
          // run can wait a day for its approval, and a sale by hand or a lower NAV in between must not take it below what was signed
          if (prog?.kind === 'swp' && order.side === 'sell' && inst && order.qty) {
            const sp = parse<{ instrumentId?: string; alsoFrom?: string[]; reserve?: number; needByDays?: number }>(ver!.params_json, {})
            if ((sp.reserve ?? 0) > 0) {
              let free = 0n
              for (const id of [sp.instrumentId, ...(sp.alsoFrom ?? [])]) {
                const si = id ? instrument(db, id) : undefined, nav = si ? ctx.market.get(si.id, 'nav') : undefined
                if (si && nav) free += notional(available(db, a.user_id, `pos:${si.id}`), si.baseScale, parsePrice(nav.price), si.quoteScale, 'down')
              }
              const navNow = ctx.market.get(inst.id, 'nav')
              const leg = navNow ? notional(big(order.qty), inst.baseScale, parsePrice(navNow.price), inst.quoteScale, 'down') : 0n
              const left = free - leg
              add('swp-reserve', !!navNow && left >= BigInt(sp.reserve!), `${homeMoneyMinor(free)} of free units in the signed funds at the latest NAV, less this sale of ${homeMoneyMinor(leg)}, leaves ${homeMoneyMinor(left)} against the signed reserve of ${homeMoneyMinor(sp.reserve!)}.`)
            }
            const nb = parse<{ neededBy?: number }>(db.get<{ decision_json: string }>('SELECT decision_json FROM runs WHERE id = ?', a.run_id)?.decision_json, {}).neededBy
            if (typeof nb === 'number') { const pays = payoutAt(inst, now); add('swp-needed-by', pays <= nb, `Sent now, this sale pays ${whenIst(pays)}; the money was to reach your bank by ${whenIst(nb)}.`) }
          }
        }
        if (pay && scope.payeeHandles) add('payee-in-scope', scope.payeeHandles.includes(pay.payeeHandle), `${pay.payeeHandle} ${scope.payeeHandles.includes(pay.payeeHandle) ? 'is' : 'is not'} named in the signed instruction.`)
      }
      if (authority.runMode === 'approve') {
        const ap = approvalState(db, a.user_id, a.approval_id, `run:${a.run_id}`, now)
        add('run-approved', ap.ok, ap.detail)
      }
    } else add('authority-on-record', false, 'No signed authority was found for this run.')
    // A stop holds protective selling too, unless the owner chose to keep it running when they stopped (R7-091).
    const held = !!user?.stop_at && !(protective && user.stop_protective === 1)
    add('not-stopped', !held, held ? (protective ? 'You stopped everything, protective selling included.' : 'You stopped all autonomous activity.') : user?.stop_at ? 'You stopped everything except protective selling, so this sale may run.' : 'No emergency stop is in force.')
  } else if (a.origin === 'commerce') {
    // A purchase QED makes inside the owner's signed commerce mandate (commerce-mandate.ts): the mandate is the authority, and
    // it is read again here from the records, whatever the purchase flow found, so a quote cannot talk its way past it.
    const c = pay?.commerce
    const row = c ? db.get<{ state: string; amount: number | null; service_id: string | null }>('SELECT state, amount, service_id FROM commerce_purchases WHERE id = ? AND user_id = ?', c.purchaseId, a.user_id) : undefined
    add('commerce-is-a-spend', !!pay && !order && pay.purpose === 'spend' && !!c, !!pay && !order && pay.purpose === 'spend' && !!c ? 'It is a payment for a purchase made within the commerce mandate.' : 'A commerce purchase is a payment for a purchase, nothing else.')
    const known = c ? simServices()?.services.find((s) => s.id === c.serviceId)?.payTo ?? null : null
    add('purchase-on-record', !!row && row.state === 'paying' && !!pay && row.amount === Number(pay.amount) && row.service_id === c?.serviceId, row ? `The purchase is on record as ${row.state}, for ${row.amount === null ? 'no amount' : homeMoneyMinor(row.amount)}.` : 'No purchase on record matches this payment.')
    if (pay && c) {
      const v = mandateVerdict(db, a.user_id, { serviceId: c.serviceId, amount: Number(pay.amount), quotedPayTo: pay.payeeHandle, knownPayTo: known }, now, c.purchaseId)
      for (const k of v.checks) add(`mandate:${k.name}`, k.ok, k.detail)
    }
    const stopped = !!user?.stop_at
    add('not-stopped', !stopped, stopped ? 'You stopped all autonomous activity, so nothing is bought.' : 'No emergency stop is in force.')
  } else {
    const ap = approvalState(db, a.user_id, a.approval_id, `action:${a.economic_id}`, now)
    add('owner-approved', ap.ok, ap.detail)
    if (!ap.ok && !a.approval_id) needsApproval = true
  }

  // ---- the instrument and its data
  if (order) {
    add('instrument-tradable', !!inst && inst.tradable === 1 && inst.venue === a.venue, inst ? `${inst.name} is traded on ${inst.venue === 'paper-mf' ? 'the paper fund registrar' : inst.venue === 'paper-gsec' ? 'the paper government-securities desk' : 'the paper exchange'}.` : 'Unknown instrument.')
    if (inst && inst.kind === 'crypto_spot') {
      const t = ctx.market.get(inst.id, isBuy ? 'ask' : 'bid')
      const f = freshness(t, inst, now)
      add('price-fresh', f.usableForExecution, t ? `The price ${isBuy ? 'sellers ask' : 'buyers offer'} was received ${ago(f.ageMs)} ago; it may be at most ${((inst.meta.execMaxAgeMs ?? 0) / 1000).toFixed(0)} s old.` : 'No price has been received.', true)
      const cc = crossCheck(ctx, inst, now)
      // An autonomous action must have an independent price that agrees. The owner acting by hand has seen the quote.
      if (inst.meta.crossCheck) add('price-agrees-with-independent-source', a.origin === 'owner' ? (cc.available ? cc.ok : true) : cc.ok, a.origin === 'owner' && !cc.available ? `${cc.detail} Shown as a warning because you placed this order yourself.` : cc.detail, !cc.available)
    }
    if (inst && isSecurity(inst)) {
      const t = ctx.market.get(inst.id, isBuy ? 'ask' : 'bid')
      const f = freshness(t, inst, now)
      add('price-fresh', f.usableForExecution, t ? `The price ${isBuy ? 'sellers ask' : 'buyers offer'} was received ${ago(f.ageMs)} ago; it may be at most ${((inst.meta.execMaxAgeMs ?? 0) / 1000).toFixed(0)} s old. ${DATA_LABEL}.` : 'No price has been received.', true)
      const open = sessionOf(inst, now)
      add('market-open', open.open, open.open ? `The ${inst.venue === 'paper-gsec' ? 'government-securities desk' : 'exchange'} is open until ${open.closes} India time.` : closedText(inst, now))
    }
    if (inst && inst.kind === 'mutual_fund') {
      const t = ctx.market.get(inst.id, 'nav')
      // the NAV's day in words, as the record shows this check's detail to the owner (R12 task comparison, T4-a)
      add('nav-on-record', !!t, t ? `Latest NAV ${t.price} is for ${dayText(istDay(t.sourceTs ?? 0), istDay(now))}. The order executes at a later published NAV.` : 'No NAV has been received for this scheme.')
    }
  }

  // ---- money and holdings
  if (order && inst && isBuy) {
    const size = orderSize(ctx, inst, order)
    const free = available(db, a.user_id, 'bank')
    add('funds-available', size !== null && free >= size, size === null ? 'No price to size the order.' : `${homeMoneyMinor(size)} needed; ${homeMoneyMinor(free)} available in the bank account.`, size === null)
  }
  if (order && inst && !isBuy) {
    const freeQty = available(db, a.user_id, `pos:${inst.id}`)
    const want = order.sellAll ? 1n : big(order.qty)
    add('holding-available', freeQty >= want && freeQty > 0n, `${qtyText(freeQty, inst)} free to sell; ${order.sellAll ? 'all of it' : qtyText(want, inst)} wanted.`)
  }
  if (pay) {
    // A contribution to a goal goes only into a set-aside of one of the owner's goals, and an instruction's run only into
    // its own goal's: money set aside for one goal cannot be moved to another by a plan, by a fault or by a changed row.
    if (pay.purpose === 'goal') {
      const g = pay.goalId ? db.get<{ kind: string }>('SELECT kind FROM programs WHERE id = ? AND user_id = ?', pay.goalId, a.user_id) : undefined
      const own = a.origin !== 'program' || pay.goalId === a.program_id
      add('set-aside-is-the-goals', !!g && g.kind === 'goal' && own, !g || g.kind !== 'goal' ? 'The set-aside it names is not one of your goals.' : own ? `Into the set-aside for ${pay.payeeName}, inside your own bank.` : 'An instruction may move money only into its own set-aside, and this names another goal\'s.')
    }
    const total = big(pay.amount) + big(pay.charge)
    const free = available(db, a.user_id, 'bank')
    add('funds-available', total > 0n && free >= total, `${homeMoneyMinor(total)} needed; ${homeMoneyMinor(free)} available in the bank account.`)
    if (pay.purpose === 'card' || pay.purpose === 'loan:personal' || pay.purpose === 'loan:home') {
      const owed = balance(db, a.user_id, pay.purpose === 'card' ? 'card' : pay.purpose)
      add('not-more-than-owed', big(pay.amount) <= owed, `${homeMoneyMinor(big(pay.amount))} against ${homeMoneyMinor(owed)} owed.`)
    }
  }

  // ---- the protection floor: an action that adds risk or removes protected money must leave the worst case above it
  if (!protective && !(order && !isBuy)) {
    const profile = getProfile(db, a.user_id)
    const w = worstCase(db, ctx.market, a.user_id, now, undefined, profile)
    let delta = 0n
    let how = ''
    if (order && inst) {
      const size = orderSize(ctx, inst, order) ?? 0n
      const fall = BigInt(Math.round(limitFor(db, inst).fall * 1_000_000))
      delta = -mulDiv(size, fall, 1_000_000n, 'up')
      how = `buying ${homeMoneyMinor(size)} of ${inst.name} puts ${homeMoneyMinor(-delta)} at risk under its limit`
    } else if (pay) {
      const amt = big(pay.amount), charge = big(pay.charge)
      const registered = pay.purpose === 'bill' && !!pay.billId
      // paying a card or a registered bill, or moving money into a deposit or a goal's set-aside, does not lower the
      // worst case: the debt or the due bill is counted already, and a deposit and a set-aside are counted as cash
      delta = pay.purpose === 'card' || pay.purpose === 'fd' || pay.purpose === 'goal' || registered ? -charge : -(amt + charge)
      how = delta === 0n ? 'this payment does not change the worst case' : `this payment lowers the worst case by ${homeMoneyMinor(-delta)}`
    }
    const after = BigInt(w.gHat) + delta
    const ok = delta === 0n || after >= BigInt(w.line)
    if (a.origin !== 'owner') {
      if (!w.valid && delta < 0n) add('floor-can-be-evaluated', false, `The worst case cannot be relied on: ${w.invalidReasons.join('; ')}.`, true)
      add('worst-case-stays-above-floor', ok, `Worst case ${homeMoneyMinor(w.gHat)}, floor ${homeMoneyMinor(w.line)}; ${how}; after: ${homeMoneyMinor(after)}.${w.illustrative ? ' Limits are illustrative, not calibrated.' : ''}`)
    } else if (ok || acknowledged.belowFloor) {
      // The owner may go below their own floor by hand; the approval document says so and the check is recorded.
      add('worst-case-stays-above-floor', true, `Worst case ${homeMoneyMinor(w.gHat)}, floor ${homeMoneyMinor(w.line)}; ${how}; after: ${homeMoneyMinor(after)}.${ok ? '' : ' Below your floor. Allowed: you were shown this and approved it yourself.'}`)
    } else {
      add('worst-case-stays-above-floor', false, `Worst case ${homeMoneyMinor(w.gHat)}, floor ${homeMoneyMinor(w.line)}; ${how}; after: ${homeMoneyMinor(after)}. When you approved this it stayed above your floor. It no longer does, so it was not sent. Review it again.`)
    }
  }

  // ---- liquidity: money that something already due will need before income is certain to arrive is not free. The
  // floor above asks whether the household is worth enough; this asks whether the money will be in the bank on the day.
  if (!protective && (pay || (order && isBuy))) {
    const out = order && inst ? orderSize(ctx, inst, order) : pay ? big(pay.amount) + big(pay.charge) : null
    if (out !== null) {
      const prepays = pay && (pay.purpose === 'loan:personal' || pay.purpose === 'loan:home') ? { code: pay.purpose, amount: Number(big(pay.amount)) } : undefined
      const l = staysLiquid(db, a.user_id, now, Number(out), { ...(pay?.purpose === 'bill' && pay.billId ? { paysBillId: pay.billId } : {}), ...(prepays ? { prepays } : {}) })
      // As with the floor, the owner may do by hand what an instruction may not, but only what they were shown. An
      // approval given while the money was free does not cover taking what must stay: if balances have changed since,
      // the action is refused and the owner reviews it again with the warning in front of them.
      if (a.origin !== 'owner') add('stays-liquid', l.ok, l.detail)
      else if (l.ok) add('stays-liquid', true, l.detail)
      else if (acknowledged.intoReserve) add('stays-liquid', true, `${l.detail} Allowed: you were shown this and approved it yourself.`)
      else add('stays-liquid', false, `${l.detail} When you approved this it left what must stay untouched. It no longer does, so it was not sent. Review it again.`)
    }
  }

  // ---- a payment to a payee in its first 24 hours, once what goes to it comes to more than the household's amount, is
  // sent only after the wait its signed terms give it (new-payee.ts; R12 task comparison, gap 4). Only an owner's terms
  // can carry a wait: an instruction's payment to a new payee above the amount is refused, whatever its parameters say,
  // and so is an owner's payment whose terms gave it no wait (its terms were prepared before what went to the payee grew).
  if (pay && a.origin !== 'commerce' && isThirdParty(pay.payeeHandle) && (pay.purpose === 'spend' || pay.purpose === 'bill')) {
    const signed = a.origin === 'owner' ? pay.hold : undefined
    if (signed && typeof signed.until === 'number') {
      const over = now >= signed.until
      add('new-payee-wait', over, over ? `It waited until ${whenIst(signed.until)}, as the terms you approved said.` : `It waits until ${whenIst(signed.until)}, as the terms you approved say. ${signed.why}`)
      // ...and it goes only to the payee its terms were signed for, as it was then (R13 section 4, recipient changes): one
      // removed, added again at the same address (a new payee, with its own first day) or renamed while it waited is not
      // paid. No route changes a payee today; this holds whatever a later one, or a changed database, does.
      const y = payeeByHandle(db, a.user_id, pay.payeeHandle)
      const replaced = !!y && signed.payeeId !== undefined && y.id !== signed.payeeId
      const same = !!y && !replaced && y.name === pay.payeeName
      const none = 'so it was not sent, and nothing left your bank for it.'
      add('payee-as-signed', same, same ? `${pay.payeeName} is one of your payees, as when you approved it.`
        : !y ? `${pay.payeeName} is no longer one of your payees, ${none}`
        : replaced ? `${pay.payeeName} was removed from your payees and added again while it waited, ${none} To pay them, check the address with them yourself, then pay again.`
        : `The payee at ${pay.payeeHandle} is now called ${y.name}, not ${pay.payeeName} as you approved, ${none}`)
    } else {
      const h = holdFor(db, a.user_id, getProfile(db, a.user_id), pay.payeeHandle, big(pay.amount) + big(pay.charge), now, a.id)
      if (h) add('new-payee-wait', false, a.origin === 'program' ? `${h.why} An instruction's payment does not wait, so it was not sent.` : `${h.why} It did not wait, so it was not sent. Review it again: its new terms will say when it is sent.`)
    }
  }

  // ---- a payment that repeats an earlier one waits for the person's confirmation (duplicates.ts; audit finding S4). Only an
  // owner's payment can wait; the check is decided again here whenever the payment is, so the rule holds whatever the
  // preview said. A payment the person has confirmed passes, and so does one whose earlier payment has since ended unsent.
  if (pay && a.origin === 'owner') {
    const rep = repeatOf(db, a.user_id, pay, { id: a.id, createdAt: a.created_at })
    if (!rep) add('duplicate-payment', true, 'It does not repeat an earlier payment.')
    else if (typeof a.result.duplicateConfirmedAt === 'number') add('duplicate-payment', true, `It repeats an earlier payment, and you confirmed it at ${whenIst(a.result.duplicateConfirmedAt)}.`)
    else add('duplicate-payment', false, repeatWords(rep, pay.payeeName, whenIst(rep.askedAt)))
  }

  // ---- an action is started when it is asked for, or not at all. If the engine was not running, or the data it
  // needed did not arrive, the action is refused rather than sent late at whatever the price has become. A protective
  // sale is exempt: reducing risk late is better than not reducing it. A payment that waited until its signed time is
  // asked for when its wait ends (execute.ts startedAt).
  if (a.state === 'planned' && !protective) {
    const waited = now - (a.times.released ?? a.created_at)
    add('started-in-time', waited <= START_BY_MS, `${waited < 1000 ? 'Started at once' : `Started ${(waited / 1000).toFixed(0)} s after it was asked for`} (limit ${START_BY_MS / 1000} s).`)
  }

  const allowed = checks.every((c) => c.ok)
  return { allowed, needsApproval: needsApproval && checks.filter((c) => !c.ok).every((c) => c.name === 'owner-approved'), checks, decidedAt: now }
}
