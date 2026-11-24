/**
 * The owner's rejection of 22 Nov 2026 (D-069), kept as checks that run on the rendered interface: they fail when a
 * screen falls back into a fault the owner named. They read only text that is actually rendered (a closed
 * "Technical details" disclosure is not), at desktop and phone width. They cannot judge taste; they catch regressions.
 *
 *   node scripts/design-checks.ts [label]      (the design fixture must be running: scripts/design-fixture.ts)
 *
 * Checks, per screen:
 *   identifiers   no raw address or hash (0x… of 8+ hex digits) on a primary screen outside a disclosure
 *   chain-jargon  no block numbers, chain ids, ERC/EIP numbers or "Anvil" on a primary screen outside a disclosure
 *   token-jargon  no "tINR"/"tUSD" on the money overviews (home, save, protect)
 *   one-pause     exactly one control that pauses QED on the page, and nothing labelled "Stop everything"
 *   overflow      nothing wider than the window (phone width)
 *   empty-column  at desktop width, no two-column layout where one column is under 35% of the other's height
 *                 while the other is taller than a window
 *   fault         no "could not be drawn" page and no console error
 *   one-sum       no rupee sum written both to the paisa and rounded on the same screen (₹7,09,604.72 beside
 *                 ₹7,09,605): D-097, "one sum, one way", which the finish review of 23 Nov asked for; whole-rupee
 *                 figures under ₹1,000 and compact axis forms (₹6.39 lakh) are not compared. A price is not a sum
 *                 (DESIGN.md, Figures: written at the venue's own step, ₹63,76,731.7 at a step of 0.1), so a figure
 *                 with one or more than two digits after the point is left alone
 *   label-fit     every chart label (text in an svg in the page) inside its chart: the full runway's lowest-point
 *                 label ran 5 px past the chart's edge at 390 px and 49 px at 320 (23 Nov)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const label = process.argv[2] ?? 'checks'
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]

const PRIMARY = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/vault']
const MONEY = ['/', '/save', '/protect']
const ALL = [...PRIMARY, '/instructions', '/security', '/workspace', '/safeguards', '/ask', '/readiness', '/more']

interface Finding { route: string; width: number; check: string; detail: string }
const findings: Finding[] = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const width of [1440, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 } })
  await ctx.addCookies([{ name, value, url: fx.base }])
  const page = await ctx.newPage()
  for (const route of ALL) {
    const errors: string[] = []
    const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) }
    page.on('console', onConsole)
    await page.goto(fx.base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    const r = await page.evaluate(() => {
      const text = document.body.innerText
      const pauses = Array.from(document.querySelectorAll('button')).filter((b) => /^(QED active|QED paused|Paused, protection on|QED not running|Stop everything|Resume)(Pause|Resume)?$/.test((b.textContent ?? '').trim()) && b.closest('.topbar, .bottombar, .main') !== null)
      const stopWords = Array.from(document.querySelectorAll('button, a')).filter((b) => /Stop everything/.test(b.textContent ?? '')).length
      const overflow = document.documentElement.scrollWidth - window.innerWidth
      // A column is the children that share a left edge, measured from the first one's top to the last one's bottom:
      // a stack of children is one column, two panels side by side are two, and a masonry board's two lanes are two
      // (until 23 Nov this took each child as a column, which misread Home's stacked header and board as two).
      const cols = Array.from(document.querySelectorAll('.cols, .home, .board')).map((c) => {
        const lanes = new Map<number, { top: number; bottom: number }>()
        for (const k of Array.from(c.children)) {
          if ((k as HTMLElement).offsetParent === null || getComputedStyle(k).position === 'fixed' || k.tagName === 'DIALOG') continue
          const b = (k as HTMLElement).getBoundingClientRect(), key = Math.round(b.left), lane = lanes.get(key)
          if (lane) { lane.top = Math.min(lane.top, b.top); lane.bottom = Math.max(lane.bottom, b.bottom) } else lanes.set(key, { top: b.top, bottom: b.bottom })
        }
        return [...lanes.values()].map((l) => l.bottom - l.top)
      })
      const clipped = Array.from(document.querySelectorAll('main svg text')).filter((t) => t.getClientRects().length && (t.textContent ?? '').trim()).map((t) => {
        const s = (t as SVGTextElement).ownerSVGElement!.getBoundingClientRect(), b = t.getBoundingClientRect()
        return { text: (t.textContent ?? '').trim().slice(0, 40), over: Math.round(Math.max(s.left - b.left, b.right - s.right, s.top - b.top, b.bottom - s.bottom)) }
      }).filter((x) => x.over > 1)
      return { text, pauses: pauses.length, stopWords, overflow, cols, clipped, fault: /This page could not be drawn/.test(text) }
    })
    page.off('console', onConsole)
    const add = (check: string, detail: string) => findings.push({ route, width, check, detail })
    if (PRIMARY.includes(route)) {
      const hex = r.text.match(/0x[0-9a-fA-F]{8,}/g)
      if (hex) add('identifiers', `${hex.length} raw identifier(s), e.g. ${hex[0]!.slice(0, 14)}…`)
      const jargon = r.text.match(/\b(block \d[\d,]*|chain(?: id)? \d{3,}|ERC-\d+|EIP-\d+|anvil)\b/gi)
      if (jargon) add('chain-jargon', `${[...new Set(jargon)].slice(0, 4).join('; ')}`)
    }
    if (MONEY.includes(route)) { const t = r.text.match(/\bt(INR|USD)\b/g); if (t) add('token-jargon', `${t.length} × ${[...new Set(t)].join(', ')}`) }
    if (r.pauses !== 1) add('one-pause', `${r.pauses} pause controls in the bar and page`)
    if (r.stopWords > 0) add('one-pause', `${r.stopWords} control(s) labelled "Stop everything"`)
    if (width < 600 && r.overflow > 1) add('overflow', `${r.overflow}px wider than the window`)
    if (width >= 1200) for (const hs of r.cols) { if (hs.length === 2) { const [a, b] = hs as [number, number]; const big = Math.max(a, b), small = Math.min(a, b); if (big > 900 && small < 0.35 * big) add('empty-column', `columns ${Math.round(a)}px and ${Math.round(b)}px`) } }
    // rupee sums as rendered: "₹6,39,249.51", "−₹2,967.53", "₹13,034"; compact forms (₹6.39 lakh, ₹45k) are skipped
    const sums = [...r.text.matchAll(/₹\s?(\d[\d,]*)(?:\.(\d+))?(?!\d|\s?(?:lakh|crore|k\b|L\b|Cr\b))/g)].map((m) => ({ text: m[0], whole: Number(m[1]!.replace(/,/g, '')), frac: m[2] }))
    const exact = sums.filter((s) => s.frac?.length === 2).map((s) => ({ text: s.text, paise: s.whole * 100 + Number(s.frac) }))
    const pairs = new Set<string>()
    for (const w of sums.filter((s) => s.frac === undefined && s.whole >= 1000)) {
      for (const e of exact) if (e.paise !== w.whole * 100 && Math.abs(e.paise - w.whole * 100) < 100) pairs.add(`${w.text} beside ${e.text}`)
    }
    if (pairs.size) add('one-sum', [...pairs].slice(0, 4).join('; '))
    for (const c of r.clipped) add('label-fit', `"${c.text}" runs ${c.over}px past its chart`)
    if (r.fault) add('fault', 'the fault page is shown')
    for (const e of errors) add('fault', `console: ${e}`)
  }
  await ctx.close()
}
await browser.close()
const summary = { what: 'Design regression checks from the owner\'s rejection of the five directions (D-069)', at: new Date().toISOString(), screens: ALL.length * 2, findings }
writeFileSync(join(out, 'checks.json'), `${JSON.stringify(summary, null, 1)}\n`)
console.log(`${ALL.length * 2} screens checked; ${findings.length} finding(s)`)
for (const f of findings) console.log(`  ${f.check.padEnd(13)} ${String(f.width).padEnd(5)} ${f.route.padEnd(14)} ${f.detail}`)
process.exit(findings.length ? 1 : 0)
