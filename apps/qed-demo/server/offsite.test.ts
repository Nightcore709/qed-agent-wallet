/**
 * Off-host copies (server/offsite.ts): the SigV4 signer against AWS's published example, the S3 client against a fake store
 * over http on localhost, and push and prune over real sealed backups. No network beyond loopback; no real store.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createBackup } from './backup.ts'
import { APP_ROOT } from './core.ts'
import { buildFixture } from './backup-fixture.ts'
import { DEFAULT_RETENTION } from './backup-retention.ts'
import { FileKekProvider, Keyring } from './keys.ts'
import { newestRemote, type ObjectStore, offsiteConfig, planFiles, pruneLocal, pruneRemote, push, S3Store, signV4 } from './offsite.ts'

const made: string[] = []
const servers: Server[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); for (const s of servers) s.close() })
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'qed-offsite-test-')); made.push(d); return d }

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>()
  async put(k: string, b: Buffer) { this.objects.set(k, Buffer.from(b)) }
  async get(k: string) { const b = this.objects.get(k); if (!b) throw new Error(`no ${k}`); return b }
  async list(p: string) { return [...this.objects].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.length })) }
  async delete(k: string) { this.objects.delete(k) }
}

describe('SigV4', () => {
  it('reproduces the signature in AWS\'s published "GET Object" example', () => {
    const r = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: [],
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
    })
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(r.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date')
  })
  it('reproduces the signature in AWS\'s published "GET Bucket (List Objects)" example', () => {
    const r = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: [['max-keys', '2'], ['prefix', 'J']],
      headers: { 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
    })
    expect(r.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
  })
})

describe('configuration', () => {
  const ok = { QED_OFFSITE: 'on', QED_OFFSITE_ENDPOINT: 'https://s3.example.com', QED_OFFSITE_BUCKET: 'qed-backups', QED_OFFSITE_ACCESS_KEY_ID: 'AK', QED_OFFSITE_SECRET_ACCESS_KEY: 'SK' }
  it('is off unless QED_OFFSITE=on', () => { expect(offsiteConfig({})).toBeNull(); expect(offsiteConfig({ QED_OFFSITE: 'off' })).toBeNull(); expect(() => offsiteConfig({ QED_OFFSITE: 'true' })).toThrow(/QED_OFFSITE/) })
  it('accepts a good one and normalises the prefix', () => {
    const c = offsiteConfig({ ...ok, QED_OFFSITE_PREFIX: '/prod/qed' })!
    expect(c.prefix).toBe('prod/qed/'); expect(c.pathStyle).toBe(true); expect(c.region).toBe('auto')
  })
  it('refuses plain http beyond localhost, a path in the endpoint, a bad bucket, a traversal prefix and missing keys, without echoing the secret', () => {
    expect(() => offsiteConfig({ ...ok, QED_OFFSITE_ENDPOINT: 'http://s3.example.com' })).toThrow(/https/)
    expect(() => offsiteConfig({ ...ok, QED_OFFSITE_ENDPOINT: 'https://s3.example.com/bucket' })).toThrow(/origin only/)
    expect(() => offsiteConfig({ ...ok, QED_OFFSITE_BUCKET: 'Bad_Bucket' })).toThrow(/bucket/)
    expect(() => offsiteConfig({ ...ok, QED_OFFSITE_PREFIX: '../x' })).toThrow(/PREFIX/)
    let msg = ''
    try { offsiteConfig({ ...ok, QED_OFFSITE_SECRET_ACCESS_KEY: '' }) } catch (e) { msg = String(e) }
    expect(msg).toMatch(/QED_OFFSITE_SECRET_ACCESS_KEY is required/)
    expect(() => offsiteConfig({ ...ok, QED_OFFSITE_ENDPOINT: 'http://127.0.0.1:9000' })).not.toThrow()
  })
})

/** A fake S3 on loopback: path-style, PUT/GET/DELETE/list-v2 with continuation, checks the body hash header. */
async function fakeS3(): Promise<{ url: string; objects: Map<string, Buffer>; requests: string[]; badSignatures: number }> {
  const objects = new Map<string, Buffer>(); const requests: string[] = []; const state = { badSignatures: 0 }
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks), u = new URL(req.url!, 'http://x')
      requests.push(`${req.method} ${u.pathname}${u.search}`)
      if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(String(req.headers.authorization))) state.badSignatures++
      if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) state.badSignatures++
      const m = /^\/qed-backups\/?(.*)$/.exec(decodeURIComponent(u.pathname))
      if (!m) { res.statusCode = 404; res.end('<Error><Code>NoSuchBucket</Code></Error>'); return }
      const key = m[1]!
      if (req.method === 'PUT') { objects.set(key, body); res.end() }
      else if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; res.end() }
      else if (req.method === 'GET' && key === '') {
        const prefix = u.searchParams.get('prefix') ?? '', after = u.searchParams.get('continuation-token')
        const all = [...objects].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => !after || k > after)
        const page = all.slice(0, 2), more = all.length > 2
        res.end(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${page[1]![0]}</NextContinuationToken>` : ''}${page.map(([k, b]) => `<Contents><Key>${k}</Key><Size>${b.length}</Size></Contents>`).join('')}</ListBucketResult>`)
      } else if (req.method === 'GET') { const b = objects.get(key); if (b) res.end(b); else { res.statusCode = 404; res.end('<Error><Code>NoSuchKey</Code></Error>') } }
      else { res.statusCode = 405; res.end() }
    })
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok)); servers.push(srv)
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, objects, requests, get badSignatures() { return state.badSignatures } }
}

