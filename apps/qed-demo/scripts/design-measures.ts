/**
 * Measures every screen of a running design fixture (scripts/design-fixture.ts) the same way, so two designs can be
 * compared on numbers rather than impressions (R7-112): words, type scale, text colours, contrast, target sizes,
 * blank space, alignment, controls and overflow, plus axe's WCAG 2.2 AA rules, at desktop and phone width in light and
 * dark. It measures what is rendered: text in a closed disclosure or visually hidden text is not counted.
 *
 *   QED_FIXTURE_FILE=<fixture.json> node scripts/design-measures.ts <label> [route ...]
 *
 * Writes evidence/design/<label>/measures.json. Compare two runs with scripts/design-compare.ts.
 *
 * Definitions (the same instrument for every design; each is a proxy, not a verdict):
 *   words, wordsFirst    visible words on the whole page / in the first window
 *   sizes, weights       distinct font sizes (px) and weights of visible text; families: distinct first families
 *   colours              distinct text colours
 *   contrastMin          lowest text contrast ratio found (WCAG formula, background found by walking up opaque layers)
 *   contrastFails        text elements under 4.5:1 (3:1 at 24 px, or 18.66 px bold)
 *   targets, small24     visible controls that are not links inside running text / those under 24 x 24 px (WCAG 2.5.8)
 *   under32, smallList   controls under 32 px, Clear's own floor for small controls beside text (DESIGN.md C3), and which
 *   under44              controls under 44 x 44 px (Apple's guidance; WCAG 2.5.5 at AAA)
 *   blankFirst           the largest rectangle with no text, control or image inside the box spanned by the first
 *                        window's content, as a share of that box
 *   inkFirst             share of that box covered by text, controls and images
 *   blankPage            the largest such rectangle over the whole page, in windows (1 = one full window)
 *   edgesFirst           distinct edges (2 px) text blocks in the first window are set against: the left edge for
 *                        start-aligned text, the right edge for end-aligned figures; fewer means stronger alignment
 *   overflow             the page is wider than the window
 *   axe                  violations per axe rule (nodes), tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const label = process.argv[2] ?? 'measures'
const base = fx.base
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const widths = (process.env.QED_WIDTHS ?? '1440,390').split(',').map(Number)
const themes = (process.env.QED_THEMES ?? 'light,dark').split(',') as ('light' | 'dark')[]
const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function routes(): Promise<string[]> {
  if (process.argv.length > 3) return process.argv.slice(3)
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name, value, url: base }])
  const progs = (await (await ctx.request.get(`${base}/api/programs`)).json()) as { programs: { id: string; state: string }[] }
  const acts = (await (await ctx.request.get(`${base}/api/activity`)).json()) as { actions?: { id: string }[] }
  await ctx.close()
  const r = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/instructions', '/instructions/new', '/vault', '/safeguards', '/security', '/workspace', '/ask', '/readiness', '/more', '/evidence']
  const p = progs.programs.find((x) => x.state === 'active')
  if (p) r.push(`/instructions/${p.id}`)
  const a = acts.actions?.[0]
  if (a) r.push(`/record/${a.id}`)
  return r
}

type Measure = {
  words: number; wordsFirst: number; sizes: number[]; weights: number[]; families: string[]; colours: number
  contrastMin: number | null; contrastFails: number; targets: number; small24: number; under32: number; under44: number; smallest: string | null; smallList: string[]
  blankFirst: number; inkFirst: number; blankPage: number; edgesFirst: number; overflow: boolean; height: number
}

// Runs in the page. Kept free of outside references: Playwright sends it as source.
function measure(): Measure {
  const vw = innerWidth, vh = innerHeight
  const shown = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    }
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // Computed colours come back as rgb() for sRGB values and as oklch(), oklab() or color() for the design's OKLCH
  // tokens and color-mix(); the canvas converts any of them to 8-bit sRGB (it was rgb() only until 23 Nov, which read
  // every OKLCH colour as transparent black and made the contrast figures meaningless).
  const cvs = document.createElement('canvas'); cvs.width = 1; cvs.height = 1
  const cx = cvs.getContext('2d', { willReadFrequently: true })!
  const seen = new Map<string, [number, number, number, number]>()
  const parse = (c: string): [number, number, number, number] => {
    const known = seen.get(c)
    if (known) return known
    let out: [number, number, number, number] = [0, 0, 0, 0]
    const m = c.match(/^rgba?\(([^)]+)\)$/)
    if (m) {
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
      out = [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1]
    } else if (c && c !== 'transparent') {
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0, 0, 0, 0)'; cx.fillStyle = c
      cx.fillRect(0, 0, 1, 1)
      const d = cx.getImageData(0, 0, 1, 1).data
      out = [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    seen.set(c, out)
    return out
  }
  const lum = ([r, g, b]: number[]): number => {
    const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
  }
  const over = (top: number[], bottom: number[]): number[] => { const a = top[3]!; return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) }
  const backdrop = (el: Element): number[] | null => {
    const layers: number[][] = []
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.backgroundImage && s.backgroundImage !== 'none') return null
      const c = parse(s.backgroundColor)
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break }
    }
    let bg = [255, 255, 255, 1]
    for (const l of layers.reverse()) bg = over(l, bg)
    return bg
  }
  const ink: DOMRect[] = []
  const texts = new Set<Element>()
  let words = 0, wordsFirst = 0
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? ''
    if (!t.trim()) continue
    const el = n.parentElement
    if (!el || el.closest('script,style,noscript') || !shown(el)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const rects = [...range.getClientRects()].filter((x) => x.width > 1 && x.height > 1)
    if (!rects.length) continue
    // visually hidden text (a 1 px clip) is not seen
    const s = getComputedStyle(el)
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') continue
    const w = t.trim().split(/\s+/).length
    words += w
    if (rects[0]!.top < vh) wordsFirst += w
    ink.push(...rects)
    texts.add(el)
  }
  for (const el of document.querySelectorAll('img,svg,canvas,video,input:not([type=hidden]),select,textarea,button,[role=img],progress,meter')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    if (shown(el)) ink.push(el.getBoundingClientRect())
  }
  const sizes = new Set<number>(), weights = new Set<number>(), families = new Set<string>(), colours = new Set<string>()
  let contrastMin: number | null = null, contrastFails = 0
  for (const el of texts) {
    const s = getComputedStyle(el)
    const size = Math.round(parseFloat(s.fontSize) * 2) / 2
    sizes.add(size); weights.add(Number(s.fontWeight)); families.add(s.fontFamily.split(',')[0]!.replace(/["']/g, '').trim()); colours.add(s.color)
    if (el.closest(':disabled,[aria-disabled="true"]')) continue
    const bg = backdrop(el)
    if (!bg) continue
    const fg = over(parse(s.color), bg)
    const [a, b] = [lum(fg), lum(bg)]
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    contrastMin = contrastMin === null ? ratio : Math.min(contrastMin, ratio)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5) - 0.005) contrastFails++
  }
  // controls: a link inside running text is exempt from the target-size rule; a checkbox or radio counts as its label
  let targets = 0, small24 = 0, under32 = 0, under44 = 0, smallest: [number, string] | null = null
  const smallList: string[] = []
  const controls = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=switch],[role=checkbox],[role=radio],[role=menuitem]')
  for (const el of controls) {
    if (!shown(el)) continue
    const s = getComputedStyle(el)
    if (el.tagName === 'A' && s.display === 'inline') {
      const block = el.parentElement
      const own = (el.textContent ?? '').trim().length
      if (block && (block.textContent ?? '').trim().length > own + 3) continue
    }
    let r = el.getBoundingClientRect()
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const lab = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null)
      if (lab) r = lab.getBoundingClientRect()
    }
    targets++
    const m = Math.min(r.width, r.height)
    const what = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`
    if (m < 24 - 0.01) small24++
    if (m < 32 - 0.01) { under32++; if (smallList.length < 15) smallList.push(what) }
    if (m < 44 - 0.01) under44++
    if (!smallest || m < smallest[0]) smallest = [m, what]
  }
  // blank space: an 8 px grid; a cell is ink when any text, control or image box touches it
  const cell = 8
  const largestBlank = (x0: number, y0: number, x1: number, y1: number): number => {
    const cols = Math.max(1, Math.ceil((x1 - x0) / cell)), rows = Math.max(1, Math.ceil((y1 - y0) / cell))
    const grid = new Uint8Array(cols * rows)
    for (const r of ink) {
      const a = Math.max(0, Math.floor((r.left - x0) / cell)), b = Math.min(cols - 1, Math.floor((r.right - 0.01 - x0) / cell))
      const c = Math.max(0, Math.floor((r.top - y0) / cell)), d = Math.min(rows - 1, Math.floor((r.bottom - 0.01 - y0) / cell))
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) grid[y * cols + x] = 1
    }
    const h = new Array<number>(cols).fill(0)
    let best = 0
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) h[x] = grid[y * cols + x] ? 0 : h[x]! + 1
      const stack: number[] = []
      for (let x = 0; x <= cols; x++) {
        const cur = x === cols ? 0 : h[x]!
        while (stack.length && h[stack[stack.length - 1]!]! >= cur) {
          const top = stack.pop()!
          const left = stack.length ? stack[stack.length - 1]! + 1 : 0
          best = Math.max(best, h[top]! * (x - left))
        }
        stack.push(x)
      }
    }
    return best / (cols * rows)
  }
  const first = ink.filter((r) => r.top < vh && r.bottom > 0)
  const box = first.reduce((b, r) => [Math.min(b[0]!, r.left), Math.min(b[1]!, Math.max(0, r.top)), Math.max(b[2]!, r.right), Math.max(b[3]!, Math.min(vh, r.bottom))], [vw, vh, 0, 0])
  const blankFirst = first.length ? largestBlank(box[0]!, box[1]!, box[2]!, box[3]!) : 1
  let inkArea = 0
  {
    const cols = Math.ceil((box[2]! - box[0]!) / cell), rows = Math.ceil((box[3]! - box[1]!) / cell)
    const g = new Uint8Array(Math.max(1, cols * rows))
    for (const r of first) {
      const a = Math.max(0, Math.floor((r.left - box[0]!) / cell)), b = Math.min(cols - 1, Math.floor((r.right - 0.01 - box[0]!) / cell))
      const c = Math.max(0, Math.floor((r.top - box[1]!) / cell)), d = Math.min(rows - 1, Math.floor((r.bottom - 0.01 - box[1]!) / cell))
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) g[y * cols + x] = 1
    }
    inkArea = g.reduce((s, v) => s + v, 0) / Math.max(1, cols * rows)
  }
  const page = ink.reduce((b, r) => [Math.min(b[0]!, r.left), Math.min(b[1]!, r.top), Math.max(b[2]!, r.right), Math.max(b[3]!, r.bottom)], [vw, Number.POSITIVE_INFINITY, 0, 0])
  const pageShare = ink.length ? largestBlank(page[0]!, page[1]!, page[2]!, page[3]!) : 0
  const blankPage = (pageShare * (page[2]! - page[0]!) * (page[3]! - page[1]!)) / (vw * vh)
  // alignment: the edge a block of text is set against (left for start-aligned text, right for end-aligned figures)
  const edges = new Set<string>()
  for (const el of texts) {
    let b: Element | null = el
    while (b && getComputedStyle(b).display.startsWith('inline')) b = b.parentElement
    if (!b) continue
    const r = b.getBoundingClientRect()
    if (r.top >= vh || r.bottom <= 0) continue
    const align = getComputedStyle(b).textAlign
    if (align === 'center') continue
    edges.add(align === 'right' || align === 'end' ? `r${Math.round(r.right / 2) * 2}` : `l${Math.round(r.left / 2) * 2}`)
  }
  return {
    words, wordsFirst, sizes: [...sizes].sort((a, b) => a - b), weights: [...weights].sort((a, b) => a - b), families: [...families], colours: colours.size,
    contrastMin: contrastMin === null ? null : Math.round(contrastMin * 100) / 100, contrastFails, targets, small24, under32, under44, smallest: smallest ? smallest[1] : null, smallList,
    blankFirst: Math.round(blankFirst * 1000) / 1000, inkFirst: Math.round(inkArea * 1000) / 1000, blankPage: Math.round(blankPage * 100) / 100,
    edgesFirst: edges.size, overflow: document.documentElement.scrollWidth > vw + 1, height: document.documentElement.scrollHeight,
  }
}

const list = await routes()
const results: Record<string, Measure & { axe: Record<string, number>; fault: boolean }> = {}
for (const theme of themes) {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    await ctx.addCookies([{ name, value, url: base }])
    const page = await ctx.newPage()
    for (const r of list) {
      await page.goto(base + r, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(700)
      const fault = (await page.getByText(/could not be drawn/i).count()) > 0
      const m = await page.evaluate(measure)
      const axe = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze().catch(() => null)
      const counts: Record<string, number> = {}
      for (const v of axe?.violations ?? []) counts[v.id] = v.nodes.length
      results[`${r} ${w} ${theme}`] = { ...m, axe: counts, fault }
      console.log(`${r} ${w} ${theme}: words ${m.words}/${m.wordsFirst}, sizes ${m.sizes.length}, contrast ${m.contrastMin} (${m.contrastFails} under), small ${m.small24}/${m.targets}, blank ${m.blankFirst}, edges ${m.edgesFirst}, axe ${Object.values(counts).reduce((a, b) => a + b, 0)}${fault ? ', FAULT' : ''}`)
    }
    await ctx.close()
  }
}
await browser.close()
writeFileSync(join(out, 'measures.json'), `${JSON.stringify({ base, at: new Date().toISOString(), routes: list, widths, themes, results }, null, 1)}\n`)
console.log(`wrote ${join(out, 'measures.json')}`)
