import { describe, expect, it } from 'vitest'
import { login, logout, register, sessionFor, stepUp, IDLE_MS, ABSOLUTE_MS, STEPUP_MS } from './auth.ts'
import { makeKit, T0 } from './testkit.ts'

const PW = 'correct horse battery 42'
const meta = { ip: '127.0.0.1', ua: 'test' }

describe('accounts and sessions', () => {
  it('registers, signs in, and stores neither the password nor the session token', async () => {
    const k = makeKit({ user: false })
    const id = await register(k.db, { handle: 'Asha', password: PW, displayName: 'Asha' }, meta.ip, T0)
    const s = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    expect(s.userId).toBe(id)
    const row = k.db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', id)!
    expect(row.pw_hash.startsWith('scrypt$131072$8$1$')).toBe(true)
    expect(row.pw_hash).not.toContain(PW)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE id_hash = ?', s.token)!.n).toBe(0) // only its hash is stored
    expect(sessionFor(k.db, s.token, T0 + 1000)?.userId).toBe(id)
    expect(sessionFor(k.db, s.token + 'x', T0 + 1000)).toBe(null)
  }, 20_000)

  it('rejects weak or malformed credentials with a message per field, and a taken handle', async () => {
    const k = makeKit({ user: false })
    await expect(register(k.db, { handle: 'a', password: 'short' }, meta.ip, T0)).rejects.toMatchObject({ fields: { handle: expect.any(String), password: expect.any(String) } })
    await expect(register(k.db, { handle: 'asha', password: 'asha-asha-asha' }, meta.ip, T0)).rejects.toMatchObject({ fields: { password: expect.stringMatching(/easy to guess/) } })
    await register(k.db, { handle: 'asha', password: PW }, meta.ip, T0)
    await expect(register(k.db, { handle: 'ASHA', password: PW }, meta.ip, T0)).rejects.toMatchObject({ code: 'handle_taken' })
  }, 20_000)

  it('gives the same answer for a wrong password and an unknown handle, and locks after five wrong passwords', async () => {
    const k = makeKit({ user: false })
    await register(k.db, { handle: 'asha', password: PW }, meta.ip, T0)
    const wrong = await login(k.db, { handle: 'asha', password: 'not the password' }, meta, T0).catch((e: Error) => e.message)
    const unknown = await login(k.db, { handle: 'nobody', password: 'not the password' }, meta, T0).catch((e: Error) => e.message)
    expect(wrong).toBe(unknown)
    for (let i = 0; i < 4; i++) await login(k.db, { handle: 'asha', password: 'nope nope nope' }, meta, T0 + i).catch(() => null)
    await expect(login(k.db, { handle: 'asha', password: PW }, meta, T0 + 10)).rejects.toMatchObject({ code: 'locked' })
    const s = await login(k.db, { handle: 'asha', password: PW }, meta, T0 + 16 * 60_000)
    expect(s.userId).toBeTruthy()
  }, 40_000)

  it('ends a session on sign-out, after 12 idle hours and after 7 days', async () => {
    const k = makeKit({ user: false })
    await register(k.db, { handle: 'asha', password: PW }, meta.ip, T0)
    const a = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    expect(sessionFor(k.db, a.token, T0 + IDLE_MS - 1000)).not.toBe(null)
    expect(sessionFor(k.db, a.token, T0 + 2 * IDLE_MS + 5000)).toBe(null) // last seen was just under 12 hours in
    const b = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    for (let t = T0; t < T0 + ABSOLUTE_MS; t += IDLE_MS / 2) sessionFor(k.db, b.token, t)
    expect(sessionFor(k.db, b.token, T0 + ABSOLUTE_MS + 1)).toBe(null)
    const c = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    logout(k.db, c.token, T0 + 1)
    expect(sessionFor(k.db, c.token, T0 + 2)).toBe(null)
  }, 40_000)

  it('a password re-entry lasts five minutes and is never a passkey confirmation; many correct passwords never lock the owner out, wrong ones do', async () => {
    const k = makeKit({ user: false })
    await register(k.db, { handle: 'asha', password: PW }, meta.ip, T0)
    const s = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    const sess = () => sessionFor(k.db, s.token, T0 + 10 * 60_000)!
    expect(sess().stepUpFresh).toBe(false) // signing in counted as step-up at T0; ten minutes later it has lapsed
    for (let i = 0; i < 15; i++) await stepUp(k.db, sess(), PW, meta.ip, T0 + 10 * 60_000 + i)
    // Since R7 a password re-entry is recorded as such: it never counts as a passkey confirmation, and it unlocks
    // nothing but adding a first passkey (server/passkeys.ts beginAddPasskey).
    expect(sessionFor(k.db, s.token, T0 + 10 * 60_000 + STEPUP_MS - 1000)).toMatchObject({ passwordStepUpFresh: true, stepUpFresh: false })
    for (let i = 0; i < 8; i++) await stepUp(k.db, sess(), 'wrong wrong wrong', meta.ip, T0 + 11 * 60_000 + i).catch(() => null)
    await expect(stepUp(k.db, sess(), PW, meta.ip, T0 + 11 * 60_000 + 100)).rejects.toMatchObject({ code: 'too_many' })
  }, 90_000)

  it('a passkey-only account is answered on the password path exactly as an unknown handle: a hash is computed, no failure is counted, it never locks', async () => {
    const k = makeKit()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_pk', 'pkonly', 'P', '!', ?, 'person')`, T0)
    const meta = { ip: '127.0.0.9', ua: 'test' }
    for (let i = 0; i < 7; i++) {
      const t = performance.now()
      await expect(login(k.db, { handle: 'pkonly', password: 'not-the-password-1' }, meta, T0 + i)).rejects.toMatchObject({ code: 'bad_credentials' })
      expect(performance.now() - t).toBeGreaterThan(20) // the same scrypt work as for a handle that does not exist
    }
    expect(k.db.get('SELECT failed_logins, locked_until FROM users WHERE id = ?', 'usr_pk')).toEqual({ failed_logins: 0, locked_until: null })
  })
})
