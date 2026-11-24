/**
 * Restoring the QED database from a sealed copy, and the checks that a restored database is sound (R7-085, R7-076;
 * docs/ENCRYPTION.md section 4). Making sealed copies (backups and the copies taken before a migration) is in sealed.ts;
 * its API is re-exported here.
 *
 * Restore: the manifest is checked against the file (size, SHA-256) and the file's header before anything is decrypted;
 * the keyring must be of the copy's purpose (a backup opens only under the backup key, a migration copy only under the
 * migration-copy key); the file is decrypted into a private folder; SQLite's integrity, every ledger's re-derivation and
 * every receipt chain are verified on a read-only connection (the checks of "npm run verify": ledger.ts verifyLedger,
 * receipts.ts verifyChain), and the time each step took is reported. The live database is written only with the explicit
 * flag, only when it does not look open, and only after it has itself been backed up encrypted. No other existing file is
 * ever written over.
 */
import { existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { registerAmountSql } from './amount-sql.ts'
import type { Db } from './core.ts'
import { type Keyring, samePath } from './keys.ts'
import { verifyLedger } from './ledger.ts'
import { verifyChain } from './receipts.ts'
import { makeScratch } from './scratch.ts'
import { BackupError, checkSealed, contextOf, createBackup, type Manifest, privateFolder, purposeOf, readManifest, reencryptSealed, sweepOrRefuse, type BackupResult } from './sealed.ts'

/** The private folders a restore decrypts into, beside its target. */
export const RESTORE_PREFIX = '.qed-restore-'

export { BackupError, type BackupErrorCode, type BackupOptions, type BackupResult, checkSealed, contextOf, createBackup, createMigrationCopy, listManifests, MANIFEST_FORMAT, type Manifest, purposeOf, readManifest, reencryptSealed, type SealedPurpose, verifySealed } from './sealed.ts'

const ms = (t: number): number => Math.round((performance.now() - t) * 10) / 10
const noop = (): void => {}

export interface Verification {
  ok: boolean
  integrity: string
  foreignKeyIssues: number
  schemaVersion: string | null
  users: number
  ledgerBreaks: number
  receipts: number
  chainsBroken: number
  /** The first check that failed, by user id and check name; no amounts or stored values. */
  firstFailure: string | null
}

/**
 * verifyLedger and verifyChain read through all() and get() only (ledger.ts:190, receipts.ts:41). This view of a
 * read-only connection offers nothing else, so a future write through it fails rather than change a restored copy.
 */
function readOnlyView(raw: DatabaseSync): Db {
  const view = { all: (sql: string, ...p: SQLInputValue[]) => raw.prepare(sql).all(...p), get: (sql: string, ...p: SQLInputValue[]) => raw.prepare(sql).get(...p) }
  return view as unknown as Db
}

/** The checks of "npm run verify" and SQLite's own, on a read-only connection: the file is not changed. */
export function verifyDatabase(path: string): Verification {
  const raw = new DatabaseSync(path, { readOnly: true })
  try {
    registerAmountSql(raw) // verifyLedger sums amounts with amount_sum; it reads a copy older than v6 too (server/ledger.ts)
    const integrity = (raw.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check).join('; ')
    const foreignKeyIssues = raw.prepare('PRAGMA foreign_key_check').all().length
    const schemaVersion = (raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: string } | undefined)?.value ?? null
    const db = readOnlyView(raw)
    const users = raw.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[]
    let ledgerBreaks = 0, receipts = 0, chainsBroken = 0
    let firstFailure: string | null = null
    for (const u of users) {
      const breaks = verifyLedger(db, u.id)
      const chain = verifyChain(db, u.id)
      ledgerBreaks += breaks.length
      receipts += chain.count
      if (!chain.ok) chainsBroken++
      firstFailure ??= breaks.length ? `${u.id}: ledger check ${breaks[0]!.check}` : !chain.ok ? `${u.id}: receipt chain broken at ${chain.brokenAt}` : null
    }
    return { ok: integrity === 'ok' && ledgerBreaks === 0 && chainsBroken === 0, integrity, foreignKeyIssues, schemaVersion, users: users.length, ledgerBreaks, receipts, chainsBroken, firstFailure }
  } finally { raw.close() }
}

export interface RestoreOptions {
  manifest: string
  keyring: Keyring
  /** Where the restored database goes. Must not exist, unless it is the live database and overwriteLive is set. */
  target: string
  /** The live database's path. Writing it needs overwriteLive, whether or not a file is there yet. */
  live?: string
  overwriteLive?: boolean
  /** With overwriteLive: the current live database is first backed up here, encrypted. */
  backupLiveTo?: string
  /**
   * The backup keyring that seals that copy of the live database. Default: `keyring`, when it is the backup keyring. A
   * migration copy restored over the live database (a rollback) needs it given, since it opens under another key.
   */
  backupKeyring?: Keyring
  log?: (line: string) => void
}
export interface RestoreResult {
  target: string
  manifest: Manifest
  verification: Verification
  replacedLive: boolean
  liveBackup: string | null
  timings: { checkMs: number; decryptMs: number; verifyMs: number; totalMs: number }
}

