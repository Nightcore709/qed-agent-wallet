/**
 * What the household is worth now, what is committed, and the worst case the protection floor is measured against.
 * What is free to use is worked out in liquidity.ts: bank money beyond what everything already due will need.
 *
 * Valuation uses the price a sale would actually get: the bid for traded instruments, the latest published NAV for
 * funds. Every value carries the age of the price behind it. The worst case applies each holding's limit (the
 * largest fall allowed for between checks), subtracts card debt and the commitments due in the next 30 days.
 * A limit marked "modelled" has not been calibrated; the result is then labelled illustrative (D-048).
 */
import { pausedFor } from './dispute-pause.ts'
import { type Db, parse } from './core.ts'
import { foreignHeldWorst } from './foreign-worst.ts'
import { getProfile, nextMonthly, type Profile } from './household.ts'
import { available, balance, heldAmount, openCost } from './ledger.ts'
import { type Liquidity, liquidity } from './liquidity.ts'
import { type Freshness, freshness, type Market, type PriceType, type Tick } from './market.ts'
import type { HoldingStory } from './performance.ts'
import { type Instrument, instrument, term, isCalibrated } from './registry.ts'
import { allSetAside, onItsWay, setAside } from './setaside.ts'
import { fromAmountText, numberOrNull } from '../shared/amount-text.ts'
import { notional, parseDec, parsePrice } from '../shared/fixed.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

export interface HoldingView {
  /** qtyAtoms: the holding in base atoms as a number when a JavaScript number holds it exactly, else null; qtyAtomsText is always exact. */
  instrumentId: string; name: string; kind: string; asset: string; qty: string; qtyAtoms: number | null; qtyAtomsText: string; baseScale: number
  priceType: PriceType | null; price: string | null; priceSourceTs: number | null; priceRecvTs: number | null; provider: string | null
  fresh: Freshness
  value: number | null          // paise, at the bid or NAV
  cost: number                  // paise, open lots
  limit: number                 // fraction of value assumed lost in the worst case
  limitStatus: string           // 'verified' | 'modelled' | ...
  limitNote: string
  worst: number | null          // value after the limit, paise
  held: string                  // quantity reserved by open orders
  /** What it was bought at, why it changed and its annual rate (server/performance.ts); added where a screen shows them (/api/home). */
  story?: HoldingStory
}

