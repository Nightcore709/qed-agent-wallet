/**
 * Migration rehearsal and restore drill (stage S3 of the global money model: schema v5 to v6). Run it on a copy of a
 * database before the database itself is migrated. The copy is made by the operator, read-only on the live file:
 *
 *   sqlite3 -readonly <live qed.db> "VACUUM INTO '<scratch>/copy.db'"
 *   node scripts/migration-rehearsal.ts --copy <scratch>/copy.db --scratch <new dir> [--old-code <dir>] [--out <report.json>]
 *
 * In a new scratch folder it makes test keys (server/key-fixture.ts: a key-encryption key and the backup and
 * migration-copy keyrings, with HOME and QED_KEY_DIR pointing into the scratch folder, never at the owner's ~/.qed), then:
 * (1) duplicates the copy, keeping a pristine pre-migration file; (2) runs this build's "server/main.ts verify" on the
 * duplicate, which seals its copy under the migration-copy key (server/migration-copy.ts), migrates it and verifies every
 * ledger and receipt chain; (3) checks the migrated file: integrity, foreign keys, every row of the three amount tables as
 * it was in the pre-migration file (v5 columns, both ways), amount_text equal to the INTEGER, receipts unchanged, one
 * sealed copy and no plaintext one; (4) the restore drill: the sealed copy, restored into a new private folder
 * (server/backup.ts restoreBackup, which verifies it), is the v5 database, verifies read-only under this build, under the
 * previous build when --old-code names an export of its apps/qed-demo (the rollback), and migrates again to exactly the
 * same books; the pristine file also goes through an encrypted backup and restore under the test backup key. Child
 * processes get PATH, HOME, QED_KEY_DIR and QED_DB only. The report holds counts, timings and outcomes only: no user
 * handle, no stored value, no key. Exit code 0 only if every check passed.
 * It refuses a copy or a scratch folder inside a data folder, and the configured live database.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { registerAmountSql } from '../server/amount-sql.ts'
import { createBackup, listManifests, restoreBackup, verifyDatabase } from '../server/backup.ts'
import { APP_ROOT, loadConfig, SCHEMA_VERSION } from '../server/core.ts'
import { openKeyring } from '../server/key-config.ts'
import { testKeys } from '../server/key-fixture.ts'

const { values: v } = parseArgs({ options: { copy: { type: 'string' }, scratch: { type: 'string' }, 'old-code': { type: 'string' }, out: { type: 'string' } } })
if (!v.copy || !v.scratch) { console.error('Usage: node scripts/migration-rehearsal.ts --copy <VACUUM INTO copy> --scratch <new dir> [--old-code <dir>] [--out <report.json>]'); process.exit(2) }
const copy = resolve(v.copy), scratch = resolve(v.scratch)
const inData = (p: string): boolean => p.split(sep).includes('data') || p.startsWith(join(APP_ROOT, 'data') + sep)
if (inData(copy) || inData(scratch)) { console.error('Refused: the copy and the scratch folder must be outside every data folder (the live database lives there).'); process.exit(2) }
if (resolve(loadConfig().dbPath) === copy) { console.error('Refused: that is the configured live database.'); process.exit(2) }
if (!existsSync(copy)) { console.error(`No copy at ${copy}`); process.exit(2) }
if (existsSync(scratch)) { console.error(`${scratch} exists; give a new folder.`); process.exit(2) }
mkdirSync(scratch, { recursive: true, mode: 0o700 })
// Keys made for this rehearsal only, in its own folder (scratch/keys); HOME points into the scratch folder as well.
const keys = testKeys(scratch)

const MAIN = join(APP_ROOT, 'server', 'main.ts')
const TABLES = { postings: 'id', balances: 'account_id', holds: 'id' } as const
const V5: Record<keyof typeof TABLES, string> = {
  postings: 'id, entry_id, account_id, asset_id, amount, instrument_id',
  balances: 'account_id, amount',
  holds: 'id, user_id, account_id, amount, reason, ref, created_at, released_at',
}
const checks: { step: string; ok: boolean; detail: unknown }[] = []
const check = (step: string, ok: boolean, detail: unknown = null): boolean => { checks.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail === null ? '' : `  ${JSON.stringify(detail)}`}`); return ok }
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const place = (name: string): string => { const d = join(scratch, name); mkdirSync(d, { recursive: true, mode: 0o700 }); return join(d, 'qed.db') }
const ms = (t: number): number => Math.round(performance.now() - t)

/** What a migration could change, on a read-only connection. */
function facts(path: string): Record<string, unknown> {
  const d = new DatabaseSync(path, { readOnly: true })
  try {
    registerAmountSql(d)
    const one = (sql: string): unknown => Object.values(d.prepare(sql).get() as Record<string, unknown>)[0]
    const receipts = (d.prepare('SELECT id, hash FROM receipts ORDER BY user_id, seq').all() as { id: string; hash: string }[]).map((r) => `${r.id}:${r.hash}`).join('\n')
    const hasText = !!d.prepare(`SELECT 1 x FROM pragma_table_info('postings') WHERE name = 'amount_text'`).get()
    return {
      schemaVersion: one(`SELECT value FROM meta WHERE key = 'schema_version'`),
      integrity: (d.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check).join('; '),
      foreignKeyIssues: d.prepare('PRAGMA foreign_key_check').all().length,
      users: one('SELECT COUNT(*) FROM users'), accounts: one('SELECT COUNT(*) FROM accounts'), entries: one('SELECT COUNT(*) FROM entries'),
      postings: one('SELECT COUNT(*) FROM postings'), balances: one('SELECT COUNT(*) FROM balances'), holds: one('SELECT COUNT(*) FROM holds'),
      openHolds: one('SELECT COUNT(*) FROM holds WHERE released_at IS NULL'), receipts: one('SELECT COUNT(*) FROM receipts'),
      receiptsFingerprint: createHash('sha256').update(receipts).digest('hex'),
      postingsSumByAsset: one(`SELECT COUNT(*) FROM (SELECT asset_id FROM postings GROUP BY asset_id HAVING amount_sum(${hasText ? 'amount_text' : 'amount'}) != '0')`),
      amountTextDisagrees: hasText ? Object.fromEntries(Object.keys(TABLES).map((t) => [t, one(`SELECT COUNT(*) FROM ${t} WHERE amount_text IS NOT CAST(amount AS TEXT)`)])) : null,
      amountsPast64Bits: hasText ? Object.fromEntries(Object.keys(TABLES).map((t) => [t, one(`SELECT COUNT(*) FROM ${t} WHERE amount IS NULL`)])) : null,
    }
  } finally { d.close() }
}

