/**
 * The wait on payments to new payees, over HTTP against the real API server (R12 task comparison, gap 4):
 *   - the household's amount and wait are safeguards, changed only with a passkey's fresh confirmation and never by a
 *     session opened with a password, whichever way they move; set-up, which a password session may do, starts them at
 *     their defaults whatever the request says;
 *   - a held payment is sent by no route before its time: asking again with the same approval, disputing it or anything
 *     else leaves it waiting; cancelling it (tightening) needs no passkey.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { stepAllActions } from './execute.ts'
import { applyDueChanges } from './passkeys.ts'
import { FakeRail } from './rail-fake.ts'
import { approve, authenticatorFor, signIn, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// a port of its own for each run: suites in other worktrees run the same files at the same time
const PORT = 20000 + Math.floor(Math.random() * 20000)
const PW = 'a long enough pass phrase for this test'
const fake = new FakeRail()

describe('the wait on payments to new payees, over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-new-payee-'))
  let api: ReturnType<typeof startApi>
  beforeAll(async () => {
    await fake.start()
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) }))
  })
  afterAll(async () => { api.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }
  /** An account opened with a password that then added a passkey, with one session opened each way; set up unless told not to. */
  async function account(handle: string, setUp = true) {
    const first = client(), key = authenticatorFor(PORT)
    const made = await first.ok('POST', '/api/auth/signup', { handle, password: PW, displayName: handle })
    const b = await first.ok('POST', '/api/security/passkeys/begin')
    await first.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const pk = client(); await signIn(pk.ok, key)
    const pw = client(); await pw.ok('POST', '/api/auth/login', { handle, password: PW })
    if (setUp) await pk.ok('POST', '/api/household', {})
    return { userId: String(made.userId), key, pk, pw }
  }
  const hold = (pk: { ok: (m: string, p: string, b?: unknown) => Promise<J> }) => pk.ok('GET', '/api/session').then((s) => ({ above: s.profile.newPayeeHoldAbove, hours: s.profile.newPayeeHoldHours }))

  it('the amount and the wait change only with a fresh passkey confirmation, never in a password session, whichever way', async () => {
    const { key, pk, pw } = await account('hold-setting')
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 24 })
    // a password session cannot raise the amount (fewer payments wait), nor lower it, nor change the wait
    for (const change of [{ newPayeeHoldAbove: 5_000_000 }, { newPayeeHoldAbove: 0 }, { newPayeeHoldHours: 1 }, { newPayeeHoldHours: 72 }]) {
      const r = await pw.call('PATCH', '/api/profile', change)
      expect([r.status, r.json.error?.code], JSON.stringify(change)).toEqual([401, 'stepup_required'])
    }
    // nor after typing the password again: only a passkey's confirmation counts
    await pw.ok('POST', '/api/auth/stepup', { password: PW })
    expect((await pw.call('PATCH', '/api/profile', { newPayeeHoldAbove: 5_000_000 })).status).toBe(401)
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 24 })
    // with the passkey's confirmation (a passkey sign-in counts for its first minutes, as for every other safeguard): a
    // longer wait is tighter, so it takes effect at once; a higher amount is looser, so it waits out the protection delay
    // the same values again is no change, and needs nothing; other figures still change as before
    await pw.ok('PATCH', '/api/profile', { newPayeeHoldAbove: 1_000_000, spending: 7_000_000 })
    await stepUp(pk.ok, key)
    const changed = await pk.ok('PATCH', '/api/profile', { newPayeeHoldAbove: 2_500_000, newPayeeHoldHours: 48 })
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 48 })
    expect(changed).toMatchObject({ deferred: true, waiting: { after: { newPayeeHoldAbove: 2_500_000 }, before: { newPayeeHoldAbove: 1_000_000 }, effectiveAt: expect.any(Number) } })
    // a wait not on the list is refused, with the field named, and nothing is scheduled by it
    const bad = await pk.call('PATCH', '/api/profile', { newPayeeHoldHours: 5 })
    expect([bad.status, bad.json.error?.fields?.newPayeeHoldHours]).toEqual([400, 'Choose 1, 4, 12, 24, 48 or 72 hours, or no wait.'])
    expect((await pk.ok('GET', '/api/session')).profileChange).toMatchObject({ id: changed.waiting.id })
    const audited = api.ctx.db.get<{ detail_json: string }>(`SELECT detail_json FROM audit WHERE action = 'profile.update' AND detail_json LIKE '%"newPayeeHold":%' ORDER BY id DESC LIMIT 1`)
    expect(JSON.parse(audited!.detail_json)).toMatchObject({ applied: ['newPayeeHoldHours'], deferred: true, waiting: { changeId: changed.waiting.id, after: { newPayeeHoldAbove: 2_500_000 } }, newPayeeHold: { before: { above: 1_000_000, hours: 24 }, asked: { above: 2_500_000, hours: 48 }, now: { above: 1_000_000, hours: 48 } } })
  })

  it('a loosening waits out the protection delay; the passkey can cancel it, a password session cannot; it applies when due', async () => {
    const { key, pk, pw, userId } = await account('hold-loosen')
    await stepUp(pk.ok, key)
    const line = (await pk.ok('GET', '/api/session')).profile.line as number
    const asked = await pk.ok('PATCH', '/api/profile', { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 0, line: line - 100_000 })
    expect(asked.profile).toMatchObject({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24, line })
    const pending = (await pk.ok('GET', '/api/session')).profileChange
    expect(pending).toMatchObject({ id: asked.waiting.id, after: { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 0, line: line - 100_000 }, before: { newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24, line } })
    expect(pending.effectiveAt - pending.requestedAt).toBe(72 * 3600_000)
    // the person is told at once: an urgent notice, and the security history
    expect(api.ctx.db.get(`SELECT title FROM notices WHERE user_id = ? AND kind = 'security-change' ORDER BY ts DESC LIMIT 1`, userId)).toEqual({ title: 'A change that loosens your protections is scheduled' })
    // it is listed among the changes waiting under Security, and cancelled only with a passkey's confirmation
    expect((await pk.ok('GET', '/api/security')).scheduled).toEqual([expect.objectContaining({ id: pending.id, kind: 'loosen-profile', detail: { after: pending.after, before: pending.before } })])
    expect((await pw.call('POST', `/api/security/changes/${String(pending.id)}/cancel`)).status).toBe(401)
    // a password session may still tighten, at once: the floor it names is no longer in the change waiting
    await pw.ok('PATCH', '/api/profile', { line: line + 100_000 })
    expect((await pk.ok('GET', '/api/session')).profileChange).toMatchObject({ after: { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 0 }, effectiveAt: pending.effectiveAt })
    // the passkey cancels what is left
    const left = (await pk.ok('GET', '/api/session')).profileChange
    await pk.ok('POST', `/api/security/changes/${String(left.id)}/cancel`)
    expect((await pk.ok('GET', '/api/session')).profileChange).toBeNull()
    // one left to fall due: the engine's tick applies it when its delay ends
    const last = await pk.ok('PATCH', '/api/profile', { newPayeeHoldHours: 12 })
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 24 })
    applyDueChanges(api.ctx.db, Number(last.waiting.effectiveAt))
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 12 })
    expect((await pk.ok('GET', '/api/session')).profileChange).toBeNull()
  })

  it('set-up starts them at their defaults whatever the request says', async () => {
    const { pw, pk } = await account('hold-setup', false)
    await pw.ok('POST', '/api/household', { profile: { newPayeeHoldAbove: 99_00_00_000, newPayeeHoldHours: 1, spending: 6_000_000 } })
    expect(await hold(pk)).toEqual({ above: 1_000_000, hours: 24 })
    expect((await pk.ok('GET', '/api/session')).profile.spending).toBe(6_000_000)
  })

  it('a held payment is sent by no route before its time; cancelling it needs no passkey', async () => {
    const { key, pk, pw } = await account('hold-routes')
    // asking first answers 200 with the paper bank's answer and saves nothing (the form asks this before adding)
    const asked = await pk.call('POST', '/api/payees/check', { name: 'Ravi Kumaar', handle: 'ravi.kumar@upi' })
    expect([asked.status, asked.json.nameCheck?.outcome, asked.json.nameCheck?.registeredName, asked.json.needsConfirmation]).toEqual([200, 'close', 'Ravi Kumar', true])
    expect((await pk.ok('GET', '/api/payees')).payees).toEqual([])
    const y = await pk.ok('POST', '/api/payees', { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' })
    expect((await pk.ok('GET', '/api/payees')).payees[0]).toMatchObject({ name: 'Ravi Kumar', name_check: 'match', registered_name: 'Ravi Kumar' })
    const pv = await pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 1_500_000 })
    const until = JSON.parse(String(pv.document)).action.params.hold.until as number
    expect(until).toBeGreaterThan(Date.now() + 23 * 3600_000)
    await approve(pk.ok, key, String(pv.approvalId), String(pv.docHash))
    const a = await pk.ok('POST', '/api/actions', { approvalId: pv.approvalId })
    await stepAllActions(api.ctx)
    const record = () => pk.ok('GET', `/api/actions/${String(a.id)}`)
    expect(await record()).toMatchObject({ state: 'held', params: { hold: { until } }, times: { held: expect.any(Number) } })
    // the same approval again: refused, and no second payment
    expect((await pk.call('POST', '/api/actions', { approvalId: pv.approvalId })).json.error?.code).toBe('approval_used')
    // disputing it is refused: it has not been paid
    expect((await pk.call('POST', `/api/actions/${String(a.id)}/dispute`, { reason: 'Send it now please' })).json.error?.code).toBe('cannot_dispute')
    await stepAllActions(api.ctx)
    expect((await record()).state).toBe('held')
    expect(api.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n).toBe(0)
    // cancelling is tightening: a password session may do it
    const c = await pw.ok('POST', `/api/actions/${String(a.id)}/cancel`)
    expect(c).toMatchObject({ state: 'cancelled', error: 'Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.' })
    await stepAllActions(api.ctx)
    expect(await record()).toMatchObject({ state: 'cancelled', receiptId: expect.any(String) })
  })
})