/** Decrypt a backup into a private place and verify it. See the module comment for the order of checks. */
export function restoreBackup(o: RestoreOptions): RestoreResult {
  const t0 = performance.now()
  const log = o.log ?? noop
  const { m, backupPath } = readManifest(o.manifest)
  checkSealed(m, backupPath)
  o.keyring.requirePurpose(purposeOf(m))
  const target = resolve(o.target)
  const live = o.live ? resolve(o.live) : undefined
  const intoLive = live !== undefined && samePath(target, live)
  if (intoLive && !o.overwriteLive) throw new BackupError('would_overwrite_live', `${target} is the live database; a restore writes it only with --overwrite-live, after the API and the engine are stopped.`)
  if (!intoLive && existsSync(target)) throw new BackupError('target_exists', `${target} already exists; a restore never writes over a file. Choose a new path.`)
  if (intoLive && !o.backupLiveTo) throw new BackupError('live_backup_required', 'Restoring over the live database needs a folder to back the current one up into first (--backup-live-to).')
  const liveRing = o.backupKeyring ?? (o.keyring.purpose === 'backup' ? o.keyring : undefined)
  if (intoLive && !liveRing) throw new BackupError('live_backup_required', 'Restoring a migration copy over the live database needs the backup key too, to back the current one up first.')
  liveRing?.requirePurpose('backup')
  if (intoLive && (existsSync(`${target}-wal`) || existsSync(`${target}-shm`))) throw new BackupError('live_in_use', `${target} has a -wal or -shm file, so a process may still have it open. Stop the API and the engine first.`)
  const dir = privateFolder(dirname(target), 'The folder the database is restored into')
  // The plaintext is decrypted into a private folder that records its owner; one an interrupted restore left is swept first.
  sweepOrRefuse(dir, RESTORE_PREFIX, log)
  const checkMs = ms(t0)
  const work = makeScratch(dir, RESTORE_PREFIX, 'restore')
  const partial = join(work, 'restoring.db')
  try {
    const t1 = performance.now()
    const opened = o.keyring.decryptFile(backupPath, partial, contextOf(m))
    if (opened.plaintextSha256 !== m.plaintext.sha256 || opened.plaintextBytes !== m.plaintext.bytes) throw new BackupError('backup_altered', `The decrypted backup ${m.id} does not match the plaintext SHA-256 its manifest records.`)
    const decryptMs = ms(t1)
    const t2 = performance.now()
    const verification = verifyDatabase(partial)
    const verifyMs = ms(t2)
    let liveBackup: string | null = null
    if (intoLive) {
      if (!verification.ok) throw new BackupError('verification_failed', `The restored copy failed verification (${verification.firstFailure ?? verification.integrity}); the live database was not touched.`)
      if (existsSync(target)) liveBackup = createBackup({ db: target, outDir: o.backupLiveTo!, keyring: liveRing!, log }).manifestPath
      // A -wal left beside the live path would be replayed into the restored file; it appears only if something opened it.
      if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) throw new BackupError('live_in_use', `${target} was opened while it was being backed up; it was not replaced. Stop the API and the engine, then try again.`)
    }
    renameSync(partial, target)
    const totalMs = ms(t0)
    log(`restore ${m.id}: ${verification.ok ? 'verified' : 'NOT verified'} (integrity ${verification.integrity}; ${verification.users} ledgers, ${verification.ledgerBreaks} breaks; ${verification.receipts} receipts, ${verification.chainsBroken} broken chains) in ${totalMs} ms (checks ${checkMs}, decrypt ${decryptMs}, verify ${verifyMs})`)
    return { target, manifest: m, verification, replacedLive: intoLive, liveBackup, timings: { checkMs, decryptMs, verifyMs, totalMs } }
  } finally {
    rmSync(work, { recursive: true, force: true }) // after the rename only its owner record is left in it
  }
}

/**
 * Compromise response, step two (after rotating): the same snapshot sealed again under the active data key, as a new
 * sealed set of the same kind (a backup or a migration copy), streaming from the old one: no plaintext reaches the disk
 * (sealed.ts reencryptSealed). Once every copy is re-encrypted, the old version can be revoked.
 */
export function reencryptBackup(o: { manifest: string; keyring: Keyring; outDir: string; copyKeyring?: boolean; now?: () => number; log?: (l: string) => void }): BackupResult {
  return reencryptSealed(o)
}