/** Rows of a's three tables that b lacks and the other way round, on the given columns (NULLs compared as equal by EXCEPT). */
function differ(a: string, b: string, columns: (t: keyof typeof TABLES) => string): Record<string, number> {
  const d = new DatabaseSync(a, { readOnly: true })
  try {
    d.exec(`ATTACH DATABASE 'file:${b.replace(/'/g, "''")}?mode=ro' AS other`)
    return Object.fromEntries(Object.keys(TABLES).map((t) => {
      const c = columns(t as keyof typeof TABLES)
      const n = (d.prepare(`SELECT (SELECT COUNT(*) FROM (SELECT ${c} FROM main.${t} EXCEPT SELECT ${c} FROM other.${t})) + (SELECT COUNT(*) FROM (SELECT ${c} FROM other.${t} EXCEPT SELECT ${c} FROM main.${t})) n`).get() as { n: number }).n
      return [t, n]
    }))
  } finally { d.close() }
}

/** "server/main.ts verify" of a build, on a file; the output without handles: one verdict per ledger and chain. */
function runVerify(mainTs: string, db: string): { exit: number | null; ms: number; ledgers: number; consistent: number; receipts: number; chainsIntact: number; lines: string[] } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', ...keys.env, QED_DB: db }
  const t = performance.now()
  const r = spawnSync(process.execPath, [mainTs, 'verify'], { env, encoding: 'utf8', cwd: dirname(dirname(mainTs)) })
  const out = r.stdout.split('\n').filter((l) => /: ledger /.test(l))
  const lines = out.map((l) => l.replace(/^.*?: ledger/, 'ledger'))
  if (r.status !== 0) console.error(r.stderr.slice(0, 2000))
  return {
    exit: r.status, ms: ms(t), ledgers: out.length, consistent: out.filter((l) => /ledger consistent;/.test(l)).length,
    receipts: out.reduce((n, l) => n + Number(/receipts (\d+) intact/.exec(l)?.[1] ?? 0), 0), chainsIntact: out.filter((l) => /receipts \d+ intact/.test(l)).length, lines,
  }
}

