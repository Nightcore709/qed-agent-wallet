/**
 * When a screen becomes useful, not only when something paints (R11, the owner: "measure when meaningful financial
 * content and primary controls become usable; report heading/skeleton paint separately from data readiness and task
 * usability"). Per screen, from the start of navigation, on the first frame each becomes true:
 *
 *  - head:    the page's heading (its h1) is on screen;
 *  - figure:  the screen's key money figure is on screen with a real value (rupee digits, not a skeleton or a
 *             "Reading…" line), e.g. Home's free-to-use figure;
 *  - control: its primary control is drawn and enabled and, when it is within the window, the topmost thing at its
 *             centre, so a press would reach it (Home's "Pay someone", Spend's amount field, Grow's "Buy or sell",
 *             Activity's search); one below the fold counts once drawn and enabled, as a person scrolls to it;
 *  - response: pressing that control once all three hold, the longest event duration of that press (pointer down to
 *             the next frame, the Event Timing API's measure behind INP).
 *
 * LCP is kept beside them for reference. Lab figures on this computer: desktop, or QED_PROFILE=phone (390 x 844, CPU
 * slowed 4x, a slow 4G link: 150 ms, 1.6 Mb/s down, 750 kb/s up). Not field data from people's devices.
 *
 *   QED_FIXTURE_FILE=data/design-fixture.json node scripts/usable.ts [out.json] [route ...]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const outFile = process.argv[2] ?? ''
const phone = process.env.QED_PROFILE === 'phone'
const RUNS = Number(process.env.QED_RUNS ?? 3)

/** What "useful" means on each screen: the figure a person came for and the control that starts the task. */
const SCREENS: Record<string, { figure: string; control: { css?: string; text?: string } }> = {
  '/': { figure: '.hm-hero', control: { text: 'Pay someone' } },
  '/pay': { figure: '.pay-from button', control: { css: '.pay-amount input' } },
  '/save': { figure: '.sv-hero', control: { text: 'Park idle cash' } },
  '/holdings': { figure: '.gr-hero', control: { text: 'Buy or sell' } },
  '/protect': { figure: '.pr-hero', control: { text: 'New instruction' } },
  '/activity': { figure: '.ac-sum .ac-lead-v, .ac-table tbody tr', control: { css: '.ac-search input' } },
}
const routes = process.argv.length > 3 ? process.argv.slice(3) : Object.keys(SCREENS)
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]

type Times = { head: number | null; figure: number | null; control: number | null; lcp: number | null; response: number | null }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: Record<string, { runs: Times[]; median: Times }> = {}
for (const r of routes) {
  const spec = SCREENS[r]
  if (!spec) throw new Error(`no screen spec for ${r}`)
  const runs: Times[] = []
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
    await ctx.addCookies([{ name, value, url: fx.base }])
    const page = await ctx.newPage()
    if (phone) {
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 })
    }
    // a frame loop from the first script: each condition is stamped on the first frame it holds
    await page.addInitScript((spec) => {
      const w = window as unknown as { __t: Record<string, number | null>; __ev: number }
      w.__t = { head: null, figure: null, control: null, lcp: null }; w.__ev = 0
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__t.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { duration: number })[]) w.__ev = Math.max(w.__ev, e.duration) }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
      const shown = (el: Element | null): el is HTMLElement => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && getComputedStyle(el).visibility !== 'hidden' }
      const drawn = (el: Element | null): el is HTMLElement => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
      const busy = (el: Element) => !!el.closest('[aria-busy="true"], .skel, .loading-line')
      const control = (): HTMLElement | null => {
        const c = spec.control
        const all = Array.from(document.querySelectorAll<HTMLElement>(c.css ?? 'main a, main button, #content a, #content button'))
        return all.find((el) => (c.text ? (el.textContent ?? '').trim() === c.text : true) && drawn(el)) ?? null
      }
      const tick = () => {
        const now = performance.now(), t = w.__t
        if (t.head === null) { const h = document.querySelector('main h1, #content h1'); if (shown(h)) t.head = now }
        if (t.figure === null) { const f = Array.from(document.querySelectorAll(spec.figure)).find((el) => shown(el) && !busy(el) && /\d/.test(el.textContent ?? '') && /₹|\$/.test(el.textContent ?? '')); if (f) t.figure = now }
        if (t.control === null) {
          const el = control()
          if (el && !busy(el) && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true') {
            const b = el.getBoundingClientRect(), cy = b.top + b.height / 2
            if (cy < 0 || cy > innerHeight) t.control = now // below the fold: drawn and enabled
            else { const top = document.elementFromPoint(b.left + b.width / 2, cy); if (top && (top === el || el.contains(top))) t.control = now }
          }
        }
        if (t.head === null || t.figure === null || t.control === null) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, spec)
    await page.goto(fx.base + r, { waitUntil: 'commit' })
    // all three stamped (or a minute gone) before the press, so a press that leaves the page cannot hide a late figure
    await page.waitForFunction(() => { const t = (window as unknown as { __t: Record<string, number | null> }).__t; return t && t.head !== null && t.figure !== null && t.control !== null }, null, { timeout: 60_000, polling: 50 }).catch(() => {})
    // then press the control: how long that press takes to show its result
    let response: number | null = null
    const box = await page.evaluate((spec) => {
      const c = spec.control
      const el = Array.from(document.querySelectorAll<HTMLElement>(c.css ?? 'main a, main button, #content a, #content button')).find((e) => (c.text ? (e.textContent ?? '').trim() === c.text : true))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }, spec)
    if (box) {
      await page.evaluate(() => { (window as unknown as { __ev: number }).__ev = 0 })
      await (phone ? page.touchscreen.tap(box.x, box.y) : page.mouse.click(box.x, box.y))
      await page.waitForTimeout(1500)
      response = await page.evaluate(() => (window as unknown as { __ev: number }).__ev || null).catch(() => null)
    }
    const t = await page.evaluate(() => (window as unknown as { __t: Record<string, number | null> }).__t).catch(() => ({ head: null, figure: null, control: null, lcp: null }))
    runs.push({ head: t.head ?? null, figure: t.figure ?? null, control: t.control ?? null, lcp: t.lcp ?? null, response })
    await ctx.close()
  }
  const med = (k: keyof Times) => { const v = runs.map((x) => x[k]).filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? Math.round(v[Math.floor(v.length / 2)]!) : null }
  results[r] = { runs, median: { head: med('head'), figure: med('figure'), control: med('control'), lcp: med('lcp'), response: med('response') } }
  const m = results[r].median
  console.log(`${r.padEnd(10)} head ${String(m.head).padStart(5)} ms   figure ${String(m.figure).padStart(5)} ms   control ${String(m.control).padStart(5)} ms   press ${String(m.response).padStart(4)} ms   (LCP ${m.lcp} ms; median of ${RUNS})`)
}
await browser.close()
if (outFile) writeFileSync(outFile, JSON.stringify({ profile: phone ? 'phone: 390 x 844, CPU 4x, 150 ms, 1.6 Mb/s down' : 'desktop: 1440 x 900, no throttling', runs: RUNS, measured: new Date().toISOString(), note: 'Lab figures on one computer under load from other work; not field data.', results }, null, 2))
