/**
 * The plaintext copies made before 24 Nov 2026 (R11 section 11; docs/ENCRYPTION.md section 7): find them, seal them into
 * an encrypted archive under the backup key (each entry checked byte for byte; the originals are left where they are),
 * check an archive, extract an entry, re-encrypt one after a key rotation, and only with an explicit flag and the
 * archive's id typed back, remove the originals. Removing them is the owner's decision: until it is made, archive and
 * verify only. Nothing here prints a key or a file's contents.
 *
 *   npm run plaintext:scan [-- --dir <folder>...] [--json]
 *   npm run plaintext:archive -- [--file <path>]... [--dir <folder>]... [--assume-closed <database>]... [--out <dir>] [--json]
 *       with no --file or --dir: the recorded copies beside the database (qed.db.….bak, and any -wal or -shm of theirs).
 *       A database with a -wal, -shm or -journal beside it (a .bak too) is refused (it may be open) unless named with --assume-closed: only for a
 *       leftover you know no process has open; it is then archived with those files, byte for byte.
 *   node scripts/plaintext-copies.ts verify    --archive <folder or archive.json> [--json]
 *   node scripts/plaintext-copies.ts extract   --archive <...> --entry <n> --target <new path>
 *   node scripts/plaintext-copies.ts reencrypt --archive <...> [--out <dir>]
 *   node scripts/plaintext-copies.ts remove    --archive <...> --remove-plaintext --confirm <archive id>
 *
 * Keys and folders as for scripts/backup.ts (server/key-config.ts): the backup keyring of the key folder; archives go
 * into <backup folder>/archives unless --out is given; the database is QED_DB (default data/qed.db).
 * Exit codes: 0 done; 1 refused or failed (the code and the message say why); 2 usage.
 */
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../server/core.ts'
import { keyPaths, migrationCopyDir, openKeyring } from '../server/key-config.ts'
import { KeyError, type Keyring } from '../server/keys.ts'
import { ArchiveError, archivePlaintext, extractEntry, listArchives, readArchive, reencryptArchive, removeOriginals, scanPlaintext, verifyArchive } from '../server/plaintext-archive.ts'
import { BackupError, sha256File } from '../server/sealed.ts'

// SIGINT, SIGTERM and SIGHUP wait for the step under way (all synchronous) to finish, so an extraction is never cut off
// with part of a plaintext file on disk (independent review of cb85271, finding 1).
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => {})

const USAGE = 'Usage: node scripts/plaintext-copies.ts <scan | archive | verify | extract | reencrypt | remove> [options] (see the comment at the top of this file)'
const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string', multiple: true }, dir: { type: 'string', multiple: true }, out: { type: 'string' }, archive: { type: 'string' }, 'assume-closed': { type: 'string', multiple: true },
    entry: { type: 'string' }, target: { type: 'string' }, 'remove-plaintext': { type: 'boolean' }, confirm: { type: 'string' }, json: { type: 'boolean' },
  },
})
const cmd = positionals[0]
const usage = (why: string): never => { console.error(`plaintext-copies: ${why}\n${USAGE}`); process.exit(2) }
const need = (name: 'archive' | 'entry' | 'target'): string => { const x = v[name]; if (typeof x !== 'string' || x === '') usage(`--${name} is required for "${cmd}"`); return x as string }
const say = (line: string): void => { if (!v.json) console.log(line) }
const print = (human: string, json: unknown): void => { console.log(v.json ? JSON.stringify(json, null, 1) : human) }

const cfg = loadConfig()
const paths = keyPaths()
const archivesDir = v.out ?? join(paths.backupDir, 'archives')
const keyring = (): Keyring => openKeyring('backup', { forbidden: [dirname(cfg.dbPath), paths.backupDir, migrationCopyDir(cfg.dbPath), archivesDir] })

function scan(): void {
  const dirs = v.dir?.length ? v.dir : [dirname(cfg.dbPath)]
  const found = dirs.flatMap((d) => scanPlaintext(d, { live: [cfg.dbPath] }))
  // Which copies an archive records, by SHA-256 (`verify` checks that the archive really gives them back).
  const recorded = new Map<string, string>()
  for (const a of listArchives(join(paths.backupDir, 'archives'))) {
    try { const { m } = readArchive(a); for (const e of m.entries) if (!recorded.has(e.sha256)) recorded.set(e.sha256, `${m.id} (entry ${e.index})`) } catch { /* an unreadable record is reported by verify */ }
  }
  const rows = found.map((f) => ({ ...f, archivedIn: f.kind === 'plaintext-copy' || f.kind === 'in-use' ? recorded.get(sha256File(f.path).sha256) ?? null : null }))
  const copies = rows.filter((r) => r.kind === 'plaintext-copy')
  const named = copies.filter((r) => r.recorded)
  const label = { 'plaintext-copy': 'plaintext copy', live: 'live database', 'in-use': 'in use (open?)', temporary: 'TEMPORARY plaintext left by an interrupted operation: remove it' } as const
  const lines = rows.map((r) => `${label[r.kind]}: ${r.path} (${r.bytes} bytes${r.sqlite ? ', SQLite' : ''}${r.recorded ? ', a recorded migration or reset copy' : ''})${r.kind === 'plaintext-copy' || r.kind === 'in-use' ? (r.archivedIn ? `, archived in ${r.archivedIn}` : ', not archived') : ''}`)
  const open = rows.filter((r) => r.kind === 'in-use')
  lines.push(`${named.length} plaintext copies of a QED database named as migration or reset copies (what \`npm run plaintext:archive\` takes by default); ${copies.length - named.length} other plaintext database files; ${copies.filter((r) => r.archivedIn).length} of the ${copies.length} plaintext copies are recorded in an archive; ${open.length} files of databases with a -wal or -shm beside them (open, or leftovers: --assume-closed), ${open.filter((r) => r.archivedIn).length} of them archived. Removing them is the owner's decision (docs/ENCRYPTION.md, section 7).`)
  print(lines.join('\n'), { findings: rows })
}