const report: Record<string, unknown> = { build: { schemaVersion: SCHEMA_VERSION, node: process.version }, copySha256: sha256(copy) }
// (1) the duplicates
const work = place('migrate'), pristine = place('pre-migration')
copyFileSync(copy, work); copyFileSync(copy, pristine)
const before = facts(work)
report.before = before
check('the copy is at schema v5, intact, with no foreign key issue', before.schemaVersion === '5' && before.integrity === 'ok' && before.foreignKeyIssues === 0, { schemaVersion: before.schemaVersion, integrity: before.integrity, foreignKeyIssues: before.foreignKeyIssues })
check('the duplicates are byte for byte the copy', sha256(work) === report.copySha256 && sha256(pristine) === report.copySha256)

// (2) migrate and verify with this build
const migrate = runVerify(MAIN, work)
report.migrateAndVerify = migrate
check('this build migrates the copy and verifies every ledger and receipt chain', migrate.exit === 0 && migrate.ledgers === before.users && migrate.consistent === migrate.ledgers && migrate.chainsIntact === migrate.ledgers, { exit: migrate.exit, ms: migrate.ms, ledgers: migrate.ledgers, consistent: migrate.consistent, receipts: migrate.receipts })

// (3) the migrated file
const after = facts(work)
report.after = after
check(`the migrated file is at schema v${SCHEMA_VERSION}, intact, with no foreign key issue`, after.schemaVersion === SCHEMA_VERSION && after.integrity === 'ok' && after.foreignKeyIssues === 0, { schemaVersion: after.schemaVersion, integrity: after.integrity })
const counts = ['users', 'accounts', 'entries', 'postings', 'balances', 'holds', 'openHolds', 'receipts'] as const
check('every count is unchanged', counts.every((c) => after[c] === before[c]), Object.fromEntries(counts.map((c) => [c, after[c]])))
check('receipts are unchanged, hash for hash', after.receiptsFingerprint === before.receiptsFingerprint)
const v5Diff = differ(work, pristine, (t) => V5[t])
check('every v5 column of every row of postings, balances and holds is as it was (compared both ways)', Object.values(v5Diff).every((n) => n === 0), v5Diff)
check('amount_text equals the INTEGER in every row of the three tables', Object.values(after.amountTextDisagrees as Record<string, number>).every((n) => n === 0), after.amountTextDisagrees)
check('the books sum to zero in every asset (amount_sum over the text)', after.postingsSumByAsset === 0)
const copyDir = join(dirname(work), 'migration-copies')
const sealed = existsSync(copyDir) ? listManifests(copyDir) : []
const plaintextLeft = readdirSync(dirname(work)).filter((f) => f.endsWith('.bak') || f.startsWith('.qed-')).length
check('openDb sealed one copy before the change, under the migration-copy key, and left no plaintext copy', sealed.length === 1 && plaintextLeft === 0, { sealed: sealed.length, plaintextLeft })

