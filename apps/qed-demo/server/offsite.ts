/**
 * Off-host copies of the sealed backups (docs/DEPLOY.md, "Backups"). OFF unless QED_OFFSITE=on. Nothing is provisioned
 * here: the owner makes a bucket at a provider they choose (any S3-compatible store) and gives this code a key that can
 * write to it.
 *
 *  - Only files that are already sealed leave the volume: `*.qedbak` and `*.qedseal` (AES-256-GCM under a data key the
 *    key-encryption key wraps; the header is checked before every upload), their JSON manifests, and the backup
 *    keyring (its data keys are wrapped by the key-encryption key, which never leaves the owner's escrow).
 *  - The store is spoken to with AWS Signature Version 4 over HTTPS (plain http only to localhost, for tests), using
 *    node:crypto and fetch: no dependency, no vendor SDK.
 *  - A single object may be up to 512 MB (one PUT; no multipart). Larger files are refused and reported, never cut.
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { backupTime, policyFromEnv, retentionOn, selectDelete, type RetentionPolicy } from './backup-retention.ts'
import { headerOfFile } from './keys.ts'

export interface OffsiteConfig {
  endpoint: URL
  region: string
  bucket: string
  /** Always ends with "/" (or is empty). */
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  pathStyle: boolean
}

export const MAX_OBJECT_BYTES = 512 * 1024 * 1024

export function offsiteOn(env: Record<string, string | undefined>): boolean {
  const v = (env.QED_OFFSITE ?? 'off').trim().toLowerCase()
  if (v === 'on') return true
  if (v === 'off' || v === '') return false
  throw new Error('QED_OFFSITE must be "on" or "off"')
}

/** The configuration, or null when off. Throws a message naming the variable on any fault; never prints the secret. */
export function offsiteConfig(env: Record<string, string | undefined>): OffsiteConfig | null {
  if (!offsiteOn(env)) return null
  const need = (n: string): string => { const v = env[n]?.trim(); if (!v) throw new Error(`${n} is required when QED_OFFSITE=on`); return v }
  let endpoint: URL
  try { endpoint = new URL(need('QED_OFFSITE_ENDPOINT')) } catch (e) { if (e instanceof TypeError) throw new Error('QED_OFFSITE_ENDPOINT is not a URL'); throw e }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) throw new Error('QED_OFFSITE_ENDPOINT must be https (http only to localhost)')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== '/' && endpoint.pathname !== '')) throw new Error('QED_OFFSITE_ENDPOINT must be an origin only: no credentials, path or query')
  const bucket = need('QED_OFFSITE_BUCKET')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('QED_OFFSITE_BUCKET is not a valid bucket name')
  const region = (env.QED_OFFSITE_REGION?.trim() || 'auto')
  if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new Error('QED_OFFSITE_REGION is not a valid region name')
  const raw = (env.QED_OFFSITE_PREFIX ?? 'qed/').trim().replace(/^\/+/, '')
  if (raw.split('/').some((s) => s === '..' || s === '.') || !/^[A-Za-z0-9._\-/]*$/.test(raw)) throw new Error('QED_OFFSITE_PREFIX may hold letters, digits, . _ - and /')
  const prefix = raw === '' || raw.endsWith('/') ? raw : `${raw}/`
  const ps = (env.QED_OFFSITE_PATH_STYLE ?? '1').trim()
  if (ps !== '0' && ps !== '1') throw new Error('QED_OFFSITE_PATH_STYLE must be 0 or 1')
  return { endpoint, region, bucket, prefix, accessKeyId: need('QED_OFFSITE_ACCESS_KEY_ID'), secretAccessKey: need('QED_OFFSITE_SECRET_ACCESS_KEY'), pathStyle: ps === '1' }
}

