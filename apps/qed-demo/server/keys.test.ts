/**
 * Keys for encryption at rest (R7-076, D10): versioned data keys wrapped by a key-encryption key held outside the
 * database. Each failure fails closed with a precise code, and nothing ever falls back to plaintext.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EnvKekProvider, FileKekProvider, KeychainKekProvider, KeyError, Keyring, newKekRecord, parseHeader, systemKeychain } from './keys.ts'
import { MemoryKeychain } from './keys-fake.ts'

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
// Every scratch folder holds generated test keys: none is left behind.
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-keys-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
/** The code a call fails with, or 'none'. Any error that is not a KeyError is rethrown: it would not be precise. */
function failure(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof KeyError) return e.code; throw e }
  return 'none'
}
function messageOf(fn: () => unknown): string {
  try { fn() } catch (e) { return (e as Error).message }
  return ''
}
function world() {
  const root = scratch()
  const keyFile = join(root, 'keys', 'qed.kek')
  const ringPath = join(root, 'keys', 'keyring.json')
  const provider = FileKekProvider.generate(keyFile)
  const ring = Keyring.create(ringPath, provider.load(), 1_000)
  return { root, keyFile, ringPath, provider, ring }
}
const CTX = 'qed/field/payees.handle:pay_1'
const secret = (): Buffer => Buffer.from('marker.payee.sensitive@paperupi', 'utf8')

