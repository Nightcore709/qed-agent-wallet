/**
 * What a statement of the reserve ("what must stay in the bank") says it counts (R7-090; audit SV3). Every place that
 * states the figure also states, in these words and from the server's own liquidity record: what is counted, how far
 * ahead QED looks, and the late-income and lost-salary assumptions. Nothing here is worked out; each number is read.
 */
import type { Liquidity } from './types.ts'

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`

/** The sentence under a reserve figure. `money` formats minor units in the home currency (fmt.money). */
export function reserveBasisWords(l: Pick<Liquidity, 'horizonDays' | 'assumptions' | 'notCounted'>, money: (paise: number) => string): string {
  const a = l.assumptions
  const counted = `Counted: the bills and loan instalments on record${a.spending > 0 ? `, everyday spending of ${money(a.spending)} a month` : ''}, less income certain to arrive, over the next ${days(l.horizonDays)}.`
  const salary = a.income > 0
    ? ` Allowed for: a salary up to ${days(a.lateDays)} late, and ${a.lostSalaries === 0 ? 'no salary lost' : `${a.lostSalaries} salar${a.lostSalaries === 1 ? 'y' : 'ies'} lost`}${a.allowanceLeft < a.lostSalaries ? ` (${a.allowanceLeft} of the allowance left)` : ''}.`
    : ' No salary is recorded, so none is counted on.'
  return `${counted}${salary}`
}
