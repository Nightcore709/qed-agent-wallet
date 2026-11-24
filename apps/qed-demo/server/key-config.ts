/**
 * Where the keys and the sealed copies live (docs/ENCRYPTION.md, section 3), read from the environment with defaults, so
 * that the service, a migration and the operator's commands all find the same keys.
 *
 *   QED_KEY_DIR             the key folder; default ~/.qed/keys (outside the repository and the data folder). It holds
 *                           qed.kek, the key-encryption key (mode 600), and one keyring per purpose: backup.keyring.json,
 *                           migration-copy.keyring.json and wallet-secret.keyring.json (the wallet service's secrets at
 *                           rest); database.keyring.json is reserved for field encryption, D10.
 *   QED_KEY_FILE            the key-encryption key's file, elsewhere (a host's mounted secret).
 *   QED_KEK                 the key-encryption key itself, from a host's secret manager; removed from the environment once
 *                           read. Not together with QED_KEY_FILE.
 *   QED_KEYRING             the backup keyring, elsewhere (the name used before 24 Nov); QED_MIGRATION_KEYRING likewise
 *                           for the migration-copy keyring.
 *   QED_BACKUP_DIR          the backup folder; default ~/.qed/backups.
 *   QED_MIGRATION_COPY_DIR  where the copies taken before a migration go; default migration-copies beside the database.
 *
 * The default locations are a proposal: where the key-encryption key lives and how it is escrowed are the owner's
 * decisions (docs/ENCRYPTION.md, section 7). Only initKeys (`npm run keys:init`) creates a key; nothing here prints one.
 * This module imports nothing from the server but keys.ts: core.ts reaches it through migration-copy.ts.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EnvKekProvider, FileKekProvider, KeyError, Keyring, type KekProvider, type KeyPurpose } from './keys.ts'

export type Env = Record<string, string | undefined>

export interface KeyPaths {
  /** The key folder. */
  dir: string
  /** The key-encryption key's file; null when the key comes from the environment (kekEnv). */
  kekFile: string | null
  kekEnv: string | null
  keyring: Record<KeyPurpose, string>
  backupDir: string
}

// QED_KEK is removed from the environment when it is read, so the provider that read it is kept per environment: a second
// use in the same process finds the key it already holds, never a different one in a file.
const envProviders = new WeakMap<object, EnvKekProvider>()
function envProvider(env: Env): EnvKekProvider | undefined {
  let p = envProviders.get(env)
  if (!p && env.QED_KEK !== undefined && env.QED_KEK !== '') {
    p = new EnvKekProvider('QED_KEK', env)
    envProviders.set(env, p)
  }
  return p
}
const set = (v: string | undefined): v is string => v !== undefined && v !== ''

export function keyPaths(env: Env = process.env): KeyPaths {
  const home = set(env.HOME) ? env.HOME : homedir()
  const dir = resolve(set(env.QED_KEY_DIR) ? env.QED_KEY_DIR : join(home, '.qed', 'keys'))
  const fromEnv = envProvider(env) !== undefined
  return {
    dir,
    kekFile: fromEnv ? null : resolve(set(env.QED_KEY_FILE) ? env.QED_KEY_FILE : join(dir, 'qed.kek')),
    kekEnv: fromEnv ? 'QED_KEK' : null,
    keyring: {
      database: join(dir, 'database.keyring.json'),
      backup: resolve(set(env.QED_KEYRING) ? env.QED_KEYRING : join(dir, 'backup.keyring.json')),
      'migration-copy': resolve(set(env.QED_MIGRATION_KEYRING) ? env.QED_MIGRATION_KEYRING : join(dir, 'migration-copy.keyring.json')),
      'wallet-secret': join(dir, 'wallet-secret.keyring.json'),
    },
    backupDir: resolve(set(env.QED_BACKUP_DIR) ? env.QED_BACKUP_DIR : join(home, '.qed', 'backups')),
  }
}

/** Where the copies taken before a migration of the database at dbPath go. */
export function migrationCopyDir(dbPath: string, env: Env = process.env): string {
  return resolve(set(env.QED_MIGRATION_COPY_DIR) ? env.QED_MIGRATION_COPY_DIR : join(dirname(resolve(dbPath)), 'migration-copies'))
}

/** The configured source of the key-encryption key. forbidden: folders a key file may not be inside (database, copies). */
export function kekProvider(env: Env = process.env, forbidden: string[] = []): KekProvider {
  const fromEnv = envProvider(env)
  if (fromEnv && set(env.QED_KEY_FILE)) throw new KeyError('key_config', 'Both QED_KEK and QED_KEY_FILE are set; set one, so that it is clear which key-encryption key is meant.')
  return fromEnv ?? new FileKekProvider(keyPaths(env).kekFile!, { forbiddenFolders: forbidden })
}

/** Open the keyring of one purpose: the key-encryption key first, then the keyring, which must be of that purpose. */
export function openKeyring(purpose: KeyPurpose, o: { env?: Env; forbidden?: string[] } = {}): Keyring {
  const env = o.env ?? process.env
  const kek = kekProvider(env, o.forbidden).load()
  return Keyring.load(keyPaths(env).keyring[purpose], kek, purpose)
}

export interface InitResult {
  kek: { id: string; where: string; created: boolean }
  keyrings: { purpose: KeyPurpose; path: string; created: boolean; version: number; kid: string; check: string | null }[]
}

/**
 * `npm run keys:init`: a key-encryption key file (unless one is configured or the key comes from the environment) and a
 * keyring for each purpose that has none. What exists is loaded and checked, never replaced, so running it again is safe.
 */
export function initKeys(o: { env?: Env; purposes?: KeyPurpose[]; forbidden?: string[]; now?: number } = {}): InitResult {
  const env = o.env ?? process.env
  const p = keyPaths(env)
  const made = p.kekFile !== null && !existsSync(p.kekFile)
  const provider = made ? FileKekProvider.generate(p.kekFile!, { forbiddenFolders: o.forbidden ?? [] }) : kekProvider(env, o.forbidden)
  const kek = provider.load()
  const keyrings = (o.purposes ?? ['backup', 'migration-copy', 'wallet-secret']).map((purpose) => {
    const path = p.keyring[purpose]
    const created = !existsSync(path)
    const ring = created ? Keyring.create(path, kek, o.now ?? Date.now(), purpose) : Keyring.load(path, kek, purpose)
    const k = ring.list().find((x) => x.version === ring.activeVersion)!
    return { purpose, path, created, version: k.version, kid: k.kid, check: k.check }
  })
  return { kek: { id: kek.id, where: provider.where, created: made }, keyrings }
}
