/**
 * Notifications (notify.ts, R10-006): urgency, quiet hours with their exceptions, acknowledgement, escalation once,
 * the digest, and the lists leaving out what is held. Times are Indian time, as the owner's settings are.
 */
import { describe, expect, it } from 'vitest'
import { AppError, istInstant } from './core.ts'
import { notice } from './execute.ts'
import { acknowledge, checkPrefs, DEFAULT_PREFS, inQuiet, nextAt, notifyTick, notifyView, setPrefs, surfaceAt, urgencyOf } from './notify.ts'
import { securityEvent } from './passkeys.ts'
import { makeKit } from './testkit.ts'
import { noticesView } from './views.ts'

const at = (date: string, hm: string) => istInstant(date, hm)
const NIGHT = { quietFrom: '22:00', quietTo: '07:00', digestAt: '08:00', escalateMin: 30 }
const OK = { settleSecurity: true }

describe('urgency', () => {
  it('a change to who can act or to the record of money is critical; a notice that needs an answer is action', () => {
    expect(urgencyOf('vault-signer-added', 'warning')).toBe('critical')
    expect(urgencyOf('recon-break', 'action')).toBe('critical')
    expect(urgencyOf('payment-reversed', 'action')).toBe('critical')
    expect(urgencyOf('run-approval', 'action')).toBe('action')
    expect(urgencyOf('runs-missed', 'warning')).toBe('warning')
    expect(urgencyOf('program-expired', 'info')).toBe('info')
  })
})

describe('quiet hours and surfacing', () => {
  it('a window that crosses midnight holds 23:00 and 06:59, not 07:00 or 21:59', () => {
    expect(inQuiet(at('2026-11-23', '23:00'), NIGHT)).toBe(true)
    expect(inQuiet(at('2026-11-24', '06:59'), NIGHT)).toBe(true)
    expect(inQuiet(at('2026-11-24', '07:00'), NIGHT)).toBe(false)
    expect(inQuiet(at('2026-11-23', '21:59'), NIGHT)).toBe(false)
    expect(inQuiet(at('2026-11-23', '23:00'), DEFAULT_PREFS)).toBe(false)
  })

  it('critical and action notices surface at once even in the quiet hours; a warning waits for them to end; info waits for the digest', () => {
    const t = at('2026-11-23', '23:30')
    expect(surfaceAt('critical', t, NIGHT)).toBe(t)
    expect(surfaceAt('action', t, NIGHT)).toBe(t) // an approval held overnight could lapse
    expect(surfaceAt('warning', t, NIGHT)).toBe(at('2026-11-24', '07:00'))
    expect(surfaceAt('warning', at('2026-11-23', '12:00'), NIGHT)).toBe(at('2026-11-23', '12:00'))
    expect(surfaceAt('info', at('2026-11-23', '09:00'), NIGHT)).toBe(at('2026-11-24', '08:00'))
    expect(nextAt(at('2026-11-23', '08:00'), '08:00')).toBe(at('2026-11-23', '08:00'))
  })

  it('settings are checked: times of day, both ends of the quiet hours or neither, a known escalation delay', () => {
    const fields = (p: Record<string, unknown>) => { try { checkPrefs(p); return null } catch (e) { return (e as AppError).fields } }
    expect(fields({ quietFrom: '22:00' })).toEqual({ quietTo: 'Set both ends of the quiet hours, or neither.' })
    expect(fields({ quietFrom: '25:00', quietTo: '07:00' })).toEqual({ quietFrom: 'A time of day, such as 22:00.' })
    expect(fields({ quietFrom: '07:00', quietTo: '07:00' })).toEqual({ quietTo: 'The quiet hours must end at a different time from when they start.' })
    expect(fields({ escalateMin: 7 })).toEqual({ escalateMin: 'One of 15, 30, 60, 120, 240 minutes.' })
    expect(checkPrefs({ quietFrom: '', quietTo: null, digestAt: '09:30', escalateMin: 60 })).toEqual({ quietFrom: null, quietTo: null, digestAt: '09:30', escalateMin: 60 })
  })
})

