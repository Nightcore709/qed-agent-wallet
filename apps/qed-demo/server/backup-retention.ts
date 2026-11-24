/**
 * Retention for sealed backups (docs/DEPLOY.md, "Backups"): which backups to keep. Pure: it lists nothing and deletes
 * nothing, so the same rule decides for the volume and for an off-host store.
 *
 * Grandfather-father-son in UTC: of each hour, day, ISO week (Monday start) and month, the NEWEST backup stands for it,
 * and the most recent N hours, days, weeks and months that have a backup are kept. Defaults: 0 hours, 7 days, 4 weeks,
 * 3 months. A backup kept by any one class is kept. The newest backup is always kept. A backup whose time cannot be read
 * from its id is never listed for deletion.
 */

export interface RetentionPolicy { hourly: number; daily: number; weekly: number; monthly: number }
export interface RetentionItem { id: string; atMs: number | null }

export const DEFAULT_RETENTION: RetentionPolicy = { hourly: 0, daily: 7, weekly: 4, monthly: 3 }

const ID_AT = /^bk-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/

/** The creation time in an id made by server/sealed.ts (`bk-YYYYMMDDTHHMMSSZ-xxxxxx`), else null. Only backups ("bk"). */
export function backupTime(id: string): number | null {
  const m = ID_AT.exec(id)
  if (!m) return null
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
  return Number.isFinite(t) ? t : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
function keys(atMs: number): { hour: string; day: string; week: string; month: string } {
  const d = new Date(atMs)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)))
  return {
    hour: `${day}T${pad(d.getUTCHours())}`,
    day,
    week: `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`,
    month: day.slice(0, 7),
  }
}

/** The ids to keep. Items with no readable time are all kept. */
export function selectKeep(items: RetentionItem[], policy: RetentionPolicy): Set<string> {
  const timed = items.filter((i): i is { id: string; atMs: number } => i.atMs !== null).sort((a, b) => b.atMs - a.atMs || b.id.localeCompare(a.id))
  const keep = new Set<string>(items.filter((i) => i.atMs === null).map((i) => i.id))
  if (timed.length) keep.add(timed[0]!.id)
  for (const cls of ['hour', 'day', 'week', 'month'] as const) {
    const n = policy[({ hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly' } as const)[cls]]
    const seen = new Set<string>()
    for (const it of timed) { // newest first: the first of each period stands for it
      const k = keys(it.atMs)[cls]
      if (seen.has(k)) continue
      if (seen.size >= n) break
      seen.add(k)
      keep.add(it.id)
    }
  }
  return keep
}

/** The ids to delete: every timed item not kept. */
export function selectDelete(items: RetentionItem[], policy: RetentionPolicy): string[] {
  const keep = selectKeep(items, policy)
  return items.filter((i) => i.atMs !== null && !keep.has(i.id)).map((i) => i.id)
}

/** The policy from the environment: QED_RETAIN_HOURLY, _DAILY, _WEEKLY, _MONTHLY (whole numbers 0 to 999). */
export function policyFromEnv(env: Record<string, string | undefined>): RetentionPolicy {
  const get = (name: string, fallback: number): number => {
    const v = env[name]
    if (v === undefined || v === '') return fallback
    if (!/^\d{1,3}$/.test(v)) throw new Error(`${name} must be a whole number from 0 to 999`)
    return Number(v)
  }
  const p = { hourly: get('QED_RETAIN_HOURLY', DEFAULT_RETENTION.hourly), daily: get('QED_RETAIN_DAILY', DEFAULT_RETENTION.daily), weekly: get('QED_RETAIN_WEEKLY', DEFAULT_RETENTION.weekly), monthly: get('QED_RETAIN_MONTHLY', DEFAULT_RETENTION.monthly) }
  return p
}

/** Retention is on only when QED_BACKUP_RETENTION=on; anything else but "off" or empty is refused. */
export function retentionOn(env: Record<string, string | undefined>): boolean {
  const v = (env.QED_BACKUP_RETENTION ?? 'off').trim().toLowerCase()
  if (v === 'on') return true
  if (v === 'off' || v === '') return false
  throw new Error('QED_BACKUP_RETENTION must be "on" or "off"')
}
