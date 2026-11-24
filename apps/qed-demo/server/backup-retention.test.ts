import { describe, expect, it } from 'vitest'
import { backupTime, DEFAULT_RETENTION, policyFromEnv, retentionOn, selectDelete, selectKeep, type RetentionItem } from './backup-retention.ts'

const id = (iso: string): string => `bk-${iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-abcdef`
const item = (iso: string): RetentionItem => ({ id: id(iso), atMs: backupTime(id(iso)) })
/** Hourly backups from `from` for `hours` hours. */
function hourly(from: string, hours: number): RetentionItem[] {
  const t0 = Date.parse(from)
  return Array.from({ length: hours }, (_, h) => item(new Date(t0 + h * 3_600_000).toISOString()))
}

describe('backup retention (7 daily, 4 weekly, 3 monthly)', () => {
  it('reads the time from an id and nothing else', () => {
    expect(backupTime('bk-20261124T140520Z-511fb7')).toBe(Date.UTC(2026, 10, 24, 14, 5, 20))
    expect(backupTime('mc-20261124T140520Z-511fb7')).toBeNull() // a migration copy is never a backup
    expect(backupTime('bk-20261124-511fb7')).toBeNull()
  })
  it('keeps the newest of each of the last 7 days, 4 weeks and 3 months, and drops the rest', () => {
    const items = hourly('2026-06-01T00:00:00Z', 24 * 180) // 180 days, hourly, to 27 Nov 2026 23:00
    const keep = selectKeep(items, DEFAULT_RETENTION)
    const kept = items.filter((i) => keep.has(i.id)).map((i) => new Date(i.atMs!).toISOString())
    // days: the last 7 UTC days, each at its last hour
    for (let d = 21; d <= 27; d++) expect(kept).toContain(`2026-11-${d}T23:00:00.000Z`)
    // weeks (Monday start): the weeks of 23 Nov, 16 Nov, 9 Nov, 2 Nov end Sunday 22 Nov, 15, 8 and 1 Nov, 23:00; the week of 23 Nov's newest is 28 Nov
    for (const w of ['2026-11-22', '2026-11-15', '2026-11-08']) expect(kept).toContain(`${w}T23:00:00.000Z`)
    // months: Nov (newest 27 Nov), Oct 31, Sep 30
    expect(kept).toContain('2026-10-31T23:00:00.000Z')
    expect(kept).toContain('2026-09-30T23:00:00.000Z')
    expect(kept).not.toContain('2026-08-31T23:00:00.000Z') // a fourth month back
    expect(kept.length).toBeLessThanOrEqual(7 + 4 + 3)
    expect(kept.length).toBeGreaterThanOrEqual(10)
    expect(selectDelete(items, DEFAULT_RETENTION).length + keep.size).toBe(items.length)
  })
  it('always keeps the newest backup, even with every count at 0', () => {
    const items = hourly('2026-11-01T00:00:00Z', 10)
    expect([...selectKeep(items, { hourly: 0, daily: 0, weekly: 0, monthly: 0 })]).toEqual([items.at(-1)!.id])
  })
  it('keeps a lone backup, and keeps hourly ones when asked', () => {
    const one = [item('2026-11-24T10:00:00Z')]
    expect(selectDelete(one, DEFAULT_RETENTION)).toEqual([])
    const day = hourly('2026-11-24T00:00:00Z', 12)
    expect(selectDelete(day, { ...DEFAULT_RETENTION, hourly: 5 }).length).toBe(12 - 5)
  })
  it('never lists an item with no readable time for deletion', () => {
    const items: RetentionItem[] = [{ id: 'bk-odd', atMs: null }, ...hourly('2026-11-01T00:00:00Z', 100)]
    expect(selectDelete(items, DEFAULT_RETENTION)).not.toContain('bk-odd')
  })
  it('weeks start on Monday in UTC', () => {
    // Sun 22 Nov 23:00 and Mon 23 Nov 00:00 are different weeks; with weekly=2 and no days, both stand
    const a = item('2026-11-22T23:00:00Z'), b = item('2026-11-23T00:00:00Z')
    expect(selectKeep([a, b], { hourly: 0, daily: 0, weekly: 2, monthly: 0 }).size).toBe(2)
    const c = item('2026-11-22T01:00:00Z') // same week as a
    expect(selectDelete([a, c], { hourly: 0, daily: 0, weekly: 4, monthly: 0 })).toEqual([c.id])
  })
  it('reads its settings strictly', () => {
    expect(policyFromEnv({})).toEqual({ hourly: 0, daily: 7, weekly: 4, monthly: 3 })
    expect(policyFromEnv({ QED_RETAIN_DAILY: '14' }).daily).toBe(14)
    expect(() => policyFromEnv({ QED_RETAIN_DAILY: '-1' })).toThrow(/QED_RETAIN_DAILY/)
    expect(retentionOn({})).toBe(false)
    expect(retentionOn({ QED_BACKUP_RETENTION: 'on' })).toBe(true)
    expect(() => retentionOn({ QED_BACKUP_RETENTION: 'yes' })).toThrow()
  })
})
