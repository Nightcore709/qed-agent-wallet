/**
 * Key separation (R11 section 11; docs/ENCRYPTION.md section 3): the database's own data keys (field encryption, D10;
 * reserved: nothing is sealed under them yet), the backups' and the migration copies' are kept in separate keyrings.
 * Each keyring names its purpose, the purpose is authenticated, each data key is an independent random key whose id
 * names its purpose, and a keyring of one purpose never opens, or stands in for, another's. Also here: a sealed file is
 * verified, and re-sealed under a new key version, without its plaintext ever reaching the disk.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ensurePrivateFolder, FileKekProvider, KEY_PURPOSES, KeyError, Keyring, parseHeader, parseKekRecord, realish, type KeyPurpose } from './keys.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-keysep-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
function failure(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof KeyError) return e.code; throw e }
  return 'none'
}
function messageOf(fn: () => unknown): string {
  try { fn() } catch (e) { return (e as Error).message }
  return ''
}
const CTX = 'qed/test/separation'
const SECRET = Buffer.from('marker.separation.sensitive value', 'utf8')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** One key-encryption key and a keyring for every purpose, in a private key folder. */
function world() {
  const root = scratch()
  const keyFile = join(root, 'keys', 'qed.kek')
  const kek = FileKekProvider.generate(keyFile).load()
  const path = (p: KeyPurpose): string => join(root, 'keys', `${p}.keyring.json`)
  const rings = Object.fromEntries(KEY_PURPOSES.map((p) => [p, Keyring.create(path(p), kek, 1_000, p)])) as Record<KeyPurpose, Keyring>
  return { root, keyFile, kek, path, rings }
}

