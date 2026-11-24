/**
 * Restore drill (R7-085): proves that an encrypted backup restores and verifies on a host that has only the backups
 * and the key-encryption key from its secret manager, and measures how long it takes. Isolated: everything happens
 * in a new scratch folder, on a fresh database built with the application's own code (server/backup-fixture.ts).
 * It never opens the review database (data/qed.db) and refuses a scratch folder inside the data folder.
 *
 *   node scripts/restore-drill.ts [--out <report.json>] [--scratch <new dir>] [--households <n>] [--entries <n>] [--keep]
 *   node scripts/restore-drill.ts --manifest <path> --keyring <path> (--key-file <path> | --key-env <NAME>) [--out <report.json>]
 *
 * The first form runs the whole scenario:
 *   host A: the database open as the running service holds it; backup 1; a later write; data key rotated; key-encryption
 *   key re-wrapped; backup 2 (under the new version, the keyring copy beside it refreshed); another later write.
 *   Host A is then deleted (data and keys). Host B: an empty folder; the key arrives in an environment variable only;
 *   a separate process restores backup 2 into the place of the live database (the explicit flag), and the application's
 *   own "npm run verify" checks it; backup 1 (a retired version) is restored too. Then the refusals: the old key, a
 *   truncated and an altered copy, a restore over the live file without the flag, a missing key. Finally every output
 *   is searched for the fixture's sensitive values.
 * The second form drills one existing backup set: restore into a private scratch folder, verify, measure, remove.
 * The report holds timings, sizes, counts and outcomes; no key and no stored value. Exit code 0 only if all passed.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { BackupError, createBackup, restoreBackup, type BackupResult, type Manifest } from '../server/backup.ts'
import { buildFixture, FIXTURE_T0, lateWrite, SENSITIVE } from '../server/backup-fixture.ts'
import { APP_ROOT, loadConfig, openDb } from '../server/core.ts'
import { EnvKekProvider, FileKekProvider, inside, KeyError, Keyring, type KekProvider } from '../server/keys.ts'

const { values: v } = parseArgs({
  options: {
    out: { type: 'string' }, scratch: { type: 'string' }, households: { type: 'string' }, entries: { type: 'string' }, keep: { type: 'boolean' },
    manifest: { type: 'string' }, keyring: { type: 'string' }, 'key-file': { type: 'string' }, 'key-env': { type: 'string' },
  },
})
const BACKUP_CLI = join(APP_ROOT, 'scripts', 'backup.ts')
const MAIN = join(APP_ROOT, 'server', 'main.ts')
const t = (): number => performance.now()
const since = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
const logs: string[] = []
const say = (s: string): void => { logs.push(s); console.log(s) }
const codeOf = (fn: () => unknown): string => { try { fn(); return 'none' } catch (e) { if (e instanceof KeyError || e instanceof BackupError) return e.code; throw e } }
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)])) : [])
const markersIn = (p: string): string[] => { const b = readFileSync(p); return SENSITIVE.filter((m) => b.includes(Buffer.from(m, 'utf8'))) }
const countRef = (db: string, ref: string): number => { const d = new DatabaseSync(db, { readOnly: true }); try { return Number((d.prepare('SELECT COUNT(*) n FROM entries WHERE ref = ?').get(ref) as { n: number }).n) } finally { d.close() } }
const environment = { node: process.version, sqlite: process.versions.sqlite, openssl: process.versions.openssl, platform: process.platform, arch: process.arch }

/** The scratch root: new, private, and never inside the configured data folder (where the review database lives). */
function scratchRoot(): string {
  const dataDir = dirname(loadConfig().dbPath)
  const root = v.scratch ? resolve(v.scratch) : mkdtempSync(join(tmpdir(), 'qed-restore-drill-'))
  if (inside(root, dataDir) || inside(root, join(APP_ROOT, 'data'))) { console.error(`restore-drill: refusing a scratch folder inside ${dataDir}; the drill never runs beside the review data.`); process.exit(2) }
  if (v.scratch) {
    if (existsSync(root) && readdirSync(root).length) { console.error(`restore-drill: ${root} is not empty; give a new folder.`); process.exit(2) }
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  chmodSync(root, 0o700)
  return root
}

function drillOne(): void {
  if (!v.manifest || !v.keyring) { console.error('restore-drill: --manifest and --keyring are required to drill one backup'); process.exit(2) }
  const provider: KekProvider = v['key-file'] ? new FileKekProvider(v['key-file'], { forbiddenFolders: [dirname(v.manifest)] }) : v['key-env'] ? new EnvKekProvider(v['key-env']) : (() => { console.error('restore-drill: --key-file or --key-env is required'); return process.exit(2) })()
  const root = scratchRoot()
  try {
    const r = restoreBackup({ manifest: v.manifest, keyring: Keyring.load(v.keyring, provider.load()), target: join(root, 'restore', 'qed.db'), live: loadConfig().dbPath, log: say })
    const report = { drill: 'one-backup', at: new Date().toISOString(), environment, manifest: r.manifest.id, snapshotAt: new Date(r.manifest.snapshotAtMs).toISOString(), verification: r.verification, timings: r.timings, ok: r.verification.ok }
    if (v.out) writeFileSync(v.out, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 })
    process.exitCode = r.verification.ok ? 0 : 1
  } finally { if (!v.keep) rmSync(root, { recursive: true, force: true }) }
}

