/**
 * The copy taken before a schema migration (R11 section 11; docs/ENCRYPTION.md section 4). core.ts openDb calls
 * sealMigrationCopy before it changes anything. If an encrypted, verified copy cannot be made, the migration does not run
 * and the database is left as it was (a file an earlier start opened, byte for byte; opening one never opened before
 * switches it to WAL, as any open does): there is no plaintext copy, and no falling back to one. (The plaintext
 * `qed.db.pre-vN-….bak` files of 20 to 23 Nov were the last; docs/ENCRYPTION.md, section 7, on what becomes of them.)
 *
 * The copy is sealed under the migration-copy key, a keyring of its own (never the backup key, never the database's own
 * key), into migration-copies/ beside the database (QED_MIGRATION_COPY_DIR to put it elsewhere), with the keys found as
 * key-config.ts describes (QED_KEY_DIR, default ~/.qed/keys). Restore one with
 * `npm run restore -- --manifest <path> --target <new path>`.
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type Env, migrationCopyDir, openKeyring } from './key-config.ts'
import { KeyError } from './keys.ts'
import { BackupError, type BackupOptions, type BackupResult, createMigrationCopy } from './sealed.ts'

/** A migration that did not run because its copy could not be sealed. `reason` is the refusal underneath. */
export class MigrationRefused extends Error {
  readonly code = 'migration_refused'
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'MigrationRefused'
    this.reason = reason
  }
}

const KEYS = 'Set the keys up with `npm run keys:init` and escrow the key file it makes, or point QED_KEY_DIR (or QED_KEY_FILE, or QED_KEK) at the key-encryption key; then start again.'
const FIX: Record<string, string> = {
  key_missing: KEYS,
  keyring_missing: 'Make the missing keyring with `npm run keys:init`, or put its copy back (one is kept beside the migration copies and the backups); then start again.',
  key_permissions: 'Make the key private as the message says (chmod 600 for the key file, 700 for its folder); then start again.',
  key_location: 'Keep the key-encryption key outside the data folder and the folder of copies (QED_KEY_DIR or QED_KEY_FILE); then start again.',
  wrong_key: 'Supply the key-encryption key that wrapped this keyring (QED_KEY_FILE or QED_KEK), or re-wrap the keyring; then start again.',
  key_purpose: 'QED_MIGRATION_KEYRING must name the migration-copy keyring, not another purpose\'s; `npm run keys:init` makes one.',
  key_config: 'Set QED_KEY_FILE or QED_KEK, not both.',
}

export interface SealMigrationCopyOptions extends Pick<BackupOptions, 'tempParent' | 'now' | 'remove' | 'afterSeal'> {
  env?: Env
  log?: (line: string) => void
}

/**
 * Seal and verify the copy of the database at db (at schema version `from`) that is taken before migrating it to `to`.
 * Keys are loaded first, so a missing or wrong key refuses before anything is read or written. Throws MigrationRefused.
 */
export function sealMigrationCopy(db: string, from: string, to: string, o: SealMigrationCopyOptions = {}): BackupResult {
  const env = o.env ?? process.env
  const outDir = migrationCopyDir(db, env)
  const refuse = (e: KeyError | BackupError): MigrationRefused => new MigrationRefused(e.code, `The database ${db} has schema version ${from}; this build needs ${to}. Before a migration QED seals an encrypted copy of the database and checks it, and that could not be done (${e.code}): ${e.message} Nothing was changed: the database was not migrated (its file and its write-ahead log are as they were) and no copy was recorded. ${FIX[e.code] ?? KEYS}`)
  try {
    const keyring = openKeyring('migration-copy', { env, forbidden: [dirname(db), outDir] })
    return createMigrationCopy({
      db, outDir, keyring, from, to,
      log: o.log ?? ((l) => console.log(`[migration] ${l}`)),
      ...(o.tempParent ? { tempParent: o.tempParent } : {}), ...(o.now ? { now: o.now } : {}), ...(o.remove ? { remove: o.remove } : {}), ...(o.afterSeal ? { afterSeal: o.afterSeal } : {}),
    })
  } catch (e) {
    if (e instanceof KeyError || e instanceof BackupError) throw refuse(e)
    throw e
  }
}

/**
 * Close the connection of a refused migration, leaving the database's files as they were found (independent review of
 * cb85271, finding 5). Closing the last connection to a WAL database checkpoints the log into the database file and
 * removes the log. When the log held committed changes (an earlier start was killed before its checkpoint), a read-only
 * connection is opened first, so the closing one is not the last, and the read-only one cannot checkpoint when it closes
 * after it. The database file and its log stay byte for byte; the -shm index (which holds no data) may be rewritten.
 * With no log waiting, an ordinary close removes only the empty files the open made.
 */
export function closeAsFound(db: { close(): void }, path: string): void {
  let pending = false
  try { pending = statSync(`${path}-wal`).size > 0 } catch { /* no log */ }
  if (!pending) { db.close(); return }
  let guard: DatabaseSync | undefined
  try {
    guard = new DatabaseSync(path, { readOnly: true })
    guard.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch { guard?.close(); guard = undefined }
  try { db.close() } finally { guard?.close() }
}
