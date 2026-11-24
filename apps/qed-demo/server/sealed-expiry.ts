/**
 * Expiry and rotation of sealed copies of the database (backups and the copies taken before a migration), so that a
 * deletion (server/records.ts) reaches them within a stated time.
 *
 * The rule. A sealed copy is kept SEALED_WINDOW_DAYS from the data it holds (its snapshot time). The keyring's data key is
 * replaced every KEY_ROTATION_DAYS, so that copies are spread over keys that can be given up one by one. A retired data
 * key is destroyed (Keyring.revoke) once the newest copy sealed under it, or the day it was retired if that is later, is
 * more than the window old; every copy under it is then unreadable, and its files and manifests are removed. A copy
 * taken at time t is therefore unreadable by t + SEALED_WINDOW_DAYS + KEY_ROTATION_DAYS at the latest, when the expiry
 * runs at least once a day. QED does not schedule it: the operator does (`npm run backup:expire`).
 *
 * What this does not do: it never claims physical erasure. It cannot reach a copy kept anywhere else (a copy made by hand,
 * a plaintext archive, a copy off this computer), and the keyring's own copies are only as current as the folders that
 * were told about it (the command refreshes every copy it knows of). It destroys keys only for the keyring it is given, so
 * a copy under another purpose's key is untouched.
 *
 * This module imports nothing from the server but keys.ts and sealed.ts, so that records.ts can name the window.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Keyring } from './keys.ts'
import { type Manifest, purposeOf } from './sealed.ts'

const DAY = 86_400_000
/**
 * Long enough for the deployment's backup retention (server/backup-retention.ts DEFAULT_RETENTION keeps the newest backup of each of
 * the last 3 months: at most 3 months and a partial month, 124 days), so key destruction never takes a backup that retention keeps;
 * server/sealed-expiry.test.ts checks this against that policy.
 */
export const SEALED_WINDOW_DAYS = 125
export const KEY_ROTATION_DAYS = 7

export interface SealedSet { m: Manifest; folder: string }
export interface ExpiryPlan {
  /** The active data key is older than the rotation period: a new one should seal from now on. */
  rotate: boolean
  /** Retired keys that can be destroyed now, with the copies that go with them. */
  revoke: { version: number; kid: string; newestCopy: number | null; copies: string[] }[]
  /** Retired keys still needed, and when each can go. */
  waiting: { version: number; kid: string; revokableAt: number; copies: number }[]
}
export interface ExpiryOptions {
  windowMs?: number
  rotationMs?: number
  /** Keys that something else is still sealed under (a plaintext archive): never destroyed here. */
  pinned?: { version: number; kid: string }[]
}

export function planExpiry(ring: Keyring, sets: SealedSet[], now: number, o: ExpiryOptions = {}): ExpiryPlan {
  const window = o.windowMs ?? SEALED_WINDOW_DAYS * DAY, rotation = o.rotationMs ?? KEY_ROTATION_DAYS * DAY
  const mine = sets.filter(({ m }) => purposeOf(m) === ring.purpose)
  const keys = ring.list()
  const active = keys.find((k) => k.state === 'active')
  const plan: ExpiryPlan = { rotate: !!active && now - active.createdAt >= rotation, revoke: [], waiting: [] }
  for (const k of keys) {
    if (k.state !== 'retired') continue
    const copies = mine.filter(({ m }) => m.key.version === k.version && m.key.kid === k.kid)
    const newest = copies.reduce<number | null>((t, { m }) => (t === null || m.snapshotAtMs > t ? m.snapshotAtMs : t), null)
    const pinned = (o.pinned ?? []).some((x) => x.version === k.version && x.kid === k.kid)
    const revokableAt = pinned ? Number.MAX_SAFE_INTEGER : Math.max(k.retiredAt ?? 0, newest ?? 0) + window
    if (revokableAt <= now) plan.revoke.push({ version: k.version, kid: k.kid, newestCopy: newest, copies: copies.map(({ m }) => m.id) })
    else plan.waiting.push({ version: k.version, kid: k.kid, revokableAt, copies: copies.length })
  }
  return plan
}

export interface ExpiryResult extends ExpiryPlan { rotated: boolean; destroyed: number[]; removed: string[] }

/**
 * Rotate if due, then destroy every key that is past the window and remove the copies sealed under it. The plan is taken
 * after the rotation, so a key retired by it is not destroyed in the same run. With dryRun nothing is changed.
 */
export function applyExpiry(ring: Keyring, sets: SealedSet[], now: number, o: ExpiryOptions & { dryRun?: boolean } = {}): ExpiryResult {
  const first = planExpiry(ring, sets, now, o)
  if (o.dryRun) return { ...first, rotated: false, destroyed: [], removed: [] }
  if (first.rotate) ring.rotate(now)
  const plan = first.rotate ? planExpiry(ring, sets, now, o) : first
  const destroyed: number[] = [], removed: string[] = []
  for (const r of plan.revoke) {
    ring.revoke(r.version, now)
    destroyed.push(r.version)
    for (const { m, folder } of sets) {
      if (purposeOf(m) !== ring.purpose || m.key.version !== r.version || m.key.kid !== r.kid) continue
      rmSync(join(folder, m.file), { force: true })
      rmSync(join(folder, `${m.id}.manifest.json`), { force: true })
      removed.push(m.id)
    }
  }
  return { ...plan, rotated: first.rotate, destroyed, removed }
}
