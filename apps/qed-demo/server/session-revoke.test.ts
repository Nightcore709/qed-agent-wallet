/**
 * Ending another session from the security screen (R7-077: sessions listed and revocable). The screen names a session
 * by the first twelve hex digits of its stored hash (server/passkeys.ts revokeSession); the token itself is never
 * stored or shown.
 */
import { describe, expect, it } from 'vitest'
import { login, register, sessionFor } from './auth.ts'
import { sha256hex } from './receipts.ts'
import { revokeSession } from './passkeys.ts'
import { makeKit, T0 } from './testkit.ts'

const PW = 'correct horse battery 42'
const meta = { ip: '127.0.0.1', ua: 'test' }
const idOf = (token: string): string => sha256hex(token).slice(0, 12)

describe('ending one session from another (R7-077)', () => {
  it('ends that session at once and keeps this one; a session of another person cannot be named; an ended one cannot be ended twice', async () => {
    const k = makeKit({ user: false })
    await register(k.db, { handle: 'asha', password: PW }, meta.ip, T0)
    await register(k.db, { handle: 'ravi', password: PW }, meta.ip, T0)
    const laptop = await login(k.db, { handle: 'asha', password: PW }, meta, T0)
    const phone = await login(k.db, { handle: 'asha', password: PW }, { ...meta, ua: 'phone' }, T0)
    const ravi = await login(k.db, { handle: 'ravi', password: PW }, meta, T0)
    const here = sessionFor(k.db, laptop.token, T0 + 1000)!

    revokeSession(k.db, here, idOf(phone.token), T0 + 2000)
    expect(sessionFor(k.db, phone.token, T0 + 3000)).toBe(null)
    expect(sessionFor(k.db, laptop.token, T0 + 3000)).not.toBe(null)

    expect(() => revokeSession(k.db, here, idOf(ravi.token), T0 + 4000)).toThrow(/not found/)
    expect(sessionFor(k.db, ravi.token, T0 + 5000)).not.toBe(null)
    expect(() => revokeSession(k.db, here, idOf(phone.token), T0 + 6000)).toThrow(/not found|already ended/)
    expect(() => revokeSession(k.db, here, 'not-a-session', T0 + 7000)).toThrow(/not valid/)
  }, 40_000)
})