// ------------------------------------------------------------------------------------------------------ SigV4
const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const hmac = (k: Buffer | string, d: string): Buffer => createHmac('sha256', k).update(d).digest()
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface SignInput { method: string; host: string; path: string; query: [string, string][]; headers: Record<string, string>; payloadSha256: string; region: string; accessKeyId: string; secretAccessKey: string; amzDate: string }
/** AWS Signature Version 4 for S3: the Authorization header's value. `headers` are those signed besides host and x-amz-date. */
export function signV4(i: SignInput): { authorization: string; signedHeaders: string; signature: string } {
  const date = i.amzDate.slice(0, 8)
  const all: Record<string, string> = { host: i.host, 'x-amz-date': i.amzDate, ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])) }
  const names = Object.keys(all).sort()
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalQuery = [...i.query].map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
  const canonical = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadSha256].join('\n')
  const scope = `${date}/${i.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signedHeaders, signature }
}

export interface RemoteObject { key: string; size: number }
/** What the off-host code needs of a store; the tests use an in-memory one. */
export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  list(prefix: string): Promise<RemoteObject[]>
  delete(key: string): Promise<void>
}

export class S3Store implements ObjectStore {
  private readonly cfg: OffsiteConfig
  private readonly now: () => Date
  constructor(cfg: OffsiteConfig, now: () => Date = () => new Date()) { this.cfg = cfg; this.now = now }
  private target(key: string, query: [string, string][]): { url: string; host: string; path: string } {
    const c = this.cfg
    const keyPath = key.split('/').map(enc).join('/')
    const host = c.pathStyle ? c.endpoint.host : `${c.bucket}.${c.endpoint.host}`
    const path = c.pathStyle ? `/${c.bucket}${key === '' ? '' : `/${keyPath}`}` : `/${keyPath}`
    const q = query.length ? `?${query.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')}` : ''
    return { url: `${c.endpoint.protocol}//${host}${path}${q}`, host, path }
  }
  private async call(method: string, key: string, query: [string, string][] = [], body?: Buffer): Promise<Response> {
    const t = this.target(key, query)
    const payload = body ?? Buffer.alloc(0)
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const payloadSha256 = sha256hex(payload)
    const s = signV4({ method, host: t.host, path: t.path, query, headers: { 'x-amz-content-sha256': payloadSha256 }, payloadSha256, region: this.cfg.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, amzDate })
    const res = await fetch(t.url, { method, headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256, authorization: s.authorization }, body: method === 'PUT' ? new Uint8Array(payload) : undefined, signal: AbortSignal.timeout(120_000), redirect: 'error' })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ')
      throw new Error(`${method} ${key === '' ? 'bucket' : key}: HTTP ${res.status}${/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ? ` ${/<Code>([^<]+)<\/Code>/.exec(text)![1]}` : ''}`)
    }
    return res
  }
  async put(key: string, body: Buffer): Promise<void> { await this.call('PUT', key, [], body) }
  async get(key: string): Promise<Buffer> { return Buffer.from(await (await this.call('GET', key)).arrayBuffer()) }
  async delete(key: string): Promise<void> { await this.call('DELETE', key) }
  async list(prefix: string): Promise<RemoteObject[]> {
    const out: RemoteObject[] = []
    let token: string | undefined
    for (let page = 0; page < 1000; page++) {
      const q: [string, string][] = [['list-type', '2'], ['prefix', prefix], ...(token ? [['continuation-token', token] as [string, string]] : [])]
      const xml = await (await this.call('GET', '', q)).text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1]
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1])
        if (key !== undefined && Number.isFinite(size)) out.push({ key: key.replace(/&amp;/g, '&'), size })
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined
      if (!token) return out
    }
    throw new Error('the listing did not end after 1000 pages')
  }
}

// ----------------------------------------------------------------------------------------------- what to copy
export interface Folders { backupDir: string; /** the backup keyring's file */ keyring: string }
export interface PlannedFile { local: string; remote: string; size: number }
export interface Skipped { file: string; why: string }

const SEALED = /\.(qedbak|qedseal)$/
const BACKUP_FILE = /^(bk-\d{8}T\d{6}Z-[0-9a-f]{6})\.(qedbak|manifest\.json)$/
const ARCHIVE_ID = /^ar-\d{8}T\d{6}Z-[0-9a-f]{6}$/

/** Every file that may leave the volume, with the remote key it gets. Anything not sealed is reported as skipped. */
export function planFiles(f: Folders, prefix: string): { files: PlannedFile[]; skipped: Skipped[] } {
  const files: PlannedFile[] = [], skipped: Skipped[] = []
  const add = (local: string, remote: string): void => {
    const size = statSync(local).size
    if (size > MAX_OBJECT_BYTES) { skipped.push({ file: local, why: `larger than ${MAX_OBJECT_BYTES / 1024 / 1024} MB; one-request upload only` }); return }
    if (SEALED.test(local)) { try { headerOfFile(local) } catch { skipped.push({ file: local, why: 'not a sealed file (its header does not parse); never uploaded' }); return } }
    files.push({ local, remote: `${prefix}${remote}`, size })
  }
  if (existsSync(f.backupDir)) {
    for (const n of readdirSync(f.backupDir).sort()) if (BACKUP_FILE.test(n)) add(join(f.backupDir, n), `backups/${n}`)
    const wallet = join(f.backupDir, 'wallet-service')
    if (existsSync(wallet)) for (const a of readdirSync(wallet).sort()) {
      if (!ARCHIVE_ID.test(a)) continue
      for (const n of readdirSync(join(wallet, a)).sort()) if (n === 'archive.json' || /^\d{4,}\.qedseal$/.test(n)) add(join(wallet, a, n), `wallet-service/${a}/${n}`)
    }
  }
  if (existsSync(f.keyring)) add(f.keyring, 'keys/backup.keyring.json')
  return { files, skipped }
}

