/**
 * R13 review fix F3: the deployed image's process isolation, checked from inside the running container (Linux only).
 *
 *   docker exec <container> node scripts/deploy/isolation-check.ts
 *
 * Prints PASS or FAIL for each check and exits non-zero if any fails (or if it cannot run them):
 *   1. the co-signer runs as another user than the wallet service, not root, with no capability and no way to gain one;
 *   2. that user cannot read the wallet service's /proc/<pid>/environ, the key folder, the key-encryption key file, the
 *      data folder, the wallet service's own folder or its token;
 *   3. no process under process 1 holds QED_KEK in its /proc/<pid>/environ: neither the name nor the key itself;
 *   4. the co-signer still signs: the wallet service's /cosigner/self-test returns a signature by the co-signer's key, made
 *      by the co-signer's own process.
 * Needs root (docker exec's default user in this image) to read every process's /proc entries; it changes nothing.
 * Processes started by `docker exec` (this one included) are not under process 1 and are not scanned: they carry
 * whatever environment the exec gives them.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Proc { pid: number; ppid: number; uid: number; gid: number; cmd: string; capEff: bigint; capPrm: bigint; capAmb: bigint; noNewPrivs: boolean; groups: string }

/** Every process under `root` (a /proc), from its status and cmdline; one that exits meanwhile is skipped. */
export function readProcs(root = '/proc'): Proc[] {
  const out: Proc[] = []
  for (const d of readdirSync(root)) {
    if (!/^\d+$/.test(d)) continue
    try {
      const st = readFileSync(join(root, d, 'status'), 'utf8')
      const field = (k: string): string => (new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(st)?.[1] ?? '').trim()
      out.push({
        pid: Number(d), ppid: Number(field('PPid')), uid: Number(field('Uid').split(/\s+/)[0]), gid: Number(field('Gid').split(/\s+/)[0]),
        cmd: readFileSync(join(root, d, 'cmdline'), 'utf8').split('\0').join(' ').trim(),
        capEff: BigInt(`0x${field('CapEff') || '0'}`), capPrm: BigInt(`0x${field('CapPrm') || '0'}`), capAmb: BigInt(`0x${field('CapAmb') || '0'}`),
        noNewPrivs: field('NoNewPrivs') === '1', groups: field('Groups'),
      })
    } catch { /* gone */ }
  }
  return out
}

/** `of` and every process below it. */
export function treeOf(procs: Proc[], of = 1): Set<number> {
  const tree = new Set<number>([of])
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true }
  }
  return tree
}

/** A process's initial environment as the kernel recorded it, or null if it cannot be read. */
export function environOf(pid: number, root = '/proc'): string[] | null {
  try { return readFileSync(join(root, String(pid), 'environ'), 'utf8').split('\0').filter(Boolean) } catch { return null }
}

/** The processes in `pids` whose environment names QED_KEK or holds one of `secrets`; and those that could not be read. */
export function kekHolders(pids: Iterable<number>, secrets: string[], root = '/proc'): { holders: number[]; unread: number[] } {
  const holders: number[] = [], unread: number[] = []
  for (const pid of pids) {
    const env = environOf(pid, root)
    if (env === null) { if (existsSync(join(root, String(pid)))) unread.push(pid); continue }
    if (env.some((v) => v.startsWith('QED_KEK=') || secrets.some((s) => s.length >= 16 && v.includes(s)))) holders.push(pid)
  }
  return { holders, unread }
}

/** The secret parts of a key-encryption key record (qedkek1:<id>:<key>:<check>): the key, and the whole record. */
export function kekSecrets(record: string | undefined): string[] {
  const r = (record ?? '').trim()
  const m = /^qedkek1:[^\s:]+:([^\s:]+):[^\s:]+$/.exec(r)
  return m ? [m[1]!, r] : []
}

interface Result { name: string; ok: boolean; detail: string }