describe('the tick', () => {
  it('holds a warning raised in the quiet hours out of the lists until they end, but never an action', () => {
    const k = makeKit({ start: at('2026-11-23', '23:10') })
    setPrefs(k.db, k.userId, NIGHT, k.clock.now())
    const now = k.clock.now()
    notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'Two runs were missed', body: 'b' }, now)
    notice(k.db, k.userId, { level: 'action', kind: 'run-approval', title: 'A run waits for you', body: 'b' }, now)
    expect(notifyTick(k.db, now).planned).toBe(2)
    expect(noticesView(k.db, k.userId, now).map((n) => n.title)).toEqual(['A run waits for you'])
    expect(notifyView(k.db, k.userId, now).held).toMatchObject([{ title: 'Two runs were missed', surfaceAt: at('2026-11-24', '07:00') }])
    expect(noticesView(k.db, k.userId, at('2026-11-24', '07:00')).map((n) => n.title).sort()).toEqual(['A run waits for you', 'Two runs were missed'])
  })

  it('escalates an unacknowledged critical notice once, after the delay; acknowledging the escalation settles both', () => {
    const k = makeKit({ start: at('2026-11-23', '10:00') })
    const t0 = k.clock.now()
    notice(k.db, k.userId, { level: 'warning', kind: 'vault-signer-added', title: 'A signer was added to your wallet', body: 'b', subject: 'vlt_1' }, t0)
    notifyTick(k.db, t0)
    expect(notifyTick(k.db, t0 + 29 * 60_000).escalated).toBe(0)
    expect(notifyTick(k.db, t0 + 30 * 60_000).escalated).toBe(1)
    expect(notifyTick(k.db, t0 + 90 * 60_000).escalated).toBe(0) // once only
    const views = noticesView(k.db, k.userId, t0 + 31 * 60_000)
    const esc = views.find((n) => n.kind === 'escalation')!
    expect(esc.title).toBe('Not acknowledged for 30 minutes: A signer was added to your wallet')
    acknowledge(k.db, k.userId, String(esc.id), t0 + 32 * 60_000, OK)
    const v = notifyView(k.db, k.userId, t0 + 33 * 60_000)
    expect(v.unacknowledged).toEqual([])
    expect(noticesView(k.db, k.userId, t0 + 33 * 60_000).some((n) => n.kind === 'escalation')).toBe(false)
  })

  it('an acknowledged notice is not escalated, and only urgent or answer-needing notices can be acknowledged', () => {
    const k = makeKit({ start: at('2026-11-23', '10:00') })
    const t0 = k.clock.now()
    notice(k.db, k.userId, { level: 'action', kind: 'bill-waiting', title: 'A bill is over its cap', body: 'b' }, t0)
    notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'A run was missed', body: 'b' }, t0)
    notifyTick(k.db, t0)
    const [bill, missed] = ['A bill is over its cap', 'A run was missed'].map((t) => noticesView(k.db, k.userId, t0).find((n) => n.title === t)!)
    acknowledge(k.db, k.userId, String(bill!.id), t0 + 60_000, OK)
    expect(notifyTick(k.db, t0 + 120 * 60_000).escalated).toBe(0)
    expect(() => acknowledge(k.db, k.userId, String(missed!.id), t0, OK)).toThrowError(/Only urgent notices/)
    expect(() => acknowledge(k.db, 'usr_other', String(bill!.id), t0, OK)).toThrowError(/No such notice/)
  })

  it('gathers info notices into one digest at the chosen time, grouped by kind with counts', () => {
    const k = makeKit({ start: at('2026-11-23', '09:00') })
    const t0 = k.clock.now()
    for (const [i, kind] of ['program-expired', 'program-expired', 'dispute-resolved'].entries()) notice(k.db, k.userId, { level: 'info', kind, title: `${kind} ${i}`, body: 'b', dedupe: `d${i}` }, t0 + i)
    notifyTick(k.db, t0)
    expect(noticesView(k.db, k.userId, t0).length).toBe(0) // held for the digest
    expect(notifyTick(k.db, at('2026-11-24', '07:59')).digests).toBe(0)
    expect(notifyTick(k.db, at('2026-11-24', '08:00')).digests).toBe(1)
    expect(notifyTick(k.db, at('2026-11-24', '08:01')).digests).toBe(0)
    const d = (notifyView(k.db, k.userId, at('2026-11-24', '08:01')).digests as { body: { kind: string; count: number }[] }[])[0]!
    expect(d.body.map((g) => [g.kind, g.count]).sort()).toEqual([['dispute-resolved', 1], ['program-expired', 2]])
  })

  it('changing the quiet hours plans held warnings again', () => {
    const k = makeKit({ start: at('2026-11-23', '23:10') })
    setPrefs(k.db, k.userId, NIGHT, k.clock.now())
    notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'Missed', body: 'b' }, k.clock.now())
    notifyTick(k.db, k.clock.now())
    setPrefs(k.db, k.userId, { quietFrom: null, quietTo: null, digestAt: '08:00', escalateMin: 30 }, k.clock.now() + 1000)
    expect(noticesView(k.db, k.userId, k.clock.now() + 1000).map((n) => n.title)).toEqual(['Missed'])
  })

  it('a change to who can act is told at once as an urgent notice; an ordinary sign-in is not; acknowledging settles it', () => {
    const k = makeKit({ start: at('2026-11-23', '23:30') })
    setPrefs(k.db, k.userId, NIGHT, k.clock.now())
    const t0 = k.clock.now()
    securityEvent(k.db, k.userId, 'signed-in', {}, t0)
    securityEvent(k.db, k.userId, 'passkey-added', { name: 'Unknown phone' }, t0)
    notifyTick(k.db, t0)
    const shown = noticesView(k.db, k.userId, t0) // in the quiet hours: urgent notices are never held
    expect(shown.map((n) => [n.kind, n.title])).toEqual([['security-change', 'A passkey was added to your account']])
    expect(String(shown[0]!.body)).toMatch(/If this was not you, open Security and recovery now/)
    acknowledge(k.db, k.userId, String(shown[0]!.id), t0 + 60_000, OK)
    expect(noticesView(k.db, k.userId, t0 + 60_000)).toEqual([])
    expect(notifyTick(k.db, t0 + 120 * 60_000).escalated).toBe(0)
  })

  it('two identical events give one notice; a completed recovery is told once, not once more for the codes it replaced', () => {
    const k = makeKit({ start: at('2026-11-23', '10:00') })
    const t0 = k.clock.now()
    for (let i = 0; i < 2; i++) notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'A run was missed', body: 'b', dedupe: 'runs-missed:prg_1:2026-11-23' }, t0 + i)
    expect(noticesView(k.db, k.userId, t0 + 5).filter((n) => n.kind === 'runs-missed').length).toBe(1)
    securityEvent(k.db, k.userId, 'recovery-completed', { requestId: 'rcv_1', passkey: 'New phone' }, t0)
    securityEvent(k.db, k.userId, 'recovery-codes-replaced', { reason: 'recovery' }, t0)
    expect(noticesView(k.db, k.userId, t0 + 5).filter((n) => n.kind === 'security-change').map((n) => n.title)).toEqual(['A recovery of your account was completed'])
    securityEvent(k.db, k.userId, 'recovery-codes-replaced', {}, t0 + 10) // replaced by the person, on its own: told
    expect(noticesView(k.db, k.userId, t0 + 15).filter((n) => n.kind === 'security-change').length).toBe(2)
  })

  it('a session that may not clear a security change (a password session of a passkey account) is refused; other notices are not affected', () => {
    const k = makeKit({ start: at('2026-11-23', '10:00') })
    const t0 = k.clock.now()
    securityEvent(k.db, k.userId, 'passkey-added', { name: 'Unknown phone' }, t0)
    notice(k.db, k.userId, { level: 'action', kind: 'bill-waiting', title: 'A bill is over its cap', body: 'b' }, t0)
    notifyTick(k.db, t0)
    const [told, bill] = ['security-change', 'bill-waiting'].map((kind) => noticesView(k.db, k.userId, t0).find((n) => n.kind === kind)!)
    expect(() => acknowledge(k.db, k.userId, String(told!.id), t0, { settleSecurity: false })).toThrowError(/Confirm with one of your passkeys/)
    acknowledge(k.db, k.userId, String(bill!.id), t0, { settleSecurity: false })
    notice(k.db, k.userId, { level: 'warning', kind: 'vault-signer-added', title: 'A signer was added to your wallet', body: 'b', subject: 'vlt_1' }, t0)
    const signer = noticesView(k.db, k.userId, t0).find((n) => n.kind === 'vault-signer-added')!
    expect(() => acknowledge(k.db, k.userId, String(signer.id), t0, { settleSecurity: false })).toThrowError(/Confirm with one of your passkeys/)
    // the escalation of a security change is held to the same rule
    notifyTick(k.db, t0 + 30 * 60_000)
    const esc = noticesView(k.db, k.userId, t0 + 31 * 60_000).find((n) => n.kind === 'escalation' && n.subject === told!.id)!
    expect(() => acknowledge(k.db, k.userId, String(esc.id), t0 + 31 * 60_000, { settleSecurity: false })).toThrowError(/Confirm with one of your passkeys/)
    acknowledge(k.db, k.userId, String(esc.id), t0 + 32 * 60_000, OK)
    const left = noticesView(k.db, k.userId, t0 + 33 * 60_000).map((n) => n.id)
    expect(left).not.toContain(told!.id)
    expect(left).not.toContain(esc.id)
  })

  it('an unacknowledged security change is raised again once; acknowledging the escalation settles both', () => {
    const k = makeKit({ start: at('2026-11-23', '10:00') })
    const t0 = k.clock.now()
    securityEvent(k.db, k.userId, 'password-changed', {}, t0)
    notifyTick(k.db, t0)
    expect(notifyTick(k.db, t0 + 30 * 60_000).escalated).toBe(1)
    const esc = noticesView(k.db, k.userId, t0 + 31 * 60_000).find((n) => n.kind === 'escalation')!
    expect(esc.title).toBe('Not acknowledged for 30 minutes: Your password was changed')
    acknowledge(k.db, k.userId, String(esc.id), t0 + 32 * 60_000, OK)
    expect(noticesView(k.db, k.userId, t0 + 33 * 60_000)).toEqual([])
  })
})