try {
  if (cmd === 'scan') scan()
  else if (cmd === 'archive') {
    const given = [...(v.file ?? []), ...(v.dir ?? [])]
    const inputs = given.length ? given : scanPlaintext(dirname(cfg.dbPath), { live: [cfg.dbPath] }).filter((f) => f.recorded).map((f) => f.path)
    const r = archivePlaintext({ inputs, outDir: archivesDir, keyring: keyring(), live: [cfg.dbPath], assumeClosed: v['assume-closed'] ?? [], log: say })
    print(`Archive ${r.manifest.id} in ${r.dir}: ${r.manifest.entries.length} entries sealed under data key ${r.manifest.key.kid} (version ${r.manifest.key.version}), each checked byte for byte against its original. The originals are left where they are${r.manifest.skipped.length ? `; skipped: ${r.manifest.skipped.map((s) => `${s.path} (${s.why})`).join(', ')}` : ''}.\nCheck it again at any time: node scripts/plaintext-copies.ts verify --archive ${r.dir}\nRemoving the originals is the owner's decision (docs/ENCRYPTION.md, section 7); once made: node scripts/plaintext-copies.ts remove --archive ${r.dir} --remove-plaintext --confirm ${r.manifest.id}`, r)
  } else if (cmd === 'verify') {
    const r = verifyArchive({ manifest: need('archive'), keyring: keyring() })
    const ok = r.entries.filter((e) => e.sealed === 'ok').length
    print([`${r.record === 'ok' ? 'OK' : 'FAIL'} record of archive ${r.id}: ${r.record === 'ok' ? 'archive.json is the record sealed beside it' : r.record}`, ...r.entries.map((e) => `${e.sealed === 'ok' ? 'OK' : 'FAIL'} entry ${e.index} ${e.name}: ${e.bytes} bytes; sealed copy ${e.sealed}; original ${e.original}`), `${ok} of ${r.entries.length} entries decrypt to their recorded contents (archive ${r.id})`].join('\n'), r)
    if (!r.ok) process.exitCode = 1
  } else if (cmd === 'extract') {
    const index = Number(need('entry'))
    if (!Number.isSafeInteger(index)) usage('--entry must be a whole number')
    const r = extractEntry({ manifest: need('archive'), keyring: keyring(), index, target: need('target'), log: say })
    print(`Entry ${index} extracted to ${r.target} (mode 600): ${r.bytes} bytes, matching its record.`, r)
  } else if (cmd === 'reencrypt') {
    const { dir } = readArchive(need('archive'))
    const r = reencryptArchive({ manifest: need('archive'), keyring: keyring(), outDir: v.out ?? dirname(dir), log: say })
    print(`Archive ${r.manifest.reencryptedFrom} re-encrypted as ${r.manifest.id} in ${r.dir} under data key version ${r.manifest.key.version}.`, r)
  } else if (cmd === 'remove') {
    if (v['remove-plaintext'] !== true) usage('removing the originals needs --remove-plaintext and --confirm <archive id>; it is the owner\'s decision (docs/ENCRYPTION.md, section 7)')
    const r = removeOriginals({ manifest: need('archive'), keyring: keyring(), confirm: v.confirm ?? '', live: [cfg.dbPath] })
    print(`Removed ${r.removed.length} originals of archive ${r.archive}, each checked byte for byte against it first${r.alreadyGone.length ? `; ${r.alreadyGone.length} were already gone` : ''}${r.foldersRemoved.length ? `; emptied folders removed: ${r.foldersRemoved.join(', ')}` : ''}. Record: ${r.recordPath}. On an SSD their blocks are not overwritten: FileVault protects them, and local snapshots may still hold them.`, r)
  } else usage(cmd ? `unknown command "${cmd}"` : 'no command')
} catch (e) {
  if (e instanceof ArchiveError || e instanceof KeyError || e instanceof BackupError) {
    const hint = e.code === 'key_missing' || e.code === 'keyring_missing' ? ' If keys were never set up here, run `npm run keys:init` first (docs/ENCRYPTION.md, section 4).' : ''
    console.error(`plaintext-copies: ${e.code}: ${e.message}${hint}`)
    process.exit(1)
  }
  throw e
}