describe('key separation: database, backup, migration-copy and wallet-secret keys', () => {
  it('one key-encryption key, four purposes: independent data keys with ids that name their purpose and distinct check values', () => {
    const { rings } = world()
    expect([...KEY_PURPOSES]).toEqual(['database', 'backup', 'migration-copy', 'wallet-secret'])
    for (const p of KEY_PURPOSES) {
      const [k] = rings[p].list()
      expect(rings[p].purpose).toBe(p)
      expect(k!.kid).toMatch(new RegExp(`^dek_${p}_[0-9a-f]{16}$`))
      expect(k!.check).toMatch(/^[0-9a-f]{16}$/)
    }
    // The check value is a keyed digest of the data key itself: four different values are four different keys.
    expect(new Set(KEY_PURPOSES.map((p) => rings[p].list()[0]!.check)).size).toBe(4)
    expect(new Set(KEY_PURPOSES.map((p) => rings[p].list()[0]!.kid)).size).toBe(4)
  })

  it('each keyring opens only what it sealed: another purpose\'s ciphertext fails closed and returns nothing', () => {
    const { rings } = world()
    for (const a of KEY_PURPOSES) {
      const blob = rings[a].encrypt(SECRET, CTX)
      expect(parseHeader(blob).kid.startsWith(`dek_${a}_`)).toBe(true)
      for (const b of KEY_PURPOSES) {
        if (a === b) expect(rings[b].decrypt(blob, CTX).equals(SECRET)).toBe(true)
        else expect([a, b, failure(() => rings[b].decrypt(blob, CTX))]).toEqual([a, b, 'unknown_key'])
      }
    }
  })

  it('a keyring of one purpose is refused where another is required, and the message names both purposes', () => {
    const { path, kek, rings } = world()
    expect(failure(() => Keyring.load(path('backup'), kek, 'migration-copy'))).toBe('key_purpose')
    expect(failure(() => Keyring.load(path('migration-copy'), kek, 'backup'))).toBe('key_purpose')
    expect(failure(() => Keyring.load(path('database'), kek, 'backup'))).toBe('key_purpose')
    expect(messageOf(() => Keyring.load(path('backup'), kek, 'migration-copy'))).toMatch(/backup.*migration-copy|migration-copy.*backup/)
    expect(Keyring.load(path('migration-copy'), kek, 'migration-copy').purpose).toBe('migration-copy')
    expect(failure(() => rings.backup.requirePurpose('migration-copy'))).toBe('key_purpose')
    expect(failure(() => rings['migration-copy'].requirePurpose('migration-copy'))).toBe('none')
  })

  it('the purpose is authenticated: a keyring relabelled as another purpose, or given another keyring\'s data key, fails its integrity check', () => {
    const { path, kek } = world()
    const backup = JSON.parse(readFileSync(path('backup'), 'utf8')) as { purpose: string; keys: unknown[] }
    writeFileSync(path('backup'), JSON.stringify({ ...backup, purpose: 'migration-copy' }))
    expect(failure(() => Keyring.load(path('backup'), kek, 'migration-copy'))).toBe('keyring_tampered')
    const migration = JSON.parse(readFileSync(path('migration-copy'), 'utf8')) as { keys: unknown[] }
    writeFileSync(path('migration-copy'), JSON.stringify({ ...migration, keys: backup.keys }))
    expect(failure(() => Keyring.load(path('migration-copy'), kek, 'migration-copy'))).toBe('keyring_tampered')
  })

  it('rotating one purpose leaves the others as they were; check values survive a restart and change with the version', () => {
    const { path, kek, rings } = world()
    const before = Object.fromEntries(KEY_PURPOSES.map((p) => [p, readFileSync(path(p), 'utf8')]))
    const v2 = rings['migration-copy'].rotate(2_000)
    expect(v2.version).toBe(2)
    expect(v2.check).not.toBe(rings['migration-copy'].list()[0]!.check)
    expect(readFileSync(path('backup'), 'utf8')).toBe(before.backup)
    expect(readFileSync(path('database'), 'utf8')).toBe(before.database)
    const again = Keyring.load(path('migration-copy'), kek, 'migration-copy')
    expect(again.list().map((k) => [k.version, k.state, k.check])).toEqual(rings['migration-copy'].list().map((k) => [k.version, k.state, k.check]))
    again.revoke(1)
    expect(again.list()[0]).toMatchObject({ version: 1, state: 'revoked', check: null })
  })

  it('a keyring of format 1 (made before purposes, 22 Nov) opens what it sealed, as a backup keyring only; its first change makes it format 2, with a generation', () => {
    // A known-answer vector made with the format-1 code at 103eac5. Synthetic test key; it protects nothing.
    const root = scratch()
    const keyring = join(root, 'keys', 'keyring.json')
    const kekRecord = 'qedkek1:kek_092296244238e5ec:iSqcHQZcLRQgmj-e95CUuS9Gxt7LJzCt9YHIYv2abAM:TnUQ6owD' // gitleaks:allow (test vector)
    const file = { format: 'qed-keyring/1', kekId: 'kek_092296244238e5ec', active: 1, keys: [{ version: 1, kid: 'dek_193ecdb4f67cc54c', state: 'active', createdAt: 1700000000000, retiredAt: null, revokedAt: null, wrapped: 'UUVEQwEBAAAAABRrZWtfMDkyMjk2MjQ0MjM4ZTVlYx5uN-vOFqOwUmpucwAAAAAAAAAgAAJ7ff-GMtn0-cXr-DnGtOLQVuBHoAWRb2B_-nK7v9gbe1RwmP-KdlkUdPLn4eBzZRJ1Zg' }], mac: 'TTpApqfBlr5niMpv0YMYYb04n-AHUNorMxM8ePUTVEY' }
    const blob = Buffer.from('UUVEQwEBAAAAARRkZWtfMTkzZWNkYjRmNjdjYzU0YwwPslATPJkhGe42wwAAAAAAAAAbAAd7InQiOjF9kvd1G3NHpEBihTcONVAo64svieVhsXMCbZwhYUPksf/aQhHetxgSXnEI0Q==', 'base64')
    ensurePrivateFolder(join(root, 'keys'))
    writeFileSync(keyring, JSON.stringify(file), { mode: 0o600 })
    const kek = parseKekRecord(kekRecord, 'the test vector')
    const ring = Keyring.load(keyring, kek, 'backup')
    expect([ring.format, ring.purpose]).toEqual([1, 'backup'])
    expect(ring.decrypt(blob, 'qed/test/legacy-v1').toString('utf8')).toBe('legacy format 1 test vector')
    expect(failure(() => Keyring.load(keyring, kek, 'migration-copy'))).toBe('key_purpose')
    expect(ring.generation).toBe(0)
    ring.rotate(1_800_000_000_000)
    const again = Keyring.load(keyring, kek, 'backup')
    expect([again.format, again.purpose, again.generation]).toEqual([2, 'backup', 1])
    expect(again.list().map((k) => k.state)).toEqual(['retired', 'active'])
    expect(again.decrypt(blob, 'qed/test/legacy-v1').toString('utf8')).toBe('legacy format 1 test vector')
    expect(JSON.parse(readFileSync(keyring, 'utf8'))).toMatchObject({ format: 'qed-keyring/2', purpose: 'backup', generation: 1 })
  })
})

