/**
 * Off-host copies and retention of the sealed backups (server/offsite.ts; docs/DEPLOY.md, "Backups"). Both are OFF by
 * default; the supervisor runs `push` and `prune` after each scheduled backup, and `drill` on its drill schedule.
 *
 *   node scripts/backup-offsite.ts check    validate the settings (no network, no secret printed); exit 1 on a fault
 *   node scripts/backup-offsite.ts push     copy the sealed files the store lacks (QED_OFFSITE=on)
 *   node scripts/backup-offsite.ts prune    keep 7 daily, 4 weekly and 3 monthly backups, on the volume and, when on, in the
 *                                           store (QED_BACKUP_RETENTION=on; QED_RETAIN_DAILY/_WEEKLY/_MONTHLY/_HOURLY)
 *                                           QED_OFFSITE_PRUNE=off leaves the store to the provider's own lifecycle or object-lock rules
 *   node scripts/backup-offsite.ts list     what the store holds
 *   node scripts/backup-offsite.ts drill    fetch the newest backup from the store into a scratch folder and run the restore
 *                                           drill on it (proves the off-host copy opens with this volume's key); removes the copy
 *   node scripts/backup-offsite.ts fetch <backup id> <folder>   download one backup and its keyring beside it (a lost volume)
 *
 * Exit codes: 0 done (or off: said so); 1 refused or failed; 2 usage. Nothing here prints a key or a secret.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyPaths } from '../server/key-config.ts'
import { newestRemote, offsiteConfig, policyFromEnv, pruneLocal, pruneRemote, push, retentionOn, S3Store } from '../server/offsite.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const cmd = process.argv[2]
const out = (o: Record<string, unknown>): void => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'offsite', ...o }))
const fail = (event: string, o: Record<string, unknown> = {}): never => { out({ level: 'error', event, ...o }); process.exit(1) }

function settings() {
  try {
    const cfg = offsiteConfig(process.env)
    const retention = retentionOn(process.env)
    const policy = policyFromEnv(process.env)
    if (retention && policy.hourly + policy.daily + policy.weekly + policy.monthly === 0) throw new Error('QED_BACKUP_RETENTION=on with every QED_RETAIN_* at 0 would keep only the newest backup; set at least one above 0')
    return { cfg, retention, policy }
  } catch (e) { return fail('configuration refused', { reason: e instanceof Error ? e.message : String(e) }) }
}

async function main(): Promise<void> {
  const { cfg, retention, policy } = settings()
  const paths = keyPaths()
  const folders = { backupDir: paths.backupDir, keyring: paths.keyring.backup }
  const store = cfg ? new S3Store(cfg) : null
  switch (cmd) {
    case 'check':
      out({ level: 'info', event: 'settings ok', offsite: cfg ? { endpointHost: cfg.endpoint.host, bucket: cfg.bucket, prefix: cfg.prefix, region: cfg.region, pathStyle: cfg.pathStyle } : 'off', retention: retention ? policy : 'off' })
      return
    case 'push': {
      if (!cfg || !store) { out({ level: 'info', event: 'off-host copy is off (QED_OFFSITE)' }); return }
      const r = await push(store, folders, cfg.prefix)
      out({ level: r.failed.length ? 'error' : 'info', event: r.failed.length ? 'off-host copy incomplete' : 'off-host copy done', uploaded: r.uploaded.length, already: r.already, skipped: r.skipped, failed: r.failed })
      if (r.failed.length) process.exit(1)
      return
    }
    case 'prune': {
      if (!retention) { out({ level: 'info', event: 'retention is off (QED_BACKUP_RETENTION)' }); return }
      const l = pruneLocal(folders.backupDir, policy, (p) => unlinkSync(p))
      out({ level: l.failed.length ? 'error' : 'info', event: 'pruned the volume', policy, kept: l.kept, deleted: l.deleted.length, failed: l.failed })
      let bad = l.failed.length > 0
      if (process.env.QED_OFFSITE_PRUNE === 'off') out({ level: 'info', event: 'the off-host store is not pruned here (QED_OFFSITE_PRUNE=off); the provider\'s lifecycle rule keeps its own retention' })
      else if (store && cfg) { // the store is pruned only after this volume's newest backups were pushed (the supervisor runs push first)
        const r = await pruneRemote(store, cfg.prefix, policy)
        out({ level: r.failed.length ? 'error' : 'info', event: 'pruned the off-host store', policy, kept: r.kept, deleted: r.deleted.length, failed: r.failed })
        bad ||= r.failed.length > 0
      }
      if (bad) process.exit(1)
      return
    }
    case 'list': {
      if (!store || !cfg) return fail('off-host copy is off (QED_OFFSITE)')
      for (const o of await store.list(cfg.prefix)) console.log(`${o.size}\t${o.key}`)
      return
    }
    case 'drill': {
      if (!store || !cfg) { out({ level: 'info', event: 'off-host copy is off; no off-host drill' }); return }
      const n = await newestRemote(store, cfg.prefix)
      if (!n) return fail('the off-host store holds no backup to drill')
      const dir = mkdtempSync(join(tmpdir(), 'qed-offsite-drill-'))
      try {
        const manifest = join(dir, `${n.id}.manifest.json`)
        writeFileSync(manifest, await store.get(n.manifest), { mode: 0o600 })
        writeFileSync(join(dir, `${n.id}.qedbak`), await store.get(n.sealed), { mode: 0o600 })
        const r = spawnSync(process.execPath, [join(APP, 'scripts', 'backup.ts'), 'drill', '--manifest', manifest], { encoding: 'utf8', env: process.env })
        const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' | ')
        out({ level: r.status === 0 ? 'info' : 'error', event: r.status === 0 ? 'off-host restore drill passed' : 'off-host restore drill FAILED', backup: n.id, exit: r.status, tail })
        if (r.status !== 0) process.exit(1)
      } finally { rmSync(dir, { recursive: true, force: true }) }
      return
    }
    case 'fetch': {
      const id = process.argv[3], folder = process.argv[4]
      if (!cfg || !store) return fail('off-host copy is off (QED_OFFSITE)')
      if (!id || !folder || !/^bk-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id)) { console.error('usage: backup-offsite.ts fetch <backup id> <folder>'); process.exit(2) }
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      for (const ext of ['manifest.json', 'qedbak']) writeFileSync(join(folder, `${id}.${ext}`), await store.get(`${cfg.prefix}backups/${id}.${ext}`), { mode: 0o600 })
      writeFileSync(join(folder, 'backup.keyring.json'), await store.get(`${cfg.prefix}keys/backup.keyring.json`), { mode: 0o600 })
      out({ level: 'info', event: 'fetched', backup: id, folder })
      return
    }
    default:
      console.error('usage: backup-offsite.ts check | push | prune | list | drill | fetch <backup id> <folder>')
      process.exit(2)
  }
}
main().catch((e) => fail('failed', { reason: e instanceof Error ? e.message : String(e) }))
