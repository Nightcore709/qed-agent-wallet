/**
 * Lab measures of the built interface on the running design fixture (scripts/design-fixture.ts), per screen: Largest
 * Contentful Paint, Cumulative Layout Shift over a watch window while live prices and events stream, the longest
 * interaction (pointer down to next paint) when a section link is pressed, and the JavaScript and CSS transferred.
 * Lab figures on this computer, not field data from people's devices (R7-019 distinguishes the two).
 *
 *   node scripts/perf.ts [out.json] [route ...]       defaults: evidence/design/perf.json and the main screens
 *
 * Budgets checked (R7-019, Core Web Vitals "good"): LCP <= 2500 ms, CLS <= 0.1, interaction <= 200 ms.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const outFile = process.argv[2] ?? join(app, 'evidence', 'design', 'perf.json')
const routes = process.argv.length > 3 ? process.argv.slice(3) : ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/ask', '/vault']
const WATCH_MS = Number(process.env.QED_WATCH_MS ?? 15_000)
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: Record<string, { lcpMs: number | null; cls: number; shifts: { value: number; sources: string[] }[]; interactionMs: number | null; jsKB: number; cssKB: number; pass: boolean }> = {}
// QED_PROFILE=phone: a mid-range phone in the lab (390 x 844, CPU slowed 4x, a slow 4G link: 150 ms, 1.6 Mb/s down,
// 750 kb/s up). Still a lab figure, not field data.
const phone = process.env.QED_PROFILE === 'phone'
for (const r of routes) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  await ctx.addCookies([{ name, value, url: fx.base }])
  const page = await ctx.newPage()
  if (phone) {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 })
  }
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number | null; __cls: number; __shifts: { value: number; sources: string[] }[]; __inp: number | null }
    w.__lcp = null; w.__cls = 0; w.__shifts = []; w.__inp = null
    new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { element?: Element | null; size?: number })[]) { w.__lcp = e.startTime; const el = e.element; (w as unknown as { __lcpEl: string }).__lcpEl = el ? `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ').slice(0, 2).join('.')} "${(el.textContent ?? '').trim().slice(0, 40)}" (${e.size ?? 0} px²)` : '?' } }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
        if (e.hadRecentInput) continue
        w.__cls += e.value
        w.__shifts.push({ value: Math.round(e.value * 10000) / 10000, sources: (e.sources ?? []).map((s) => { const n = s.node as Element | null | undefined; if (!n) return '?'; return n.nodeType === 1 ? `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}` : n.nodeName }) })
      }
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { duration: number })[]) w.__inp = Math.max(w.__inp ?? 0, e.duration) }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
  })
  let js = 0, css = 0
  page.on('response', async (res) => {
    const t = res.headers()['content-type'] ?? ''
    const len = Number(res.headers()['content-length'] ?? 0) || (await res.body().catch(() => Buffer.alloc(0))).length
    if (t.includes('javascript')) js += len; else if (t.includes('css')) css += len
  })
  await page.goto(fx.base + r, { waitUntil: 'networkidle' })
  await page.waitForTimeout(WATCH_MS)
  // one interaction: press the dock's link to another section (a real navigation: the old page leaves, the new one
  // renders and arrives). It was the current section's own link in the top bar until Meridian (R11) moved the sections
  // to the dock; that measured a click that changed nothing.
  const link = page.locator(`.dock a[href="${r === '/activity' ? '/' : '/activity'}"]`).first()
  if (await link.count()) { await link.click(); await page.waitForTimeout(900) }
  const m = await page.evaluate(() => { const w = window as unknown as { __lcp: number | null; __cls: number; __shifts: { value: number; sources: string[] }[]; __inp: number | null }; return { lcpEl: (w as unknown as { __lcpEl?: string }).__lcpEl ?? null, lcp: w.__lcp, cls: w.__cls, shifts: w.__shifts, inp: w.__inp } })
  const pass = (m.lcp ?? 0) <= 2500 && m.cls <= 0.1 && (m.inp ?? 0) <= 200
  results[r] = { lcpMs: m.lcp === null ? null : Math.round(m.lcp), cls: Math.round(m.cls * 10000) / 10000, shifts: m.shifts.filter((s) => s.value >= 0.001).slice(0, 8), interactionMs: m.inp === null ? null : Math.round(m.inp), jsKB: Math.round(js / 1024), cssKB: Math.round(css / 1024), pass }
  if (m.lcpEl) console.log(`${r.padEnd(12)} LCP element: ${m.lcpEl}`)
  console.log(`${r.padEnd(12)} LCP ${String(results[r]!.lcpMs).padStart(5)} ms  CLS ${results[r]!.cls.toFixed(4)}  interaction ${String(results[r]!.interactionMs ?? '-').padStart(4)} ms  JS ${results[r]!.jsKB} KB  CSS ${results[r]!.cssKB} KB  ${pass ? 'within budget' : 'OVER BUDGET'}`)
  await ctx.close()
}
await browser.close()
writeFileSync(outFile, `${JSON.stringify({ measuredAt: new Date().toISOString(), base: fx.base, watchMs: WATCH_MS, note: phone ? 'Lab measures on this computer (headless Chrome, 390x844, CPU 4x slower, slow 4G); not field data.' : 'Lab measures on this computer (headless Chrome, 1440x900, no throttling); not field data.', results }, null, 1)}\n`)
console.log(`written ${outFile}`)
