/**
 * Expiry and rotation of sealed copies (server/sealed-expiry.ts): a deletion reaches a sealed backup within the window plus
 * one rotation, by destroying the data key, never by claiming the file is physically gone. Fixtures only.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createBackup, listManifests, readManifest, verifySealed } from './backup.ts'
import { buildFixture } from './backup-fixture.ts'
import { FileKekProvider, KeyError, Keyring } from './keys.ts'
import { DEFAULT_RETENTION } from './backup-retention.ts'
import { applyExpiry, KEY_ROTATION_DAYS, planExpiry, SEALED_WINDOW_DAYS, type SealedSet } from './sealed-expiry.ts'

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 1)
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

function stack() {
  const root = mkdtempSync(join(tmpdir(), 'qed-expiry-'))
  chmodSync(root, 0o700); made.push(root)
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 })
  const db = join(data, 'qed.db'); buildFixture(db)
  const out = join(root, 'backups')
  const kek = FileKekProvider.generate(join(root, 'keys', 'qed.kek'), { forbiddenFolders: [data, out] }).load()
  const ring = Keyring.create(join(root, 'keys', 'keyring.json'), kek, T0)
  const take = (at: number) => createBackup({ db, outDir: out, keyring: ring, now: () => at })
  const sets = (): SealedSet[] => listManifests(out).map((p) => ({ m: readManifest(p).m, folder: out }))
  return { out, ring, take, sets }
}
const failure = (fn: () => unknown): string => { try { fn() } catch (e) { if (e instanceof KeyError) return e.code; throw e } return 'none' }

describe('sealed copies expire by destroying their key', () => {
  it('states a window and a rotation period', () => {
    expect(SEALED_WINDOW_DAYS).toBe(125)
    expect(KEY_ROTATION_DAYS).toBe(7)
  })

  it('is at least as long as the oldest backup the deployment\'s own retention keeps (3 months and a partial month), so expiry never takes one retention keeps', () => {
    expect(SEALED_WINDOW_DAYS).toBeGreaterThanOrEqual(DEFAULT_RETENTION.monthly * 31 + 31)
  })

  it('rotates when the active key is older than the period, and not before', () => {
    const s = stack()
    s.take(T0)
    expect(planExpiry(s.ring, s.sets(), T0 + 6 * DAY).rotate).toBe(false)
    expect(planExpiry(s.ring, s.sets(), T0 + 7 * DAY).rotate).toBe(true)
  })

  it('keeps a copy until its key is past the window, then destroys the key and removes the copies under it', () => {
    const s = stack()
    const old = s.take(T0)
    applyExpiry(s.ring, s.sets(), T0 + 8 * DAY) // rotates: version 1 is retired on day 8
    const fresh = s.take(T0 + 8 * DAY)
    expect(fresh.manifest.key.version).toBe(2)
    // the retired key was retired on day 8, so it goes on day 8 + window
    const last = 8 + SEALED_WINDOW_DAYS
    const early = applyExpiry(s.ring, s.sets(), T0 + (last - 1) * DAY)
    expect(early.destroyed).toEqual([])
    expect(early.waiting.map((w) => w.version)).toContain(1) // the key rotated again meanwhile; its copies wait on their own clock
    expect(verifySealed(old.manifestPath, s.ring).manifest.id).toBe(old.manifest.id)
    const late = applyExpiry(s.ring, s.sets(), T0 + (last + 1) * DAY)
    expect(late.destroyed).toEqual([1])
    expect(late.removed).toEqual([old.manifest.id])
    expect(existsSync(old.backupPath)).toBe(false)
    expect(existsSync(old.manifestPath)).toBe(false)
    // the key is gone for good: nothing sealed under it opens, and the newer copy is untouched
    expect(s.ring.list().find((k) => k.version === 1)).toMatchObject({ state: 'revoked', check: null })
    expect(verifySealed(fresh.manifestPath, s.ring).manifest.id).toBe(fresh.manifest.id)
    expect(existsSync(fresh.backupPath)).toBe(true)
  })

  it('a copy taken at t is unreadable by t + window + rotation, the stated bound, when the expiry runs daily', () => {
    const s = stack()
    const c = s.take(T0 + 3 * DAY) // sealed under version 1, whose key is retired by the first rotation after day 7
    let gone = -1
    for (let d = 0; d <= SEALED_WINDOW_DAYS + 30 && gone < 0; d++) {
      const now = T0 + d * DAY
      applyExpiry(s.ring, s.sets(), now)
      if (!existsSync(c.backupPath)) gone = d
    }
    expect(gone).toBeGreaterThan(0)
    expect(gone - 3).toBeLessThanOrEqual(SEALED_WINDOW_DAYS + KEY_ROTATION_DAYS)
  })

  it('a dry run changes nothing', () => {
    const s = stack()
    const c = s.take(T0)
    const before = s.ring.generation
    const r = applyExpiry(s.ring, s.sets(), T0 + 100 * DAY, { dryRun: true })
    expect(r.rotate).toBe(true)
    expect(r.rotated).toBe(false)
    expect(s.ring.generation).toBe(before)
    expect(existsSync(c.backupPath)).toBe(true)
  })

  it('never destroys a key something else is pinned to, and never the active key', () => {
    const s = stack()
    const c = s.take(T0)
    applyExpiry(s.ring, s.sets(), T0 + 8 * DAY)
    const pinned = [{ version: 1, kid: c.manifest.key.kid }]
    const r = applyExpiry(s.ring, s.sets(), T0 + 200 * DAY, { pinned })
    expect(r.destroyed).toEqual([])
    expect(existsSync(c.backupPath)).toBe(true)
    expect(failure(() => s.ring.revoke(s.ring.activeVersion))).toBe('revoke_active')
  })

  it('leaves the copies of another purpose alone', () => {
    const s = stack()
    const c = s.take(T0)
    const other = s.sets().map(({ m, folder }) => ({ m: { ...m, purpose: 'migration-copy' as const }, folder }))
    applyExpiry(s.ring, s.sets(), T0 + 8 * DAY)
    const r = applyExpiry(s.ring, other, T0 + 200 * DAY)
    expect(r.removed).toEqual([])
    expect(existsSync(c.backupPath)).toBe(true)
  })
})