// (4) the restore drill: the sealed copy restored into a new private folder (restoreBackup verifies it on the way)
const r1 = place('restore-file')
const t1 = performance.now()
const restoredCopy = restoreBackup({ manifest: sealed[0] ?? join(copyDir, 'missing.manifest.json'), keyring: openKeyring('migration-copy', { env: keys.env }), target: r1 })
const copyFacts = facts(r1)
report.copy = { migration: restoredCopy.manifest.migration ?? null, schemaVersion: restoredCopy.manifest.schemaVersion, restoreVerified: restoredCopy.verification.ok }
check('that copy is the v5 database: same version, counts and receipts as before', restoredCopy.manifest.migration?.from === '5' && restoredCopy.manifest.migration?.to === SCHEMA_VERSION && copyFacts.schemaVersion === '5' && counts.every((c) => copyFacts[c] === before[c]) && copyFacts.receiptsFingerprint === before.receiptsFingerprint, report.copy)
const ro = verifyDatabase(r1)
report.restoredReadOnly = { ...ro, ms: ms(t1) }
check('restored, the pre-migration copy verifies read-only under this build, still at v5', restoredCopy.verification.ok && ro.ok && ro.schemaVersion === '5' && ro.ledgerBreaks === 0 && ro.chainsBroken === 0, { ok: ro.ok, schemaVersion: ro.schemaVersion, users: ro.users, receipts: ro.receipts })
if (v['old-code']) {
  const r2 = place('restore-old-build')
  copyFileSync(r1, r2)
  const old = runVerify(join(resolve(v['old-code']), 'server', 'main.ts'), r2)
  report.restoredUnderPreviousBuild = old
  check('under the previous build (the rollback) it verifies too, and stays at v5', old.exit === 0 && old.consistent === old.ledgers && old.chainsIntact === old.ledgers && facts(r2).schemaVersion === '5', { exit: old.exit, ledgers: old.ledgers, receipts: old.receipts })
}
const r3 = place('restore-migrate-again')
copyFileSync(r1, r3)
const again = runVerify(MAIN, r3)
report.restoredMigratedAgain = again
const allCols = (t: keyof typeof TABLES): string => `${V5[t]}, amount_text`
const againDiff = differ(r3, work, allCols)
check('migrated again, it verifies and its three tables equal the first migration\'s, every column', again.exit === 0 && again.consistent === again.ledgers && Object.values(againDiff).every((n) => n === 0), againDiff)
// The encrypted path: back the pristine file up under the test backup key, restore it (restoreBackup verifies it).
const backups = join(scratch, 'backups')
const backupRing = openKeyring('backup', { env: keys.env })
const t4 = performance.now()
const b = createBackup({ db: pristine, outDir: backups, keyring: backupRing, tempParent: scratch })
const restored = restoreBackup({ manifest: b.manifestPath, keyring: backupRing, target: place('restore-encrypted') })
report.restoredEncrypted = { ...restored.verification, ms: ms(t4) }
check('backed up encrypted and restored, the pre-migration file verifies, at v5', restored.verification.ok && restored.verification.schemaVersion === '5', { users: restored.verification.users, receipts: restored.verification.receipts })
const encAgain = runVerify(MAIN, restored.target)
check('the encrypted restore then migrates and verifies under this build', encAgain.exit === 0 && encAgain.consistent === encAgain.ledgers && facts(restored.target).schemaVersion === SCHEMA_VERSION, { ledgers: encAgain.ledgers })

report.checks = checks
report.ok = checks.every((c) => c.ok)
const out = v.out ? resolve(v.out) : join(scratch, 'report.json')
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
console.log(`${report.ok ? 'ALL PASSED' : 'FAILED'}: ${checks.filter((c) => c.ok).length} of ${checks.length} checks; report ${out}`)
process.exit(report.ok ? 0 : 1)
