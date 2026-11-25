/**
 * Measure how long a price takes to travel through QED's own code (audit GL6, R7-039), with the wall clock.
 *
 *   node scripts/measure-quote-latency.ts [output.json] [rounds]
 *
 * Three legs are timed, in milliseconds, over many rounds, on this QED installation, in one process, with no network:
 *   receipt  a provider frame in its wire format is parsed and stored (what happens when a price arrives);
 *   display  the market view a screen reads is built (the server's part of showing it);
 *   decision a payment-sized buy order is previewed, approved, sent to the paper venue and filled.
 * The frames are made up in each provider's own format, with the source's stamp set a known 300 ms behind. That is a
 * constructed lag, not a measurement of any real provider: the delay of a real feed from its source to QED is NOT
 * VERIFIED (it needs the network, which this workspace does not use). The browser's own paint time is not measured.
 */
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { quoteLatency, summary } from '../shared/latency.ts'
import { confirmApproval } from '../server/approvals.ts'
import { stepAllActions } from '../server/execute.ts'
import { parseCoindcxTicker } from '../server/market.ts'
import { previewAction, submitApprovedAction } from '../server/owner.ts'
import { makeKit } from '../server/testkit.ts'
import { marketView } from '../server/views.ts'

const out = process.argv[2] ?? 'evidence/20261124-quote-latency.json'
const rounds = Number(process.argv[3] ?? 200)
const k = makeKit({ profile: { line: 0 } })
const receipt: number[] = [], display: number[] = [], decision: number[] = []
let sourceToReceipt: number | null = null
for (let i = 0; i < rounds; i++) {
  const recvTs = k.clock.now()
  const frame = JSON.stringify([{ market: 'BTCINR', bid: String(6_500_000 + i), ask: String(6_501_000 + i), last_price: String(6_500_500 + i), timestamp: Math.floor((recvTs - 300) / 1000) }])
  let t0 = performance.now()
  for (const t of parseCoindcxTicker(frame, new Set(['BTCINR']), recvTs)) k.market.update(t)
  k.market.flush()
  receipt.push(performance.now() - t0)
  t0 = performance.now()
  const view = marketView(k.db, k.market, recvTs + 5) as { instruments: { id: string; quotes: Record<string, { sourceTs: number | null; recvTs: number }> }[] }
  display.push(performance.now() - t0)
  sourceToReceipt = quoteLatency(view.instruments.find((x) => x.id === 'coindcx:BTCINR')!.quotes.bid!).sourceToReceiptMs
  k.clock.advance(1000)
}
const decisions = Math.min(rounds, 40)
for (let i = 0; i < decisions; i++) {
  k.btc(6_600_000)
  const t0 = performance.now()
  const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 100_000 })
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  submitApprovedAction(k.ctx, k.userId, pv.approvalId)
  for (let r = 0; r < 3; r++) { await stepAllActions(k.ctx); await k.venues.crypto.tick(); k.clock.advance(1000) }
  decision.push(performance.now() - t0)
  k.clock.advance(1000)
}
const filled = k.db.get<{ n: number }>("SELECT COUNT(*) n FROM actions WHERE kind = 'order' AND state = 'done'")!.n
const r2 = (x: { n: number; min: number; median: number; p95: number; max: number } | null) => x && { n: x.n, min: +x.min.toFixed(3), median: +x.median.toFixed(3), p95: +x.p95.toFixed(3), max: +x.max.toFixed(3) }
const report = {
  measuredAt: new Date().toISOString(), node: process.version, rounds, decisions, decisionsFilled: filled, unit: 'ms',
  scope: 'QED\'s own code, one process, in memory, no network, constructed frames in the CoinDCX ticker format; wall clock (performance.now)',
  constructedSourceLagMs: 300, sourceToReceiptReadBackMs: sourceToReceipt, sourceToReceiptNote: 'the source stamps whole seconds, so the lag read back is within a second of the 300 ms put in',
  receipt: r2(summary(receipt)), display: r2(summary(display)), decision: r2(summary(decision)),
  notVerified: ['the delay of any real provider feed from its source to QED (needs the network)', 'the browser\'s time to paint a price', 'clock offset between the source and this computer'],
}
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