export interface PushResult { uploaded: string[]; already: number; skipped: Skipped[]; failed: { key: string; why: string }[] }

/** Copy what the store lacks (same key and size = already there). The keyring is always sent: it grows by rotation. */
export async function push(store: ObjectStore, f: Folders, prefix: string): Promise<PushResult> {
  const { files, skipped } = planFiles(f, prefix)
  const remote = new Map((await store.list(prefix)).map((o) => [o.key, o.size]))
  const r: PushResult = { uploaded: [], already: 0, skipped, failed: [] }
  for (const p of files) {
    if (remote.get(p.remote) === p.size && !p.remote.endsWith('keys/backup.keyring.json')) { r.already++; continue }
    try { await store.put(p.remote, readFileSync(p.local)); r.uploaded.push(p.remote) } catch (e) { r.failed.push({ key: p.remote, why: e instanceof Error ? e.message : String(e) }) }
  }
  return r
}

/** Backup ids present in a list of file names or remote keys. */
function idsOf(names: string[]): string[] { return [...new Set(names.map((n) => BACKUP_FILE.exec(n.split('/').pop()!)?.[1]).filter((x): x is string => !!x))] }

export interface PruneResult { kept: number; deleted: string[]; failed: { what: string; why: string }[] }

/** Local: remove the files of every backup the policy does not keep. Deletes only `bk-*` pairs in the backup folder. */
export function pruneLocal(backupDir: string, policy: RetentionPolicy, remove: (path: string) => void): PruneResult {
  const names = existsSync(backupDir) ? readdirSync(backupDir).filter((n) => BACKUP_FILE.test(n)) : []
  const items = idsOf(names).map((id) => ({ id, atMs: backupTime(id) }))
  const drop = selectDelete(items, policy)
  const r: PruneResult = { kept: items.length - drop.length, deleted: [], failed: [] }
  for (const id of drop) for (const ext of ['manifest.json', 'qedbak']) {
    const p = join(backupDir, `${id}.${ext}`)
    if (!existsSync(p)) continue
    try { remove(p); r.deleted.push(p) } catch (e) { r.failed.push({ what: p, why: e instanceof Error ? e.message : String(e) }) }
  }
  return r
}

/** Remote: the same rule over `<prefix>backups/`. The manifest goes first, so a half-deleted backup never looks complete. */
export async function pruneRemote(store: ObjectStore, prefix: string, policy: RetentionPolicy): Promise<PruneResult> {
  const objects = await store.list(`${prefix}backups/`)
  const items = idsOf(objects.map((o) => o.key)).map((id) => ({ id, atMs: backupTime(id) }))
  const drop = selectDelete(items, policy)
  const r: PruneResult = { kept: items.length - drop.length, deleted: [], failed: [] }
  for (const id of drop) for (const ext of ['manifest.json', 'qedbak']) {
    const key = `${prefix}backups/${id}.${ext}`
    if (!objects.some((o) => o.key === key)) continue
    try { await store.delete(key); r.deleted.push(key) } catch (e) { r.failed.push({ what: key, why: e instanceof Error ? e.message : String(e) }) }
  }
  return r
}

/** The newest backup id in the store, with the two keys to fetch. */
export async function newestRemote(store: ObjectStore, prefix: string): Promise<{ id: string; manifest: string; sealed: string } | null> {
  const objects = await store.list(`${prefix}backups/`)
  const have = (k: string): boolean => objects.some((o) => o.key === k)
  const ids = idsOf(objects.map((o) => o.key)).filter((id) => have(`${prefix}backups/${id}.manifest.json`) && have(`${prefix}backups/${id}.qedbak`)).sort((a, b) => (backupTime(b) ?? 0) - (backupTime(a) ?? 0) || b.localeCompare(a))
  const id = ids[0]
  return id ? { id, manifest: `${prefix}backups/${id}.manifest.json`, sealed: `${prefix}backups/${id}.qedbak` } : null
}

export { policyFromEnv, retentionOn }