describe('a keyring put back from an older copy is refused (independent review of cb85271, finding 3)', () => {
  it('every change raises an authenticated generation; the highest one written is kept beside the keyring', () => {
    const { path, kek, rings } = world()
    const r = rings.backup
    expect(r.generation).toBe(1)
    r.rotate(2_000)
    expect(r.generation).toBe(2)
    r.revoke(1, 3_000)
    expect(r.generation).toBe(3)
    expect(JSON.parse(readFileSync(path('backup').replace(/\.json$/, '.generation'), 'utf8'))).toMatchObject({ generation: 3 })
    expect(Keyring.load(path('backup'), kek, 'backup').generation).toBe(3)
    // The generation is covered by the keyring's authentication: raising it by hand breaks it.
    const f = JSON.parse(readFileSync(path('backup'), 'utf8')) as { generation: number }
    writeFileSync(path('backup'), JSON.stringify({ ...f, generation: 99 }))
    expect(failure(() => Keyring.load(path('backup'), kek, 'backup'))).toBe('keyring_tampered')
  })

  it('an older copy put back over the keyring (it still holds a revoked key) is refused, saying which generations; with no record it is accepted', () => {
    const { root, path, kek, rings } = world()
    const old = readFileSync(path('backup'))
    rings.backup.rotate(2_000)
    rings.backup.revoke(1, 3_000)
    writeFileSync(path('backup'), old) // generation 1, version 1 active and still holding its key
    expect(failure(() => Keyring.load(path('backup'), kek, 'backup'))).toBe('keyring_rolled_back')
    expect(messageOf(() => Keyring.load(path('backup'), kek, 'backup'))).toMatch(/generation 1.*generation 3/)
    // Nothing seals under it: every way in goes through load.
    rmSync(path('backup').replace(/\.json$/, '.generation'))
    expect(Keyring.load(path('backup'), kek, 'backup').generation).toBe(1) // the operator removed the record on purpose
    void root
  })

  it('a missing keyring says how to set keys up, and to restore only the newest copy', () => {
    const { path, kek } = world()
    rmSync(path('backup'))
    const m = messageOf(() => Keyring.load(path('backup'), kek, 'backup'))
    expect(m).toContain('npm run keys:init')
    expect(m).toContain('newest copy')
    expect(m).not.toContain('Restore it (a copy is kept beside each backup set)')
  })

  it('each keyring keeps a list of the folders where copies were made under it', () => {
    const { root, rings } = world()
    mkdirSync(join(root, 'elsewhere'), { mode: 0o700 })
    rings.backup.copyTo(join(root, 'elsewhere', 'keyring.json'))
    rings.backup.notePlace(join(root, 'alt'))
    rings.backup.notePlace(join(root, 'alt'))
    expect(rings.backup.places()).toEqual([realish(join(root, 'elsewhere')), realish(join(root, 'alt'))]) // canonical paths
    expect(rings['migration-copy'].places()).toEqual([])
  })
})

