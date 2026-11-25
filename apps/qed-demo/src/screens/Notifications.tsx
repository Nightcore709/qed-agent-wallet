/**
 * Notifications (server/notify.ts, R10-006), in "Meridian". Telling the owner is delivery, not watching: QED's checks run
 * whether or not a notice reaches anyone, and a notice stops or undoes nothing (the pause control and the limits the
 * owner signs do). The page says how few notices interrupt: by urgency (urgent and needing an answer are shown at once,
 * never held, acknowledged explicitly and raised again once if nobody answers; warnings wait out the quiet hours; notes
 * gather into one daily digest), with notices that say the same thing grouped as one row with a count. Then what waits
 * for an acknowledgement, what is held, the digests and what was acknowledged; the settings beside them. Delivery in
 * this build is inside QED only. The head is drawn before any data (DESIGN.md M11).
 */
import { BellRing, Inbox, Moon, Repeat } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { KindTag } from '../ui/kinds.tsx'
import { Btn, Field, Loading, Note, Problem, Stamp, useAction, useMasonry, useSession } from '../ui/kit.tsx'
import { withPasskeyIfAsked } from './Protect.tsx'

interface Prefs { quietFrom: string | null; quietTo: string | null; digestAt: string; escalateMin: number }
interface Row { id: string; ts: number; kind: string; title: string; body?: string; urgency: string; escalatedAt?: number | null; surfaceAt?: number; ackedAt?: number }
interface View { prefs: Prefs; delivery: string; unacknowledged: Row[]; acknowledged: Row[]; held: Row[]; digests: { id: string; at: number; fromTs: number; body: { kind: string; title: string; count: number; first: number; last: number }[] }[] }

