/**
 * Grow: what you own and what a sale would fetch now (the price buyers offer, or the latest published NAV), how far
 * each holding could fall if its limit holds, and where that leaves your worst case against your floor; the price
 * record of anything traded or watched here; and buying and selling by hand, where an indicative price, a priced
 * estimate and a fill are three different things, each with its source and time, and the ticket says what is and is
 * not guaranteed. Design system "Meridian" (DESIGN.md M4, M6, M11).
 *
 * The page is a command grid: what the investments are worth beside the room above the floor; then each holding as one
 * card on one grid (the table's columns on a wide screen, the same rows on a phone), its figures right-aligned in
 * tabular figures and its four actions in one place under them; then the price record across the page; then the ticket
 * and its fills beside the market's prices; then the deposits and debts, and the dollar reserve on the chain. Value and
 * risk use one language everywhere: lit is what would be left if a limit held, hatched is what the limit could take,
 * QED's bracket is the room a purchase may use.
 *
 * R12 (the owner: simpler explanations, aligned cards, a phone layout designed for the phone): the sentences that
 * restated a bar's figures became the bar's own key, with each figure once; the tiles under the lead figure became that
 * key; the floor's sentence became the subtraction it describes. Performance (M11): this module draws the head, the
 * figures and the controls; the price record (PriceRecord.tsx with the chart) and the on-chain wallet's section are
 * fetched as their own chunks once those are drawn, and nothing here imports another screen.
 *
 * Live prices change in place and never move a column: every table here has a fixed layout with a reserved width for
 * each figure, every price is written at its venue's own step with the same number of decimals each time, and a
 * change shows as a small mark of its direction in space kept for it. Nothing here is a forecast; the only figures
 * worked out here are differences, sums and shares of the server's own (a change since bought, a total, a share), and
 * the average price paid for a holding (what its open lots cost, buying costs included, over its quantity).
 */
import { ArrowLeftRight, ChartLine, ChevronRight, Clock, FilePlus2, FlaskConical, Scale, Shield } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react'
import { calibrated } from '../lib/limits.ts'
import { journeyWords } from '../../shared/latency.ts'
import { api, fmt, navigate, sourceName, useData, useLocation, useNow, useQuote } from '../lib/core.ts'
import { SOURCE } from '../lib/words.ts'
import { ActionDoc, ApprovalSheet, type PendingApproval } from '../ui/instrument.tsx'
import { Paise } from '../ui/charts.tsx'
import { Basis, Btn, Field, Link, MoneyInput, Note, Problem, Stamp, StateStamp, useAction, useSession } from '../ui/kit.tsx'
import { Skel, useHashTarget } from '../ui/page.tsx'
import { atomsText, dailyWord, deskStatus, fromOf, isoDayOf, isUnits, MINUS, pctText, placesOf, quantityText, show, tickerOf, unitsWord } from '../ui/prices.ts'
import { useMedia } from '../ui/viewport.ts'
import { dayOf, dayText, istDay } from '../../shared/day-text.ts'
import { fundLine } from '../lib/fund-stages.ts'
import { navThenAllotted, OUT_OF_ORDER } from '../lib/nav-order.ts'
import type { IdeaSummary } from '../../shared/ideaTypes.ts'
import type { ActionPreview, ActionView, Annual, Holding, Home, Market, MarketInstrument, Quote } from '../lib/types.ts'

// the price record and its chart, and the on-chain wallet's section: their own chunks, asked for once the figures and
// controls above them are drawn (R12 perf, the phone profile)
const PriceRecord = lazy(() => import('./PriceRecord.tsx').then((m) => ({ default: m.PriceRecord })))
const GrowCompare = lazy(() => import('./GrowCompare.tsx').then((m) => ({ default: m.GrowCompare })))
const WalletGrowSection = lazy(() => import('./WalletInline.tsx').then((m) => ({ default: m.WalletGrowSection })))

const signedInr = (paise: number, paiseShown = true): string => (paise === 0 ? fmt.inr(0, paiseShown) : `${paise > 0 ? '+' : MINUS}${fmt.inr(Math.abs(paise), paiseShown)}`)
const signedPct = (x: number): string => (Math.abs(x) < 0.00005 ? '0.00%' : `${x > 0 ? '+' : MINUS}${(Math.abs(x) * 100).toFixed(2)}%`)

/**
 * A streamed price, updated in place. The figure does not flash, count or change colour (DESIGN.md, motion). When it
 * changes, a small mark beside it says which way, appearing once; its space is always kept, so nothing moves.
 */
function LivePrice({ inst, type, q }: { inst: MarketInstrument; type: string; q: Quote | undefined }) {
  const live = useQuote(inst.id, type)
  const price = live?.price ?? q?.price
  const last = useRef(price)
  const [tick, setTick] = useState<{ dir: 'up' | 'down'; n: number } | null>(null)
  useEffect(() => {
    const a = Number(last.current), b = Number(price)
    if (last.current !== undefined && price !== undefined && Number.isFinite(a) && Number.isFinite(b) && a !== b) setTick((t) => ({ dir: b > a ? 'up' : 'down', n: (t?.n ?? 0) + 1 }))
    last.current = price
  }, [price])
  return (
    <span className="px">
      <svg key={tick?.n ?? 0} className={`px-dir ${tick?.dir ?? ''}`} viewBox="0 0 8 8" aria-hidden="true">{tick ? <path d={tick.dir === 'up' ? 'M1.5 5.5L4 2.5L6.5 5.5' : 'M1.5 2.5L4 5.5L6.5 2.5'} /> : null}</svg>
      <span className="px-v">{price ? show(inst, price) : 'none yet'}</span>
    </span>
  )
}
/**
 * How old a price is, in words, and whether it can still be used. A published value says which day it is for ("NAV
 * for Mon 23 Nov"), with "stale" once the server says so; `short` gives the day alone, for a column headed by it.
 */
function Heard({ inst, type, q, now, short }: { inst: MarketInstrument; type: string; q: Quote | undefined; now: number; short?: boolean }) {
  const live = useQuote(inst.id, type)
  const recv = live?.recvTs ?? q?.recvTs
  if (!recv) return <span className="muted">Nothing received yet</span>
  if (q?.precision === 'day') {
    // "NAV for Mon 23 Nov": the year only when it is not this year's, as every other day on the page is written
    const day = q.sourceTs ? dayText(isoDayOf(q.sourceTs), istDay(now)) : 'an unknown day'
    return <span className={q.stale ? 'void' : 'muted'}>{short ? day : `${dailyWord(type)} for ${day}`}{q.stale ? '; stale' : ''}</span>
  }
  const age = now - recv
  // where freshness matters, the price's journey too: the source's delay to QED, and QED's to this screen (GL6)
  const journey = journeyWords({ sourceTs: live?.sourceTs ?? q?.sourceTs ?? null, recvTs: recv }, live?.shownAt)
  return <span className={age > 30_000 ? 'void' : 'muted'} title={journey}>{fmt.age(age)}{age > 30_000 ? '; stale, not usable to trade' : ''}<span className="sr-only"> {journey}</span></span>
}

// ------------------------------------------------------------------------------------------------ what the investments are worth

/**
 * The holdings at one scale: what would be left if each fell by its limit (lit), what those falls would take
 * (hatched), and a mark at what was paid. Its key (below it) carries the same figures; this says them to a screen reader.
 */
function ValueBar({ now, worst, paid }: { now: number; worst: number; paid: number }) {
  const top = Math.max(1, now, paid)
  const pc = (v: number) => `${((Math.max(0, v) / top) * 100).toFixed(3)}%`
  const fall = Math.max(0, now - worst)
  const label = `Worth ${fmt.inr(now, true)} now: ${fmt.inr(worst, true)} would be left if each holding fell by its limit, and the limits could take ${fmt.inr(fall, true)}.${paid > 0 ? ` You paid ${fmt.inr(paid, true)}.` : ''}`
  return (
    <div className="gr-vbar" role="img" aria-label={label}>
      {worst > 0 ? <span className="keep" style={{ width: pc(worst) }} /> : null}
      {fall > 0 ? <span className="fall" style={{ left: pc(worst), width: `max(3px, ${pc(fall)})` }} /> : null}
      {paid > 0 ? <span className="paid" style={{ left: pc(paid) }} /> : null}
    </div>
  )
}

