/**
 * Non-text contrast of every money bar on a page (DESIGN.md M14), measured in pixels as the browser draws it (WCAG
 * 1.4.11: a part that carries meaning needs 3:1 against what is next to it). For each bar: each part's colour (the
 * average over its middle, so a hatch counts as it is seen; a shortfall, which is hollow, by its dashes) against the
 * panel just above the bar, each part against the part beside it, and the span of what QED may move against the panel
 * under it. Exit status 1 when any part or span is under 3:1 against the panel.
 *
 *   QED_FIXTURE_FILE=data/design-fixture.json node scripts/bar-contrast.ts <web base> <route>[,<route>...] [dark|light] [width] [cssFile]
 *
 * cssFile (optional) is a stylesheet laid over the page, as the R12 palette round did; the page's own code is unchanged.
 * The fixture's session cookie is read from QED_FIXTURE_FILE at run time and never printed.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const [base = 'http://127.0.0.1:6500', routesArg = '/', scheme = 'dark', w = '1440', cssFile = ''] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? 'data/design-fixture.json', 'utf8')) as { cookie: string }
const eq = fx.cookie.indexOf('=')

interface Part { tone: string; bg: number; next: number | null }
interface Bar { where: string; parts: Part[]; reach: number | null }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: Number(w), height: 900 }, colorScheme: scheme === 'light' ? 'light' : 'dark', deviceScaleFactor: 2, reducedMotion: 'reduce' })
await ctx.addCookies([{ name: fx.cookie.slice(0, eq), value: fx.cookie.slice(eq + 1), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
if (cssFile) {
  const css = readFileSync(cssFile, 'utf8')
  await ctx.addInitScript((c: string) => { const s = document.createElement('style'); s.textContent = c; const put = (): void => { if (document.head) document.head.appendChild(s); else requestAnimationFrame(put) }; put() }, css)
}
let worst = 99
for (const route of routesArg.split(',')) {
  const page = await ctx.newPage()
  await page.goto(base + route, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1200)
  await page.addStyleTag({ content: '.topbar,.dock,.ak-foot,.bottombar{visibility:hidden!important}' })
  const n = await page.locator('.mbar-row').count()
  for (let i = 0; i < n; i++) {
    await page.locator('.mbar-row').nth(i).scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const shot = await page.screenshot()
    const bar = await page.evaluate(async ({ b64, i }): Promise<Bar> => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
      const cx = cv.getContext('2d', { willReadFrequently: true })!; cx.drawImage(img, 0, 0)
      const sx = img.width / innerWidth
      const lin = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      const lum = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      // the luminance of a box's average colour (CSS px)
      const avg = (x0: number, y0: number, x1: number, y1: number): number => {
        const d = cx.getImageData(Math.floor(x0 * sx), Math.floor(y0 * sx), Math.max(1, Math.floor((x1 - x0) * sx)), Math.max(1, Math.floor((y1 - y0) * sx))).data
        let r = 0, g = 0, b = 0; const k = d.length / 4
        for (let j = 0; j < d.length; j += 4) { r += d[j]!; g += d[j + 1]!; b += d[j + 2]! }
        return lum(r / k, g / k, b / k)
      }
      const cr = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      const row = document.querySelectorAll('.mbar-row')[i]!
      const rr = row.getBoundingClientRect()
      const where = (row.closest('section, aside, article')?.getAttribute('aria-labelledby') ?? 'bar').slice(0, 40)
      const bgAbove = avg(rr.left + 4, rr.top - 6, rr.right - 4, rr.top - 3)
      const seen = Array.from(row.querySelectorAll('.mbar-part')).map((p) => {
        const b = p.getBoundingClientRect(), pad = Math.min(b.width * 0.2, 20)
        const tone = p.className.replace('mbar-part', '').trim()
        if (tone === 'short') {
          // the dashes, not the gaps between them: the fifth of the edge's pixels that differ most from the panel
          const d = cx.getImageData(Math.floor((b.left + pad) * sx), Math.floor((b.top + 0.5) * sx), Math.max(1, Math.floor((b.width - 2 * pad) * sx)), 1).data
          const ys: number[] = []
          for (let j = 0; j < d.length; j += 4) ys.push(lum(d[j]!, d[j + 1]!, d[j + 2]!))
          ys.sort((a, c) => Math.abs(c - bgAbove) - Math.abs(a - bgAbove))
          return { tone, y: ys[Math.floor(ys.length / 5)] ?? bgAbove }
        }
        return { tone, y: b.width > 8 ? avg(b.left + pad, b.top + 3, b.right - pad, b.bottom - 3) : avg(b.left + 1, b.top + 3, b.right - 1, b.bottom - 3) }
      })
      const parts = seen.map((p, k) => ({ tone: p.tone, bg: +cr(p.y, bgAbove).toFixed(2), next: k < seen.length - 1 ? +cr(p.y, seen[k + 1]!.y).toFixed(2) : null }))
      const span = row.querySelector('.mbar-reach')
      let reach: number | null = null
      if (span) { const b = span.getBoundingClientRect(); reach = +cr(avg(b.left + 3, b.bottom - 2.5, b.right - 3, b.bottom - 0.5), avg(b.left + 3, b.bottom + 3, b.right - 3, b.bottom + 6)).toFixed(2) }
      return { where, parts, reach }
    }, { b64: shot.toString('base64'), i })
    console.log(`${route} #${i} ${bar.where}: ${bar.parts.map((p) => `${p.tone} ${p.bg}${p.next !== null ? ` | ${p.next}` : ''}`).join('   ')}${bar.reach !== null ? `   reach ${bar.reach}` : ''}`)
    for (const p of bar.parts) worst = Math.min(worst, p.bg)
    if (bar.reach !== null) worst = Math.min(worst, bar.reach)
  }
  await page.close()
}
console.log(`worst part or span against the panel: ${worst.toFixed(2)} (${scheme} ${w})`)
await browser.close()
process.exitCode = worst < 3 ? 1 : 0
