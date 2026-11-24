import { reserveBasisWords } from '../lib/reserve.ts'
import { fmt } from '../lib/core.ts'
import type { Liquidity } from '../lib/types.ts'

/**
 * A statement of the reserve beside a screen's own figure: what is counted, the look-ahead and the assumptions, from the
 * server's liquidity record (R7-090). `data-reserve-basis` marks it for the browser check, which reads the days and the
 * assumptions back from the server and compares them with what is said here.
 */
export function ReserveBasis({ l }: { l: Liquidity }) {
  return (
    <p className="small muted reserve-basis" data-reserve-basis data-horizon={l.horizonDays} data-late-days={l.assumptions.lateDays} data-lost={l.assumptions.lostSalaries}>
      {reserveBasisWords(l, (p) => fmt.money(p))}
    </p>
  )
}
