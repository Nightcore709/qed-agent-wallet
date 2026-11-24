/**
 * Give the local review account a new random password and store it in data/review-account.json (git-ignored,
 * readable only by the owner of the file). Prints nothing secret. The app has no change-password screen yet, so
 * this is how the review credential is rotated.
 *
 *     node scripts/review-password.ts
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashPassword } from '../server/auth.ts'
import { loadConfig, openDb } from '../server/core.ts'

const cfg = loadConfig()
const file = join(cfg.dbPath, '..', 'review-account.json')
const account = JSON.parse(readFileSync(file, 'utf8')) as { handle: string; password: string; note?: string }
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const password = Array.from(randomBytes(24), (b) => alphabet[b % alphabet.length]).join('')
const db = openDb(cfg.dbPath)
const r = db.run('UPDATE users SET pw_hash = ?, failed_logins = 0, locked_until = NULL WHERE handle = ?', await hashPassword(password), account.handle)
if (Number(r.changes) !== 1) throw new Error(`No account with the handle in ${file}; nothing was changed.`)
writeFileSync(file, `${JSON.stringify({ ...account, password, rotatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
chmodSync(file, 0o600)
console.log(`The review account has a new password, stored in ${file}. Sessions already signed in stay signed in.`)
