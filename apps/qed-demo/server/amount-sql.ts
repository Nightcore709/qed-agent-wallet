/**
 * SQL functions for amounts (ADR-0012; stage S3 of the global money model). Registered on every connection the server
 * opens (server/core.ts Db, and the read-only connection server/backup.ts verifies a restored copy with).
 *
 * amount_sum(x) is the exact sum of amounts. SQLite's SUM fails past 2^63 - 1 ("integer overflow"), and over integer text
 * that does not fit 64 bits it silently returns a float (docs/research/qed-systems-architect/checks/20261123-sqlite-amount-probe.ts),
 * so no SQL in the server sums an amount with it (the scan in server/amount-sql.test.ts).
 *
 * - Inputs: an INTEGER, or canonical integer text (shared/amount-text.ts); NULL is skipped, as SUM skips it.
 * - Result: canonical integer text, "0" for no rows (SUM gives NULL). Read it with fromAmountText, never compare it with
 *   a number in SQL: the text "0" is not equal to the integer 0 there. Compare with the text '0' or in JavaScript.
 * - Anything else (a REAL, a BLOB, text that is not canonical) is not added: the result becomes a refusal,
 *   "amount_sum refused …", which fromAmountText rejects with that reason. The function never throws inside SQLite: on
 *   Node 22.23.3 an error thrown in an aggregate's callback is swallowed and the statement returns no row at all (on
 *   26.12.0 it throws with an empty message), so a throw could turn a corrupt row into a missing sum.
 * - directOnly: it cannot be used in a view, a trigger or a CHECK, so the schema never depends on it and the sqlite3 tool
 *   or any other client can still open and check the database.
 */
import type { DatabaseSync } from 'node:sqlite'

const CANONICAL = /^(?:0|-?[1-9][0-9]*)$/

function refusal(v: unknown): string {
  if (typeof v === 'number') return `amount_sum refused a REAL value (${v})`
  if (typeof v === 'string') return `amount_sum refused text that is not canonical (${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)})`
  return v instanceof Uint8Array ? 'amount_sum refused a BLOB' : `amount_sum refused a value of type ${typeof v}`
}

export function registerAmountSql(raw: DatabaseSync): void {
  if (typeof (raw as { aggregate?: unknown }).aggregate !== 'function') {
    throw new Error('This runtime cannot register amount_sum (node:sqlite has no aggregate()). Amounts are not summed with SQLite\'s SUM instead; run QED on a Node release whose node:sqlite has DatabaseSync.aggregate (22.23.3 and 26.12.0 are known to).')
  }
  raw.aggregate<bigint | string>('amount_sum', {
    start: 0n,
    useBigIntArguments: true,
    deterministic: true,
    directOnly: true,
    step: (acc, v) => {
      if (typeof acc === 'string' || v === null) return acc // refused already, or NULL
      if (typeof v === 'bigint') return acc + v
      if (typeof v === 'string' && CANONICAL.test(v)) return acc + BigInt(v)
      return refusal(v)
    },
    result: (acc) => (typeof acc === 'bigint' ? acc.toString() : acc),
  })
}