/** The lead panel: what the investments would fetch now, the change since bought, and what their limits would leave. */
function Worth({ home }: { home: Home }) {
  const o = home.overview, w = o.worst
  const priced = o.holdings.filter((h) => h.value !== null)
  const paid = priced.reduce((s, h) => s + h.cost, 0)
  const gain = priced.reduce((s, h) => s + (h.value ?? 0) - h.cost, 0)
  const fall = Math.max(0, w.holdingsValue - w.holdingsWorst)
  const n = o.holdings.length
  return (
    <section className="panel gr-worth" aria-labelledby="pos-h">
      <div className="gr-lead-head">
        <h2 id="pos-h">Your investments, worth now</h2>
        <span className="gr-asof">{n === 0 ? 'Nothing held' : `${n} holding${n === 1 ? '' : 's'}`}, at the prices of {fmt.time(o.asOf, true)}</span>
      </div>
      <p className="gr-hero" data-resolve=""><Paise paise={o.holdingsValue} /></p>
      <p className="gr-hero-sub">
        {priced.length && paid > 0 ? <span className={`gr-chg ${gain < 0 ? 'loss' : gain > 0 ? 'gain' : ''}`}>{signedInr(gain)}<span className="gr-chg-pct"> ({signedPct(gain / paid)})</span> since bought</span> : null}
        {n === 0 ? <span>You hold nothing that moves with a market.</span> : null}
      </p>
      {w.holdingsValue > 0 ? <>
        <ValueBar now={w.holdingsValue} worst={w.holdingsWorst} paid={paid} />
        <dl className="gr-legend">
          <div><dt><i className="gr-sw keep" aria-hidden="true" /><Basis kind="limit" /></dt><dd>{fmt.inr(w.holdingsWorst, true)}</dd></div>
          <div><dt><i className="gr-sw fall" aria-hidden="true" /><span>The limits could take <span className="gr-legend-pct">{pctText(fall / w.holdingsValue)}</span></span></dt><dd>{fmt.inr(fall, true)}</dd></div>
          {paid > 0 ? <div><dt><i className="gr-sw paid" aria-hidden="true" />You paid, costs included</dt><dd>{fmt.inr(paid, true)}</dd></div> : null}
        </dl>
      </> : null}
      {o.inTransit > 0 ? <p className="gr-transit"><Clock aria-hidden="true" /><span><b>{fmt.inr(o.inTransit, true)}</b> more is with the fund house, {transitWords(home)}</span></p> : null}
    </section>
  )
}

/** What the money with the fund house is waiting for: units for a purchase, the bank for units redeemed, or both. */
function transitWords(home: Home): string {
  const funds = home.inFlight.filter((a) => a.instrument?.kind === 'mutual_fund')
  const buying = funds.some((a) => a.params.side !== 'sell'), redeemed = funds.some((a) => a.params.side === 'sell' && typeof a.result.allottedAt === 'number')
  if (buying && redeemed) return 'waiting for units, or from units redeemed and on its way to your bank: not valued until it is units or reaches your bank.'
  if (redeemed) return 'from units redeemed, on its way to your bank on its payout day.'
  return 'waiting for units: not valued until they are allotted.'
}

/**
 * The worst case against the floor on one rule from nothing: lit is what would be left if every holding fell by its
 * limit at once, hatched is what those falls would take, the mark is the floor, and QED's bracket is the room between
 * the floor and the worst case, which is all a purchase may use before QED refuses it. Drawn from the server's
 * valuation (`overview.worst`); the subtraction under it carries the same figures.
 */
function FloorBound({ worst, fall, floor }: { worst: number; fall: number; floor: number }) {
  const today = worst + Math.max(0, fall)
  const lo = Math.min(0, worst), hi = Math.max(today, floor, 1) * 1.03
  const at = (v: number) => (v - lo) / (hi - lo)
  const pc = (v: number) => `${(at(v) * 100).toFixed(3)}%` // a position on the rule
  const len = (v: number) => `${((Math.max(0, v) / (hi - lo)) * 100).toFixed(3)}%` // a length along it
  // a label stays inside the rule: centred on its mark, or held to the end it is near
  const place = (f: number): 'start' | 'mid' | 'end' => (f < 0.14 ? 'start' : f > 0.86 ? 'end' : 'mid')
  const below = worst < floor
  const base = Math.max(0, worst)
  return (
    <div className="gr-rule" aria-hidden="true">
      <div className="gr-rule-top"><span className={`gr-rule-lab ${place(at(worst))}`} style={{ left: pc(worst) }}>Worst case</span></div>
      <div className="gr-rule-bar">
        {worst > 0 ? <span className={`keep ${below ? 'below' : ''}`} style={{ left: pc(0), width: len(worst) }} /> : null}
        {fall > 0 ? <span className="fall" style={{ left: pc(base), width: `max(2px, ${len(fall)})` }} /> : null}
        {below ? <span className="short" style={{ left: pc(base), width: len(floor - base) }} /> : <span className="room" style={{ left: pc(floor), width: len(worst - floor) }} />}
        <span className="floor" style={{ left: pc(floor) }} />
      </div>
      <div className="gr-rule-foot">
        {at(floor) > 0.3 ? <span className="gr-rule-lab start" style={{ left: '0%' }}>{lo < 0 ? fmt.inr(lo) : '₹0'}</span> : null}
        <span className={`gr-rule-lab ${place(at(floor))}`} style={{ left: pc(floor) }}>Your floor</span>
      </div>
    </div>
  )
}

