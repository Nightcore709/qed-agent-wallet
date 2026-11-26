/**
 * R14 (UX final): empty-area measures of Earn. For each section (panel, card, pane) of /earn: its box, the share of it not
 * covered by any content (text lines, controls, images, svg) on an 8 px grid, and the largest empty rectangle. A fresh
 * household and the design fixture's household (needs scripts/design-fixture.ts running), at four widths. Also: does a
 * step's text ever collapse to a narrow column (a text block under 22 characters wide holding a long sentence)?
 *   node scripts/r14-ux-final-earn.ts <before|after> [path]       writes evidence/design/r14-ux-final/earn-<kind>-<w>-<tag>.png
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { addAuthenticator } from '../browser/support/passkey.ts'

const tag = process.argv[2] ?? 'after', path = process.argv[3] ?? '/earn'
const fx = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const out = join(import.meta.dirname, '..', 'evidence', 'design', 'r14-ux-final')
const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function fresh(page: Page): Promise<void> {
  await addAuthenticator(page)
  await page.goto(fx.base + '/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`fr${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await page.getByRole('button', { name: 'Open the household' }).waitFor({ state: 'detached' })
}

const measure = (page: Page) => page.evaluate(() => {
  const GRID = 8
  const secs = [...document.querySelectorAll<HTMLElement>('main :is(section, article, .panel, .card, .pane, aside, details)')].filter((e) => e.offsetParent && e.getBoundingClientRect().height > 60 && !e.parentElement?.closest('main :is(section, article, .panel, .card, .pane, aside, details)'))
  const rects = (root: HTMLElement): DOMRect[] => {
    const rs: DOMRect[] = []
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.textContent ?? '').trim() && (n.parentElement as HTMLElement).offsetParent) { const r = document.createRange(); r.selectNodeContents(n); rs.push(...r.getClientRects()) }
    for (const e of root.querySelectorAll<HTMLElement>('input, select, textarea, button, img, svg, canvas, progress, meter')) if (e.offsetParent || e instanceof SVGElement) rs.push(e.getBoundingClientRect())
    return rs
  }
  return secs.map((el) => {
    const b = el.getBoundingClientRect()
    const cols = Math.ceil(b.width / GRID), rows = Math.ceil(b.height / GRID)
    const g = Array.from({ length: rows }, () => new Uint8Array(cols))
    for (const r of rects(el)) for (let y = Math.max(0, Math.floor((r.top - b.top) / GRID)); y <= Math.min(rows - 1, Math.floor((r.bottom - b.top) / GRID)); y++) for (let x = Math.max(0, Math.floor((r.left - b.left) / GRID)); x <= Math.min(cols - 1, Math.floor((r.right - b.left) / GRID)); x++) g[y]![x] = 1
    let empty = 0; for (const row of g) for (const v of row) if (!v) empty++
    // largest empty rectangle (histogram method)
    const h = new Array(cols).fill(0); let best = { a: 0, w: 0, h: 0 }
    for (const row of g) { for (let x = 0; x < cols; x++) h[x] = row[x] ? 0 : h[x] + 1; const st: number[] = []; for (let x = 0; x <= cols; x++) { const cur = x === cols ? 0 : h[x]; while (st.length && h[st[st.length - 1]!] >= cur) { const hh = h[st.pop()!]; const ww = st.length ? x - st[st.length - 1]! - 1 : x; if (hh * ww > best.a) best = { a: hh * ww, w: ww, h: hh } } st.push(x) } }
    const name = el.querySelector('h1, h2, h3')?.textContent?.trim().slice(0, 40) ?? el.getAttribute('aria-label') ?? el.className.toString().slice(0, 30)
    // a step's text in a narrow column: a text element under 24ch wide (< 11em) that wraps over 4+ lines
    const narrow = [...el.querySelectorAll<HTMLElement>('p, li, dd, span, div')].filter((t) => t.children.length === 0 && (t.textContent ?? '').trim().length > 50 && t.offsetParent).filter((t) => { const r = t.getBoundingClientRect(), lh = parseFloat(getComputedStyle(t).lineHeight) || 20; return r.width < 150 && r.height / lh >= 4 }).map((t) => `${Math.round(t.getBoundingClientRect().width)}px: ${t.textContent!.trim().slice(0, 30)}`)
    return { name, w: Math.round(b.width), h: Math.round(b.height), emptyPct: Math.round(100 * empty / (cols * rows)), voidW: best.w * GRID, voidH: best.h * GRID, narrow }
  })
})

for (const kind of ['fresh', 'data'] as const) {
  for (const w of [1440, 1024, 768, 390]) {
    const c = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: 'reduce' })
    const page = await c.newPage()
    if (kind === 'data') await c.addCookies([{ name: fx.cookie.slice(0, fx.cookie.indexOf('=')), value: fx.cookie.slice(fx.cookie.indexOf('=') + 1), url: fx.base }])
    else await fresh(page)
    await page.goto(fx.base + path); await page.waitForLoadState('networkidle').catch(() => undefined); await page.waitForTimeout(1500)
    const rows = await measure(page)
    console.log(`\n[earn ${tag}] ${kind} ${w}px`)
    for (const r of rows) console.log(`  ${r.name.padEnd(40)} ${r.w}x${r.h}  empty ${String(r.emptyPct).padStart(2)}%  largest void ${r.voidW}x${r.voidH}${r.narrow.length ? '  NARROW: ' + r.narrow.join(' | ') : ''}`)
    await page.screenshot({ path: join(out, `earn-${kind}-${w}-${tag}.png`), fullPage: true })
    await c.close()
  }
}
await browser.close()
