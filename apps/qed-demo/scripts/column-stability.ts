/**
 * Whether live price updates move the columns of a screen's market tables (the owner's report of 22 Nov: Grow's
 * digital-assets table moved sideways as prices streamed). Opens the screen on the running design fixture with every
 * disclosure open, then for N seconds samples the box (left edge, width) of every cell of every table, of each
 * holding row and of the ticket's quote, and the figures they show. Reports, per table, the largest change of a left
 * edge or a width seen in any cell, and how many distinct figure texts were seen (the proof that prices did change
 * while it watched: a table that never updated cannot show stability).
 *
 *   node scripts/column-stability.ts [width] [seconds] [out.json] [route]      defaults 1440, 20, none, /holdings
 *
 * Adopted on 23 Nov 2026 from the Save and Grow workstream's scratch tool; it measured 20.7 px at 1440 and 6.9 px at
 * 390 before that rebuild and 0 px at both after (evidence/design/proof-save-grow/columns-*.json).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

type Cell = [number, number, string]
type Sample = { label: string; rows: Cell[][] }[]

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const width = Number(process.argv[2] ?? 1440), seconds = Number(process.argv[3] ?? 20), outFile = process.argv[4], route = process.argv[5] ?? '/holdings'
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
await ctx.addCookies([{ name, value, url: fx.base }])
const page = await ctx.newPage()
await page.goto(`${fx.base}${route}`, { waitUntil: 'networkidle' })
await page.evaluate(() => document.querySelectorAll('main details').forEach((d) => { (d as HTMLDetailsElement).open = true }))
await page.waitForTimeout(1500)

const sample = (): Promise<Sample> => page.evaluate(() => {
  const box = (c: Element): [number, number, string] => { const r = c.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.width * 10) / 10, (c.textContent ?? '').trim()] }
  const out: { label: string; rows: [number, number, string][][] }[] = []
  document.querySelectorAll('main table').forEach((t, ti) => {
    const label = t.closest('[aria-label]')?.getAttribute('aria-label') ?? t.querySelector('caption')?.textContent ?? `table ${ti}`
    out.push({ label, rows: Array.from(t.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map(box)) })
  })
  // The ticket's quote is not a table: each of its parts is measured the same way. (The holdings were a list until R10;
  // they are a table now and measured above.) A selector that finds nothing says so, so a check cannot pass empty.
  for (const [label, sel] of [['Ticket quote', 'main .ticket-quote']] as const) {
    const found = Array.from(document.querySelectorAll(sel))
    out.push({ label: found.length ? label : `${label} (none on this screen)`, rows: [[], ...found.map((el) => Array.from(el.children).map(box))] })
  }
  return out
})

const runs: Sample[] = []
const t0 = Date.now()
while (Date.now() - t0 < seconds * 1000) { runs.push(await sample()); await page.waitForTimeout(500) }
await browser.close()

const report = runs[0]!.map(({ label }, ti) => {
  let moved = 0
  const texts = new Set<string>()
  const cols = new Map<string, { l: [number, number]; w: [number, number] }>()
  for (const run of runs) {
    run[ti]?.rows.forEach((row, ri) => row.forEach(([left, w, text], ci) => {
      const k = `${ri}:${ci}`, c = cols.get(k) ?? { l: [left, left], w: [w, w] }
      c.l = [Math.min(c.l[0], left), Math.max(c.l[1], left)]; c.w = [Math.min(c.w[0], w), Math.max(c.w[1], w)]
      cols.set(k, c)
      if (ri > 0 && /\d/.test(text)) texts.add(`${ri}:${ci}:${text}`)
    }))
  }
  for (const c of cols.values()) moved = Math.max(moved, c.l[1] - c.l[0], c.w[1] - c.w[0])
  return { table: label, samples: runs.length, largestShiftPx: Math.round(moved * 10) / 10, distinctFigureTexts: texts.size }
})
const result = { route, width, seconds, at: new Date().toISOString(), report }
if (outFile) writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)
for (const r of report) console.log(`${r.table.slice(0, 60).padEnd(60)} shift ${String(r.largestShiftPx).padStart(5)} px over ${r.samples} samples, ${r.distinctFigureTexts} distinct figures`)
