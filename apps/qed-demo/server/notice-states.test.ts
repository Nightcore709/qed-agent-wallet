/**
 * Notifications distinguish created, queued, delivered and acknowledged (R13 section 4), shown truly; and simulated
 * delivery is never presented as a real message.
 *
 * Inside QED, where every notice is shown in this build: a notice is created when it is raised (notices.ts row, `ts`);
 * queued while it is held (a warning in the owner's quiet hours until they end, an info notice until the day's digest);
 * delivered when it surfaces (shown in the lists, gathered in a digest); acknowledged when the owner says so (only an
 * urgent notice or one that needs an answer). Outside QED: a message is kept in the simulated outbox, status
 * 'simulated', and is never 'sent'.
 *
 * Property (fast-check, fixed seed): random notices of every urgency raised at random times under random quiet hours and
 * digest times, the engine's pass run at random moments or not at all, random acknowledgements; at each moment checked,
 * each notice is in exactly one state, the lists show it only once it is delivered, whether or not the engine has
 * planned it yet (until R13 a notice the engine had not yet planned was shown at once, an info notice before its digest
 * and a warning inside the quiet hours, until the engine's next pass hid it again), and an acknowledgement is refused for
 * anything but an urgent or answer-needing notice.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { configureDelivery, deliver, outboxView } from './delivery.ts'
import { notice } from './execute.ts'
import { acknowledge, getPrefs, heldIds, notifyTick, notifyView, setPrefs, surfaceAt, urgencyOf } from './notify.ts'
import { makeKit } from './testkit.ts'
import { noticesView } from './views.ts'

const KINDS: [string, 'action' | 'warning' | 'info'][] = [['payment-reversed', 'warning'], ['run-approval', 'action'], ['stopped', 'warning'], ['goal-reached', 'info'], ['bank-event-error', 'warning'], ['program-expired', 'info'], ['security-change', 'warning']]
type State = 'queued' | 'delivered' | 'acknowledged'

describe('a notice is created, queued, delivered and acknowledged, each distinct and shown truly', () => {
  it('property: at every moment each notice is in exactly one state, and the lists show it only once it is delivered, planned by the engine or not', () => {
    const plan = fc.record({
      quiet: fc.option(fc.record({ from: fc.integer({ min: 0, max: 23 }), len: fc.integer({ min: 1, max: 10 }) }), { nil: null }),
      digest: fc.integer({ min: 0, max: 23 }),
      notes: fc.array(fc.record({ kind: fc.integer({ min: 0, max: KINDS.length - 1 }), atMin: fc.integer({ min: 0, max: 3 * 1440 }) }), { minLength: 1, maxLength: 12 }),
      checks: fc.array(fc.record({ atMin: fc.integer({ min: 0, max: 4 * 1440 }), engine: fc.boolean(), ack: fc.nat(11) }), { minLength: 1, maxLength: 10 }),
    })
    fc.assert(fc.property(plan, ({ quiet, digest, notes, checks }) => {
      const start = istInstant('2026-11-23', '00:00')
      const k = makeKit({ start })
      const hm = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`
      setPrefs(k.db, k.userId, { quietFrom: quiet ? hm(quiet.from) : null, quietTo: quiet ? hm(quiet.from + quiet.len) : null, digestAt: hm(digest), escalateMin: 240 }, start)
      const prefs = getPrefs(k.db, k.userId)
      const events = [...notes.map((n, i) => ({ t: start + n.atMin * 60_000, raise: i })), ...checks.map((c, i) => ({ t: start + c.atMin * 60_000, check: i }))].sort((a, b) => a.t - b.t)
      for (const e of events) {
        k.clock.set(e.t)
        if ('raise' in e) {
          const [kind, level] = KINDS[notes[e.raise!]!.kind]!
          notice(k.db, k.userId, { level, kind, title: `${kind} ${e.raise}`, body: 'b', dedupe: `n${e.raise}` }, e.t)
          continue
        }
        const c = checks[e.check!]!
        if (c.engine) notifyTick(k.db, e.t)
        const read = () => k.db.all<{ id: string; ts: number; kind: string; level: string; resolved_at: number | null }>('SELECT id, ts, kind, level, resolved_at FROM notices WHERE user_id = ? ORDER BY ts, id', k.userId)
        // an acknowledgement of one of them: refused unless it is urgent or needs an answer
        const all = read()
        const target = all[c.ack % Math.max(1, all.length)]
        if (target) {
          const u = urgencyOf(target.kind, target.level)
          if (u === 'critical' || u === 'action') acknowledge(k.db, k.userId, target.id, e.t, { settleSecurity: true })
          else expect(() => acknowledge(k.db, k.userId, target.id, e.t, { settleSecurity: true })).toThrow(/Only urgent notices/)
        }
        const rows = read()
        const listed = new Set(noticesView(k.db, k.userId, e.t).map((r) => String(r.id)))
        const held = heldIds(k.db, k.userId, e.t)
        for (const n of rows.filter((r) => r.resolved_at === null)) {
          const u = urgencyOf(n.kind, n.level)
          const due = surfaceAt(u, n.ts, prefs)
          const d = k.db.get<{ acked_at: number | null; surface_at: number }>('SELECT acked_at, surface_at FROM notice_delivery WHERE notice_id = ?', n.id)
          const state: State = d?.acked_at != null && d.acked_at <= e.t ? 'acknowledged' : due <= e.t ? 'delivered' : 'queued'
          // critical and action notices are never queued; what is planned is planned for the same moment
          if (u === 'critical' || u === 'action') expect(due).toBe(n.ts)
          if (d) expect(d.surface_at).toBe(due)
          // the states are in their order: created, then delivered, then acknowledged
          if (d?.acked_at != null) expect(d.acked_at).toBeGreaterThanOrEqual(due)
          // shown truly: in the lists once delivered, held (not in the lists) while queued, planned by the engine or not
          expect(listed.has(n.id), `${n.kind} ${state}`).toBe(state !== 'queued')
          expect(held.has(n.id), `${n.kind} ${state}`).toBe(state === 'queued')
        }
        // what waits for an acknowledgement is exactly the urgent and answer-needing notices not yet acknowledged
        if (c.engine) {
          const waiting = new Set((notifyView(k.db, k.userId, e.t).unacknowledged as { id: string }[]).map((r) => r.id))
          for (const n of rows.filter((r) => r.resolved_at === null)) {
            const u = urgencyOf(n.kind, n.level)
            const acked = k.db.get<{ a: number | null }>('SELECT acked_at a FROM notice_delivery WHERE notice_id = ?', n.id)?.a != null
            expect(waiting.has(n.id)).toBe((u === 'critical' || u === 'action') && !acked)
          }
        }
      }
    }), { seed: 7, numRuns: 150 })
  })
})

describe('a message outside QED is kept in the simulated outbox, never sent', () => {
  it('stored as simulated, by the local test outbox, and the outbox says first that nothing was sent', () => {
    const k = makeKit()
    configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5174' })
    deliver(k.db, { channel: 'email', to: 'asha@example.com', personId: k.userId, purpose: 'notice:security-change', subject: 'QED: a change', body: 'A change.' }, k.clock.now())
    const v = outboxView(k.db)
    expect(v).toMatchObject({ simulated: true, notice: 'Simulated delivery: no email or text message was sent.' })
    expect(v.messages.map((m) => m.status)).toEqual(['simulated'])
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbound_messages WHERE status IN ('sent', 'queued', 'sending')`)!.n).toBe(0)
  })
})
