/**
 * The wallet service's secrets at rest (chain/rail/sealed-at-rest.ts; docs/ENCRYPTION.md section 9).
 *
 *   node scripts/wallet-sealing.ts status [--rail-dir <dir>]           sealed, plaintext or absent, the key version, and a
 *                                                                      fingerprint (a domain-separated SHA-256 prefix,
 *                                                                      never the secret) to compare before and after
 *   node scripts/wallet-sealing.ts prepare [--rail-dir <dir>]          ready to seal? Needs an existing key-encryption key
 *                                                                      (never makes one: that is `npm run keys:init`, then
 *                                                                      its escrow); makes the wallet-secret keyring if
 *                                                                      missing and its copy beside the secrets. Exit 3: no
 *                                                                      key-encryption key, so start without sealing.
 *   node scripts/wallet-sealing.ts seal [--rail-dir <dir>]             seal the plaintext ones now (the wallet service does
 *                                                                      this itself at start when QED_RAIL_SEAL=1)
 *   node scripts/wallet-sealing.ts unseal --confirm [--rail-dir <dir>] the rollback: each plaintext file back, byte for
 *                                                                      byte, before its sealed file is removed
 *   node scripts/wallet-sealing.ts restore-keyring [--rail-dir <dir>]  put the keyring's copy kept beside the secrets back
 *                                                                      into the key folder, after checking it opens
 *
 * The rail folder defaults to data/rail. seal, unseal and restore-keyring take the folder's lock (sealing.lock), which a
 * wallet service holds while it uses sealed secrets, and also refuse while its chain or its port (QED_RAIL_PORT, default
 * 5176) is in use. Keys come from the key folder as configured (QED_KEY_DIR, default ~/.qed/keys); nothing here prints
 * a key or a secret.
 */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { anySealed, keepKeyringCopy, KEYRING_COPY, lockFolder, peekSecret, readSecret, secretState, unsealSecret, walletRing } from '../chain/rail/sealed-at-rest.ts'
import { initKeys, kekProvider, keyPaths } from '../server/key-config.ts'
import { KeyError, Keyring } from '../server/keys.ts'

const app = join(import.meta.dirname, '..')
const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { 'rail-dir': { type: 'string' }, confirm: { type: 'boolean' } } })
const railDir = resolve(v['rail-dir'] ?? join(app, 'data', 'rail'))
const FILES = ['master.key', 'cosigner.key'] as const
const VALIDATE: Record<(typeof FILES)[number], (b: Buffer) => void> = {
  'master.key': (b) => { if (!/^[0-9a-f]{64}$/.test(b.toString('utf8').trim())) throw new Error('master.key is not 32 bytes of hex; it was left unchanged.') },
  'cosigner.key': (b) => { try { JSON.parse(b.toString('utf8')) } catch { throw new Error('cosigner.key is not valid JSON; it was left unchanged.') } },
}
const fingerprint = (b: Buffer): string => createHash('sha256').update('qed-wallet-secret-fingerprint/1\n').update(b).digest('hex').slice(0, 16)
const fail = (msg: string, code = 1): never => { console.error(msg); process.exit(code) }

function chainRunning(): number | null {
  const pidFile = join(railDir, 'anvil.pid')
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return pid } catch { return null }
}
const portInUse = (port: number): Promise<boolean> => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true) })
  s.on('error', () => res(false))
  s.setTimeout(1500, () => { s.destroy(); res(false) })
})
/** Refuse while a wallet service may be using the folder; else hold its lock until this command ends. */
async function exclusive(what: string): Promise<void> {
  const pid = chainRunning()
  if (pid !== null) fail(`The wallet service's chain is running (pid ${pid}); stop the review build before you ${what} (scripts/review-build.sh stop).`)
  const port = Number(process.env.QED_RAIL_PORT ?? 5176)
  if (await portInUse(port)) fail(`Something answers on port ${port}, where the wallet service listens; stop it before you ${what}.`)
  try { lockFolder(railDir) } catch (e) { fail((e as Error).message) }
}

