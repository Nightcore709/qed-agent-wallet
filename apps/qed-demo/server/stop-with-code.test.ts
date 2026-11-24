/**
 * Pausing QED with a saved recovery code from the signed-out page (server/stop-with-code.ts; R12 task comparison, T6-a
 * and T6-d): a right code pauses everything but protective selling, opens no session, resumes nothing and leaves the
 * code usable; a wrong code or an unknown handle changes nothing; every answer is the same; the person's allowance and
 * the address's allowance hold.
 */
import { describe, expect, it } from 'vitest'
import { makeRecoveryCodes } from './passkeys.ts'
import { PAUSE_REASON, pauseWithCode } from './stop-with-code.ts'
import { makeKit } from './testkit.ts'

const stopOf = (k: ReturnType<typeof makeKit>) => k.db.get<{ stop_at: number | null; stop_protective: number; stop_reason: string | null }>('SELECT stop_at, stop_protective, stop_reason FROM users WHERE id = ?', k.userId)!
const events = (k: ReturnType<typeof makeKit>) => k.db.all<{ kind: string; detail_json: string }>(`SELECT kind, detail_json FROM security_events WHERE person_id = ? AND kind = 'paused-with-saved-code'`, k.userId)

describe('pausing with a saved code, signed out', () => {
  it('a right code pauses all but protective selling, and nothing else changes', async () => {
    const k = makeKit()
    const [code] = makeRecoveryCodes(k.db, k.userId, k.clock.now())
    const sessions = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n
    expect(await pauseWithCode(k.ctx, { handle: '@Tester ', code: code!.toLowerCase() }, '10.0.0.1')).toEqual({ ok: true })
    expect(stopOf(k)).toMatchObject({ stop_protective: 1, stop_reason: PAUSE_REASON })
    expect(stopOf(k).stop_at).not.toBeNull()
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n).toBe(sessions) // no session opened
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', k.userId)!.n).toBe(0) // the code still works for a recovery
    expect(events(k)).toHaveLength(1)
    expect(JSON.parse(events(k)[0]!.detail_json)).toEqual({ already: false, protectiveContinues: true })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0) // no money moved
  })

  it('a wrong code, a replaced code or an unknown handle changes nothing, and every answer is the same', async () => {
    const k = makeKit()
    const [old] = makeRecoveryCodes(k.db, k.userId, k.clock.now())
    makeRecoveryCodes(k.db, k.userId, k.clock.now()) // the first set is replaced
    expect(await pauseWithCode(k.ctx, { handle: 'tester', code: old! }, '10.0.0.2')).toEqual({ ok: true })
    expect(await pauseWithCode(k.ctx, { handle: 'tester', code: 'AAAA-BBBB-CCCC-DDDD' }, '10.0.0.2')).toEqual({ ok: true })
    expect(await pauseWithCode(k.ctx, { handle: 'nobody-here', code: 'AAAA-BBBB-CCCC-DDDD' }, '10.0.0.2')).toEqual({ ok: true })
    expect(await pauseWithCode(k.ctx, { handle: 42, code: null }, '10.0.0.2')).toEqual({ ok: true })
    expect(stopOf(k).stop_at).toBeNull()
    expect(events(k)).toHaveLength(0)
  })

  it('leaves a pause already in force as it was, protective selling included', async () => {
    const k = makeKit()
    const [code] = makeRecoveryCodes(k.db, k.userId, k.clock.now())
    k.db.run('UPDATE users SET stop_at = ?, stop_reason = ?, stop_protective = 0 WHERE id = ?', k.clock.now() - 1000, 'Paused by you', k.userId)
    await pauseWithCode(k.ctx, { handle: 'tester', code: code! }, '10.0.0.3')
    expect(stopOf(k)).toMatchObject({ stop_protective: 0, stop_reason: 'Paused by you' })
    // the history says it was already paused and that protective selling stays stopped (R13: said truly)
    expect(JSON.parse(events(k)[0]!.detail_json)).toEqual({ already: true, protectiveContinues: false })
  })

  it('wrong codes never stop a right one (review M1): they are told to the person at the third in a day; the address\'s allowance holds (ten an hour)', async () => {
    const k = makeKit()
    const [code] = makeRecoveryCodes(k.db, k.userId, k.clock.now())
    for (let i = 0; i < 5; i++) await pauseWithCode(k.ctx, { handle: 'tester', code: 'AAAA-BBBB-CCCC-DDDD' }, `10.0.1.${i}`)
    expect(stopOf(k).stop_at).toBeNull()
    expect(k.db.all(`SELECT 1 FROM security_events WHERE person_id = ? AND kind = 'pause-code-failures'`, k.userId)).toHaveLength(1)
    await pauseWithCode(k.ctx, { handle: 'tester', code: code! }, '10.0.1.9') // the right code, after five wrong ones
    expect(stopOf(k).stop_at).not.toBeNull()
    const ip = '10.0.2.1'
    for (let i = 0; i < 10; i++) await pauseWithCode(k.ctx, { handle: `nobody${i}`, code: 'x' }, ip)
    await expect(pauseWithCode(k.ctx, { handle: 'nobody', code: 'x' }, ip)).rejects.toMatchObject({ code: 'too_many' })
  })
})
