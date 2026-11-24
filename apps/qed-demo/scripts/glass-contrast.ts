/**
 * Contrast of text over what is really behind it (DESIGN.md M9). Glass shows the atmosphere through it, and a computed-
 * colour check (e2e/support/contrast.ts) cannot see gradients, images or blur. This one measures pixels:
 *
 *  1. open the route as the design fixture's account (cookie read from QED_FIXTURE_FILE at run time, never printed),
 *     with reduced motion so every block is in place;
 *  2. walk the page a window at a time; in each window, record every visible text run (each line box of each text
 *     node; a line outside a box that clips its overflow, such as a line clamp, is not on show), its colour and size;
 *  3. make all text transparent, photograph the window, and read the background pixels under each run;
 *     (an SVG label keeps its halo, a stroke painted under its glyphs, since that is what sits behind them);
 *  4. composite the text colour over each background pixel and keep the worst ratio (WCAG 2.x luminance). Text needs
 *     4.5:1, or 3:1 at 24 px and above, or 18.66 px bold and above.
 *
 * The bar, the dock and Ask's docked composer are measured in the first window with the page under them, then hidden
 * while the page beneath them is measured (text they cover is not on show at that scroll position).
 *
 *   QED_FIXTURE_FILE=data/design-fixture.json node scripts/glass-contrast.ts <web base> <route>[,<route>...] [dark|light] [width] [height] [out.json]
 *
 * QED_CONTRAST_OPEN=".gr-why > summary|.gr-lots > summary" opens those disclosures on every route before measuring.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const [base = 'http://127.0.0.1:6500', routesArg = '/', scheme = 'dark', w = '1440', h = '900', out = ''] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? 'data/design-fixture.json', 'utf8')) as { cookie: string }
const eq = fx.cookie.indexOf('=')

interface Run { id: number; text: string; where: string; x: number; y: number; w: number; h: number; rgba: [number, number, number, number]; size: number; weight: number }
interface Result { route: string; text: string; where: string; ratio: number; threshold: number; size: number }

const HIDE_TEXT = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}::placeholder{color:transparent!important}svg text{fill:transparent!important}'

async function runs(page: Page, chrome: boolean): Promise<Run[]> {
  return page.evaluate(({ chrome }) => {
    const out: Run[] = []
    const vw = innerWidth, vh = innerHeight
    const inChrome = (el: Element) => !!el.closest('.topbar, .dock, .ak-foot')
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n: Node | null, id = 0
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (m) { const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1] }
      const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d')!; x.fillStyle = c; x.fillRect(0, 0, 1, 1)
      const d = x.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    while ((n = walker.nextNode())) {
      id++
      const t = (n.textContent ?? '').trim()
      if (!t) continue
      const el = n.parentElement
      if (!el || el.closest('.atmos, [aria-hidden="true"] svg, script, style, noscript, .sr, .sr-only')) continue
      // not on show: inside a closed disclosure (its summary excepted), or clipped away as visually-hidden text
      if (el.closest('details:not([open])') && !el.closest('summary')) continue
      let clipped = false; for (let a: Element | null = el; a; a = a.parentElement) { const cp = getComputedStyle(a).clipPath; if (cp && cp.includes('inset(50%')) { clipped = true; break } }
      if (clipped) continue
      if (chrome !== inChrome(el)) continue
      const cs = getComputedStyle(el)
      if (cs.visibility !== 'visible') continue
      let op = 1; for (let a: Element | null = el; a; a = a.parentElement) op *= Number(getComputedStyle(a).opacity)
      if (op < 0.05) continue
      const range = document.createRange(); range.selectNodeContents(n)
      const isSvg = el instanceof SVGElement
      const color = parse(isSvg ? cs.fill : cs.color)
      color[3] *= op
      // boxes that clip their overflow (a line clamp, a scroller): a line outside one is not on show
      const clips: DOMRect[] = []
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a); if (o.overflowX !== 'visible' || o.overflowY !== 'visible') clips.push(a.getBoundingClientRect()) }
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 2 || r.height < 4) continue
        if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) continue
        const cy = r.top + r.height / 2
        if (clips.some((c) => cy < c.top || cy > c.bottom || r.right <= c.left || r.left >= c.right)) continue
        const tag = el.tagName.toLowerCase(), cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        out.push({ id, text: t.slice(0, 60), where: `${tag}${cls ? `.${cls}` : ''}`, x: r.left, y: r.top, w: r.width, h: r.height, rgba: color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 })
      }
    }
    return out
  }, { chrome }) as Promise<Run[]>
}

/** Worst contrast of each run's colour over the pixels under it (the page decodes its own screenshot on a canvas). */
async function measure(page: Page, shot: Buffer, list: Run[]): Promise<number[]> {
  const b64 = shot.toString('base64')
  return page.evaluate(async ({ b64, list }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
    const cx = cv.getContext('2d', { willReadFrequently: true })!; cx.drawImage(img, 0, 0)
    const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
    const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const sx = img.width / innerWidth, sy = img.height / innerHeight
    return list.map((r) => {
      let worst = 99
      const cols = Math.max(3, Math.min(14, Math.round(r.w / 12))), rows = 3
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const px = Math.floor((r.x + (r.w * (i + 0.5)) / cols) * sx), py = Math.floor((r.y + (r.h * (j + 0.5)) / rows) * sy)
        const d = cx.getImageData(Math.min(px, img.width - 1), Math.min(py, img.height - 1), 1, 1).data
        const [fr, fg, fb, fa] = r.rgba
        const tr = fr * fa + d[0]! * (1 - fa), tg = fg * fa + d[1]! * (1 - fa), tb = fb * fa + d[2]! * (1 - fa)
        const L1 = lum(tr, tg, tb), L2 = lum(d[0]!, d[1]!, d[2]!)
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
        if (ratio < worst) worst = ratio
      }
      return worst
    })
  }, { b64, list })
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const all: Result[] = []
let checked = 0
for (const route of routesArg.split(',')) {
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, colorScheme: scheme === 'light' ? 'light' : 'dark', reducedMotion: 'reduce' })
  await ctx.addCookies([{ name: fx.cookie.slice(0, eq), value: fx.cookie.slice(eq + 1), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await ctx.newPage()
  await page.goto(base + route, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1500)
  // Measuring the signed-out page in place of the route is a false pass (R12: a base of 127.0.0.1 was redirected to
  // localhost, where the cookie was not sent, and the sign-in page was measured with 0 failures). Refuse instead.
  const where = new URL(page.url())
  const session = await page.evaluate(async () => { try { return (await (await fetch('/api/session', { credentials: 'same-origin' })).json()) as { authenticated?: boolean } } catch { return null } })
  if (where.pathname !== new URL(base + route).pathname) console.error(`glass-contrast: note: ${route} is drawn at ${where.pathname} (an in-app redirect); measured there.`)
  if (where.host !== new URL(base).host || session?.authenticated !== true) {
    console.error(`glass-contrast: ${route} did not open as the fixture's account (landed on ${where.host}${where.pathname}, ${session?.authenticated ? 'signed in' : 'signed out'}); nothing was measured. Use the fixture's own base (its file's "base"), not another host name for it.`)
    process.exit(2)
  }
  // QED_CONTRAST_OPEN: disclosures to open before measuring, selectors separated by "|" (text in a closed disclosure
  // is not on show and is skipped above); e.g. ".gr-why > summary" measures each holding's "Why it changed" open.
  const open = (process.env.QED_CONTRAST_OPEN ?? '').split('|').map((x) => x.trim()).filter(Boolean)
  for (const sel of open) for (const el of await page.locator(sel).all()) await el.click().catch(() => {})
  if (open.length) await page.waitForTimeout(300)
  const seen = new Set<string>()
  const pass = async (chrome: boolean) => {
    const list = (await runs(page, chrome)).filter((r) => { const k = `${r.id}:${Math.round(r.y + scrollY0)}`; if (seen.has(k)) return false; seen.add(k); return true })
    if (!list.length) return
    const hide = await page.addStyleTag({ content: HIDE_TEXT })
    await page.waitForTimeout(60)
    const shot = await page.screenshot()
    await hide.evaluate((n) => (n as Element).remove())
    const ratios = await measure(page, shot, list)
    list.forEach((r, i) => {
      checked++
      const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700)
      const threshold = large ? 3 : 4.5
      if (ratios[i]! < threshold) all.push({ route, text: r.text, where: r.where, ratio: Math.round(ratios[i]! * 100) / 100, threshold, size: r.size })
    })
  }
  let scrollY0 = 0
  await pass(true) // the bar and the dock, over the page as it first appears
  const chromeOff = await page.addStyleTag({ content: '.topbar,.dock,.ak-foot{visibility:hidden!important}' })
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const step = Number(h) - 120
  for (let y = 0; y < height; y += step) {
    await page.evaluate((y) => window.scrollTo(0, y), y)
    await page.waitForTimeout(120)
    scrollY0 = await page.evaluate(() => scrollY)
    await pass(false)
  }
  await chromeOff.evaluate((n) => (n as Element).remove())
  await ctx.close()
}
await browser.close()
const worst = all.sort((a, b) => a.ratio - b.ratio)
console.log(`${checked} text runs measured on ${routesArg} (${scheme}, ${w}x${h}); ${worst.length} below threshold`)
for (const f of worst.slice(0, 40)) console.log(`  ${f.ratio.toFixed(2)} < ${f.threshold}  ${f.route}  ${f.where}  "${f.text}" (${f.size}px)`)
if (out) writeFileSync(out, JSON.stringify({ routes: routesArg.split(','), scheme, width: Number(w), checked, failures: worst }, null, 2))
process.exitCode = worst.length ? 1 : 0
