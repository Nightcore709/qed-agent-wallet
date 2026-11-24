/**
 * N-018: the dispute pack shows the deadline that applies to the person's jurisdiction, with the arithmetic tested:
 * US two business days after learning of a loss and 60 days after the statement; India three working days for a
 * transaction before 1 Jan 2027 and five calendar days for one from that date. Rules from the bank-agent terms research
 * (docs/research/qed-fin-infra-compliance/20261123-bank-agent-terms.md, section 4.5, B23, B24, B60, B62; accessed 23 Nov 2026).
 */
import { describe, expect, it } from 'vitest'
import { deadlinesFor, escalationFor } from './dispute-deadlines.ts'

const at = (iso: string) => Date.parse(`${iso}Z`)
const by = (id: string, list: ReturnType<typeof deadlinesFor>) => list.find((d) => d.id === id)

describe('US (Regulation E)', () => {
  it('two business days after learning: a Thursday report is due the Monday, a Friday one the Tuesday, skipping the weekend', () => {
    // 26 Nov 2026 is a Thursday, 27 Nov a Friday
    expect(by('customer-report', deadlinesFor('US', { learnedAt: at('2026-11-26T15:00:00'), transactionAt: at('2026-11-25T15:00:00') }))!.dueDate).toBe('2026-11-30')
    expect(by('customer-report', deadlinesFor('US', { learnedAt: at('2026-11-27T15:00:00'), transactionAt: at('2026-11-25T15:00:00') }))!.dueDate).toBe('2026-12-01')
  })
  it('60 days after the statement the error first appears on, when the person gives its date; otherwise the rule without a date', () => {
    const ds = deadlinesFor('US', { learnedAt: at('2026-11-26T15:00:00'), transactionAt: at('2026-11-25T15:00:00'), statementDate: '2026-11-30' })
    expect(by('statement-error', ds)!.dueDate).toBe('2027-01-29')
    const none = by('statement-error', deadlinesFor('US', { learnedAt: at('2026-11-26T15:00:00'), transactionAt: at('2026-11-25T15:00:00') }))!
    expect(none.dueDate).toBeNull()
    expect(none.text).toContain('60 days')
  })
  it('the bank\'s own time is shown as its rule, counted from the day it is told, and says the bank decides', () => {
    const ds = deadlinesFor('US', { learnedAt: at('2026-11-26T15:00:00'), transactionAt: at('2026-11-25T15:00:00') })
    expect(by('institution-investigate', ds)).toMatchObject({ dueDate: '2026-12-10', party: 'institution' })
    expect(by('institution-investigate', ds)!.text).toContain('decides')
  })
})

describe('India (RBI)', () => {
  it('before 1 Jan 2027: three working days, counted on India\'s business days', () => {
    // 24 Nov 2026 is a Tuesday: three working days later is Friday 27 Nov
    expect(by('customer-report', deadlinesFor('IN', { learnedAt: at('2026-11-24T09:00:00'), transactionAt: at('2026-11-24T08:00:00') }))).toMatchObject({ dueDate: '2026-11-27', rule: 'three working days' })
    // learned on a Friday: Monday, Tuesday, Wednesday
    expect(by('customer-report', deadlinesFor('IN', { learnedAt: at('2026-11-27T09:00:00'), transactionAt: at('2026-11-26T08:00:00') }))!.dueDate).toBe('2026-12-02')
  })
  it('a transaction from 1 Jan 2027: five calendar days, weekends included', () => {
    const ds = deadlinesFor('IN', { learnedAt: at('2027-01-08T09:00:00'), transactionAt: at('2027-01-07T08:00:00') })
    expect(by('customer-report', ds)).toMatchObject({ dueDate: '2027-01-13', rule: 'five calendar days' })
  })
  it('the rule is chosen by the transaction\'s date, not by when the person learned: a 31 Dec 2026 payment keeps the old rule', () => {
    const ds = deadlinesFor('IN', { learnedAt: at('2027-01-04T09:00:00'), transactionAt: at('2026-12-31T08:00:00') })
    expect(by('customer-report', ds)!.rule).toBe('three working days')
    expect(by('customer-report', ds)!.dueDate).toBe('2027-01-07')
  })
  it('the bank\'s time: shadow credit in 10 working days and 90 days before 2027; 45 days from it', () => {
    const before = deadlinesFor('IN', { learnedAt: at('2026-11-24T09:00:00'), transactionAt: at('2026-11-24T08:00:00') })
    expect(by('institution-credit', before)!.text).toContain('10 working days')
    expect(by('institution-resolve', before)).toMatchObject({ dueDate: '2027-02-22' })
    const after = deadlinesFor('IN', { learnedAt: at('2027-01-08T09:00:00'), transactionAt: at('2027-01-07T08:00:00') })
    expect(by('institution-resolve', after)).toMatchObject({ dueDate: '2027-02-22' })
    expect(by('institution-resolve', after)!.text).toContain('45 days')
  })
})

describe('escalation and other places', () => {
  it('names the escalation route for each jurisdiction and never promises an outcome', () => {
    expect(escalationFor('US').text).toContain('CFPB')
    expect(escalationFor('IN').text).toContain('Ombudsman')
    for (const j of ['US', 'IN', 'GB']) expect(escalationFor(j).text).not.toMatch(/will refund|guarantee/i)
  })
  it('a jurisdiction with no rule written gives no deadline and says so, rather than guessing', () => {
    const ds = deadlinesFor('GB', { learnedAt: at('2026-11-24T09:00:00'), transactionAt: at('2026-11-24T08:00:00') })
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({ dueDate: null })
    expect(ds[0]!.text).toContain('NOT VERIFIED')
  })
})
