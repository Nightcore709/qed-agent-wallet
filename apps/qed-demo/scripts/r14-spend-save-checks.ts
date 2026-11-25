/**
 * Measured checks of Spend and Save on the running R14 fixture (scripts/r14-spend-save-fixture.ts), for the accessibility
 * table in the R14 Spend and Save report: nothing here judges by eye.
 *
 *   node scripts/r14-spend-save-checks.ts [household ...]        default: inr-empty inr-data usd-data
 *
 * For each household, screen (/pay, /save) and width (1440, 1024, 768, 390, and 720 CSS px at two device pixels, which is
 * 1440 px at 200% zoom):
 *   overflow   nothing in the page reaches past its right edge
 *   axe        axe-core's WCAG 2.0, 2.1 and 2.2 A and AA rules
 *   targets    every control's pointer target: under 24 x 24 CSS px fails WCAG 2.2 SC 2.5.8; under 44 is listed
 *   fields     in each row of fields (.form-grid.fields) the controls of one row start on one line
 *   keyboard   Tab from the top of the page to its end: every stop is visible, shows a focus ring, and is not under the
 *              top bar, the bottom navigation or Spend's payment line (SC 2.4.11 Focus Not Obscured)
 *   sticky     at 1440 x 900 and 1024 x 768, Spend's summary: that it is pinned (layout rule L2 unpins one taller than
 *              the room between the bars) and that, pinned, its button is above the bottom navigation
 * Writes evidence/design/r14-spend-save/checks.json and prints one line per check that fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'r14-spend-save-fixture.json'), 'utf8')) as { base: string; households: Record<string, { cookie: string }> }
const who = process.argv.length > 2 ? process.argv.slice(2) : ['inr-empty', 'inr-data', 'usd-data']
const out = join(app, 'evidence', 'design', 'r14-spend-save')
mkdirSync(out, { recursive: true })
const WIDTHS: [string, number, number, number][] = [['1440', 1440, 900, 1], ['1024', 1024, 768, 1], ['768', 768, 1024, 1], ['390', 390, 844, 1], ['720 at 2x (1440 at 200%)', 720, 450, 2]]

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.fonts.status === 'loaded', undefined, { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}

const overflow = (page: Page): Promise<string[]> => page.evaluate(() => {
  const w = document.documentElement.clientWidth
  const bad: string[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('main *'))) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > w + 1 && !el.closest('.table-scroll, .sr')) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} +${Math.round(r.right - w)}px`)
    if (bad.length > 8) break
  }
  return bad
})

/** Every control in the page: its name and its pointer target (a label's box counts for the box or radio inside it). */
const targets = (page: Page): Promise<{ under24: string[]; under44: string[]; count: number }> => page.evaluate(() => {
  const under24: string[] = [], under44: string[] = []
  const seen = Array.from(document.querySelectorAll<HTMLElement>('main :is(a[href], button, input, select, textarea, summary, [tabindex="0"])')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' })
  for (const el of seen) {
    const host = (el.matches('input[type=checkbox], input[type=radio]') ? el.closest('label') : null) ?? el
    const r = host.getBoundingClientRect()
    // a link inside a sentence is exempt (SC 2.5.8, inline); it is still listed when it is under 44
    const inline = el.tagName === 'A' && getComputedStyle(el).display.startsWith('inline') && !!el.parentElement && (el.parentElement.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 8
    const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? (el as HTMLInputElement).name ?? '').trim().replace(/\s+/g, ' ').slice(0, 48)}" ${Math.round(r.width)}x${Math.round(r.height)}`
    if ((r.width < 24 || r.height < 24) && !inline) under24.push(name)
    else if (r.height < 43.5 && !inline) under44.push(name)
  }
  return { under24, under44: [...new Set(under44)], count: seen.length }
})

/** In each row of fields, the controls that share a row start on one line. */
const fields = (page: Page): Promise<string[]> => page.evaluate(() => {
  const bad: string[] = []
  for (const grid of Array.from(document.querySelectorAll<HTMLElement>('.form-grid.fields'))) {
    if (!grid.getBoundingClientRect().width) continue
    const rows = new Map<number, number[]>()
    for (const f of Array.from(grid.querySelectorAll<HTMLElement>(':scope > .field'))) {
      const c = f.querySelector<HTMLElement>('.input, .seg')
      if (!c) continue
      const key = Math.round(f.getBoundingClientRect().top)
      rows.set(key, [...(rows.get(key) ?? []), Math.round(c.getBoundingClientRect().top)])
    }
    for (const tops of rows.values()) if (Math.max(...tops) - Math.min(...tops) > 1) bad.push(`${String(grid.className)}: control tops ${tops.join(', ')}`)
  }
  return bad
})