describe('sealed files: verified and re-sealed without plaintext on disk', () => {
  function sealedFile() {
    const w = world()
    const dir = join(w.root, 'work')
    const plain = join(w.root, 'plain.bin')
    const body = Buffer.concat([SECRET, Buffer.alloc(3 << 20, 7), SECRET]) // spans several 1 MiB chunks
    writeFileSync(plain, body, { mode: 0o600 })
    ensurePrivateFolder(dir)
    const sealed = join(dir, 'file.sealed')
    const seal = w.rings.backup.encryptFile(plain, sealed, CTX, { what: 'test' })
    return { ...w, dir, plain, body, sealed, seal }
  }

  it('verifyFile streams the plaintext to a sink, checks the tag, and writes nothing', () => {
    const { rings, dir, body, sealed, seal } = sealedFile()
    const seen: Buffer[] = []
    const before = readdirSync(dir).sort()
    const r = rings.backup.verifyFile(sealed, CTX, (b) => { seen.push(Buffer.from(b)) })
    expect(r.plaintextSha256).toBe(sha(body))
    expect(r.plaintextSha256).toBe(seal.plaintextSha256)
    expect(Buffer.concat(seen).equals(body)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(rings.backup.verifyFile(sealed, CTX).plaintextBytes).toBe(body.length)
  })

  it('verifyFile fails closed on an altered byte, a wrong context and another purpose\'s keyring', () => {
    const { rings, sealed } = sealedFile()
    const x = readFileSync(sealed)
    x[x.length >> 1] = x[x.length >> 1]! ^ 1
    writeFileSync(sealed.replace('file', 'altered'), x)
    expect(failure(() => rings.backup.verifyFile(sealed.replace('file', 'altered'), CTX))).toBe('authentication_failed')
    expect(failure(() => rings.backup.verifyFile(sealed, 'qed/test/other'))).toBe('authentication_failed')
    expect(failure(() => rings['migration-copy'].verifyFile(sealed, CTX))).toBe('unknown_key')
  })

  it('resealFile moves a file sealed under a retired version to the active one, streaming, under a new context', () => {
    const { rings, dir, body, sealed } = sealedFile()
    rings.backup.rotate()
    const out = join(dir, 'file.v2.sealed')
    const r = rings.backup.resealFile(sealed, CTX, out, 'qed/test/separation-v2', { what: 'test', again: true })
    expect(r.from).toEqual({ kid: rings.backup.list()[0]!.kid, version: 1 })
    expect([r.header.version, r.header.kid]).toEqual([2, rings.backup.list()[1]!.kid])
    expect(r.plaintextSha256).toBe(sha(body))
    expect(readFileSync(out).includes(SECRET)).toBe(false)
    const back: Buffer[] = []
    rings.backup.verifyFile(out, 'qed/test/separation-v2', (b) => { back.push(Buffer.from(b)) })
    expect(Buffer.concat(back).equals(body)).toBe(true)
    // The old file is left as it was; once its version is revoked it cannot be opened, the re-sealed one can.
    rings.backup.revoke(1)
    expect(failure(() => rings.backup.verifyFile(sealed, CTX))).toBe('key_revoked')
    expect(rings.backup.verifyFile(out, 'qed/test/separation-v2').plaintextSha256).toBe(sha(body))
  })

  it('resealFile leaves no output when the source fails authentication', () => {
    const { rings, dir, sealed } = sealedFile()
    const x = readFileSync(sealed)
    x[x.length - 20] = x[x.length - 20]! ^ 1
    writeFileSync(sealed, x)
    rings.backup.rotate()
    const out = join(dir, 'file.v2.sealed')
    expect(failure(() => rings.backup.resealFile(sealed, CTX, out, CTX, {}))).toBe('authentication_failed')
    expect(existsSync(out)).toBe(false)
  })
})
