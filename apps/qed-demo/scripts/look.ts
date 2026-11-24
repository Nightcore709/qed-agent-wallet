/**
 * Look at the interface as the design fixture's account sees it (DESIGN.md M9): screenshots of one route on a Vite dev
 * server that proxies to a design fixture. The fixture's session cookie is read from QED_FIXTURE_FILE at run time and
 * never printed.
 *
 *   QED_FIXTURE_FILE=data/design-fixture.json node scripts/look.ts <web base> <route> <out.png> [width] [height] [dark|light] [full] [frames]
 *
 * `full` (1) takes the whole page with reduced motion, so every block that waits for scrolling is shown; `frames`
 * ("0,120,300,700") takes the viewport at those milliseconds after the page opens, to read how it arrives.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const [base = 'http://127.0.0.1:6500', route = '/', out = 'look.png', w = '1440', h = '900', scheme = 'dark', full = '0', frames = ''] = process.argv.slice(2)
const file = process.env.QED_FIXTURE_FILE ?? 'data/design-fixture.json'
const fx = JSON.parse(readFileSync(file, 'utf8')) as { cookie: string }
const eq = fx.cookie.indexOf('=')
const host = new URL(base).hostname
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, colorScheme: scheme === 'light' ? 'light' : 'dark', deviceScaleFactor: 1, reducedMotion: full === '1' ? 'reduce' : 'no-preference' })
await ctx.addCookies([{ name: fx.cookie.slice(0, eq), value: fx.cookie.slice(eq + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
const page = await ctx.newPage()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`))
const t0 = Date.now()
await page.goto(base + route, { waitUntil: 'domcontentloaded' })
if (frames) {
  for (const ms of frames.split(',').map(Number)) {
    const wait = ms - (Date.now() - t0)
    if (wait > 0) await page.waitForTimeout(wait)
    await page.screenshot({ path: out.replace(/\.png$/, `-${ms}.png`) })
  }
} else {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1600)
  await page.screenshot({ path: out, fullPage: full === '1' })
}
if (errors.length) console.log(`console errors: ${errors.slice(0, 8).join(' | ')}`)
await browser.close()
