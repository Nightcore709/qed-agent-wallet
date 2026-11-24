/**
 * One phone-profile load of a route (as scripts/usable.ts: 390x844, CPU 4x, 150 ms, 1.6 Mb/s), printed as a timeline:
 * every request's start, first byte and end (Resource Timing, same clock as the stamps), long tasks, long animation
 * frames with their scripts, and the frames on which the head and the key figure first show.
 *   node timeline.ts <fixture.json> <route> <figure-selector> [runs]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
const [fxFile, route, figSel, runsArg, outFile] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(fxFile!, 'utf8')) as { base: string; cookie: string }
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const all: unknown[] = []
for (let run = 0; run < Number(runsArg ?? 1); run++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await ctx.addCookies([{ name, value, url: fx.base }])
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 })
  await page.addInitScript((sel) => {
    const w = window as unknown as Record<string, unknown>
    const t = { head: null as number | null, figure: null as number | null, prOpen: null as number | null }
    const lt: [number, number][] = [], loaf: unknown[] = []
    w.__t = t; w.__lt = lt; w.__loaf = loaf
    // when the live stream's first hello arrives (startLive bumps 'reconnect' on it)
    const ES = window.EventSource
    window.EventSource = class extends ES { constructor(u: string | URL, o?: EventSourceInit) { super(u, o); const opened = performance.now(); (w as Record<string, unknown>).__esOpen = opened; this.addEventListener('hello', () => { if (!(w as Record<string, unknown>).__hello) (w as Record<string, unknown>).__hello = performance.now() }) } } as typeof EventSource
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: 'longtask', buffered: true })
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { blockingDuration: number; renderStart: number; styleAndLayoutStart: number; scripts: { sourceURL: string; sourceFunctionName: string; invoker: string; duration: number; forcedStyleAndLayoutDuration: number }[] })[]) {
          loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), render: Math.round(e.startTime + e.duration - (e.renderStart || e.startTime + e.duration)), styleLayout: Math.round(e.startTime + e.duration - (e.styleAndLayoutStart || e.startTime + e.duration)), scripts: e.scripts.map((s) => `${(s.sourceURL.split('/').pop() ?? '')}:${s.sourceFunctionName || s.invoker} ${Math.round(s.duration)}ms`).slice(0, 4) })
        }
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch { /* no LoAF */ }
    const shown = (el: Element | null) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && getComputedStyle(el).visibility !== 'hidden' }
    const tick = () => {
      const now = performance.now()
      if (t.head === null) { const h = document.querySelector('main h1, #content h1'); if (shown(h)) t.head = now }
      if (t.prOpen === null && document.querySelector('.page-wait')) t.prOpen = now
      if (t.figure === null) { const f = Array.from(document.querySelectorAll(sel)).find((el) => shown(el) && !el.closest('[aria-busy="true"], .skel, .loading-line') && /\d/.test(el.textContent ?? '') && /₹|\$/.test(el.textContent ?? '')); if (f) t.figure = now }
      if (t.head === null || t.figure === null) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, figSel!)
  await page.goto(fx.base + route!, { waitUntil: 'commit' })
  await page.waitForFunction(() => { const t = (window as unknown as { __t: { head: number | null; figure: number | null } }).__t; return t && t.head !== null && t.figure !== null }, null, { timeout: 60_000, polling: 50 }).catch(() => {})
  await page.waitForTimeout(2500)
  const r = await page.evaluate(() => {
    const w = window as unknown as { __t: Record<string, number | null>; __lt: [number, number][]; __loaf: unknown[] }
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    const res = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((e) => ({ name: e.name.replace(location.origin, ''), start: Math.round(e.startTime), reqStart: Math.round(e.requestStart), ttfb: Math.round(e.responseStart), end: Math.round(e.responseEnd), xfer: e.transferSize, enc: e.encodedBodySize, dec: e.decodedBodySize, initiator: e.initiatorType }))
    return { hello: Math.round((w as unknown as { __hello?: number }).__hello ?? -1), esOpen: Math.round((w as unknown as { __esOpen?: number }).__esOpen ?? -1), t: w.__t, lt: w.__lt, loaf: w.__loaf, nav: { ttfb: Math.round(nav.responseStart), end: Math.round(nav.responseEnd), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) }, res }
  })
  all.push(r)
  const firsts = (n: string) => r.res.filter((e) => e.name === n).map((e) => `${e.start}-${e.end}`).join(', ')
  console.log(`\n--- summary: session ${firsts('/api/session')} | stream opened ${r.esOpen}, hello ${r.hello} | /api/liquidity ${firsts('/api/liquidity')} | /api/payees ${firsts('/api/payees')} | /api/engine ${firsts('/api/engine')}`)
  console.log(`=== run ${run + 1}: head ${Math.round(r.t.head ?? -1)}  figure ${Math.round(r.t.figure ?? -1)}  (nav ttfb ${r.nav.ttfb}, html end ${r.nav.end}, DCL ${r.nav.dcl})`)
  if (process.env.QUIET !== '1') for (const e of r.res.sort((a, b) => a.start - b.start)) console.log(`${String(e.start).padStart(5)} → ${String(e.end).padStart(5)}  (req ${String(e.reqStart).padStart(5)}, ttfb ${String(e.ttfb).padStart(5)})  ${String(e.xfer).padStart(6)} B  ${e.name}`)
  console.log("long tasks:", r.lt.filter(([s]) => s < (r.t.figure ?? 1e9) + Number(process.env.AFTER ?? 500)).map(([s, d]) => `${s}+${d}`).join('  '))
  for (const f of r.loaf as { start: number; dur: number; render: number; styleLayout: number; scripts: string[] }[]) if (f.start < (r.t.figure ?? 1e9) + Number(process.env.AFTER ?? 500)) console.log(`LoAF ${f.start}+${f.dur} (style+layout ${f.styleLayout}) ${f.scripts.join(' | ')}`)
  await ctx.close()
}
await browser.close()
if (outFile) writeFileSync(outFile, JSON.stringify(all, null, 1))