function drillScenario(): void {
  const households = Number(v.households ?? 6), entries = Number(v.entries ?? 1500)
  const root = scratchRoot()
  const hostA = join(root, 'host-a'), hostB = join(root, 'host-b'), backups = join(root, 'backups')
  const dataA = join(hostA, 'data'), keysA = join(hostA, 'keys')
  mkdirSync(dataA, { recursive: true, mode: 0o700 })
  const liveA = join(dataA, 'qed.db')
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); say(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`) }
  try {
    say(`restore drill in ${root} (isolated; synthetic paper data; node ${environment.node}, SQLite ${environment.sqlite}, OpenSSL ${environment.openssl})`)
    // ---- host A
    let t0 = t()
    const fx = buildFixture(liveA, { households, entries, start: FIXTURE_T0 })
    const buildMs = since(t0)
    const dbBytes = statSync(liveA).size
    say(`fixture: ${households} households, ${fx.entries} entries and receipts, ${dbBytes} bytes, built in ${buildMs} ms`)
    const kek1 = FileKekProvider.generate(join(keysA, 'qed.kek'), { forbiddenFolders: [dataA, backups] })
    const ring = Keyring.create(join(keysA, 'keyring.json'), kek1.load())
    const service = openDb(liveA) // the running service's connection: the backups below run beside it
    const b1: BackupResult = createBackup({ db: liveA, outDir: backups, keyring: ring, log: say })
    lateWrite(service, 'usr_fx0', FIXTURE_T0 + 30 * 86_400_000, 'drill-after-backup-1')
    ring.rotate()
    const kek2 = FileKekProvider.generate(join(keysA, 'qed-2.kek'), { forbiddenFolders: [dataA, backups] })
    ring.rewrap(kek2.load())
    const b2: BackupResult = createBackup({ db: liveA, outDir: backups, keyring: ring, log: say })
    lateWrite(service, 'usr_fx0', FIXTURE_T0 + 31 * 86_400_000, 'drill-after-backup-2')
    service.close()
    check('backups run beside the open service', b1.manifest.key.version === 1 && b2.manifest.key.version === 2, `backup 1 under version 1, backup 2 under version 2, both taken with the service's connection open`)
    // The secret manager's copy of the current key; the old key is kept only to prove it no longer works.
    const secretManager = readFileSync(join(keysA, 'qed-2.kek'), 'utf8')
    const oldKey = readFileSync(join(keysA, 'qed.kek'), 'utf8')
    rmSync(hostA, { recursive: true, force: true })
    check('host A is gone', !existsSync(hostA), 'its database and key files are deleted before host B starts')
    // ---- host B: a separate process with only the backups and the key in its environment
    const liveB = join(hostB, 'data', 'qed.db')
    const env = { PATH: process.env.PATH ?? '', HOME: root }
    t0 = t()
    const child = spawnSync(process.execPath, [BACKUP_CLI, 'restore', '--manifest', b2.manifestPath, '--target', liveB, '--live', liveB, '--overwrite-live', '--backup-live-to', join(hostB, 'pre-restore'), '--keyring', join(backups, 'keyring.json'), '--key-env', 'QED_KEK', '--json'], { encoding: 'utf8', env: { ...env, QED_KEK: secretManager } })
    const childWallMs = since(t0)
    const restored = child.status === 0 ? (JSON.parse(child.stdout) as { verification: { ok: boolean; receipts: number; users: number; ledgerBreaks: number; chainsBroken: number; integrity: string }; timings: Record<string, number> }) : undefined
    check('host B restores the newest backup in a separate process, key from the environment only', child.status === 0 && restored?.verification.ok === true, child.status === 0 ? `verified: integrity ${restored!.verification.integrity}, ${restored!.verification.users} ledgers with ${restored!.verification.ledgerBreaks} breaks, ${restored!.verification.receipts} receipts with ${restored!.verification.chainsBroken} broken chains; ${childWallMs} ms wall` : `exit ${child.status}: ${child.stderr.split('\n')[0]}`)
    t0 = t()
    const verify = spawnSync(process.execPath, [MAIN, 'verify'], { encoding: 'utf8', env: { ...env, QED_DB: liveB } })
    const appVerifyMs = since(t0)
    const lines = verify.stdout.trim().split('\n').filter(Boolean)
    const good = lines.filter((l) => l.includes('ledger consistent') && l.includes('intact')).length
    check('the application opens the restored database and "npm run verify" passes', verify.status === 0 && good === households, `exit ${verify.status}; ${good} of ${lines.length} workspaces consistent and intact; ${appVerifyMs} ms wall`)
    const expectedReceipts = fx.receipts + 1
    check('the restore holds what was written before the backup and not after it (RPO = time since the last backup)', countRef(liveB, 'drill-after-backup-1') === 1 && countRef(liveB, 'drill-after-backup-2') === 0 && restored?.verification.receipts === expectedReceipts, `the write after backup 1 is present; the write after backup 2 (the newest) is lost, as the backup interval allows; ${restored?.verification.receipts} receipts restored, ${expectedReceipts} expected`)
    // ---- the older backup, sealed under the retired version, through the re-wrapped keyring
    const ringB = Keyring.load(join(backups, 'keyring.json'), new EnvKekProvider('QED_KEK', { QED_KEK: secretManager }).load())
    const older = restoreBackup({ manifest: b1.manifestPath, keyring: ringB, target: join(hostB, 'older', 'qed.db'), live: liveB, log: say })
    check('backup 1, under the retired version, restores after rotation and re-wrapping', older.verification.ok && countRef(join(hostB, 'older', 'qed.db'), 'drill-after-backup-1') === 0, `verified in ${older.timings.totalMs} ms; it predates both later writes`)
    // ---- refusals, each leaving nothing behind
    const t1 = join(hostB, 'refused', 'qed.db')
    check('the old key-encryption key no longer opens the keyring', codeOf(() => Keyring.load(join(backups, 'keyring.json'), new EnvKekProvider('K', { K: oldKey }).load())) === 'wrong_key', 'wrong_key')
    const tamper = (name: string, edit: (bak: string, man: string) => void): string => {
      const dir = join(root, name)
      mkdirSync(dir, { mode: 0o700 })
      const bak = join(dir, b2.manifest.file), man = join(dir, `${b2.manifest.id}.manifest.json`)
      copyFileSync(b2.backupPath, bak); copyFileSync(b2.manifestPath, man)
      edit(bak, man)
      return codeOf(() => restoreBackup({ manifest: man, keyring: ringB, target: t1 }))
    }
    const truncated = tamper('truncated', (bak) => truncateSync(bak, statSync(bak).size - 1))
    check('a truncated backup fails closed', truncated === 'backup_truncated' && !existsSync(t1), truncated)
    const altered = tamper('altered', (bak, man) => {
      const x = readFileSync(bak); x[x.length >> 1] = x[x.length >> 1]! ^ 1; writeFileSync(bak, x)
      const m = JSON.parse(readFileSync(man, 'utf8')) as Manifest
      m.ciphertext.sha256 = createHash('sha256').update(readFileSync(bak)).digest('hex')
      writeFileSync(man, JSON.stringify(m))
    })
    check('an altered backup whose manifest was re-hashed to match fails authentication', altered === 'authentication_failed' && !existsSync(t1), altered)
    const over = spawnSync(process.execPath, [BACKUP_CLI, 'restore', '--manifest', b2.manifestPath, '--target', liveB, '--live', liveB, '--keyring', join(backups, 'keyring.json'), '--key-env', 'QED_KEK'], { encoding: 'utf8', env: { ...env, QED_KEK: secretManager } })
    check('a restore over the live database without the flag is refused', over.status === 1 && over.stderr.includes('would_overwrite_live'), over.stderr.split(':')[1]?.trim() ?? `exit ${over.status}`)
    const noKey = spawnSync(process.execPath, [BACKUP_CLI, 'restore', '--manifest', b2.manifestPath, '--target', t1, '--keyring', join(backups, 'keyring.json'), '--key-env', 'QED_KEK'], { encoding: 'utf8', env })
    check('a missing key fails closed', noKey.status === 1 && noKey.stderr.includes('key_missing') && !existsSync(t1), noKey.stderr.split(':')[1]?.trim() ?? `exit ${noKey.status}`)
    // ---- no plaintext outside the restored databases
    const outputs = [...filesUnder(backups), ...filesUnder(join(hostB, 'pre-restore'))]
    const leaks = outputs.filter((f) => markersIn(f).length)
    const printed = [logs.join('\n'), child.stdout, child.stderr, verify.stdout, verify.stderr, over.stdout, over.stderr, noKey.stdout, noKey.stderr].join('\n')
    const keyPart = secretManager.trim().split(':')[2]!
    check('no sensitive value or key in the backups, manifests, keyring copy or any output', leaks.length === 0 && !SENSITIVE.some((m) => printed.includes(m)) && !printed.includes(keyPart) && !printed.includes(oldKey.trim().split(':')[2]!), `${outputs.length} files searched, ${leaks.length} with a sensitive value; output searched for ${SENSITIVE.length} values and both keys`)
    check('positive control: the restored database does hold the sensitive values', markersIn(liveB).length === SENSITIVE.length, `${markersIn(liveB).length} of ${SENSITIVE.length} found in the restored file`)
    const ok = checks.every((c) => c.ok)
    const report = {
      drill: 'restore', at: new Date().toISOString(), environment, scratch: v.keep ? root : '(removed)',
      fixture: { households, entries: fx.entries, receipts: fx.receipts, databaseBytes: dbBytes, buildMs },
      backups: [b1, b2].map((b) => ({ id: b.manifest.id, keyVersion: b.manifest.key.version, plaintextBytes: b.manifest.plaintext.bytes, ciphertextBytes: b.manifest.ciphertext.bytes, timings: b.timings })),
      restore: { inProcess: restored?.timings ?? null, childProcessWallMs: childWallMs, appVerifyWallMs: appVerifyMs, recoveryTimeMs: Math.round((childWallMs + appVerifyMs) * 10) / 10, olderBackupMs: older.timings.totalMs },
      checks, ok,
    }
    if (v.out) writeFileSync(v.out, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 })
    say(`${ok ? 'DRILL PASSED' : 'DRILL FAILED'}: ${checks.filter((c) => c.ok).length} of ${checks.length} checks; measured recovery ${report.restore.recoveryTimeMs} ms (restore process ${childWallMs} ms, of which restore work ${restored?.timings.totalMs ?? '?'} ms; application verify ${appVerifyMs} ms)${v.out ? `; report ${v.out}` : ''}`)
    process.exitCode = ok ? 0 : 1
  } finally {
    if (!v.keep) rmSync(root, { recursive: true, force: true })
  }
}

if (v.manifest) drillOne()
else drillScenario()
