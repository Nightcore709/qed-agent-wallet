/** Read a saved trace: per 100 ms bucket after navigation start, the style recalculations on the renderer main thread
 * (count, total ms, elements recalculated) and the animations Chrome names as running.   node trace2.ts <trace.json> */
import { readFileSync } from 'node:fs'
const ev = (JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { traceEvents: { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; id?: string; id2?: unknown; cat: string; args?: Record<string, any> }[] }).traceEvents
const nav = ev.find((e) => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame && e.args?.data?.documentLoaderURL?.includes('/protect'))!
const t0 = nav.ts
const main = ev.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && e.pid === nav.pid)!
const style = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.name === 'UpdateLayoutTree' && e.ph === 'X')
const buckets = new Map<number, { n: number; ms: number; el: number }>()
for (const s of style) { const b = Math.floor((s.ts - t0) / 100_000); const x = buckets.get(b) ?? { n: 0, ms: 0, el: 0 }; x.n++; x.ms += s.dur! / 1000; x.el += Number(s.args?.elementCount ?? 0); buckets.set(b, x) }
for (const [b, x] of [...buckets].sort((a, b) => a[0] - b[0])) if (b >= 18 && b <= 45) console.log(`${String(b * 100).padStart(5)} ms: ${String(x.n).padStart(2)} recalcs, ${x.ms.toFixed(1).padStart(5)} ms, ${x.el} elements`)
const anim = ev.filter((e) => e.name === 'Animation' && e.ph === 'b')
const names = new Map<string, { first: number; n: number }>()
for (const a of anim) { const k = String(a.args?.data?.name ?? a.args?.data?.id ?? '?'); const x = names.get(k) ?? { first: (a.ts - t0) / 1000, n: 0 }; x.n++; names.set(k, x) }
console.log('animations begun (name: first start ms, count):', [...names].map(([k, x]) => `${k}: ${x.first.toFixed(0)} (${x.n})`).join('; ') || 'none recorded')
const ends = ev.filter((e) => e.name === 'Animation' && e.ph === 'e').map((e) => (e.ts - t0) / 1000)
console.log('animation ends (ms):', ends.slice(0, 30).map((x) => x.toFixed(0)).join(', '))
