/**
 * The owner told what only the wallet service knows (server/vault-watch.ts): a job a chain reorganisation undid (R7-036),
 * once per job, resolved if the chain holds it again; and a raise of the caps on earned authority (D-K1b) told again when
 * it comes into force, never when a lower cap dropped it.
 */
import { describe, expect, it } from 'vitest'
import { acknowledge } from './notify.ts'
import { capsRaiseNotices, reorgNotices } from './vault-watch.ts'
import { makeKit } from './testkit.ts'

const open = (k: ReturnType<typeof makeKit>, kind: string) => k.db.all<{ id: string; title: string; body: string; subject: string | null; level: string }>(`SELECT id, title, body, subject, level FROM notices WHERE user_id = ? AND kind = ? AND resolved_at IS NULL`, k.userId, kind)

describe('a wallet operation a reorganisation undid', () => {
  it('raises one notice that needs the owner per job, says it is not done and nothing was re-sent, and is resolved by acknowledging it or by the job being done again', () => {
    const k = makeKit()
    const jobs = [{ id: 'job-a', kind: 'convert', status: 'reorged', error: 'A chain reorganisation replaced the block that held this operation\'s transaction (0xabc) before it had 2 confirmations. It was never done.' }, { id: 'job-b', kind: 'pay', status: 'done' }]
    expect(reorgNotices(k.db, k.userId, jobs, k.clock.now())).toBe(1)
    expect(reorgNotices(k.db, k.userId, jobs, k.clock.now() + 30_000)).toBe(0)
    const n = open(k, 'vault-job-reorged')
    expect(n.map((x) => [x.subject, x.level])).toEqual([['job-a', 'action']])
    expect(n[0]!.title).toBe('A conversion on your on-chain wallet is not done')
    expect(n[0]!.body).toMatch(/Nothing was sent again/)
    expect(n[0]!.body).toMatch(/valueless test tokens/)
    // mined again and done after its confirmations: resolved
    reorgNotices(k.db, k.userId, [{ id: 'job-a', kind: 'convert', status: 'done' }], k.clock.now() + 60_000)
    expect(open(k, 'vault-job-reorged')).toEqual([])
    // another one, acknowledged by the owner: settled
    reorgNotices(k.db, k.userId, [{ id: 'job-c', kind: 'withdraw', status: 'reorged', error: null }], k.clock.now() + 90_000)
    const c = open(k, 'vault-job-reorged')[0]!
    acknowledge(k.db, k.userId, c.id, k.clock.now() + 91_000, { settleSecurity: false })
    expect(open(k, 'vault-job-reorged')).toEqual([])
  })
})

describe('a raise of the caps on earned authority', () => {
  const remember = (k: ReturnType<typeof makeKit>, nonce: string, effectiveAt: number, values: Record<string, string>) =>
    k.db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `vault.caps-raise:${k.userId}:${nonce}`, JSON.stringify({ workspaceId: k.userId, nonce, effectiveAt, people: [k.userId], caps: Object.keys(values), values, raises: ['in any window: 800.00 tINR'] }))
  const told = (k: ReturnType<typeof makeKit>) => k.db.all<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? AND kind = 'vault-earned-caps-raised'`, k.userId).length

  it('is told when it has come into force, once; not before its delay ends; and forgotten without a notice when a lower cap dropped it', () => {
    const k = makeKit(), now = k.clock.now()
    remember(k, 'n-1', now + 60_000, { perWindow: '80000' })
    expect(capsRaiseNotices(k.db, k.userId, { inForce: { perWindow: '50000', perPayer: '10000' }, pending: [{ cap: 'perWindow', nonce: 'n-1' }] }, now)).toBe(0)
    // the delay has ended by QED's clock, but the wallet service still lists it as waiting: asked again later
    expect(capsRaiseNotices(k.db, k.userId, { inForce: { perWindow: '50000', perPayer: '10000' }, pending: [{ cap: 'perWindow', nonce: 'n-1' }] }, now + 61_000)).toBe(0)
    expect(capsRaiseNotices(k.db, k.userId, { inForce: { perWindow: '80000', perPayer: '10000' }, pending: [] }, now + 62_000)).toBe(1)
    expect(told(k)).toBe(1)
    expect(capsRaiseNotices(k.db, k.userId, { inForce: { perWindow: '80000', perPayer: '10000' }, pending: [] }, now + 63_000)).toBe(0)
    expect(told(k)).toBe(1)
    // a raise a lower cap dropped: no notice, and forgotten
    remember(k, 'n-2', now + 60_000, { perWindow: '90000' })
    expect(capsRaiseNotices(k.db, k.userId, { inForce: { perWindow: '45000', perPayer: '10000' }, pending: [] }, now + 120_000)).toBe(0)
    expect(told(k)).toBe(1)
    expect(k.db.get(`SELECT 1 x FROM meta WHERE key LIKE ?`, `vault.caps-raise:${k.userId}:%`)).toBeUndefined()
  })
})