/** The room above the floor: the figure, the rule, the subtraction it comes from, and how the worst case adds up. */
function Floor({ home }: { home: Home }) {
  const w = home.overview.worst
  const fall = Math.max(0, w.holdingsValue - w.holdingsWorst)
  const above = w.cushion >= 0
  const shown = w.parts.filter((p) => p.amount !== 0 || p.label === 'Bank account')
  return (
    <section className="panel gr-floor" aria-labelledby="floor-h">
      <div className="gr-lead-head">
        <h2 id="floor-h"><i className={`gr-sw ${above ? 'room' : 'short'}`} aria-hidden="true" />{above ? 'Above your floor' : 'Below your floor'}</h2>
        <span className="gr-asof">Checked before every purchase</span>
      </div>
      <p className={`gr-lead ${above ? '' : 'loss'}`} data-resolve="">{above ? null : MINUS}<Paise paise={Math.abs(w.cushion)} /></p>
      <p className="gr-lead-sub">{above ? 'What purchases may use. QED refuses one that would take your worst case below your floor.' : 'QED refuses any purchase that would lower your worst case further.'}</p>
      <FloorBound worst={w.gHat} fall={fall} floor={w.line} />
      {/* the subtraction as rows; the operators are said as words to a screen reader */}
      <dl className="gr-eq">
        <div><dt><i className="gr-sw keep" aria-hidden="true" />Your worst case</dt><dd>{fmt.inr(w.gHat, true)}</dd></div>
        <div><dt><span className="gr-op" aria-hidden="true">{MINUS}</span><span className="sr">minus </span>Your floor</dt><dd>{fmt.inr(w.line, true)}</dd></div>
        <div className="sum"><dt><span className="gr-op" aria-hidden="true">=</span><span className="sr">equals </span>{above ? 'Above your floor' : 'Below your floor'}</dt><dd className={above ? '' : 'loss'}>{above ? '' : MINUS}{fmt.inr(Math.abs(w.cushion), true)}</dd></div>
      </dl>
      <p className="gr-floor-what"><b>Worst case:</b> your bank, deposits and holdings at their limits, less the card and what is due in 30 days.</p>
      {!w.valid ? <Note tone="void" title="This figure cannot be relied on right now">{w.invalidReasons.join('. ')}. While that lasts QED refuses purchases that depend on it.</Note> : null}
      <details className="gr-parts">
        <summary>How your worst case adds up</summary>
        <table className="ledger fixed gr-parts-t">
          <caption className="sr">Your worst case, part by part</caption>
          <colgroup><col /><col className="c-sum" /></colgroup>
          <tbody>{shown.map((p) => <tr key={p.label}><th scope="row">{p.label}<span className="sub">{p.note}</span></th><td className="num">{p.amount < 0 ? `${MINUS}${fmt.inr(-p.amount, true)}` : fmt.inr(p.amount, true)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">Your worst case</th><td className="num">{fmt.inr(w.gHat, true)}</td></tr></tfoot>
        </table>
        <p className="gr-parts-foot"><Link to="/safeguards#floor">The worst case, line by line, and your floor<ChevronRight aria-hidden="true" /></Link></p>
      </details>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ what you hold

/** What a holding's limit could take, drawn as a share of its value now: lit is what would be left, hatched the fall. */
function RiskBar({ value, worst }: { value: number | null; worst: number | null }) {
  const keep = value && value > 0 && worst !== null ? Math.max(0, Math.min(1, worst / value)) : null
  return (
    <span className={`gr-risk ${keep === null ? 'none' : ''}`} aria-hidden="true">
      {keep === null ? null : <><i className="keep" style={{ width: `${(keep * 100).toFixed(2)}%` }} /><i className="fall" style={{ width: `${((1 - keep) * 100).toFixed(2)}%` }} /></>}
    </span>
  )
}

/**
 * How a holding's limit was set, one press away (the same button and note as the page's other definitions): a limit
 * measured from past prices says how, in the server's words; an illustrative one says it is not measured. Neither is a
 * worst case.
 */
function LimitWords({ h }: { h: Holding }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const cal = calibrated(h.limitStatus)
  return (
    <span className="basis-wrap gr-limit-words">
      <button type="button" className={`basis ${cal ? '' : 'gr-illus'}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}>{cal ? 'measured from past prices' : 'illustrative, not calibrated'}</button>
      {open ? <span id={id} role="note" className="basis-pop">{cal ? `Not a worst case: a larger fall has happened. ${h.limitNote.replace(/^./, (c) => c.toUpperCase())}.` : 'An illustration, not measured from past prices. Your worst case counts it, so that figure is illustrative too.'}</span> : null}
    </span>
  )
}

/** A holding's four actions, in one place and one order on every holding and at every width. */
function HoldingActions({ h, inst, onChart }: { h: Holding; inst: MarketInstrument | undefined; onChart: (id: string) => void }) {
  return (
    <div className="gr-h-acts" role="group" aria-label={`Act on ${h.name}`}>
      <Link className="btn sm" to={`/holdings?buy=${h.instrumentId}#ticket`}>Buy more<span className="sr"> {h.name}</span></Link>
      <Link className="btn sm" to={`/holdings?sell=${h.instrumentId}#ticket`}>{h.kind === 'mutual_fund' ? 'Redeem' : 'Sell'}<span className="sr"> {h.name}</span></Link>
      {inst ? <button type="button" className="btn sm" onClick={() => onChart(h.instrumentId)}><ChartLine aria-hidden="true" />Price history<span className="sr">: {h.name}</span></button> : null}
      <Link className="btn sm" to="/instructions/new?kind=exit"><Shield aria-hidden="true" />Protect it<span className="sr"> with an instruction that sells {h.name} if its price falls</span></Link>
    </div>
  )
}

/** One holding's figures, worked out once for the table and the cards. */
function viewOf(h: Holding, inst: MarketInstrument | undefined, now: number) {
  const gain = h.value === null ? null : h.value - h.cost
  const type = h.priceType ?? (h.kind === 'mutual_fund' ? 'nav' : 'bid')
  const daily = inst?.quotes[type]?.precision === 'day'
  const qty = `${quantityText(h.qty, placesOf(h.kind, inst, h.baseScale))} ${unitsWord(h.kind, h.asset)}`
  const price = inst ? <LivePrice inst={inst} type={type} q={inst.quotes[type]} /> : <span>No price</span>
  // a live price says whose price it is and how old; a published one, the day it is for
  const priceWhat = inst ? (daily ? <Heard inst={inst} type={type} q={inst.quotes[type]} now={now} /> : <>Buyers offer, <Heard inst={inst} type={type} q={inst.quotes[type]} now={now} /></>) : null
  const worst = h.worst === null ? 'Unknown' : fmt.inr(h.worst, true)
  const share = h.value && h.value > 0 && h.worst !== null ? (h.value - h.worst) / h.value : h.limit
  return { gain, qty, price, priceWhat, worst, share, held: h.held !== '0' ? `${h.held} held by an order in progress` : null, bought: boughtLine(h, inst, now) }
}

// ------------------------------------------------------------------------------------------------ what it was bought at, and why it changed

/** A day as one word on the page ("Tue 24 Nov" never breaks across lines). */
const Day = ({ children }: { children: string }) => <span className="gr-nb">{children}</span>
/** "from Mon 2 Nov to Wed 25 Nov", or "on Wed 25 Nov" when it is one day. */
const between = (a: number, b: number, now: number): ReactNode => (istDay(a) === istDay(b) ? <>on <Day>{dayOf(a, now)}</Day></> : <>from <Day>{dayOf(a, now)}</Day> to <Day>{dayOf(b, now)}</Day></>)
/** A price a holding was bought at, as its prices are written on this page; a fund's NAV to four places. */
const atPrice = (inst: MarketInstrument | undefined, price: string): string => (inst ? show(inst, price) : `₹${price}`)
const perUnit = (h: Holding): string => (h.kind === 'mutual_fund' || isUnits(h.kind) ? 'a unit' : `per ${h.asset}`)

/**
 * What a holding was bought at (R12 task comparison, T4-b), from its open purchases: one purchase says its price, its NAV
 * day and the day its units were allotted ("Bought at ₹178.6000 a unit, the NAV for Tue 24 Nov; allotted Wed 25 Nov");
 * several say the average over the units held, and each is one press away (Each purchase). The two days are only ever
 * shown in the order they happen (R13): a record that puts the allotment first has it left out, and says so.
 */
export function boughtLine(h: Holding, inst: MarketInstrument | undefined, now: number): ReactNode {
  const s = h.story
  if (!s?.boughtAt || !s.purchases.length) return null
  const fund = h.kind === 'mutual_fund'
  const price = atPrice(inst, s.boughtAt.price)
  if (s.purchases.length === 1) {
    const p = s.purchases[0]!
    if (!fund) return <>Bought at {price} {perUnit(h)}, <Day>{dayOf(p.at, now)}</Day></>
    // R13: the NAV's day, then the allotment day, only ever in that order (src/lib/nav-order.ts)
    const d = navThenAllotted(p.navDate, p.at, now)
    return <>Bought at {price} a unit, the NAV for <Day>{d.nav ?? 'its day'}</Day>; {d.allotted ? <>allotted <Day>{d.allotted}</Day></> : OUT_OF_ORDER}</>
  }
  const inOrder = !fund || s.purchases.every((p) => navThenAllotted(p.navDate, p.at, now).inOrder)
  return <>Bought at {price} {perUnit(h)} on average, in {s.purchases.length} purchases{inOrder ? <> {fund ? 'allotted ' : ''}{between(s.boughtAt.first, s.boughtAt.last, now)}</> : <>; {OUT_OF_ORDER} for one of them</>}</>
}

/** Why there is an annual rate or not, and its method, in words. */
export function annualWords(an: Annual): { figure: string | null; says: string } {
  const method = 'money-weighted: an XIRR, the yearly rate at which the money you put in and took out, on the days it moved, would grow to what it is worth today'
  if (an.rate !== null) return { figure: `${signedPct(an.rate)} a year`, says: `${method[0]!.toUpperCase()}${method.slice(1)}. A record of what happened, not a forecast.` }
  switch (an.reason) {
    case 'young': return { figure: null, says: `Not shown until you have held it for a year (${an.heldDays} day${an.heldDays === 1 ? '' : 's'} so far): over a shorter time a yearly rate is mostly a few days' price movement multiplied up. When shown, it is ${method}.` }
    case 'several': return { figure: null, says: 'Not shown: more than one yearly rate fits the money that went in and out, so none can be called its rate.' }
    case 'none': case 'one-sided': return { figure: null, says: 'Not shown: no yearly rate fits the money that went in and out.' }
    case 'no-price': return { figure: null, says: 'Not shown until it has a price.' }
    default: return { figure: null, says: 'Not shown: this holding\'s records do not add up, so no figure is worked out from them.' }
  }
}

/**
 * Why a holding changed (R12 task comparison, T4-c): since it was first bought, three lines from the ledger that add up
 * exactly to its change in value, from nothing to what it is worth now (server/performance.ts): the money put in less
 * the money taken out, the price movement on the units while they were held, and the costs. Then the annual rate, with
 * its method named, or why it is not shown. And, with several purchases, each one: its day, units, price and cost.
 */
export function HoldingStory({ h, inst, now }: { h: Holding; inst: MarketInstrument | undefined; now: number }) {
  const s = h.story
  if (!s) return null
  const w = s.why, fund = h.kind === 'mutual_fund'
  const an = annualWords(s.annual)
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const costParts = w ? [
    w.stamp ? `stamp duty ${fmt.inr(w.stamp, true)}` : '',
    w.fees ? `${fund ? 'exit load' : 'venue fees'} ${fmt.inr(w.fees, true)}` : '',
    w.taxes ? `tax deducted at source ${fmt.inr(w.taxes, true)}, which counts toward your income tax` : '',
    w.rounding ? `${w.rounding > 0 ? 'rounding' : 'rounding in your favour'} ${fmt.inr(Math.abs(w.rounding), true)}${fund ? ' (units are allotted in thousandths, money in paise)' : ' (money in paise)'}` : '',
  ].filter(Boolean) : []
  const several = s.purchases.length > 1
  return (
    <div className="gr-story">
      <details className="gr-why">
        <summary>Why it changed<span className="sr">: {h.name}</span></summary>
        {w ? <>
          <p className="gr-why-since">Since you first bought it, <Day>{dayOf(w.since, now)}</Day>: from nothing to {fmt.inr(w.change, true)} now.{w.sells ? ` These lines count the units you ${fund ? 'redeemed' : 'sold'} too, while you held them; "Since bought" counts only the units you still hold.` : ''}</p>
          <dl className="gr-why-lines">
            <div><dt>{w.takenOut ? 'Money you put in, less money taken out' : 'Money you put in'}<span className="sub">{fmt.inr(w.added, true)} in {plural(w.buys, 'purchase', 'purchases')}{w.takenOut ? `; ${fmt.inr(w.takenOut, true)} taken out in ${plural(w.sells, fund ? 'redemption' : 'sale', fund ? 'redemptions' : 'sales')}` : ''}</span></dt><dd className="gr-n">{signedInr(w.flows)}</dd></div>
            <div><dt>Price movement on the units you held<span className="sub">{fund ? 'Each change in the NAV' : 'Each change in the price'}, on what you held at the time</span></dt><dd className={`gr-n ${w.movement < 0 ? 'loss' : w.movement > 0 ? 'gain' : ''}`}>{signedInr(w.movement)}</dd></div>
            <div><dt>Costs: fees, stamp duty and taxes<span className="sub">{costParts.length ? `${costParts.join('; ')}.` : 'None.'}</span></dt><dd className="gr-n">{w.costs ? `${MINUS}${fmt.inr(w.costs, true)}` : fmt.inr(0, true)}</dd></div>
            <div className="sum"><dt><span className="sr">Adding up to the </span>Change in value</dt><dd className="gr-n">{signedInr(w.change)}</dd></div>
          </dl>
          <p className="gr-why-rate">{an.figure ? <><b className="gr-n">{an.figure}</b><span className="sr">. </span> </> : <b>Annual rate. </b>}{an.says}</p>
        </> : <p className="gr-why-since">{s.annual.reason === 'no-price' ? 'Worked out once it has a price.' : 'Not worked out: this holding\'s records do not add up, so no figure is drawn from them.'}</p>}
      </details>
      {several ? (
        <details className="gr-lots">
          <summary>Each purchase ({s.purchases.length})<span className="sr">: {h.name}</span></summary>
          <ol className="gr-lot-list">{s.purchases.map((p, i) => {
            const held = quantityText(atomsText(p.held, h.baseScale), placesOf(h.kind, inst, h.baseScale)), bought = quantityText(atomsText(p.bought, h.baseScale), placesOf(h.kind, inst, h.baseScale))
            return (
              <li key={`${p.at}-${p.price}-${i}`}>
                <span className="gr-lot-what">{(() => {
                  const d = fund ? navThenAllotted(p.navDate, p.at, now) : null
                  const lead = d && !d.inOrder ? `NAV for ${d.nav}` : `${dayOf(p.at, now)}${fund ? '' : `, ${fmt.time(p.at)}`}`
                  return <><b>{lead}</b> {held}{p.held !== p.bought ? ` of ${bought}` : ''} {fund ? 'units' : h.asset} at {atPrice(inst, p.price)}{d?.inOrder && d.nav ? `, the NAV for ${d.nav}` : ''}{d && !d.inOrder ? `; ${OUT_OF_ORDER}` : ''}</>
                })()}</span>
                <span className="gr-lot-cost gr-n">{fmt.inr(p.cost, true)}<span className="sr"> paid for the units still held, costs included</span></span>
              </li>
            )
          })}</ol>
          <p className="gr-lot-foot">What each cost, costs included, for the units you still hold; together {fmt.inr(h.cost, true)}.</p>
        </details>
      ) : null}
    </div>
  )
}

/**
 * The holdings on one grid. On a wide screen, a ruled table: what it is (and how much), the price with its source and
 * age, its value, the change since bought, what it would be worth if its limit held, and the limit drawn as a bar on
 * one scale, so bars line up with their rows and with each other; each holding's actions in one row under its figures.
 * Narrower, the same holdings as cards on one grid: the name and the value on one baseline, then the price, the value
 * if limits hold and the limit as rows with their figures right-aligned, then the four actions in two even rows.
 */
function Holdings({ home, market, now, onChart }: { home: Home; market: Market; now: number; onChart: (id: string) => void }) {
  const o = home.overview
  const wide = useMedia('(min-width: 1100px)')
  const instOf = (id: string): MarketInstrument | undefined => market.instruments.find((i) => i.id === id)
  const priced = o.holdings.filter((h) => h.value !== null)
  const total = priced.reduce((s, h) => s + (h.value ?? 0), 0)
  const totalWorst = priced.reduce((s, h) => s + (h.worst ?? 0), 0)
  const totalGain = priced.reduce((s, h) => s + (h.value ?? 0) - h.cost, 0)
  const totalPaid = priced.reduce((s, h) => s + h.cost, 0)
  const limitBar = (value: number | null, worst: number | null, share: number) => <span className="gr-lim-line"><RiskBar value={value} worst={worst} /><span className="gr-n">{pctText(share)}</span></span>
  return (
    <section className="panel gr-hold-panel" aria-labelledby="h-own">
      <div className="panel-head"><h2 id="h-own">What you hold</h2><p>Worth {fmt.inr(o.holdingsValue, true)} now</p></div>
      {o.holdings.length === 0 ? (
        <div className="gr-empty"><p><b>You hold nothing yet.</b> Buy something with the ticket below, or <Link to="/instructions/new?kind=invest">write an instruction to invest regularly</Link>.</p></div>
      ) : wide ? (
        <table className="ledger fixed gr-hold">
          <caption className="sr">Your holdings: each with its quantity, the price with its source and age, the value now, the change since bought, the value if it fell by its limit, and the limit; each holding's actions follow its row</caption>
          <thead><tr>
            <th scope="col" className="c-name">Holding</th>
            <th scope="col" className="num c-px">Price</th>
            <th scope="col" className="num c-val">Value now</th>
            <th scope="col" className="num c-chg">Since bought</th>
            <th scope="col" className="num c-worst">If limits hold</th>
            <th scope="col" className="num c-lim">Could fall</th>
          </tr></thead>
          <tbody>{o.holdings.flatMap((h) => {
            const inst = instOf(h.instrumentId)
            const v = viewOf(h, inst, now)
            return [
              <tr key={h.instrumentId} className="gr-h-row">
                <th scope="row" className="c-name"><span className="gr-h-name">{h.name}</span><span className="sub">{tickerOf({ id: h.instrumentId, kind: h.kind })} · {v.qty}</span>{v.bought ? <span className="sub gr-bought">{v.bought}</span> : null}{v.held ? <span className="sub">{v.held}</span> : null}</th>
                <td className="num c-px"><span className="gr-n">{v.price}</span><span className="sub">{v.priceWhat}</span>{inst ? <span className="sub">From {fromOf(inst, h.priceType ?? 'bid')}</span> : null}</td>
                <td className="num c-val"><span className="gr-n gr-val">{h.value === null ? 'No price' : fmt.inr(h.value, true)}</span></td>
                <td className="num c-chg">{v.gain === null ? <span className="gr-n">None</span> : <><span className={`gr-n ${v.gain < 0 ? 'loss' : 'gain'}`}>{signedInr(v.gain)}</span><span className="sub">{h.cost > 0 ? `${signedPct(v.gain / h.cost)} on ${fmt.inr(h.cost, true)}` : ''}</span></>}</td>
                <td className="num c-worst"><span className="gr-n">{v.worst}</span></td>
                <td className="num c-lim">{limitBar(h.value, h.worst, v.share)}<span className="sub"><LimitWords h={h} /></span></td>
              </tr>,
              <tr key={`${h.instrumentId}-act`} className="gr-h-act"><td colSpan={6}><HoldingStory h={h} inst={inst} now={now} /><HoldingActions h={h} inst={inst} onChart={onChart} /></td></tr>,
            ]
          })}</tbody>
          {o.holdings.length > 1 ? (
            <tfoot><tr>
              <th scope="row" className="c-name">All holdings</th>
              <td className="c-px" />
              <td className="num c-val"><span className="gr-n gr-val">{fmt.inr(total, true)}</span></td>
              <td className="num c-chg"><span className={`gr-n ${totalGain < 0 ? 'loss' : 'gain'}`}>{signedInr(totalGain)}</span>{totalPaid > 0 ? <span className="sub">{signedPct(totalGain / totalPaid)} on {fmt.inr(totalPaid, true)}</span> : null}</td>
              <td className="num c-worst"><span className="gr-n">{fmt.inr(totalWorst, true)}</span></td>
              <td className="num c-lim">{limitBar(total, totalWorst, total > 0 ? (total - totalWorst) / total : 0)}</td>
            </tr></tfoot>
          ) : null}
        </table>
      ) : (
        <ul className="gr-cards">{o.holdings.map((h) => {
          const inst = instOf(h.instrumentId)
          const v = viewOf(h, inst, now)
          return (
            <li key={h.instrumentId} className="gr-card">
              <div className="gr-card-top">
                <h3 className="gr-card-name">{h.name}</h3>
                <p className="gr-card-v">{h.value === null ? 'No price' : fmt.inr(h.value, true)}<span className="sr"> worth now</span></p>
                <p className="sub gr-card-code">{tickerOf({ id: h.instrumentId, kind: h.kind })} · {v.qty}</p>
                {v.bought ? <p className="sub gr-bought">{v.bought}</p> : null}
              </div>
              <dl className="gr-card-facts">
                <div><dt>Price</dt><dd><span className="gr-n">{v.price}</span><span className="sub">{v.priceWhat}</span></dd></div>
                <div><dt>Since bought</dt><dd>{v.gain === null ? <span className="gr-n">Not valued yet</span> : <span className={`gr-n ${v.gain < 0 ? 'loss' : 'gain'}`}>{signedInr(v.gain)}{h.cost > 0 ? ` (${signedPct(v.gain / h.cost)})` : ''}</span>}<span className="sub">on {fmt.inr(h.cost, true)} paid, costs included</span></dd></div>
                <div><dt>If limits hold</dt><dd><span className="gr-n">{v.worst}</span></dd></div>
                <div><dt>Could fall</dt><dd>{limitBar(h.value, h.worst, v.share)}<span className="sub"><LimitWords h={h} /></span></dd></div>
              </dl>
              {v.held ? <p className="sub gr-card-held">{v.held}</p> : null}
              <HoldingStory h={h} inst={inst} now={now} />
              <HoldingActions h={h} inst={inst} onChart={onChart} />
            </li>
          )
        })}</ul>
      )}
      {o.inTransit > 0 || home.inFlight.some((a) => a.instrument?.kind === 'mutual_fund') ? <FundsWaiting home={home} now={now} /> : null}
    </section>
  )
}

/**
 * Money with a fund house and not yet units, and units redeemed and not yet paid: each order with where it stands, in
 * the registrar's own states (with the registrar, money received with its day, redeemed) and when its units or money come.
 */
function FundsWaiting({ home, now }: { home: Home; now: number }) {
  const waiting = home.inFlight.filter((a) => a.instrument?.kind === 'mutual_fund' && a.state !== 'planned' && a.state !== 'awaiting_approval')
  return (
    <div className="gr-waiting" id="funds-waiting">
      <p className="gr-waiting-h"><Clock aria-hidden="true" /><span>{home.overview.inTransit > 0 ? <><b>{fmt.inr(home.overview.inTransit, true)}</b> is with the fund house. </> : null}Fund orders in progress, each where it stands:</span></p>
      <ul>{waiting.map((a) => <li key={a.id}><Link to={`/record/${a.id}`}>{a.what}</Link>: {fundLine(a, now)}</li>)}</ul>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ the ticket

/** What a ticket promises, for the kind of order it is: what the venue is held to, and what nobody can promise. */
function promiseOf(fund: boolean, side: 'buy' | 'sell', type: 'market' | 'limit' | 'stop', slip: number, cutoff: string, security = false): { yes: string; no: string } {
  if (security) return { yes: `It fills at the price shown when it is sent, in whole lots, with every cost inside the amount you enter${side === 'buy' ? '' : ' (a sale pays out less its costs)'}, or it is refused.`, no: `The price, which moves; that the market is open (out of hours it is refused, not held); and that ${side === 'sell' ? 'the money arrives at once: it reaches your bank the next business day' : 'it is not a loss: the price can fall the moment after'}.` }
  const pc = `${(slip / 100).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`
  const budget = side === 'buy' ? ` A buy never spends more than you enter, ${fund ? 'stamp duty' : 'fee'} included.` : ''
  if (fund) return { yes: `The NAV for its own day, whatever that NAV is.${budget}`, no: `That NAV, and so how many units ${side === 'buy' ? 'you get' : 'you are paid for'}: it is published after the ${cutoff} India time cut-off.` }
  if (type === 'limit') return { yes: `It fills only at your price or better.${budget}`, no: 'That it fills at all: what does not fill waits for your price, or until you cancel it.' }
  if (type === 'stop') return { yes: `Nothing is sold until buyers offer your level or less; then it fills only within ${pc} of the best price, and the rest is cancelled.`, no: 'The price it sells at, or that it fills.' }
  return { yes: `It fills only within ${pc} of the best price when it is sent; what cannot fill inside that is cancelled.${budget}`, no: 'The prices shown here or in the estimate, or that all of it fills.' }
}

function Ticket({ market, home, onDone, preset, onPick }: { market: Market; home: Home; onDone: (actionId: string) => void; preset: { id?: string; side?: string }; onPick: (id: string) => void }) {
  const now = useNow(1000)
  const tradable = market.instruments.filter((i) => i.tradable)
  const [id, setId] = useState(preset.id ?? 'amfi:120716')
  const [side, setSide] = useState<'buy' | 'sell'>(preset.side === 'sell' ? 'sell' : 'buy')
  const [amount, setAmount] = useState<number | null>(100_000)
  const [qty, setQty] = useState('')
  const [all, setAll] = useState(false)
  const [type, setType] = useState<'market' | 'limit' | 'stop'>('market')
  const [price, setPrice] = useState('')
  const [slip, setSlip] = useState(100)
  const [pv, setPv] = useState<(PendingApproval & ActionPreview) | null>(null)
  const inst = tradable.find((i) => i.id === id)
  const fund = inst?.kind === 'mutual_fund'
  const security = !!inst && isUnits(inst.kind)
  const desk = inst && security ? deskStatus(inst, now) : null
  const held = home.overview.holdings.find((h) => h.instrumentId === id)
  const w = home.overview.worst
  const preview = useAction(async () => {
    const body: Record<string, unknown> = { kind: 'order', instrumentId: id, side }
    if (side === 'buy') body.amount = amount ?? 0
    else if (all) body.sellAll = true
    else body.qty = qty.trim()
    if (security) body.type = 'market'
    else if (!fund) { body.type = type; body.maxSlippageBps = slip; if (type === 'limit') body.limitPrice = price.replace(/[,\s]/g, ''); if (type === 'stop') body.stopPrice = price.replace(/[,\s]/g, '') }
    setPv(await api<PendingApproval & ActionPreview>('POST', '/api/actions/preview', body))
  })
  const f = preview.error?.fields ?? {}
  const promise = promiseOf(!!fund, side, type, slip, String(inst?.meta.cutoff ?? '15:00'), security)
  return (
    <form className="ticket" aria-labelledby="h-ticket" onSubmit={(e) => { e.preventDefault(); void preview.run() }}>
      <Field label="What" error={f.instrumentId}>{(p) => (
        <select {...p} className="input" value={id} onChange={(e) => { setId(e.target.value); setType('market'); onPick(e.target.value) }}>
          <optgroup label="Mutual funds (priced once a day at NAV)">{tradable.filter((i) => i.kind === 'mutual_fund').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
          <optgroup label="ETFs (synthetic prices, whole units)">{tradable.filter((i) => i.kind === 'etf').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
          <optgroup label="Shares (synthetic prices)">{tradable.filter((i) => i.kind === 'equity').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
          <optgroup label="Government bills and bonds (synthetic prices, lots of 100 units)">{tradable.filter((i) => i.kind === 'tbill' || i.kind === 'gsec').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
          <optgroup label="Digital assets (live order book, in rupees)">{tradable.filter((i) => i.kind === 'crypto_spot').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
        </select>)}</Field>
      {/* a phone's select cuts a long fund name short and cannot wrap it: the whole name is written under it (the select itself announces it) */}
      {inst && inst.name.length > 28 ? <p className="tk-full small muted" aria-hidden="true">{inst.name}</p> : null}
      {inst ? (
        <div className="tk-now">
          <p className="tk-stage"><b>Indicative, now</b><span>{fund ? `From ${fromOf(inst, 'nav')}. Your order gets the NAV for its own day.` : security ? `From ${fromOf(inst, 'bid')}. One price a side, not reserved for you. ${desk!.open ? 'The market is open' : 'The market is closed'}: it trades ${desk!.hours}; holidays are not known here.` : `${fromOf(inst, 'bid')}'s order book, not reserved for you.`}</span></p>
          <dl className="ticket-quote">
            {fund ? <><div><dt>Latest NAV</dt><dd><LivePrice inst={inst} type="nav" q={inst.quotes.nav} /></dd></div><div className="age"><dt className="sr">Published</dt><dd><Heard inst={inst} type="nav" q={inst.quotes.nav} now={now} /></dd></div></>
              : <><div><dt>Buyers offer</dt><dd><LivePrice inst={inst} type="bid" q={inst.quotes.bid} /></dd></div><div><dt>Sellers ask</dt><dd><LivePrice inst={inst} type="ask" q={inst.quotes.ask} /></dd></div><div className="age"><dt className="sr">Heard</dt><dd><Heard inst={inst} type="bid" q={inst.quotes.bid} now={now} /></dd></div></>}
          </dl>
        </div>
      ) : null}
      <div className="field"><span className="legend">Do</span><div className="seg ticket-side" role="group" aria-label="Buy or sell">
        <button type="button" aria-pressed={side === 'buy'} onClick={() => { setSide('buy'); if (type === 'stop') setType('market') }}>Buy</button>
        <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>{fund ? 'Redeem' : 'Sell'}</button></div></div>
      {side === 'buy'
        ? <Field label="With how much" error={f.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        : <div className="form-grid">
            <Field label={fund || security ? (inst?.kind === 'equity' ? 'How many shares' : 'How many units') : `How much ${inst?.base ?? ''}`} hint={held ? `You hold ${held.qty}${held.held !== '0' ? `, of which ${held.held} is reserved` : ''}.` : 'You hold none of this.'} error={f.qty}>{(p) => <input {...p} className="input" inputMode="decimal" value={all ? '' : qty} disabled={all} onChange={(e) => setQty(e.target.value)} />}</Field>
            <label className="check ticket-all"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything free to sell</label>
          </div>}
      {!fund && !security ? <div className="form-grid">
        <Field label="How">{(p) => <select {...p} className="input" value={type} onChange={(e) => setType(e.target.value as 'market' | 'limit' | 'stop')}><option value="market">Now, at the prices on the book</option><option value="limit">Only at my price or better</option>{side === 'sell' ? <option value="stop">Later, if the price falls to a level</option> : null}</select>}</Field>
        {type !== 'market' ? <Field label={type === 'limit' ? 'My price, in rupees' : 'Sell when buyers offer this or less'} error={f.limitPrice ?? f.stopPrice}>{(p) => <input {...p} className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field> : null}
        {type !== 'limit' ? <Field label="Worst price to accept" hint="Away from the best price at that moment. What cannot fill inside it is cancelled.">{(p) => <select {...p} className="input" value={slip} onChange={(e) => setSlip(Number(e.target.value))}><option value={50}>0.5%</option><option value={100}>1%</option><option value={200}>2%</option><option value={500}>5%</option></select>}</Field> : null}
      </div> : null}
      {side === 'buy' ? <p className="small muted ticket-floor"><i className={`gr-sw ${w.cushion >= 0 ? 'room' : 'short'}`} aria-hidden="true" />{w.cushion >= 0 ? <>QED refuses a purchase that would take your worst case below your floor: {fmt.inr(w.cushion, true)} of room now. The estimate shows the room after this order.</> : <>Your worst case is {fmt.inr(-w.cushion, true)} below your floor, so QED refuses a purchase that lowers it further.</>}</p> : null}
      {preview.error && Object.keys(f).length === 0 ? <Problem error={preview.error} /> : null}
      <div className="tk-go"><Btn tone="fill" type="submit" busy={preview.busy}>See what this would do</Btn><span className="small muted">An estimate at current prices. Nothing is sent until you approve it with your passkey.</span></div>
      <dl className="tk-promise">
        <div><dt>Guaranteed</dt><dd>{promise.yes}</dd></div>
        <div><dt>Not guaranteed</dt><dd>{promise.no}</dd></div>
      </dl>
      <ApprovalSheet approval={pv} title="Approve this order" action="Approve and send" onClose={() => setPv(null)}
        onApproved={async (approvalId) => { const a = await api<{ id: string }>('POST', '/api/actions', { approvalId }); setPv(null); onDone(a.id) }}>
        {pv ? <><ActionDoc summary={pv.summary} lines={pv.lines} warnings={pv.warnings} worst={pv.worst} />{pv.quote ? <QuoteAge q={pv.quote} /> : null}</> : null}
      </ApprovalSheet>
    </form>
  )
}

/**
 * The owner's own orders, newest first: what filled, at what time, against whose book, and what is still waiting. A
 * fill is the venue's answer, not an estimate; each opens its record with the fills and the book they met.
 */
function Fills({ market }: { market: Market }) {
  const act = useData<{ actions: ActionView[] }>('/api/activity?limit=40', ['action'])
  const orders = (act.data?.actions ?? []).filter((a) => a.kind === 'order' && a.origin === 'owner').slice(0, 3)
  const instOf = (id: string | undefined): MarketInstrument | undefined => market.instruments.find((i) => i.id === id)
  return (
    <section className="panel gr-fills" aria-labelledby="fills-h">
      <div className="panel-head"><h2 id="fills-h">Your fills</h2><p>Orders you placed by hand, newest first</p></div>
      {!act.data ? (act.error ? <Problem error={act.error} /> : <Skel h={64} r={14} />) : orders.length === 0 ? <p className="small muted">None yet. A filled order shows its quantity, amount, time and the book it met, here and on its record.</p> : (
        <ul className="tk-fill-list">{orders.map((a) => {
          const unit = a.instrument ? unitsWord(a.instrument.kind, a.instrument.baseAsset) : ''
          const filled = Number(a.result.filledQty ?? 0) > 0
          const qty = atomsText(String(a.result.filledQty ?? '0'), a.instrument?.baseScale ?? 0)
          const amount = Number(a.result.filledAmount ?? 0), fees = Number(a.result.fees ?? 0) + Number(a.result.taxes ?? 0)
          const at = a.times.executed ?? a.times.finished
          const inst = instOf(a.instrument?.id)
          const book = a.instrument?.kind === 'mutual_fund' ? 'at the fund house\'s published NAV' : `on paper against ${inst ? fromOf(inst, a.params.side === 'buy' ? 'ask' : 'bid') : 'the venue'}'s order book`
          return (
            <li key={a.id}>
              <div className="tk-fill-top"><Link to={`/record/${a.id}`}>{a.what}</Link><StateStamp state={a.state} recon={a.reconState} /></div>
              <p className="small muted">{filled
                ? <>{a.params.side === 'sell' ? 'Sold' : 'Bought'} <b className="gr-n">{qty} {unit}</b> for <b className="gr-n">{fmt.inr(amount, true)}</b>{fees ? <>, fees and taxes {fmt.inr(fees, true)}</> : null}; filled {at ? `${fmt.day(at)}, ${fmt.time(at, true)}` : ''} {book}.</>
                : a.state === 'working' || a.state === 'submitting' || a.state === 'planned' ? <>{a.instrument?.kind === 'mutual_fund' && a.state !== 'planned' ? fundLine(a, Date.now()) : 'Not filled yet.'}</>
                  : <>Nothing filled{a.error ? `: ${a.error}` : '.'}</>}</p>
            </li>
          )
        })}</ul>
      )}
      <div className="panel-foot"><Link to="/activity">Every order and payment, with the checks behind each</Link></div>
    </section>
  )
}

/** When an estimate was priced and from where, and how long it holds (R7-094); signing is refused once it has lapsed. */
function QuoteAge({ q }: { q: NonNullable<ActionPreview['quote']> }) {
  const now = useNow(1000)
  const left = q.validUntil === null ? null : q.validUntil - now
  return <>
    <p className={`small ${left !== null && left <= 0 ? 'void' : 'muted'}`} role="status">Priced on {sourceName(q.source)}'s order book at {fmt.time(q.at, true)}. {q.indicative ? 'Indicative: several members must sign, so it fills only within its price bound, or not at all.' : left !== null && left > 0 ? `This estimate holds for ${Math.ceil(left / 1000)} more seconds; after that it cannot be signed.` : 'This estimate has lapsed: close this and see what it would do again, at current prices.'}</p>
    <p className="small muted">An estimate, not a fill: the order is checked again against prices and your balance when it is sent, and the fill is the venue's own price and time, shown on its record.</p>
  </>
}

// ------------------------------------------------------------------------------------------------ the page

export function HoldingsScreen() {
  const presentation = !!useSession().session.presentation
  const now = useNow(1000)
  const { query } = useLocation()
  const home = useData<Home>('/api/home', ['action', 'nav', 'profile'])
  const market = useData<Market>('/api/market', ['provider', 'nav'])
  const preset = query.get('sell') ? { id: query.get('sell')!, side: 'sell' } : query.get('buy') ? { id: query.get('buy')!, side: 'buy' } : {}
  const [chart, setChart] = useState<string | null>(preset.id ?? null)
  useHashTarget(!!(home.data && market.data))
  // the head (title, sentence, actions) is drawn before any data arrives; only the parts that show data wait for it
  const head = (
    <header className="page-head gr-head">
      <div><h1>Grow.<span className="dim"> What you own, and how far it could fall.</span></h1><p>Valued at what a sale would fetch now. Test an idea against doing nothing before any money moves.</p></div>
      <nav className="gr-acts" aria-label="Do something yourself">
        <Link to="/holdings/idea" className="btn fill"><Scale aria-hidden="true" />Test an idea</Link>
        <Link to="/holdings#ticket" className="btn"><ArrowLeftRight aria-hidden="true" />Buy or sell</Link>
        <Link to="/instructions/new?kind=invest" className="btn"><FilePlus2 aria-hidden="true" />Invest regularly</Link>
        <Link to="/holdings/lab" className="btn"><FlaskConical aria-hidden="true" />Portfolio lab</Link>
      </nav>
    </header>
  )
  if (!home.data || !market.data) return <div className="gr-page">{head}{home.error || market.error ? <Problem error={home.error ?? market.error} /> : <GrowSkeleton />}</div>
  const o = home.data.overview, m = market.data
  const charted = chart ?? o.holdings[0]?.instrumentId ?? 'coindcx:BTCINR'
  const pick = (id: string) => { setChart(id); document.getElementById('chart')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
  const assets = m.instruments.filter((i) => i.tradable && i.kind === 'crypto_spot')
  const funds = m.instruments.filter((i) => i.tradable && i.kind === 'mutual_fund')
  const listed = m.instruments.filter((i) => i.tradable && (i.kind === 'etf' || i.kind === 'equity'))
  const govt = m.instruments.filter((i) => i.tradable && (i.kind === 'tbill' || i.kind === 'gsec'))
  const refs = m.instruments.filter((i) => !i.tradable)
  const name = (i: MarketInstrument) => <button type="button" className="gr-pick" onClick={() => pick(i.id)} aria-pressed={charted === i.id} title="Show this on the chart">{i.name}</button>
  const silent = [...new Set(m.instruments.filter((i) => Object.values(i.quotes).some((q) => q.precision !== 'day' && q.sourceTs === null)).map((i) => sourceName(i.provider)))]
  const live = m.providers.filter((p) => p.state === 'live').length
  const tall = typeof window !== 'undefined' && window.matchMedia('(min-width: 1100px)').matches ? 280 : 232
  const recordWaiting = <figure className="panel price-chart" id="chart" aria-labelledby="h-chart" aria-busy="true"><div className="pc-top"><div className="pc-title"><h2 id="h-chart">Prices over time</h2><p>Recorded or published; no forecast</p></div></div><div className="pc-loading"><p className="pc-q loading-line">Reading the price record</p><Skel h={tall + 52} r={18} /></div></figure>

  return (
    <div className="gr-page">
      {head}

      <div className="gr-top">
        <Worth home={home.data} />
        <Floor home={home.data} />
      </div>

      <Holdings home={home.data} market={m} now={now} onChart={pick} />

      <GrowIdeas />

      <Suspense fallback={<Skel h={220} r={24} />}><GrowCompare /></Suspense>

      {/* the record arrives as its own chunk once the figures above are drawn; its heading, its place and the id a link
          goes to are drawn meanwhile. (Waiting until it is scrolled near was tried and refused: a screen reader's list of
          headings and a find in the page would miss what is not yet drawn.) */}
      <Suspense fallback={recordWaiting}>
        <PriceRecord m={m} home={home.data} id={charted} onPick={setChart} now={now} />
      </Suspense>

      {/* the ticket with its fills under it, beside the prices of what it can buy; in reading order the ticket, the
          fills, then the prices. The two columns end together: the fills take what height the prices leave. */}
      <div className="gr-trade">
        <section className="panel gr-ticket" aria-labelledby="h-ticket" id="ticket">
          <div className="panel-head"><h2 id="h-ticket">Buy or sell by hand</h2><p>You see the estimate before you approve</p></div>
          <Ticket key={`${query.get('buy')}-${query.get('sell')}`} market={m} home={home.data} preset={preset} onPick={setChart} onDone={(id) => navigate(`/record/${id}`)} />
        </section>
        <Fills market={m} />

        <section className="panel gr-market" aria-labelledby="h-prices">
          <div className="panel-head"><h2 id="h-prices">Prices</h2><p>Choose a name to chart it</p></div>

          <div className="gr-table-head"><h3>Digital assets, in rupees</h3><p className="small muted">{presentation ? 'A synthetic order book generated on this computer (presentation mode).' : 'Live order book from CoinDCX.'} Paper orders fill against it.</p></div>
          {assets.length === 0 ? <p className="small muted gr-none">No digital asset can be bought or sold here right now: the venue's list has not been read.</p> : <div className="gr-scroll" tabIndex={0} role="region" aria-label="Digital asset prices; scroll sideways on a narrow screen">
            <table className="ledger fixed market">
              <colgroup><col /><col className="c-px" /><col className="c-px c-ask" /><col className="c-age" /></colgroup>
              <thead><tr><th scope="col">Asset</th><th scope="col" className="num">Buyers offer</th><th scope="col" className="num ask">Sellers ask</th><th scope="col" className="age">Heard</th></tr></thead>
              <tbody>{assets.map((i) => <tr key={i.id}><th scope="row">{name(i)}<span className="sub">{tickerOf(i)}</span><span className="sub narrow-age"><Heard inst={i} type="bid" q={i.quotes.bid} now={now} /></span></th><td className="num"><LivePrice inst={i} type="bid" q={i.quotes.bid} /><span className="sub narrow-ask">Sellers ask <LivePrice inst={i} type="ask" q={i.quotes.ask} /></span></td><td className="num ask"><LivePrice inst={i} type="ask" q={i.quotes.ask} /></td><td className="small age"><Heard inst={i} type="bid" q={i.quotes.bid} now={now} /></td></tr>)}</tbody>
            </table>
          </div>}

          <div className="gr-table-head"><h3>Mutual funds</h3><p className="small muted">{presentation ? 'One synthetic NAV a day (presentation mode).' : 'One NAV for each business day, published by AMFI.'} An order gets the NAV for its own day, not this one.</p></div>
          {funds.length === 0 ? <p className="small muted gr-none">No fund can be bought here right now: the list of funds has not been read.</p> : <div className="gr-scroll" tabIndex={0} role="region" aria-label="Fund NAVs; scroll sideways on a narrow screen">
            <table className="ledger fixed market funds">
              <colgroup><col /><col className="c-px" /><col className="c-day" /></colgroup>
              <thead><tr><th scope="col">Fund</th><th scope="col" className="num">Latest NAV</th><th scope="col" className="day">For the day</th></tr></thead>
              <tbody>{funds.map((i) => <tr key={i.id}><th scope="row">{name(i)}<span className="sub">{i.meta.category ? `${String(i.meta.category)[0]!.toUpperCase()}${String(i.meta.category).slice(1)} fund` : ''}<span className="narrow-day">. <Heard inst={i} type="nav" q={i.quotes.nav} now={now} /></span></span></th><td className="num"><LivePrice inst={i} type="nav" q={i.quotes.nav} /></td><td className="small day"><Heard inst={i} type="nav" q={i.quotes.nav} now={now} short /></td></tr>)}</tbody>
            </table>
          </div>}

          <div className="gr-table-head"><h3>ETFs and shares, whole units</h3><p className="small muted">Synthetic prices generated on this computer, never market data. Each starts from a stated value (an ETF from a fund NAV AMFI published on a named day; a share from a round number). The exchange trades 9:15 am to 3:30 pm India time, weekdays; holidays are not modelled. A sale pays out the next business day.</p></div>
          <SecurityTable list={listed} now={now} name={name} label="ETF and share prices; scroll sideways on a narrow screen" />

          <div className="gr-table-head"><h3>Government bills and bonds, lots of 100 units</h3><p className="small muted">A unit is ₹100 of face value; the price is for one unit. Synthetic prices generated on this computer from a round yield, never auction or market data. The desk trades 9:00 am to 5:00 pm India time, weekdays. A bill pays ₹100 at maturity; a bond pays a coupon twice a year.</p></div>
          <SecurityTable list={govt} now={now} name={name} label="Bill and bond prices; scroll sideways on a narrow screen" />

          <details className="gr-more" id="not-offered">
            <summary>Not offered yet ({(m.notOffered ?? []).length})</summary>
            <p className="small muted">The mandate names these and QED does not trade them. Each says why, so that nothing is missing without a reason.</p>
            <ul className="gr-rows">{(m.notOffered ?? []).map((n) => <li key={n.id}><div className="gr-src-name"><b>{n.name}</b><Stamp tone="void">Not offered yet</Stamp></div><span className="sub">{n.reason}</span></li>)}</ul>
          </details>

          <details className="gr-more">
            <summary>Reference prices that cannot be traded here ({refs.length})</summary>
            <p className="small muted">QED checks the rupee prices above against these, and shows them for context. None can be bought or sold here.{silent.length ? ` ${silent.join(' and ')} put${silent.length === 1 ? 's' : ''} no time of its own on these quotes, so their age is counted from when they arrived here.` : ''}</p>
            <div className="gr-scroll" tabIndex={0} role="region" aria-label="Reference prices; scroll sideways on a narrow screen">
              <table className="ledger fixed market refs">
                <colgroup><col /><col className="c-px" /><col className="c-src" /><col className="c-age" /></colgroup>
                <thead><tr><th scope="col">What</th><th scope="col" className="num">Value</th><th scope="col">From</th><th scope="col" className="age">Heard</th></tr></thead>
                <tbody>{refs.map((i) => { const t = i.kind === 'fx_reference' ? 'reference' : i.kind === 'rate' ? 'rate' : 'bid'; return (
                  <tr key={i.id}><th scope="row">{name(i)}{i.meta.note ? <span className="sub">{String(i.meta.note)}</span> : null}</th><td className="num"><LivePrice inst={i} type={t} q={i.quotes[t]} />{t === 'bid' ? <span className="sub">buyers offer</span> : null}</td><td className="small muted">{sourceName(i.quotes[t]?.provider ?? i.provider)}</td><td className="small age"><Heard inst={i} type={t} q={i.quotes[t]} now={now} /></td></tr>) })}</tbody>
              </table>
            </div>
          </details>

          <details className="gr-more">
            <summary>Where these prices come from ({live} of {m.providers.length} sources live)</summary>
            <ul className="gr-rows gr-sources">
              {m.providers.map((p) => { const n = SOURCE[p.provider] ?? [p.provider, '']; const on = p.state === 'live'; return (
                <li key={p.provider}><div className="gr-src-name"><b>{n[0]}</b><Stamp tone={on ? 'ok' : 'void'}>{on ? 'Live' : p.state[0]!.toUpperCase() + p.state.slice(1)}</Stamp></div><span className="sub">{n[1]}. Last heard <span className="tabular">{p.last_ok ? fmt.age(now - p.last_ok) : 'never'}</span>.</span></li>) })}
            </ul>
          </details>
          <p className="small muted gr-src">Each source's connection and the clock every price is timed by: <Link to="/safeguards#sources">safeguards</Link>.</p>
        </section>
      </div>

      <section className="panel gr-debts" aria-labelledby="h-debts">
        <div className="panel-head"><h2 id="h-debts">Deposits and debts</h2><p>At book value</p></div>
        <ul className="gr-debt-tiles">
          <li className="tile"><p className="k">Credit card</p><p className="v">{fmt.inr(o.card, true)}</p><p className="s">You owe this. Interest is charged on a balance carried past its due date.</p><Link className="gr-tile-go" to="/pay?purpose=card">Pay it down<ChevronRight aria-hidden="true" /></Link></li>
          <li className="tile"><p className="k">Loans</p><p className="v">{fmt.inr(o.loans, true)}</p><p className="s">Personal and home loans. Instalments leave your bank on their day each month.</p><Link className="gr-tile-go" to="/pay?purpose=loan:personal">Prepay<ChevronRight aria-hidden="true" /></Link></li>
          <li className="tile"><p className="k">Fixed deposit</p><p className="v">{fmt.inr(o.deposits, true)}</p><p className="s">Broken early, the broken part earns the savings rate less one point (a modelling rule).</p><Link className="gr-tile-go" to="/pay?purpose=fd">Add to it<ChevronRight aria-hidden="true" /></Link></li>
        </ul>
      </section>

      <div className="gr-chain" data-block=""><Suspense fallback={<Skel h={320} r={24} />}><WalletGrowSection /></Suspense></div>
    </div>
  )
}

/**
 * The household's latest ideas and where each stands (R13), read only once the page's figures are drawn, so they never
 * compete with them on a slow link; nothing is drawn when there are none (the head's "Test an idea" is the way in).
 */
const IDEA_STATE: Record<IdeaSummary['state'], [string, 'ok' | 'plain' | 'you']> = { open: ['Not decided', 'you'], 'awaiting-signature': ['Waiting for your signature', 'you'], acted: ['Signed', 'ok'], declined: ['Not this', 'plain'], 'no-action': ['Nothing done', 'plain'] }
function GrowIdeas() {
  const ideas = useData<{ ideas: IdeaSummary[] }>('/api/ideas', ['action', 'program'])
  const list = ideas.data?.ideas.slice(0, 3) ?? []
  if (!list.length) return null
  return (
    <section className="panel gr-ideas" aria-labelledby="h-ideas">
      <div className="panel-head"><h2 id="h-ideas">Your ideas</h2><Link to="/holdings/idea">Test another</Link></div>
      <ol className="gr-idea-list">{list.map((i) => { const [w, tone] = IDEA_STATE[i.state]; return <li key={i.id}><Link to={`/holdings/idea/${i.id}`} className="gr-idea-row"><span className="gr-idea-t"><strong>{i.title}</strong><span className="sub">{fmt.dayTime(i.createdAt)}</span></span><Stamp tone={tone}>{w}</Stamp></Link></li> })}</ol>
    </section>
  )
}

/** One table of a securities desk's prices: buyers offer, sellers ask, and whether its market is open. */
function SecurityTable({ list, now, name, label }: { list: MarketInstrument[]; now: number; name: (i: MarketInstrument) => ReactNode; label: string }) {
  if (!list.length) return <p className="small muted gr-none">Nothing is listed on this desk right now.</p>
  return (
    <div className="gr-scroll" tabIndex={0} role="region" aria-label={label}>
      <table className="ledger fixed market">
        <colgroup><col /><col className="c-px" /><col className="c-px c-ask" /><col className="c-age" /></colgroup>
        <thead><tr><th scope="col">Name</th><th scope="col" className="num">Buyers offer</th><th scope="col" className="num ask">Sellers ask</th><th scope="col" className="age">Market</th></tr></thead>
        <tbody>{list.map((i) => { const d = deskStatus(i, now); return <tr key={i.id}><th scope="row">{name(i)}<span className="sub">{tickerOf(i)}</span><span className="sub narrow-age">{d.open ? 'Open' : 'Closed'}</span></th><td className="num"><LivePrice inst={i} type="bid" q={i.quotes.bid} /><span className="sub narrow-ask">Sellers ask <LivePrice inst={i} type="ask" q={i.quotes.ask} /></span></td><td className="num ask"><LivePrice inst={i} type="ask" q={i.quotes.ask} /></td><td className="small age">{d.open ? 'Open' : 'Closed'}</td></tr> })}</tbody>
      </table>
    </div>
  )
}

/** The page's shape while its data loads (the head is already drawn): the two lead panels, the holdings, the price record. */
function GrowSkeleton() {
  return (
    <div className="gr-skel" aria-busy="true">
      <p className="loading-line">Reading holdings and prices…</p>
      <div className="gr-top"><Skel h={340} r={24} /><Skel h={340} r={24} /></div>
      <Skel h={240} r={24} />
      <Skel h={560} r={24} />
    </div>
  )
}
