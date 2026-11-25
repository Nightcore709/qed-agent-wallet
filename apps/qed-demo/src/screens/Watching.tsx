/**
 * Grow's "Watching" panel (R14): the names the household follows, each with its latest price, where the price came from,
 * the time of it, whether it is observed (read from a public source) or synthetic (generated on this computer), and the
 * change since the name was added. The server builds every row from the market data QED already holds (server/watchlist.ts);
 * nothing here works out a price. A row can be removed, can start a test of an idea, and can open the ordinary ticket,
 * which keeps its approval: nothing is bought or sold from this list. Anyone in the workspace can read it; a viewer cannot
 * change it. A household whose home currency is not the rupee can read and keep the list; buying stays refused at the
 * ticket, with its reason (server/home-currency.ts).
 */
import { Eye, Plus, Scale, ArrowLeftRight, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { api, fmt, sourceName, useData, useNow } from '../lib/core.ts'
import type { Market, WatchItem, Watchlist } from '../lib/types.ts'
import { dayText, istDay } from '../../shared/day-text.ts'
import { Btn, EmptyState, Link, Problem, Stamp, useAction, useSession } from '../ui/kit.tsx'
import { dailyWord, isoDayOf, MINUS, priceText, tickerOf } from '../ui/prices.ts'

const GROUPS: [string, (k: string) => boolean][] = [
  ['Digital assets, in rupees', (k) => k === 'crypto_spot'], ['Mutual funds', (k) => k === 'mutual_fund'], ['ETFs and shares', (k) => k === 'etf' || k === 'equity'],
  ['Government bills and bonds', (k) => k === 'tbill' || k === 'gsec'], ['Reference prices (cannot be traded here)', (k) => !['crypto_spot', 'mutual_fund', 'etf', 'equity', 'tbill', 'gsec'].includes(k)],
]
const decimalsIn = (s: string): number => (s.split('.')[1] ?? '').length

/** A price or a difference as a person reads it: rupee prices through fmt.inr when they fit in paise, otherwise at their own places. */
export function watchFigure(w: Pick<WatchItem, 'kind' | 'quote'>, v: string, sign = false): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'no price'
  const lead = sign ? (n > 0 ? '+' : n < 0 ? MINUS : '') : n < 0 ? MINUS : ''
  const abs = Math.abs(n)
  if (w.kind === 'rate') return `${lead}${abs.toFixed(2)}%`
  if (w.quote === 'INR' && decimalsIn(v) <= 2) return `${lead}${fmt.inr(Math.round(abs * 100), true)}`
  return `${lead}${priceText(abs, w.quote, Math.max(2, decimalsIn(v)))}`
}

/** When a price is from, in the words the rest of Grow uses: a published value says the day it is for, a streamed one how long ago it was heard. */
function timeWords(w: WatchItem, now: number): string {
  if (w.at === null || w.recvTs === null) return 'no price has arrived yet'
  if (w.precision === 'day') return `${dailyWord(w.priceType)} for ${dayText(isoDayOf(w.at), istDay(now))}`
  return `heard ${fmt.age(now - w.recvTs)}, at ${fmt.time(w.at, true)}`
}