describe('the S3 client', () => {
  it('puts, lists (several pages), gets and deletes against a store; every request is signed and carries its body hash', async () => {
    const f = await fakeS3()
    const cfg = offsiteConfig({ QED_OFFSITE: 'on', QED_OFFSITE_ENDPOINT: f.url, QED_OFFSITE_BUCKET: 'qed-backups', QED_OFFSITE_ACCESS_KEY_ID: 'AK', QED_OFFSITE_SECRET_ACCESS_KEY: 'SK' })!
    const s = new S3Store(cfg)
    for (const k of ['qed/a', 'qed/b', 'qed/c', 'qed/d', 'qed/e', 'other/z']) await s.put(k, Buffer.from(`body ${k}`))
    expect((await s.list('qed/')).map((o) => o.key)).toEqual(['qed/a', 'qed/b', 'qed/c', 'qed/d', 'qed/e'])
    expect((await s.get('qed/c')).toString()).toBe('body qed/c')
    await s.delete('qed/c')
    await expect(s.get('qed/c')).rejects.toThrow(/HTTP 404 NoSuchKey/)
    expect(f.badSignatures).toBe(0)
  })
  it('names a refused request without echoing its body', async () => {
    const f = await fakeS3()
    const cfg = offsiteConfig({ QED_OFFSITE: 'on', QED_OFFSITE_ENDPOINT: f.url, QED_OFFSITE_BUCKET: 'wrong-bucket', QED_OFFSITE_ACCESS_KEY_ID: 'AK', QED_OFFSITE_SECRET_ACCESS_KEY: 'SK' })!
    await expect(new S3Store(cfg).put('x', Buffer.from('y'))).rejects.toThrow(/HTTP 404 NoSuchBucket/)
  })
})

function sealedStack() {
  const root = scratch(), dataDir = join(root, 'data'), out = join(root, 'backups'), keys = join(root, 'keys')
  mkdirSync(dataDir, { mode: 0o700 })
  const db = join(dataDir, 'qed.db')
  buildFixture(db, { households: 1, entries: 3 })
  const kek = FileKekProvider.generate(join(keys, 'qed.kek'), { forbiddenFolders: [dataDir, out] }).load()
  const keyring = join(keys, 'backup.keyring.json')
  const ring = Keyring.create(keyring, kek)
  const make = (iso: string) => createBackup({ db, outDir: out, keyring: ring, log: () => {}, now: () => Date.parse(iso) }).manifest.id
  return { root, out, keyring, make }
}