describe('key-encryption key providers', () => {
  it('a new key file is made from random bytes, mode 600 in a folder of mode 700, and loads again', () => {
    const { keyFile, provider } = world()
    expect(mode(keyFile)).toBe('600')
    expect(mode(join(keyFile, '..'))).toBe('700')
    const a = provider.load(), b = new FileKekProvider(keyFile).load()
    expect(a.id).toMatch(/^kek_[0-9a-f]{16}$/)
    expect(b.id).toBe(a.id)
    expect(a.key.symmetricKeySize).toBe(32)
    // Two generated keys never coincide; the record's key part carries 32 bytes.
    const r1 = newKekRecord(), r2 = newKekRecord()
    expect(r1).not.toBe(r2)
    expect(Buffer.from(r1.split(':')[2]!, 'base64url').length).toBe(32)
  })

  it('a key file is never overwritten', () => {
    const { keyFile } = world()
    expect(failure(() => FileKekProvider.generate(keyFile))).toBe('key_exists')
  })

  it('a missing key file fails closed', () => {
    const root = scratch()
    expect(failure(() => new FileKekProvider(join(root, 'nope.kek')).load())).toBe('key_missing')
  })

  it('a key file other users can read, or in a folder they can write, is refused with the fix named', () => {
    const { keyFile } = world()
    chmodSync(keyFile, 0o644)
    expect(failure(() => new FileKekProvider(keyFile).load())).toBe('key_permissions')
    expect(messageOf(() => new FileKekProvider(keyFile).load())).toContain('chmod 600')
    chmodSync(keyFile, 0o600)
    chmodSync(join(keyFile, '..'), 0o770)
    expect(failure(() => new FileKekProvider(keyFile).load())).toBe('key_permissions')
    chmodSync(join(keyFile, '..'), 0o700)
    expect(failure(() => new FileKekProvider(keyFile).load())).toBe('none')
  })

  it('a key file inside the database or backup folder is refused, before and after it exists', () => {
    const root = scratch()
    const dbDir = join(root, 'data')
    mkdirSync(dbDir, { mode: 0o700 })
    const inside = join(dbDir, 'keys', 'qed.kek')
    expect(failure(() => FileKekProvider.generate(inside, { forbiddenFolders: [dbDir] }))).toBe('key_location')
    FileKekProvider.generate(inside)
    expect(failure(() => new FileKekProvider(inside, { forbiddenFolders: [dbDir] }).load())).toBe('key_location')
    expect(failure(() => new FileKekProvider(join(root, 'elsewhere.kek'), { forbiddenFolders: [dbDir] }).load())).toBe('key_missing')
  })

  it('a truncated or altered key file fails closed, and the message never quotes it', () => {
    const { keyFile } = world()
    const record = readFileSync(keyFile, 'utf8').trim()
    writeFileSync(keyFile, record.slice(0, -3))
    expect(failure(() => new FileKekProvider(keyFile).load())).toBe('key_malformed')
    const parts = record.split(':')
    const flipped = parts[2]![0] === 'A' ? `B${parts[2]!.slice(1)}` : `A${parts[2]!.slice(1)}`
    writeFileSync(keyFile, [parts[0], parts[1], flipped, parts[3]].join(':'))
    expect(failure(() => new FileKekProvider(keyFile).load())).toBe('key_malformed')
    expect(messageOf(() => new FileKekProvider(keyFile).load())).not.toContain(flipped)
  })

  it('the environment provider reads the same record as the key file and removes it from the environment', () => {
    const { keyFile, ringPath, ring } = world()
    const env: Record<string, string | undefined> = { QED_KEK: readFileSync(keyFile, 'utf8') }
    const p = new EnvKekProvider('QED_KEK', env)
    const kek = p.load()
    expect(env.QED_KEK).toBeUndefined()
    expect(p.load().id).toBe(kek.id)
    const blob = ring.encrypt(secret(), CTX)
    expect(Keyring.load(ringPath, kek).decrypt(blob, CTX).toString('utf8')).toBe(secret().toString('utf8'))
  })

  it('the environment provider fails closed when the variable is missing or malformed, without quoting it', () => {
    expect(failure(() => new EnvKekProvider('QED_KEK', {}).load())).toBe('key_missing')
    const env = { QED_KEK: 'qedkek1:not-a-key-but-maybe-a-secret' }
    expect(messageOf(() => new EnvKekProvider('QED_KEK', { ...env }).load())).not.toContain('maybe-a-secret')
    expect(failure(() => new EnvKekProvider('QED_KEK', env).load())).toBe('key_malformed')
    expect(env.QED_KEK).toBeUndefined()
  })

  it('the macOS Keychain provider is an interface only: the system Keychain is not enabled; a test double works', () => {
    expect(failure(() => new KeychainKekProvider(systemKeychain).load())).toBe('keychain_not_enabled')
    expect(failure(() => systemKeychain.write('qed-demo.kek', 'qed', newKekRecord()))).toBe('keychain_not_enabled')
    const kc = new MemoryKeychain()
    expect(failure(() => new KeychainKekProvider(kc).load())).toBe('key_missing')
    const p = KeychainKekProvider.generate(kc)
    expect(p.load().id).toMatch(/^kek_/)
    expect(failure(() => KeychainKekProvider.generate(kc))).toBe('key_exists')
    const root = scratch()
    const ring = Keyring.create(join(root, 'keyring.json'), p.load())
    expect(ring.decrypt(ring.encrypt(secret(), CTX), CTX).equals(secret())).toBe(true)
  })
})

