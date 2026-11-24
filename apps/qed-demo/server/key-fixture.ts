/**
 * Test keys for the suites that migrate, back up or archive a database: a private key folder (mode 700) laid out as
 * `npm run keys:init` lays one out (a key-encryption key file and one keyring per purpose), and the environment that
 * points the application at it. Generated per test run in a scratch folder; synthetic, never the owner's keys.
 */
import { join } from 'node:path'
import { initKeys, keyPaths } from './key-config.ts'
import type { KeyPurpose } from './keys.ts'

export interface TestKeys {
  /** Pass to the code under test (or merge into process.env): QED_KEY_DIR and a HOME inside the scratch folder. */
  env: Record<string, string>
  dir: string
  kekFile: string
  keyring: Record<KeyPurpose, string>
}

/** Make a key folder under root (root/keys) with a KEK and the backup and migration-copy keyrings. */
export function testKeys(root: string): TestKeys {
  const env = { HOME: root, QED_KEY_DIR: join(root, 'keys') }
  initKeys({ env })
  const p = keyPaths(env)
  return { env, dir: p.dir, kekFile: p.kekFile!, keyring: p.keyring }
}