const URGENCY: Record<string, string> = { critical: 'Urgent', action: 'Needs an answer', warning: 'Warning', info: 'For the digest' }
const TONE: Record<string, 'void' | 'wait' | 'info' | 'plain'> = { critical: 'void', action: 'wait', warning: 'info', info: 'plain' }
const minutes = (m: number): string => (m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`)

/** A notice's urgency, as a stamp with its word (never its colour alone). */
const Urgency = ({ u }: { u: string }) => <Stamp tone={TONE[u] ?? 'plain'}>{URGENCY[u] ?? u}</Stamp>

/** How few notices interrupt, and what each kind does: the rules server/notify.ts applies, in the owner's settings. */
function HowTold({ prefs }: { prefs: Prefs }) {
  const quiet = prefs.quietFrom && prefs.quietTo ? `${prefs.quietFrom} to ${prefs.quietTo}` : null
  const rows: { u: string; icon: ReactNode; when: string; then: string }[] = [
    { u: 'critical', icon: <BellRing />, when: 'Shown at once, even in your quiet hours.', then: `Waits for you to acknowledge it; reading is not acknowledging. Unanswered for ${minutes(prefs.escalateMin)}, it is raised again once, first in line.` },
    { u: 'action', icon: <BellRing />, when: 'Shown at once, even in your quiet hours: an approval held overnight could lapse.', then: `Waits for your answer and your acknowledgement; raised again once after ${minutes(prefs.escalateMin)}.` },
    { u: 'warning', icon: <Moon />, when: quiet ? `Held during your quiet hours (${quiet}) and shown when they end.` : 'Shown at once; you have no quiet hours set.', then: 'Needs nothing from you.' },
    { u: 'info', icon: <Inbox />, when: `Gathered into one digest a day, at ${prefs.digestAt}.`, then: 'Grouped by kind, with how many times each came.' },
  ]
  return (
    <section data-col="2" className="panel pr-nt-how" aria-labelledby="nt-how-h">
      <div className="pr-nt-head"><h2 id="nt-how-h">How QED tells you</h2><KindTag kind="watched" /></div>
      <p className="pr-nt-lead">A notice carries what QED watches. Telling you is delivery, not watching: QED's checks run whether or not a notice reaches you, and a notice stops or undoes nothing.</p>
      <ol className="pr-nt-ladder">
        {rows.map((r) => <li key={r.u}><span className="pr-nt-ico" data-u={r.u} aria-hidden="true">{r.icon}</span><div><p className="pr-nt-u"><Urgency u={r.u} /></p><p>{r.when}</p><p className="pr-nt-then">{r.then}</p></div></li>)}
      </ol>
      <p className="pr-nt-dedupe"><Repeat aria-hidden="true" />Notices that say the same thing are one row with a count; QED never sends a second copy.</p>
    </section>
  )
}

export function NotificationsScreen() {
  const v = useData<View>('/api/notify', ['notice'])
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => { if (v.data && !prefs) setPrefs(v.data.prefs) }, [v.data, prefs])
  const { session } = useSession()
  const board = useMasonry()
  // A change to your security asks for a passkey when this session was opened with a password (server/api.ts).
  const ack = useAction(async (id: string) => { await withPasskeyIfAsked(() => api('POST', `/api/notices/${id}/ack`), session.hasPasskey); v.reload() })
  const save = useAction(async () => { if (prefs) { const r = await api<{ prefs: Prefs }>('POST', '/api/notify/prefs', prefs); setPrefs(r.prefs); v.reload() } })
  const head = <header className="page-head"><div><h1>Notifications</h1><p>What QED tells you, and when. A notice is only a message: it moves no money and stops nothing. To stop QED, use Pause; to change what it may do, change a limit you signed. QED's checks run whether or not you read a notice.</p></div></header>
  if (!v.data || !prefs) return <div className="pr pr-nt">{head}{v.error ? <Problem error={v.error} /> : <div className="page-wait"><Loading what="Opening notifications" /></div>}</div>
  const d = v.data
  const f = save.error?.fields ?? {}
  return (
    <div className="pr pr-nt">
      {head}
      <Note tone="wait" title="Inside QED only">{d.delivery}</Note>

      <div className="pr-nt-grid board" ref={board}>
        <section data-col="1" className={`panel pr-nt-sec ${d.unacknowledged.length ? 'has' : 'calm'}`} aria-labelledby="nt-ack-h">
          <div className="pr-nt-head"><h2 id="nt-ack-h">Waiting for you to acknowledge</h2>{d.unacknowledged.length ? <span className="count" aria-label={`${d.unacknowledged.length} waiting`}>{d.unacknowledged.length}</span> : null}<p>Urgent notices and those that need an answer</p></div>
          {d.unacknowledged.length === 0 ? <p className="pr-nt-calm">Nothing urgent is waiting.{d.held.length === 0 ? ' Nothing is held for your quiet hours.' : ''}{d.digests.length === 0 ? ` The first daily digest comes at ${prefs.digestAt} once there is a note for it.` : ''}</p> : (
            <ul className="pr-nt-list">{d.unacknowledged.map((n) => (
              <li key={n.id} data-u={n.urgency}>
                <span className="pr-nt-when">{fmt.dayTime(n.ts)}</span>
                <span className="pr-nt-what"><b>{n.title}</b><small><Urgency u={n.urgency} />{n.escalatedAt ? <span>Raised again {fmt.dayTime(n.escalatedAt)} for want of an acknowledgement</span> : null}</small></span>
                <Btn small busy={ack.busy} onClick={() => void ack.run(n.id)}>Acknowledge<span className="sr"> “{n.title}”</span></Btn>
              </li>
            ))}</ul>
          )}
          <Problem error={ack.error} />
        </section>

        <HowTold prefs={prefs} />

        {d.held.length ? <section data-col="1" className="panel pr-nt-sec" aria-labelledby="nt-held-h">
          <div className="pr-nt-head"><h2 id="nt-held-h">Held</h2><p>Warnings in your quiet hours, and notes for the next digest</p></div>
          <ul className="pr-nt-list">{d.held.map((n) => (
            <li key={n.id} data-u={n.urgency}><span className="pr-nt-when">{fmt.dayTime(n.ts)}</span><span className="pr-nt-what"><b>{n.title}</b><small><Urgency u={n.urgency} /><span>Shown {n.surfaceAt ? fmt.dayTime(n.surfaceAt) : 'soon'}</span></small></span></li>
          ))}</ul>
        </section> : null}

        {d.digests.length ? <section data-col="1" className="panel pr-nt-sec" aria-labelledby="nt-dig-h">
          <div className="pr-nt-head"><h2 id="nt-dig-h">Daily digest</h2><p>Notes that need nothing from you, gathered once a day at {prefs.digestAt}</p></div>
          {d.digests.map((g) => (
            <div key={g.id} className="pr-nt-digest">
              <p className="pr-nt-digest-h">{fmt.dayTime(g.at)}</p>
              <ul className="pr-nt-list">{g.body.map((x) => <li key={x.kind}><span className="pr-nt-when">{x.count === 1 ? '' : `${x.count} times`}</span><span className="pr-nt-what"><b>{x.title}</b><small>{x.count === 1 ? fmt.dayTime(x.first) : `${fmt.dayTime(x.first)} to ${fmt.dayTime(x.last)}`}</small></span></li>)}</ul>
            </div>
          ))}
        </section> : null}

        {d.acknowledged.length ? <section data-col="1" className="panel pr-nt-sec" aria-labelledby="nt-done-h">
          <div className="pr-nt-head"><h2 id="nt-done-h">Acknowledged</h2><p>In the last 7 days</p></div>
          <ul className="pr-nt-list">{d.acknowledged.map((n) => (
            <li key={n.id} data-u={n.urgency}><span className="pr-nt-when">{fmt.dayTime(n.ts)}</span><span className="pr-nt-what"><b>{n.title}</b><small><Urgency u={n.urgency} /><span>Acknowledged {n.ackedAt ? fmt.dayTime(n.ackedAt) : ''}</span></small></span></li>
          ))}</ul>
        </section> : null}

        <section data-col="1" className="panel pr-nt-set" aria-labelledby="nt-set-h">
          <div className="pr-nt-head"><h2 id="nt-set-h">Settings</h2><KindTag kind="set" /><p>Indian time</p></div>
          <form className="pr-nt-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
            <div className="form-grid cols-2 fields">
            <Field label="Quiet hours from" error={f.quietFrom}>{(p) => <input {...p} type="time" className="input" value={prefs.quietFrom ?? ''} onChange={(e) => setPrefs({ ...prefs, quietFrom: e.target.value || null })} />}</Field>
            <Field label="Quiet hours until" error={f.quietTo}>{(p) => <input {...p} type="time" className="input" value={prefs.quietTo ?? ''} onChange={(e) => setPrefs({ ...prefs, quietTo: e.target.value || null })} />}</Field>
            <Field label="Daily digest at" error={f.digestAt}>{(p) => <input {...p} type="time" className="input" value={prefs.digestAt} onChange={(e) => setPrefs({ ...prefs, digestAt: e.target.value })} />}</Field>
            <Field label="Raise again if not acknowledged within" error={f.escalateMin}>{(p) => <select {...p} className="input" value={prefs.escalateMin} onChange={(e) => setPrefs({ ...prefs, escalateMin: Number(e.target.value) })}>{[15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{minutes(m)}</option>)}</select>}</Field>
            </div>
            <p className="small muted pr-nt-hint">Leave the quiet hours empty for none. In them only warnings wait; urgent notices and those that need an answer are never held.</p>
            <div className="pr-nt-save"><Btn tone="fill" type="submit" busy={save.busy}>Save settings</Btn></div>
          </form>
          {save.error && !Object.keys(f).length ? <Problem error={save.error} /> : null}
        </section>
      </div>
    </div>
  )
}