describe('keyring', () => {
  it('round trip: what is sealed opens under the same context; the header names the key id and version', () => {
    const { ring } = world()
    const blob = ring.encrypt(secret(), CTX, { table: 'payees' })
    expect(blob.includes(secret())).toBe(false)
    const h = parseHeader(blob)
    expect(h.version).toBe(1)
    expect(h.kid).toBe(ring.list()[0]!.kid)
    expect(h.meta).toEqual({ table: 'payees' })
    expect(ring.decrypt(blob, CTX).equals(secret())).toBe(true)
    // Each message has its own nonce: the same plaintext never seals to the same bytes.
    expect(ring.encrypt(secret(), CTX).equals(blob)).toBe(false)
  })

  it('files are private: the keyring is mode 600 and holds no key in the clear', () => {
    const { keyFile, ringPath } = world()
    expect(mode(ringPath)).toBe('600')
    const text = readFileSync(ringPath, 'utf8')
    const kekPart = readFileSync(keyFile, 'utf8').trim().split(':')[2]!
    expect(text).not.toContain(kekPart)
    const f = JSON.parse(text) as { keys: { wrapped: string }[] }
    // The wrapped data key is itself a QED ciphertext: header, 32 bytes sealed, 16-byte tag.
    const w = Buffer.from(f.keys[0]!.wrapped, 'base64url')
    expect(w.subarray(0, 4).toString()).toBe('QEDC')
    expect(w.length).toBe(parseHeader(w).size + 32 + 16)
  })

  it('restart: a keyring reopened from its file with the same key file opens what was sealed before', () => {
    const { keyFile, ringPath, ring } = world()
    const blob = ring.encrypt(secret(), CTX)
    const again = Keyring.load(ringPath, new FileKekProvider(keyFile).load())
    expect(again.decrypt(blob, CTX).equals(secret())).toBe(true)
    expect(again.activeVersion).toBe(1)
  })

  it('rotation: a new version seals from then on; earlier versions still open, also after a restart', () => {
    const { keyFile, ringPath, ring } = world()
    const v1 = ring.encrypt(secret(), CTX)
    const info = ring.rotate(2_000)
    expect(info.version).toBe(2)
    const v2 = ring.encrypt(secret(), CTX)
    expect(parseHeader(v2).version).toBe(2)
    expect(ring.list().map((k) => k.state)).toEqual(['retired', 'active'])
    const again = Keyring.load(ringPath, new FileKekProvider(keyFile).load())
    expect(again.decrypt(v1, CTX).equals(secret())).toBe(true)
    expect(again.decrypt(v2, CTX).equals(secret())).toBe(true)
  })

  it('re-wrapping under a new key-encryption key keeps every data key; the old key no longer opens the keyring', () => {
    const { root, keyFile, ringPath, ring } = world()
    const v1 = ring.encrypt(secret(), CTX)
    ring.rotate()
    const v2 = ring.encrypt(secret(), CTX)
    const newKek = FileKekProvider.generate(join(root, 'keys', 'qed-2.kek')).load()
    ring.rewrap(newKek)
    expect(ring.kekId).toBe(newKek.id)
    const again = Keyring.load(ringPath, newKek)
    expect(again.decrypt(v1, CTX).equals(secret())).toBe(true)
    expect(again.decrypt(v2, CTX).equals(secret())).toBe(true)
    expect(failure(() => Keyring.load(ringPath, new FileKekProvider(keyFile).load()))).toBe('wrong_key')
  })

  it('wrong key: another key-encryption key, or a ciphertext from another keyring, fails closed', () => {
    const a = world(), b = world()
    expect(failure(() => Keyring.load(a.ringPath, b.provider.load()))).toBe('wrong_key')
    expect(failure(() => b.ring.decrypt(a.ring.encrypt(secret(), CTX), CTX))).toBe('unknown_key')
  })

  it('a missing keyring, or one whose metadata was altered, fails closed', () => {
    const { root, ringPath, ring, provider } = world()
    expect(failure(() => Keyring.load(join(root, 'none.json'), provider.load()))).toBe('keyring_missing')
    ring.rotate()
    const good = readFileSync(ringPath, 'utf8')
    const f = JSON.parse(good) as { active: number; keys: { state: string }[] }
    writeFileSync(ringPath, JSON.stringify({ ...f, active: 1, keys: f.keys.map((k, i) => ({ ...k, state: i === 0 ? 'active' : 'retired' })) }))
    expect(failure(() => Keyring.load(ringPath, provider.load()))).toBe('keyring_tampered')
    writeFileSync(ringPath, JSON.stringify({ ...f, keys: f.keys.slice(1) }))
    expect(failure(() => Keyring.load(ringPath, provider.load()))).toBe('keyring_tampered')
    writeFileSync(ringPath, '{ not json')
    expect(failure(() => Keyring.load(ringPath, provider.load()))).toBe('keyring_malformed')
    writeFileSync(ringPath, good)
    chmodSync(ringPath, 0o644)
    expect(failure(() => Keyring.load(ringPath, provider.load()))).toBe('key_permissions')
  })

  it('truncated or altered ciphertext, or the wrong context, fails closed; plaintext is never returned in its place', () => {
    const { ring } = world()
    const blob = ring.encrypt(secret(), CTX, { table: 'payees' })
    const h = parseHeader(blob)
    const flip = (at: number): Buffer => { const c = Buffer.from(blob); c[at] = c[at]! ^ 0x01; return c }
    expect(failure(() => ring.decrypt(blob.subarray(0, blob.length - 1), CTX))).toBe('ciphertext_truncated')
    expect(failure(() => ring.decrypt(blob.subarray(0, 8), CTX))).toBe('ciphertext_truncated')
    expect(failure(() => ring.decrypt(Buffer.concat([blob, Buffer.from([0])]), CTX))).toBe('ciphertext_malformed')
    expect(failure(() => ring.decrypt(flip(h.size + 3), CTX))).toBe('authentication_failed') // ciphertext body
    expect(failure(() => ring.decrypt(flip(blob.length - 2), CTX))).toBe('authentication_failed') // tag
    expect(failure(() => ring.decrypt(flip(h.size - 3), CTX))).toBe('authentication_failed') // authenticated metadata
    expect(failure(() => ring.decrypt(flip(11 + h.kid.length + 2), CTX))).toBe('authentication_failed') // nonce
    expect(failure(() => ring.decrypt(blob, 'qed/field/payees.handle:pay_2'))).toBe('authentication_failed')
    // Something that is not a QED ciphertext is refused, not passed through as if it were plaintext.
    expect(failure(() => ring.decrypt(secret(), CTX))).toBe('ciphertext_malformed')
  })

  it('wrong key version: an absent version, a version that is another key, and a consistent forgery all fail closed', () => {
    const { ring } = world()
    const v1 = ring.encrypt(secret(), CTX)
    ring.rotate()
    const v2kid = ring.list()[1]!.kid
    const h = parseHeader(v1)
    const absent = Buffer.from(v1); absent.writeUInt32BE(9, 6)
    expect(failure(() => ring.decrypt(absent, CTX))).toBe('unknown_key')
    const otherVersion = Buffer.from(v1); otherVersion.writeUInt32BE(2, 6)
    expect(failure(() => ring.decrypt(otherVersion, CTX))).toBe('unknown_key')
    expect(h.kid.length).toBe(v2kid.length)
    const forged = Buffer.from(otherVersion); forged.write(v2kid, 11, 'ascii')
    expect(failure(() => ring.decrypt(forged, CTX))).toBe('authentication_failed')
  })

  it('revocation destroys a retired version: what it sealed fails closed; the active version cannot be revoked', () => {
    const { keyFile, ringPath, ring } = world()
    const v1 = ring.encrypt(secret(), CTX)
    const wrapped = (JSON.parse(readFileSync(ringPath, 'utf8')) as { keys: { wrapped: string }[] }).keys[0]!.wrapped
    ring.rotate()
    expect(failure(() => ring.revoke(2))).toBe('revoke_active')
    ring.revoke(1)
    expect(readFileSync(ringPath, 'utf8')).not.toContain(wrapped)
    expect(failure(() => ring.decrypt(v1, CTX))).toBe('key_revoked')
    const again = Keyring.load(ringPath, new FileKekProvider(keyFile).load())
    expect(failure(() => again.decrypt(v1, CTX))).toBe('key_revoked')
    expect(again.list().map((k) => k.state)).toEqual(['revoked', 'active'])
    expect(again.decrypt(again.encrypt(secret(), CTX), CTX).equals(secret())).toBe(true)
  })
})