const fmtQty = (atoms: bigint, scale: number): string => {
  const s = atoms.toString().padStart(scale + 1, '0')
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s
  return scale ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/** The price a holder would be paid: bid for a venue with a book, NAV for a fund. */
export function exitPrice(market: Market, inst: Instrument): { tick: Tick | undefined; type: PriceType } {
  const type: PriceType = inst.kind === 'mutual_fund' ? 'nav' : 'bid'
  return { tick: market.get(inst.id, type), type }
}

export function limitFor(db: Db, inst: Instrument): { fall: number; status: string; note: string } {
  const t = term(db, inst.meta.limitTerm ?? `limit.${inst.id}`)
  const fall = Number(t?.value.fall ?? 1)
  return { fall: Number.isFinite(fall) && fall >= 0 && fall <= 1 ? fall : 1, status: t?.status ?? 'modelled', note: t ? `${t.source}${t.value.window ? `; window: ${String(t.value.window)}` : ''}` : 'No limit on record: treated as a total loss' }
}

export function holdings(db: Db, market: Market, userId: string, now: number): HoldingView[] {
  const rows = db.all<{ code: string; amount: string }>(`SELECT a.code, b.amount_text amount FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code LIKE 'pos:%' AND b.amount_text != '0'`, userId)
  const out: HoldingView[] = []
  for (const r of rows) {
    const inst = instrument(db, r.code.slice(4))
    if (!inst) continue
    const qty = fromAmountText(r.amount, `the holding ${r.code}`)
    const { tick, type } = exitPrice(market, inst)
    const fresh = freshness(tick, inst, now)
    const lim = limitFor(db, inst)
    const value = tick ? notional(qty, inst.baseScale, parsePrice(tick.price), inst.quoteScale, 'down') : null
    const worst = value === null ? null : value - (value * BigInt(Math.round(lim.fall * 1_000_000))) / 1_000_000n
    out.push({
      instrumentId: inst.id, name: inst.name, kind: inst.kind, asset: inst.base_asset, qty: fmtQty(qty, inst.baseScale), qtyAtoms: numberOrNull(qty), qtyAtomsText: qty.toString(), baseScale: inst.baseScale,
      priceType: tick ? type : null, price: tick?.price ?? null, priceSourceTs: tick?.sourceTs ?? null, priceRecvTs: tick?.recvTs ?? null, provider: tick?.provider ?? null, fresh,
      value: value === null ? null : Number(value), cost: Number(openCost(db, userId, inst.id).cost), limit: lim.fall, limitStatus: lim.status, limitNote: lim.note,
      worst: worst === null ? null : Number(worst), held: fmtQty(heldAmount(db, userId, r.code), inst.baseScale),
    })
  }
  return out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
}

export interface Commitment { kind: 'bill' | 'emi' | 'program' | 'card'; label: string; amount: number; dueAt: number; subject?: string; certain: boolean; runMode?: string; by?: { id: string; runMode?: string; title: string }; unpaid?: string }

/**
 * Who will pay a bill. An active bills instruction pays it only if it names the payee and the bill is within its cap;
 * otherwise nobody will, and the owner should know that before the due date, not after.
 */
export function billCover(db: Db, userId: string, handle: string, amount: number): { id: string; title: string; runMode: string } | { reason: string } {
  // While QED is paused no instruction pays anything, so no bill is covered (R7-111 F4): the owner must see it as theirs.
  const paused = db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', userId)?.stop_at != null
  // A reported problem on the rail holds QED's own payments there too (dispute-pause.ts)
  const problem = pausedFor(db, userId, 'paper-rail')
  const progs = db.all<{ id: string; title: string; params_json: string; authority_json: string }>(
    `SELECT p.id, p.title, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.state = 'active' AND p.kind = 'bills'`, userId)
  let cap: number | null = null
  for (const g of progs) {
    const prm = parse<{ payeeHandles?: string[]; capPerBill?: number }>(g.params_json, {})
    if (!prm.payeeHandles?.includes(handle)) continue
    if (amount <= (prm.capPerBill ?? 0)) return paused ? { reason: `QED is paused, so "${g.title}" will not pay it until you resume QED.` } : problem ? { reason: `You reported a problem on this account, so "${g.title}" will not pay it until you release the pause.` } : { id: g.id, title: g.title, runMode: parse<{ runMode?: string }>(g.authority_json, {}).runMode ?? 'auto' }
    cap = Math.max(cap ?? 0, prm.capPerBill ?? 0)
  }
  return { reason: cap === null ? 'No instruction pays this payee.' : `It is above the ${homeMoneyExact(cap)} cap on your bills instruction, so QED will not pay it.` }
}

/** Money already promised in the coming days: registered bills, loan instalments, and what active programs will move. */
export function commitments(db: Db, userId: string, now: number, horizonMs: number): Commitment[] {
  const out: Commitment[] = []
  const until = now + horizonMs
  const p = getProfile(db, userId)
  const bills = db.all<{ id: string; amount: number; due_at: number; name: string; handle: string }>(
    `SELECT b.id, b.amount, b.due_at, y.name, y.handle FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND b.state IN ('due', 'scheduled') AND b.due_at <= ? ORDER BY b.due_at`, userId, until)
  for (const b of bills) { const cover = billCover(db, userId, b.handle, b.amount); out.push({ kind: 'bill', label: b.name, amount: b.amount, dueAt: b.due_at, subject: b.id, certain: true, ...('id' in cover ? { by: cover } : { unpaid: cover.reason }) }) }
  for (const [code, emi, label] of [['loan:personal', p.personalLoanEmi, 'Personal loan instalment'], ['loan:home', p.homeLoanEmi, 'Home loan instalment']] as const) {
    if (emi <= 0 || balance(db, userId, code) <= 0n) continue
    let at = nextMonthly(now, p.emiDay, '09:00')
    while (at <= until) { out.push({ kind: 'emi', label, amount: emi, dueAt: at, certain: true }); at = nextMonthly(at, p.emiDay, '09:00') }
  }
  const progs = db.all<{ id: string; title: string; kind: string; next_due_at: number | null; params_json: string; authority_json: string }>(
    `SELECT p.id, p.title, p.kind, p.next_due_at, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version
     WHERE p.user_id = ? AND p.state = 'active' AND p.next_due_at IS NOT NULL AND p.next_due_at <= ?`, userId, until)
  for (const g of progs) {
    const prm = parse<{ amount?: number; target?: number; name?: string }>(g.params_json, {})
    // how it runs, so Coming up does not call a run QED's that waits for the owner's approval (walkthrough F31)
    const runMode = parse<{ runMode?: string }>(g.authority_json, {}).runMode
    if (g.kind === 'invest' && typeof prm.amount === 'number') out.push({ kind: 'program', label: g.title, amount: prm.amount, dueAt: g.next_due_at!, subject: g.id, certain: false, ...(runMode ? { runMode } : {}) })
    // a goal's next contribution: its monthly figure, or what is left to reach the target when that is less
    if (g.kind === 'goal' && typeof prm.amount === 'number' && typeof prm.target === 'number') {
      const left = prm.target - setAside(db, userId, g.id) - onItsWay(db, userId, g.id)
      if (left > 0) out.push({ kind: 'program', label: `Set aside for ${prm.name ?? g.title}`, amount: Math.min(prm.amount, left), dueAt: g.next_due_at!, subject: g.id, certain: false, ...(runMode ? { runMode } : {}) })
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt)
}

export interface WorstCase {
  /** setAside: every goal's set-aside together (R12, gap 5): the household's own money, counted as cash. */
  cash: number; deposits: number; setAside: number; inTransit: number; holdingsValue: number; holdingsWorst: number; card: number; reserves: number
  /** Money held in other currencies, counted at its reference rate less a stated haircut (foreign-worst.ts); 0 when none is held. */
  foreign: number
  gHat: number; line: number; cushion: number
  valid: boolean; invalidReasons: string[]
  illustrative: boolean
  parts: { label: string; amount: number; note: string }[]
}

export function worstCase(db: Db, market: Market, userId: string, now: number, hs: HoldingView[] = holdings(db, market, userId, now), profile: Profile = getProfile(db, userId)): WorstCase {
  const cash = Number(balance(db, userId, 'bank'))
  const deposits = Number(balance(db, userId, 'fd'))
  const setAsideAll = allSetAside(db, userId)
  const inTransit = Number(balance(db, userId, 'recv:mf') + balance(db, userId, 'clear:mf'))
  const card = Number(balance(db, userId, 'card'))
  const reserves = commitments(db, userId, now, 30 * 86_400_000).filter((c) => c.certain).reduce((s, c) => s + c.amount, 0)
  const invalidReasons: string[] = []
  let holdingsValue = 0, holdingsWorst = 0, illustrative = false
  for (const h of hs) {
    if (h.value === null || h.worst === null) { invalidReasons.push(`${h.name}: no price received yet`); continue }
    if (h.fresh.stale) invalidReasons.push(`${h.name}: the price is stale, so its limit no longer bounds the fall`)
    if (!isCalibrated(h.limitStatus)) illustrative = true
    holdingsValue += h.value
    holdingsWorst += h.worst
  }
  const fw = foreignHeldWorst(db, market, userId, now)
  const foreign = Number(fw.total)
  const gHat = cash + deposits + setAsideAll + inTransit + holdingsWorst + foreign - card - reserves
  const parts = [
    { label: 'Bank account', amount: cash, note: 'Ledger balance' },
    { label: 'Fixed deposit', amount: deposits, note: 'At book value' },
    ...(setAsideAll > 0 ? [{ label: 'Set aside for goals', amount: setAsideAll, note: 'Ledger balance; only you can release it' }] : []),
    { label: 'Fund money in transit', amount: inTransit, note: 'Purchases awaiting units and redemptions awaiting payout' },
    { label: 'Holdings after their limits', amount: holdingsWorst, note: `Valued at ${hs.length ? 'bid or NAV' : 'nothing held'}, then reduced by each limit` },
    ...(fw.lines.length ? [{ label: 'Money held in other currencies', amount: foreign, note: `${fw.words}${fw.lines.some((l) => l.why) ? ` Not counted: ${fw.lines.filter((l) => l.why).map((l) => `${l.currency} (${l.why})`).join('; ')}.` : ''}` }] : []),
    { label: 'Credit card owed', amount: -card, note: 'Ledger balance' },
    { label: 'Due in the next 30 days', amount: -reserves, note: 'Registered bills and loan instalments' },
  ]
  return { cash, deposits, setAside: setAsideAll, inTransit, holdingsValue, holdingsWorst, foreign, card, reserves, gHat, line: profile.line, cushion: gHat - profile.line, valid: invalidReasons.length === 0, invalidReasons, illustrative, parts }
}

export interface Overview {
  asOf: number
  bank: number; bankAvailable: number; bankHeld: number
  /** Every goal's set-aside together: in the household's own paper bank, not free to use, and only the owner releases it. */
  deposits: number; setAside: number; holdingsValue: number; inTransit: number; paymentsInProgress: number
  card: number; loans: number
  /**
   * Tax already deducted at source (on a sale of a digital asset): the household's own money, a credit against its tax.
   * The net position counts it; it is named here so that a screen listing what the household has can show it, and the
   * parts add up to the net position (R13: reconcile to total assets).
   */
  taxCredit: number
  /** Net position: bank, deposits, set-asides, investments, fund money in transit, payments on the rail and the tax credit, less the card and loans. */
  netWorth: number
  /** Bank money not needed for anything already due before income is certain to arrive (liquidity.free). */
  freeToUse: number
  liquidity: Liquidity
  worst: WorstCase
  holdings: HoldingView[]
  upcoming: Commitment[]
}

export function overview(db: Db, market: Market, userId: string, now: number): Overview {
  const hs = holdings(db, market, userId, now)
  const profile = getProfile(db, userId)
  const worst = worstCase(db, market, userId, now, hs, profile)
  const bank = Number(balance(db, userId, 'bank'))
  const bankAvailable = Number(available(db, userId, 'bank'))
  const loans = Number(balance(db, userId, 'loan:personal') + balance(db, userId, 'loan:home'))
  const upcoming = commitments(db, userId, now, 30 * 86_400_000)
  const liq = liquidity(db, userId, now, {}, profile)
  const paymentsInProgress = Number(balance(db, userId, 'clear:pay'))
  const tds = Number(balance(db, userId, 'tds'))
  return {
    asOf: now, bank, bankAvailable, bankHeld: bank - bankAvailable, deposits: worst.deposits, setAside: worst.setAside, holdingsValue: worst.holdingsValue, inTransit: worst.inTransit, paymentsInProgress,
    card: worst.card, loans, taxCredit: tds, netWorth: bank + worst.deposits + worst.setAside + worst.holdingsValue + worst.inTransit + paymentsInProgress + tds - worst.card - loans,
    freeToUse: liq.free, liquidity: liq, worst, holdings: hs, upcoming,
  }
}

/** Value in paise of `qty` atoms at a price given as decimal text, rounded down. */
export function valueAt(qty: bigint, inst: Instrument, price: string): bigint {
  return notional(qty, inst.baseScale, parsePrice(price), inst.quoteScale, 'down')
}
export const paiseFromText = (s: string): bigint => parseDec(s, 2, 'half')