/** Tab through the page: each stop's name, whether a ring shows, and whether it is clear of the pinned bars. */
async function keyboard(page: Page): Promise<{ stops: number; noRing: string[]; obscured: string[]; order: string[] }> {
  await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur() })
  const noRing: string[] = [], obscured: string[] = [], order: string[] = []
  let stops = 0
  for (let i = 0; i < 260; i++) {
    await page.keyboard.press('Tab')
    const s = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const host = el.matches('input[type=radio], input[type=checkbox]') ? el.closest('label') : null
      const hs = host ? getComputedStyle(host) : null
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1 && cs.outlineColor !== 'rgba(0, 0, 0, 0)') || cs.boxShadow !== 'none' || (!!hs && hs.outlineStyle !== 'none' && parseFloat(hs.outlineWidth) >= 1)
      const box = (host ?? el).getBoundingClientRect()
      const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0
      const dock = document.querySelector('.dock')?.getBoundingClientRect().top ?? innerHeight
      const strip = document.querySelector<HTMLElement>('.pay-strip > a')
      const sr = strip?.getBoundingClientRect()
      const stripTop = strip && sr && getComputedStyle(strip).visibility !== 'hidden' && sr.height > 0 && sr.top > 0 && sr.top < innerHeight && !strip.contains(el) ? sr.top : innerHeight
      const inMain = !!el.closest('main')
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 44)}"`
      // wholly hidden under a bar is the failure (SC 2.4.11, AA); partly hidden is listed with how much
      const hiddenTop = Math.max(0, Math.min(box.bottom, top) - box.top), hiddenBottom = Math.max(0, box.bottom - Math.max(box.top, Math.min(dock, stripTop)))
      return { name, ring, inMain, inDock: !!el.closest('.dock, .topbar'), h: box.height, hidden: hiddenTop + hiddenBottom, w: r.width }
    })
    if (!s) continue
    if (s.inDock && stops > 0 && order.length > 3 && i > 20) { if (s.name.includes('Home')) break }
    if (!s.inMain) continue
    stops++
    if (order.length < 400) order.push(s.name)
    if (!s.ring) noRing.push(s.name)
    if (s.h > 0 && s.hidden >= s.h - 0.5) obscured.push(`${s.name} wholly under a bar`)
    else if (s.hidden > 2) obscured.push(`${s.name} partly (${Math.round(s.hidden)} of ${Math.round(s.h)} px)`)
  }
  return { stops, noRing: [...new Set(noRing)], obscured: [...new Set(obscured)], order }
}

async function sticky(page: Page): Promise<Record<string, unknown>> {
  const read = () => page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('.pay-summary')!, j = document.querySelector<HTMLElement>('.pay-journey')!, b = s.querySelector<HTMLElement>('.pay-go .btn')
    const dock = document.querySelector('.dock')!.getBoundingClientRect().top, bar = document.querySelector('.topbar')!.getBoundingClientRect().bottom
    const r = s.getBoundingClientRect(), jr = j.getBoundingClientRect(), br = b?.getBoundingClientRect()
    return { mode: s.dataset.sticky ?? getComputedStyle(s).position, top: Math.round(r.top), bottom: Math.round(r.bottom), journeyTop: Math.round(jr.top), journeyBottom: Math.round(jr.bottom), barBottom: Math.round(bar), dockTop: Math.round(dock), buttonBottom: br ? Math.round(br.bottom) : null, buttonAboveDock: br ? br.bottom <= dock : null }
  })
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(250)
  const atTop = await read()
  // scroll until the steps' foot is in the window
  await page.evaluate(() => { const j = document.querySelector('.pay-journey')!.getBoundingClientRect(); window.scrollBy(0, j.bottom - innerHeight + 140) }); await page.waitForTimeout(350)
  const atStepsEnd = await read()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(350)
  return { atTop, atStepsEnd, levelWithStepsFoot: Math.abs(atStepsEnd.bottom - atStepsEnd.journeyBottom) <= 2 || atStepsEnd.bottom <= atStepsEnd.dockTop }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report: Record<string, unknown> = {}
const failures: string[] = []
for (const key of who) {
  const h = fx.households[key]
  if (!h) continue
  const [name, value] = [h.cookie.slice(0, h.cookie.indexOf('=')), h.cookie.slice(h.cookie.indexOf('=') + 1)]
  for (const [label, w, hgt, scale] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
    await ctx.addCookies([{ name, value, url: fx.base }])
    const page = await ctx.newPage()
    for (const path of ['/pay', '/save']) {
      const id = `${key} ${path} ${label}`
      await page.goto(fx.base + path)
      await settled(page)
      const ov = await overflow(page)
      const axe = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      const violations = axe.violations.map((v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'}, e.g. ${v.nodes[0]?.target.join(' ')}`)
      const tg = await targets(page)
      const fl = await fields(page)
      const kb = label === '1440' || label === '390' || label.startsWith('720') ? await keyboard(page) : null
      const st = path === '/pay' && (label === '1440' || label === '1024') ? await sticky(page) : null
      report[id] = { overflow: ov, axe: violations, targets: tg, fields: fl, ...(kb ? { keyboard: { stops: kb.stops, noRing: kb.noRing, obscured: kb.obscured, order: kb.order } } : {}), ...(st ? { sticky: st } : {}) }
      for (const x of ov) failures.push(`${id}: overflow ${x}`)
      for (const x of violations) failures.push(`${id}: axe ${x}`)
      for (const x of tg.under24) failures.push(`${id}: target under 24 px ${x}`)
      for (const x of fl) failures.push(`${id}: fields ${x}`)
      for (const x of kb?.noRing ?? []) failures.push(`${id}: no focus ring ${x}`)
      for (const x of (kb?.obscured ?? []).filter((o) => o.includes('wholly'))) failures.push(`${id}: focus ${x}`)
      const end = st?.atStepsEnd as { mode: string; buttonAboveDock: boolean | null } | undefined
      if (end && end.mode !== 'static' && end.buttonAboveDock === false) failures.push(`${id}: the pinned summary's button is under the bottom navigation`)
      if (end && end.mode === 'static') failures.push(`${id}: the summary is not pinned (taller than the room between the bars)`)
    }
    await ctx.close()
  }
}
await browser.close()
writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ at: new Date().toISOString(), households: who, failures, report }, null, 1)}\n`)
console.log(`${Object.keys(report).length} screens checked; ${failures.length} failure${failures.length === 1 ? '' : 's'}`)
for (const f of failures) console.log(`  ${f}`)