async function main(): Promise<number> {
  const results: Result[] = []
  const check = (name: string, ok: boolean, detail: string): void => { results.push({ name, ok, detail }) }
  if (!existsSync('/proc/1/status')) { console.log('FAIL setup: no /proc here; run it inside the Linux container (docker exec)'); return 2 }
  if (process.getuid?.() !== 0) { console.log('FAIL setup: run as root (the default user of docker exec in this image), to read every process\'s /proc entries'); return 2 }
  const procs = readProcs()
  const cosigners = procs.filter((p) => p.cmd.includes('cosigner-main.ts'))
  const wallets = procs.filter((p) => p.cmd.includes('chain/serve.ts'))
  const co = cosigners[0], wallet = co ? procs.find((p) => p.pid === co.ppid) : wallets[0]
  if (!co || !wallet) {
    console.log(`FAIL setup: the wallet service (${wallets.length} found) or its co-signer (${cosigners.length} found) is not running`)
    return 2
  }
  const wenv = new Map((environOf(wallet.pid) ?? []).map((v) => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)] as [string, string] }))
  const data = wenv.get('QED_DATA_DIR') ?? '/data'
  const keyDir = wenv.get('QED_KEY_DIR') ?? join(data, 'keys')
  const keyFile = wenv.get('QED_KEY_FILE') ?? join(keyDir, 'qed.kek')
  const railData = wenv.get('QED_RAIL_DATA') ?? join(data, 'app')

  // 1. separate, unprivileged user
  check('co-signer user', co.uid !== wallet.uid && co.uid !== 0 && co.gid !== wallet.gid && co.groups === '',
    `co-signer pid ${co.pid} uid ${co.uid} gid ${co.gid} supplementary groups [${co.groups}]; wallet service pid ${wallet.pid} uid ${wallet.uid} gid ${wallet.gid}`)
  check('co-signer capabilities', co.capEff === 0n && co.capPrm === 0n && co.capAmb === 0n && co.noNewPrivs,
    `CapEff ${co.capEff.toString(16)} CapPrm ${co.capPrm.toString(16)} CapAmb ${co.capAmb.toString(16)} NoNewPrivs ${co.noNewPrivs ? 1 : 0}`)

  // 2. what the co-signer's user can read: tried as that user, in a process of its own
  const targets: [string, 'file' | 'dir'][] = [[`/proc/${wallet.pid}/environ`, 'file'], [keyDir, 'dir'], [keyFile, 'file'], [data, 'dir'], [railData, 'dir'], [join(railData, 'rail.token'), 'file']]
  const probe = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'); const out = [];
    for (const [p, k] of JSON.parse(process.argv[1])) { try { k === 'dir' ? fs.readdirSync(p) : fs.readFileSync(p); out.push([p, 'READ']) } catch (e) { out.push([p, e.code]) } }
    process.stdout.write(JSON.stringify(out))`, JSON.stringify(targets)], { uid: co.uid, gid: co.gid, encoding: 'utf8', timeout: 10_000 })
  let tried: [string, string][] = []
  try { tried = JSON.parse(probe.stdout) as [string, string][] } catch { tried = [] }
  if (tried.length !== targets.length) check('co-signer reads', false, `the probe as uid ${co.uid} did not run: ${probe.error?.message ?? probe.stderr}`)
  for (const [p, code] of tried) check(`co-signer cannot read ${p}`, code === 'EACCES' || code === 'EPERM', code === 'READ' ? 'it could read it' : `refused with ${code}${code === 'ENOENT' ? ' (missing: nothing was checked)' : ''}`)

  // 3. QED_KEK in no initial environment under process 1
  let record: string | undefined
  try { record = readFileSync(keyFile, 'utf8') } catch { record = undefined }
  const secrets = [...kekSecrets(record), ...kekSecrets(process.env.QED_KEK)]
  const tree = treeOf(procs, 1)
  const { holders, unread } = kekHolders(tree, secrets)
  check('no QED_KEK in any environment', holders.length === 0 && unread.length === 0,
    `${tree.size} processes under process 1 scanned${secrets.length ? ', for the name and the key itself' : ', for the name (the key itself was not found to compare)'}; holding it: ${holders.join(', ') || 'none'}; unreadable: ${unread.join(', ') || 'none'}`)

  // 4. the co-signer still signs, in its own process
  try {
    const token = readFileSync(join(railData, 'rail.token'), 'utf8').trim()
    const port = Number(wenv.get('QED_RAIL_PORT') ?? 5176)
    const res = await fetch(`http://127.0.0.1:${port}/cosigner/self-test`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await res.json()) as { address?: string; signature?: `0x${string}`; message?: string; isolation?: string; pid?: number }
    const { selfTestSigner } = await import('../../chain/rail/self-test.ts')
    const signer = body.signature && body.message ? await selfTestSigner(body.message, body.signature) : null
    check('co-signer signs', res.ok && signer !== null && signer.toLowerCase() === String(body.address).toLowerCase() && body.isolation === 'separate-process' && body.pid === co.pid,
      `HTTP ${res.status}; signed by ${signer ?? 'nothing'} (its key ${body.address ?? '?'}); process ${body.pid ?? '?'} (${body.isolation ?? '?'})`)
  } catch (e) {
    check('co-signer signs', false, e instanceof Error ? e.message : String(e))
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`)
  return failed ? 1 : 0
}

if (import.meta.main) process.exit(await main())
