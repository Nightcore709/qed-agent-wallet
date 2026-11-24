/**
 * How long a price takes to travel (audit GL6, R7-039): from the moment its source stamped it to the moment QED received
 * it, to the moment a screen showed it, and to the moment a decision used it. Every figure is a difference of two
 * recorded times and is null when either time is not known: a source that stamps nothing has no measurable delay, and
 * none is invented. A negative difference (a source clock ahead of ours) is kept as it is and said so, never clipped.
 */
export interface QuoteTimes { sourceTs: number | null; recvTs: number }
export interface QuoteLatency {
  /** From the source's stamp to QED's receipt: network, the source's own queue, and any difference between the two clocks. */
  sourceToReceiptMs: number | null
  /** From QED's receipt to the screen showing it. */
  receiptToDisplayMs: number | null
  /** From QED's receipt to a decision that used it: the price's age when it was relied on. */
  receiptToDecisionMs: number | null
  /** The whole way, from the source's stamp to the decision. */
  sourceToDecisionMs: number | null
}
const diff = (a: number | null | undefined, b: number | null | undefined): number | null => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) ? null : a - b)

export function quoteLatency(q: QuoteTimes, at: { displayedAt?: number | null; decidedAt?: number | null } = {}): QuoteLatency {
  return {
    sourceToReceiptMs: diff(q.recvTs, q.sourceTs),
    receiptToDisplayMs: diff(at.displayedAt, q.recvTs),
    receiptToDecisionMs: diff(at.decidedAt, q.recvTs),
    sourceToDecisionMs: diff(at.decidedAt, q.sourceTs),
  }
}

/** A delay in words: "0.4 s", "230 ms", "2 min". */
export function delayWords(ms: number): string {
  const a = Math.abs(ms)
  return a < 1000 ? `${Math.round(a)} ms` : a < 60_000 ? `${(a / 1000).toFixed(a < 10_000 ? 1 : 0)} s` : `${Math.round(a / 60_000)} min`
}

/**
 * What a screen says about a live price's journey, under its age: the source's delay to QED's receipt, and the delay to
 * the screen. "the source gives no time" when the source stamps nothing; "the source's clock is ahead" when it is.
 */
export function journeyWords(q: QuoteTimes, displayedAt?: number | null): string {
  const l = quoteLatency(q, { displayedAt })
  const first = l.sourceToReceiptMs === null ? 'The source gives no time, so its delay is not known'
    : l.sourceToReceiptMs < 0 ? 'The source\'s clock is ahead of ours, so its delay cannot be told'
    : `Reached QED ${delayWords(l.sourceToReceiptMs)} after the source stamped it`
  const second = l.receiptToDisplayMs === null || l.receiptToDisplayMs < 0 ? '' : `; on screen ${delayWords(l.receiptToDisplayMs)} after QED had it`
  return `${first}${second}.`
}

/** Min, median, 95th percentile and max of a set of delays (nearest rank), or null for none. */
export function summary(xs: number[]): { n: number; min: number; median: number; p95: number; max: number } | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const at = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!
  return { n: s.length, min: s[0]!, median: at(0.5), p95: at(0.95), max: s[s.length - 1]! }
}

/** What a fill's price record says of the price's journey to the decision that used it (the record's own times). */
export function decisionWords(e: { sourceTs: number | null; receivedAt: number | null; ageMsAtExecution: number | null }): string {
  if (e.receivedAt === null) return ''
  const l = quoteLatency({ sourceTs: e.sourceTs, recvTs: e.receivedAt }, { decidedAt: e.ageMsAtExecution === null ? null : e.receivedAt + e.ageMsAtExecution })
  const a = l.sourceToReceiptMs === null ? 'source to QED: not known, the source gives no time' : l.sourceToReceiptMs < 0 ? 'source to QED: not told, the source\'s clock is ahead' : `source to QED ${delayWords(l.sourceToReceiptMs)}`
  const b = l.receiptToDecisionMs === null ? '' : `, QED to the decision ${delayWords(l.receiptToDecisionMs)}`
  const c = l.sourceToDecisionMs === null || l.sourceToDecisionMs < 0 ? '' : `, ${delayWords(l.sourceToDecisionMs)} in all`
  return ` Delays: ${a}${b}${c}.`
}