function WatchRow({ w, now, canChange, onRemove, busy }: { w: WatchItem; now: number; canChange: boolean; onRemove: (id: string) => void; busy: boolean }) {
  const rupees = w.quote === 'INR'
  const idea = `/holdings/idea?text=${encodeURIComponent(`Invest in ${w.name}`)}&instrument=${encodeURIComponent(w.instrumentId)}`
  return (
    <li className="gr-watch-row" data-instrument={w.instrumentId}>
      <div className="gr-watch-main">
        <h3 className="gr-watch-name">{w.name}<span className="gr-watch-sub">{tickerOf({ id: w.instrumentId, kind: w.kind })}</span></h3>
        <p className="gr-watch-px"><b className="tabular">{w.price === null ? 'No price yet' : watchFigure(w, w.price)}</b>{rupees && w.price !== null ? <span className="gr-watch-sub">a rupee price</span> : null}</p>
        <p className="gr-watch-src small">
          <Stamp tone={w.basis === 'synthetic' ? 'info' : 'ok'}>{w.basis === 'synthetic' ? 'Synthetic' : 'Observed'}</Stamp>
          <span> From {sourceName(w.provider)}; {timeWords(w, now)}.{w.stale ? <> <b className="void">Stale: older than this source's own rule.</b></> : null}</span>
        </p>
        <p className="gr-watch-chg small muted">
          {w.change !== null && w.changePct !== null
            ? <>Since you added it on {fmt.dayYear(w.addedAt)}: <b className="tabular">{watchFigure(w, w.change, true)}</b> ({w.changePct > 0 ? '+' : w.changePct < 0 ? MINUS : ''}{Math.abs(w.changePct).toFixed(2)}%), from {watchFigure(w, w.addedPrice!)}.</>
            : <>{w.changeNote ?? 'No change to show.'}</>}
        </p>
      </div>
      <div className="gr-watch-acts" role="group" aria-label={`Act on ${w.name}`}>
        {w.tradable ? <Link className="btn gr-watch-act" to={`/holdings?buy=${encodeURIComponent(w.instrumentId)}#ticket`}><ArrowLeftRight aria-hidden="true" />Buy or sell<span className="sr"> {w.name}, at the ticket, where you approve</span></Link> : null}
        {w.tradable ? <Link className="btn gr-watch-act" to={idea}><Scale aria-hidden="true" />Test an idea<span className="sr"> about {w.name}, against doing nothing</span></Link> : null}
        {canChange ? <Btn className="gr-watch-act" busy={busy} onClick={() => onRemove(w.instrumentId)}><X aria-hidden="true" />Remove<span className="sr"> {w.name} from your watchlist</span></Btn> : null}
      </div>
    </li>
  )
}

export function Watching({ market }: { market: Market }) {
  const now = useNow(1000)
  const role = useSession().session.workspace?.role ?? 'owner'
  const canChange = role !== 'viewer'
  const list = useData<Watchlist>('/api/watchlist', ['watchlist', 'provider', 'nav'])
  const [pick, setPick] = useState('')
  const [said, setSaid] = useState('')
  const selectId = useId()
  // prices age and move: read the list again every 15 seconds
  const { reload } = list
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t) }, [reload])
  const add = useAction(async (id: string) => { const r = await api<{ added: boolean; item: WatchItem }>('POST', '/api/watchlist', { instrumentId: id }); setSaid(r.added ? `Now watching ${r.item.name}.` : `${r.item.name} is already on your watchlist.`); setPick(''); reload() })
  const remove = useAction(async (id: string) => { await api('POST', '/api/watchlist/remove', { instrumentId: id }); setSaid(`Removed ${list.data?.items.find((i) => i.instrumentId === id)?.name ?? 'it'} from your watchlist.`); reload() })
  const items = list.data?.items ?? []
  const watching = new Set(items.map((i) => i.instrumentId))
  const full = (list.data?.count ?? 0) >= (list.data?.max ?? 50)
  return (
    <section className="panel gr-watch" aria-labelledby="h-watch" id="watching">
      <div className="panel-head"><h2 id="h-watch">Watching</h2><p>Names you follow. Nothing here buys or sells</p></div>
      {list.error ? <Problem error={list.error} /> : null}
      {list.data && items.length === 0 ? (
        <EmptyState compact icon={<Eye aria-hidden="true" />} title="You are not watching anything yet">
          A watchlist keeps the names you want to follow in one place, each with its latest price, where that price came from, how old it is, and how far it has moved since you added it. {canChange ? 'Choose a name below and press Add. Nothing is bought.' : 'The owner or an administrator adds names.'}
        </EmptyState>
      ) : null}
      {items.length > 0 ? <ul className="gr-watch-list" aria-label="Names you are watching">{items.map((w) => <WatchRow key={w.instrumentId} w={w} now={now} canChange={canChange} busy={remove.busy} onRemove={(id) => { void remove.run(id) }} />)}</ul> : null}
      {canChange ? (
        <form className="gr-watch-add" onSubmit={(e) => { e.preventDefault(); if (pick) void add.run(pick) }}>
          <div className="field">
            <label htmlFor={selectId}>Add a name to watch</label>
            <select id={selectId} className="input" value={pick} onChange={(e) => setPick(e.target.value)} disabled={full}>
              <option value="">Choose a name</option>
              {GROUPS.map(([label, has]) => { const these = market.instruments.filter((i) => has(i.kind) && !watching.has(i.id)); return these.length ? <optgroup key={label} label={label}>{these.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup> : null })}
            </select>
          </div>
          <Btn tone="fill" className="gr-watch-act" busy={add.busy} disabled={!pick || full} onClick={() => { if (pick) void add.run(pick) }}><Plus aria-hidden="true" />Add</Btn>
        </form>
      ) : <p className="small muted">You can read this list. Changing it needs the operator role or above.</p>}
      {full ? <p className="small muted">Your watchlist holds {list.data?.max} names, the most. Remove one to add another.</p> : null}
      {add.error ? <Problem error={add.error} /> : null}
      {remove.error ? <Problem error={remove.error} /> : null}
      <p className="small muted gr-watch-note" role="status" aria-live="polite">{said}</p>
      <p className="small muted">Prices are never refreshed on their own. Each says its source and its own time. Synthetic prices are generated on this computer and are not market data. Rupee prices are in rupees.</p>
    </section>
  )
}
