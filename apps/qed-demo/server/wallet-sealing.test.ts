/**
 * The wallet service's secrets at rest (chain/rail/sealed-at-rest.ts; docs/ENCRYPTION.md section 9): its master secret
 * and the co-signer's key file, sealed under the wallet-secret keyring when sealing is on. Every test uses a throwaway
 * key folder (server/key-fixture.ts), never the real keys.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOrCreateMasterSecret } from '../chain/rail/keys.ts'
import { keepKeyringCopy, KEYRING_COPY, LOCK_FILE, lockFolder, readSecret, SEALED_SUFFIX, secretState, unsealSecret, writeSecret } from '../chain/rail/sealed-at-rest.ts'
import { initKeys, kekProvider, keyPaths, openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { FileKekProvider, KeyError, Keyring } from './keys.ts'
import { APP_ROOT } from './core.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function world() {
  const root = mkdtempSync(join(tmpdir(), 'qed-wallet-secret-'))
  roots.push(root)
  const keys = testKeys(root)
  const rail = join(root, 'data', 'rail')
  const ring = () => openKeyring('wallet-secret', { env: keys.env })
  return { root, keys, rail, ring, master: join(rail, 'master.key'), cosigner: join(rail, 'cosigner.key') }
}
const HEX = 'a1'.repeat(32)
const errorOf = (f: () => unknown): string => { try { f(); return 'none' } catch (e) { return e instanceof KeyError ? e.code : (e as Error).message } }

describe('the wallet service\'s secrets at rest', () => {
  it('with sealing on, a plaintext master secret is sealed, read back equal, and only then removed; the same secret derives', () => {
    const w = world()
    const plain = loadOrCreateMasterSecret(w.master, { seal: false })
    expect(statSync(w.master).mode & 0o777).toBe(0o600)
    const before = readFileSync(w.master)
    const sealed = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    expect(sealed.equals(plain)).toBe(true)
    expect(existsSync(w.master)).toBe(false)
    expect(statSync(w.master + SEALED_SUFFIX).mode & 0o777).toBe(0o600)
    const blob = readFileSync(w.master + SEALED_SUFFIX)
    expect(blob.includes(before.subarray(0, 64))).toBe(false) // the hex is not in the sealed file
    expect(secretState(w.master)).toEqual({ state: 'sealed', keyVersion: 1 })
    expect(statSync(join(w.rail, KEYRING_COPY)).mode & 0o777).toBe(0o600) // the keyring's copy is beside the secrets
    // read again, sealing on or off: the sealed file is the one read
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }).equals(plain)).toBe(true)
    expect(loadOrCreateMasterSecret(w.master, { seal: false, ring: w.ring }).equals(plain)).toBe(true)
    expect(existsSync(w.master)).toBe(false)
  })

  it('a new master secret with sealing on is never written in plaintext', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    expect(s.length).toBe(32)
    expect(existsSync(w.master)).toBe(false)
    expect(existsSync(`${w.master}${SEALED_SUFFIX}.partial`)).toBe(false)
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }).equals(s)).toBe(true)
  })

  it('without the key-encryption key a sealed secret refuses to open, falls back to nothing and removes nothing', () => {
    const w = world()
    loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    rmSync(w.keys.kekFile)
    expect(errorOf(() => loadOrCreateMasterSecret(w.master, { seal: false, ring: w.ring }))).toBe('key_missing')
    expect(existsSync(w.master + SEALED_SUFFIX)).toBe(true)
    expect(existsSync(w.master)).toBe(false) // no plaintext was made in its place
  })

  it('an interrupted migration: an equal plaintext beside the sealed file is removed; a different one stops everything', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    const text = `${s.toString('hex')}\n`
    writeFileSync(w.master, text, { mode: 0o600 })
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }).equals(s)).toBe(true)
    expect(existsSync(w.master)).toBe(false)
    writeFileSync(w.master, `${HEX}\n`, { mode: 0o600 })
    expect(errorOf(() => loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }))).toMatch(/hold different secrets; neither was used or removed/)
    expect(existsSync(w.master)).toBe(true)
    expect(existsSync(w.master + SEALED_SUFFIX)).toBe(true)
  })

  it('a sealed file put in place of another secret does not open (the file name is bound to the ciphertext)', () => {
    const w = world()
    writeSecret(w.cosigner, Buffer.from('{"baseline":{"1":"0x01"}}'), { seal: true, ring: w.ring })
    renameSync(w.cosigner + SEALED_SUFFIX, w.master + SEALED_SUFFIX)
    expect(errorOf(() => readSecret(w.master, { seal: true, ring: w.ring }))).toBe('authentication_failed')
  })

  it('after the keyring is rotated, the next read re-seals under the active version, and the secret is unchanged', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    w.ring().rotate()
    expect(secretState(w.master).keyVersion).toBe(1)
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }).equals(s)).toBe(true)
    expect(secretState(w.master).keyVersion).toBe(2)
  })

  it('the co-signer\'s key file: written sealed, read back as the same JSON, and a plaintext one is sealed on first read', () => {
    const w = world()
    const keys = { ws1: { 1: `0x${'b2'.repeat(32)}` } }
    writeSecret(w.cosigner, Buffer.from(JSON.stringify(keys)), { seal: true, ring: w.ring })
    expect(existsSync(w.cosigner)).toBe(false)
    expect(JSON.parse(readSecret(w.cosigner, { seal: true, ring: w.ring })!.toString('utf8'))).toEqual(keys)
    const other = join(w.rail, 'other.key')
    writeFileSync(other, JSON.stringify(keys), { mode: 0o600 })
    expect(JSON.parse(readSecret(other, { seal: true, ring: w.ring })!.toString('utf8'))).toEqual(keys)
    expect(secretState(other).state).toBe('sealed')
  })

  it('without sealing, the files stay plaintext of mode 600, as before', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: false })
    expect(readFileSync(w.master, 'utf8').trim()).toBe(s.toString('hex'))
    writeSecret(w.cosigner, Buffer.from('{}'), { seal: false })
    expect(statSync(w.cosigner).mode & 0o777).toBe(0o600)
    expect(existsSync(w.cosigner + SEALED_SUFFIX)).toBe(false)
  })

  it('the rollback: unsealing gives back the plaintext file byte for byte and removes the sealed file only after', () => {
    const w = world()
    loadOrCreateMasterSecret(w.master, { seal: false })
    const original = readFileSync(w.master)
    loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    expect(unsealSecret(w.master, { ring: w.ring })).toBe('unsealed')
    expect(readFileSync(w.master).equals(original)).toBe(true)
    expect(statSync(w.master).mode & 0o777).toBe(0o600)
    expect(existsSync(w.master + SEALED_SUFFIX)).toBe(false)
    expect(unsealSecret(w.master, { ring: w.ring })).toBe('none')
  })

  it('the key folder lost but the key-encryption key escrowed: the keyring copy beside the secrets opens them (review H-1)', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    for (const f of ['wallet-secret.keyring.json', 'wallet-secret.keyring.generation', 'wallet-secret.keyring.places']) rmSync(join(w.keys.dir, f), { force: true })
    expect(errorOf(() => openKeyring('wallet-secret', { env: w.keys.env }))).toBe('keyring_missing')
    const copy = Keyring.load(join(w.rail, KEYRING_COPY), kekProvider(w.keys.env).load(), 'wallet-secret')
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: () => copy }).equals(s)).toBe(true)
  })

  it('a new secret never replaces one: a second first start on the same folder is refused, and the first secret stands (review M-4)', () => {
    const w = world()
    const first = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    const blob = readFileSync(w.master + SEALED_SUFFIX)
    expect(errorOf(() => writeSecret(w.master, Buffer.from(`${HEX}\n`), { seal: true, ring: w.ring, fresh: true }))).toMatch(/already exists; a new secret does not replace it/)
    expect(readFileSync(w.master + SEALED_SUFFIX).equals(blob)).toBe(true)
    expect(loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }).equals(first)).toBe(true)
  })

  it('once the chain exists, a missing master secret is refused, never replaced by a new one (review M-4)', () => {
    const w = world()
    loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    rmSync(w.master + SEALED_SUFFIX)
    expect(errorOf(() => loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring, mustExist: true }))).toMatch(/master secret is missing .* a new one was not made/)
    expect(existsSync(w.master + SEALED_SUFFIX) || existsSync(w.master)).toBe(false)
  })

  it('a malformed plaintext secret is refused before anything is sealed or removed (review L-2a)', () => {
    const w = world()
    mkdirSync(w.rail, { recursive: true })
    writeFileSync(w.master, 'not a secret\n', { mode: 0o600 })
    expect(errorOf(() => loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring }))).toMatch(/not 32 bytes of hex; it was left unchanged/)
    expect(readFileSync(w.master, 'utf8')).toBe('not a secret\n')
    expect(existsSync(w.master + SEALED_SUFFIX)).toBe(false)
  })

  it('with sealing off, an equal plaintext beside its sealed file is left alone (a rollback in progress is not undone; review L-2b)', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    writeFileSync(w.master, `${s.toString('hex')}\n`, { mode: 0o600 })
    expect(loadOrCreateMasterSecret(w.master, { seal: false, ring: w.ring }).equals(s)).toBe(true)
    expect([existsSync(w.master), existsSync(w.master + SEALED_SUFFIX)]).toEqual([true, true])
  })

  it('the folder lock: re-entrant for its holder, refused while another live process holds it, taken over from a dead one (review M-3)', () => {
    const w = world()
    const release = lockFolder(w.rail)
    expect(readFileSync(join(w.rail, LOCK_FILE), 'utf8').trim()).toBe(String(process.pid))
    lockFolder(w.rail)() // re-entrant: no error, and its release is a no-op
    expect(existsSync(join(w.rail, LOCK_FILE))).toBe(true)
    release()
    expect(existsSync(join(w.rail, LOCK_FILE))).toBe(false)
    writeFileSync(join(w.rail, LOCK_FILE), `${process.ppid}\n`) // a live process that is not this one
    expect(errorOf(() => lockFolder(w.rail))).toMatch(new RegExp(`in use by process ${process.ppid}`))
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
    writeFileSync(join(w.rail, LOCK_FILE), `${dead}\n`)
    lockFolder(w.rail)()
    expect(existsSync(join(w.rail, LOCK_FILE))).toBe(false)
  })

  it('a keyring made anew never replaces the copy that opens the sealed secrets (re-check N-1), and prepare refuses to make one', () => {
    const w = world()
    const s = loadOrCreateMasterSecret(w.master, { seal: true, ring: w.ring })
    const copy = readFileSync(join(w.rail, KEYRING_COPY))
    // the key folder's keyring is lost and a new one is made, as keys:init would
    for (const f of ['wallet-secret.keyring.json', 'wallet-secret.keyring.generation', 'wallet-secret.keyring.places']) rmSync(join(w.keys.dir, f), { force: true })
    initKeys({ env: w.keys.env, purposes: ['wallet-secret'] })
    const fresh = openKeyring('wallet-secret', { env: w.keys.env })
    expect(errorOf(() => keepKeyringCopy(fresh, w.rail))).toBe('keyring_copy_differs')
    expect(readFileSync(join(w.rail, KEYRING_COPY)).equals(copy)).toBe(true)
    expect(loadOrCreateMasterSecret(w.master, { seal: false, ring: () => Keyring.load(join(w.rail, KEYRING_COPY), kekProvider(w.keys.env).load(), 'wallet-secret') }).equals(s)).toBe(true)
    // and the operator's prepare refuses outright when the key folder has no keyring but the secrets are sealed
    rmSync(join(w.keys.dir, 'wallet-secret.keyring.json'))
    const r = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'wallet-sealing.ts'), 'prepare', '--rail-dir', w.rail], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...w.keys.env } })
    expect([r.status, r.stderr]).toEqual([4, expect.stringMatching(/sealed under one\. Nothing was made/)])
    expect(existsSync(join(w.keys.dir, 'wallet-secret.keyring.json'))).toBe(false)
    expect(readFileSync(join(w.rail, KEYRING_COPY)).equals(copy)).toBe(true)
  })

  it('after a rewrap, a process still holding the keyring from before never writes its older copy over the newer one (re-check N-4)', () => {
    const w = world()
    const before = w.ring() // held by a running service
    loadOrCreateMasterSecret(w.master, { seal: true, ring: () => before })
    const next = FileKekProvider.generate(join(w.root, 'keys-2', 'qed.kek'), {}).load()
    const now = w.ring()
    now.rewrap(next)
    now.copyTo(join(w.rail, KEYRING_COPY))
    const newer = JSON.parse(readFileSync(join(w.rail, KEYRING_COPY), 'utf8')) as { kekId: string }
    keepKeyringCopy(before, w.rail)
    expect((JSON.parse(readFileSync(join(w.rail, KEYRING_COPY), 'utf8')) as { kekId: string }).kekId).toBe(newer.kekId)
    expect(newer.kekId).toBe(next.id)
  })

  it('the operator\'s seal refuses a malformed secret before sealing or removing it (re-check L-2a)', () => {
    const w = world()
    mkdirSync(w.rail, { recursive: true })
    writeFileSync(w.master, 'not a secret\n', { mode: 0o600 })
    const r = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'wallet-sealing.ts'), 'seal', '--rail-dir', w.rail], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', QED_RAIL_PORT: '1', ...w.keys.env } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not 32 bytes of hex; it was left unchanged/)
    expect([readFileSync(w.master, 'utf8'), existsSync(w.master + SEALED_SUFFIX)]).toEqual(['not a secret\n', false])
  })

  it('the lock file is written whole before it appears, and a takeover never removes a live holder\'s lock', () => {
    const w = world()
    const release = lockFolder(w.rail)
    expect(readFileSync(join(w.rail, LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`)
    release()
    writeFileSync(join(w.rail, LOCK_FILE), `${process.ppid}\n`)
    expect(errorOf(() => lockFolder(w.rail))).toMatch(/in use by process/)
    expect(readFileSync(join(w.rail, LOCK_FILE), 'utf8')).toBe(`${process.ppid}\n`) // left in place
    expect(readFileSync(join(w.rail, LOCK_FILE), 'utf8').length).toBeGreaterThan(1)
    expect(keyPaths(w.keys.env).dir).toBe(w.keys.dir)
  })
})