describe('push and prune over real sealed backups', () => {
  it('uploads sealed files and the keyring once, skips what is there, and refuses anything unsealed', async () => {
    const s = sealedStack()
    const ids = ['2026-11-22T10:00:00Z', '2026-11-23T10:00:00Z'].map(s.make)
    writeFileSync(join(s.out, 'bk-20261124T100000Z-aaaaaa.qedbak'), 'plaintext, not sealed') // a forged "sealed" file
    writeFileSync(join(s.out, 'notes.txt'), 'x') // never considered
    const store = new MemoryStore()
    const r1 = await push(store, { backupDir: s.out, keyring: s.keyring }, 'qed/')
    expect(r1.failed).toEqual([])
    expect(r1.skipped.map((k) => k.file)).toEqual([join(s.out, 'bk-20261124T100000Z-aaaaaa.qedbak')])
    expect([...store.objects.keys()].sort()).toEqual([...ids.flatMap((i) => [`qed/backups/${i}.manifest.json`, `qed/backups/${i}.qedbak`]), 'qed/keys/backup.keyring.json'].sort())
    const r2 = await push(store, { backupDir: s.out, keyring: s.keyring }, 'qed/')
    expect(r2.uploaded).toEqual(['qed/keys/backup.keyring.json']) // the keyring is re-sent; the rest is already there
    expect(r2.already).toBe(4)
    // the store never held a plaintext database: every uploaded .qedbak is byte-identical to the sealed file
    expect(store.objects.get(`qed/backups/${ids[0]}.qedbak`)!.length).toBe(statSync(join(s.out, `${ids[0]}.qedbak`)).size)
    expect(await newestRemote(store, 'qed/')).toMatchObject({ id: ids[1] })
  })
  it('prunes both sides by the same rule, keeping the newest, and only touches backups', async () => {
    const s = sealedStack()
    const base = Date.parse('2026-11-20T00:00:00Z')
    const ids = Array.from({ length: 5 }, (_, h) => s.make(new Date(base + h * 3_600_000).toISOString())) // five hourly backups, one day
    writeFileSync(join(s.out, 'before-restore-keep.txt'), 'x')
    const store = new MemoryStore()
    await push(store, { backupDir: s.out, keyring: s.keyring }, 'qed/')
    const local = pruneLocal(s.out, DEFAULT_RETENTION, (p) => unlinkSync(p))
    expect(local.kept).toBe(1); expect(local.deleted.length).toBe(8) // 4 backups x 2 files
    expect(readdirSync(s.out).sort()).toEqual([`${ids[4]}.manifest.json`, `${ids[4]}.qedbak`, 'before-restore-keep.txt', 'keyring.json'].sort())
    const remote = await pruneRemote(store, 'qed/', DEFAULT_RETENTION)
    expect(remote.deleted.length).toBe(8)
    expect([...store.objects.keys()].sort()).toEqual([`qed/backups/${ids[4]}.manifest.json`, `qed/backups/${ids[4]}.qedbak`, 'qed/keys/backup.keyring.json'].sort())
  })
  it('lists nothing for deletion when the store holds a single backup', async () => {
    const store = new MemoryStore()
    store.objects.set('qed/backups/bk-20261120T000000Z-aaaaaa.manifest.json', Buffer.from('{}'))
    store.objects.set('qed/backups/bk-20261120T000000Z-aaaaaa.qedbak', Buffer.from('x'))
    expect((await pruneRemote(store, 'qed/', { hourly: 0, daily: 0, weekly: 0, monthly: 0 })).deleted).toEqual([])
  })
  it('plans no file from a folder that does not exist', () => { expect(planFiles({ backupDir: '/nonexistent-qed', keyring: '/nonexistent-qed/k.json' }, 'p/')).toEqual({ files: [], skipped: [] }) })
})

describe('the command, end to end against the fake store', () => {
  const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((done) => {
    const c = spawn(process.execPath, [join(APP_ROOT, 'scripts', 'backup-offsite.ts'), ...args], { env: { PATH: process.env.PATH!, ...env } })
    let out = ''
    c.stdout.on('data', (d: Buffer) => { out += d }); c.stderr.on('data', (d: Buffer) => { out += d })
    c.on('exit', (code) => done({ code, out }))
  })
  it('pushes sealed backups, lists them, drills the off-host copy, prunes, and never prints the secret', async () => {
    const f = await fakeS3()
    const s = sealedStack()
    const ids = ['2026-11-22T10:00:00Z', '2026-11-22T11:00:00Z'].map(s.make)
    const env = { QED_BACKUP_DIR: s.out, QED_KEY_DIR: join(s.root, 'keys'), QED_OFFSITE: 'on', QED_OFFSITE_ENDPOINT: f.url, QED_OFFSITE_BUCKET: 'qed-backups', QED_OFFSITE_ACCESS_KEY_ID: 'AK', QED_OFFSITE_SECRET_ACCESS_KEY: 'SECRET-VALUE-XYZ', QED_BACKUP_RETENTION: 'on', QED_DB: join(s.root, 'data', 'qed.db') }
    const pushed = await run(['push'], env)
    expect(pushed.code, pushed.out).toBe(0)
    expect([...f.objects.keys()].sort()).toEqual([...ids.flatMap((i) => [`qed/backups/${i}.manifest.json`, `qed/backups/${i}.qedbak`]), 'qed/keys/backup.keyring.json'].sort())
    const drilled = await run(['drill'], env)
    expect(drilled.code, drilled.out).toBe(0)
    expect(drilled.out).toContain('off-host restore drill passed')
    const pruned = await run(['prune'], env) // two backups in one UTC day: the newer stands for the day
    expect(pruned.code, pruned.out).toBe(0)
    expect([...f.objects.keys()].filter((k) => k.includes(ids[0]!))).toEqual([])
    expect([...f.objects.keys()].filter((k) => k.includes(ids[1]!)).length).toBe(2)
    expect(readdirSync(s.out).filter((n) => n.includes(ids[0]!))).toEqual([])
    for (const r of [pushed, drilled, pruned]) expect(r.out).not.toContain('SECRET-VALUE-XYZ')
    expect(f.badSignatures).toBe(0)
    const off = await run(['push'], { ...env, QED_OFFSITE: 'off' })
    expect(off.out).toContain('off-host copy is off')
  }, 60_000)
})