const cmd = positionals[0]
if (cmd === 'status') {
  for (const f of FILES) {
    const path = join(railDir, f)
    const s = secretState(path)
    const b = s.state === 'none' ? { sealed: null, plain: null } : peekSecret(path)
    const fp = [b.sealed && `sealed fingerprint ${fingerprint(b.sealed)}`, b.plain && `plaintext fingerprint ${fingerprint(b.plain)}`].filter(Boolean).join(', ')
    console.log(`${f}: ${s.state}${s.keyVersion !== null ? ` (wallet-secret key version ${s.keyVersion})` : ''}${fp ? `; ${fp}` : ''}`)
  }
  console.log(`keyring copy beside them: ${existsSync(join(railDir, KEYRING_COPY)) ? 'present' : 'none'}`)
} else if (cmd === 'prepare') {
  try { kekProvider().load() } catch (e) {
    if (e instanceof KeyError && e.code === 'key_missing') fail(`No key-encryption key (${keyPaths().kekFile ?? 'QED_KEK'}): the wallet service's secrets stay in plaintext. To seal them: npm run keys:init, escrow the key (docs/ENCRYPTION.md section 4), then start again.`, 3)
    throw e
  }
  // a keyring is never made anew for secrets that are already sealed: the one that sealed them is restored instead
  // (re-check of d67c514, N-1: a new keyring would have replaced the copy that opens them)
  if (!existsSync(keyPaths().keyring['wallet-secret']) && (anySealed(railDir, FILES) || existsSync(join(railDir, KEYRING_COPY)))) {
    fail(`The wallet-secret keyring is not in the key folder (${keyPaths().dir}), but this wallet's secrets are sealed under one. Nothing was made. Put it back from the copy beside them: node scripts/wallet-sealing.ts restore-keyring`, 4)
  }
  const r = initKeys({ purposes: ['wallet-secret'] }) // the key-encryption key exists, so only a missing keyring is made
  const k = r.keyrings[0]!
  keepKeyringCopy(walletRing(railDir), railDir) // never over a copy holding keys this keyring lacks
  Keyring.load(join(railDir, KEYRING_COPY), kekProvider().load(), 'wallet-secret') // the copy opens
  console.log(`wallet-secret keyring ${k.created ? 'made' : 'present'} (version ${k.version}, check ${k.check}); its copy is beside the secrets in ${railDir}`)
} else if (cmd === 'seal') {
  await exclusive('seal its secrets')
  for (const f of FILES) {
    const path = join(railDir, f)
    const before = secretState(path).state
    if (before === 'none') { console.log(`${f}: none`); continue }
    readSecret(path, { seal: true, validate: VALIDATE[f] }) // a malformed secret is refused before it is sealed or removed
    console.log(`${f}: ${before} -> ${secretState(path).state}`)
  }
} else if (cmd === 'unseal') {
  if (!v.confirm) fail('unseal writes each secret back in plaintext; pass --confirm to do it.', 2)
  await exclusive('unseal its secrets')
  for (const f of FILES) console.log(`${f}: ${unsealSecret(join(railDir, f))}`)
} else if (cmd === 'restore-keyring') {
  await exclusive('restore its keyring')
  const copy = join(railDir, KEYRING_COPY)
  const target = keyPaths().keyring['wallet-secret']
  if (!existsSync(copy)) fail(`No keyring copy at ${copy}; extract one from the newest wallet-service archive first.`)
  if (existsSync(target)) fail(`${target} exists; nothing was replaced. If it is a keyring made anew after the original was lost (npm run keys:init makes one when it finds none), move it aside and run this again.`)
  Keyring.load(copy, kekProvider().load(), 'wallet-secret') // authenticated under the key-encryption key, of this purpose
  copyFileSync(copy, target, constants.COPYFILE_EXCL)
  Keyring.load(target, kekProvider().load(), 'wallet-secret')
  console.log(`The wallet-secret keyring is back in ${target}.`)
} else {
  fail('Usage: node scripts/wallet-sealing.ts <status | prepare | seal | unseal --confirm | restore-keyring> [--rail-dir <dir>]', 2)
}
