/**
 * One phone-profile load of /protect traced (Chrome's devtools.timeline), then the renderer main thread's top-level
 * tasks between FROM and TO ms after navigation start, each with its biggest child events: what the main thread was
 * doing when a press would arrive.   node trace.ts <fixture.json> <from> <to>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
const [fxFile, fromArg, toArg] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(fxFile!, 'utf8')) as { base: string; cookie: string }
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
await ctx.addCookies([{ name, value, url: fx.base }])
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 })
await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'loading', 'blink.animations', 'cc'] })
await page.goto(fx.base + '/protect', { waitUntil: 'commit' })
await page.waitForTimeout(4000)
const buf = await browser.stopTracing()
await browser.close()
const ev = (JSON.parse(buf.toString()) as { traceEvents: { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: Record<string, any> }[] }).traceEvents
writeFileSync(process.env.TRACE_OUT ?? '/dev/null', buf)
// navigation start: the main frame's navigationStart mark
const nav = ev.find((e) => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame && e.args?.data?.documentLoaderURL?.includes('/protect'))
const t0 = nav!.ts
const main = ev.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && e.pid === nav!.pid)!
const on = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && typeof e.dur === 'number')
const from = Number(fromArg) * 1000 + t0, to = Number(toArg) * 1000 + t0
const tasks = on.filter((e) => (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.ts + e.dur! > from && e.ts < to && e.dur! > 2000)
let busy = 0
for (const t of tasks) {
  busy += t.dur!
  const kids = on.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur! <= t.ts + t.dur! && e.dur! > 1000 && !/RunTask/.test(e.name))
  const top = kids.sort((a, b) => b.dur! - a.dur!).slice(0, 5).map((k) => `${k.name}${k.args?.data?.url ? `(${String(k.args.data.url).split('/').pop()})` : k.args?.data?.functionName ? `(${k.args.data.functionName})` : k.args?.data?.type ? `(${k.args.data.type})` : ''} ${(k.dur! / 1000).toFixed(1)}`)
  console.log(`${((t.ts - t0) / 1000).toFixed(0).padStart(5)} +${(t.dur! / 1000).toFixed(1).padStart(5)} ms  ${top.join(' | ')}`)
}
console.log(`main thread busy ${(busy / 1000).toFixed(0)} ms of ${Number(toArg) - Number(fromArg)} ms (tasks over 2 ms)`)
