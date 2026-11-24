/**
 * Recovery codes matched off the event loop on the signed-out paths (QA review of R12, D-d): the same answer as the
 * blocking match, and other work keeps running while ten scrypt derivations are made.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { matchCode, matchCodeAsync, scryptCode } from './passkeys.ts'

describe('matching a recovery code off the event loop', () => {
  const rows = Array.from({ length: 10 }, (_, i) => {
    const salt = randomBytes(16).toString('hex')
    return { id: `rcv${i}`, salt, code_hash: scryptCode(salt, i === 7 ? 'ABCD-EFGH-JKMN-PQRS' : `ZZZZ-ZZZZ-ZZZZ-ZZZ${i}`), algo: 'scrypt' }
  })
  it('finds the same row as the blocking match, and none for a wrong code', async () => {
    expect((await matchCodeAsync(rows, 'abcd-efgh-jkmn-pqrs'))?.id).toBe('rcv7')
    expect(matchCode(rows, 'abcd-efgh-jkmn-pqrs')?.id).toBe('rcv7')
    expect(await matchCodeAsync(rows, 'AAAA-BBBB-CCCC-DDDD')).toBeUndefined()
  })
  it('leaves the event loop free while it derives', async () => {
    let ticks = 0
    const t = setInterval(() => { ticks++ }, 1)
    await matchCodeAsync(rows, 'AAAA-BBBB-CCCC-DDDD')
    clearInterval(t)
    expect(ticks).toBeGreaterThan(0)
  })
})
