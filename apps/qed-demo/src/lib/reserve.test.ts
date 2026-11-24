import { describe, expect, it } from 'vitest'
import { backdatedWords } from '../screens/Passbook.tsx'
import { reserveBasisWords } from './reserve.ts'

const inr = (p: number): string => `₹${p / 100}`
const base = { horizonDays: 150, notCounted: [], assumptions: { lateDays: 5, lostSalaries: 1, spending: 3_000_000, income: 8_000_000, incomeDay: 1, firstCounted: null, late: null, lostSoFar: 0, allowanceLeft: 1 } }

describe('what a statement of the reserve says it counts (R7-090)', () => {
  it('names what is counted, the look-ahead in days and the late-income and lost-salary assumptions, from the record', () => {
    expect(reserveBasisWords(base, inr)).toBe('Counted: the bills and loan instalments on record, everyday spending of ₹30000 a month, less income certain to arrive, over the next 150 days. Allowed for: a salary up to 5 days late, and 1 salary lost.')
  })
  it('says when the allowance is used up, when no salary is recorded, and in the singular', () => {
    expect(reserveBasisWords({ ...base, assumptions: { ...base.assumptions, lostSalaries: 2, allowanceLeft: 0 } }, inr)).toContain('2 salaries lost (0 of the allowance left)')
    expect(reserveBasisWords({ ...base, assumptions: { ...base.assumptions, income: 0, spending: 0 } }, inr)).toBe('Counted: the bills and loan instalments on record, less income certain to arrive, over the next 150 days. No salary is recorded, so none is counted on.')
    expect(reserveBasisWords({ ...base, horizonDays: 1, assumptions: { ...base.assumptions, lateDays: 1, lostSalaries: 0 } }, inr)).toContain('over the next 1 day. Allowed for: a salary up to 1 day late, and no salary lost.')
  })
})

describe('the statement says when lines were stamped out of order (QA hand-back)', () => {
  it('says nothing for none, and says that they stay where entered', () => {
    expect(backdatedWords(0)).toBe('')
    expect(backdatedWords(1)).toMatch(/^1 line here is stamped earlier than a line entered before it\. It stays where entered/)
    expect(backdatedWords(3)).toMatch(/^3 lines here are stamped earlier than a line entered before them\. They stay where entered/)
  })
})
