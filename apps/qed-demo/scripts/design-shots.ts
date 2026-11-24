/**
 * Photographs every screen of the running design fixture (scripts/design-fixture.ts) at desktop and phone width, in
 * light and dark, so a design can be read as rendered and compared before and after a change.
 *
 *   node scripts/design-shots.ts <label> [route ...]     e.g. node scripts/design-shots.ts before / /pay /vault
 *
 * Reads data/design-fixture.json for the address and session. QED_UI=<url> photographs another server that proxies
 * the same API (a Vite dev server, for example). Writes evidence/design/<label>/<route>-<width>-<theme>.png and a
 * list of console errors and fault pages seen per screen in evidence/design/<label>/report.json. A screen that shows
 * the "could not be drawn" page counts as a failure. QED_TYPE=fira|familjen|radio photographs in that typeface
 * (the comparison switch of the redesign); QED_WIDTHS and QED_THEMES narrow the set.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const label = process.argv[2] ?? 'shots'
const base = process.env.QED_UI ?? fx.base
const widths = (process.env.QED_WIDTHS ?? '1440,390').split(',').map(Number)
const themes = (process.env.QED_THEMES ?? 'light,dark').split(',') as ('light' | 'dark')[]
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })

const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report: Record<string, { errors: string[]; fault: boolean }> = {}

// The routes of the running interface; ids are read from the fixture's own API so detail screens are included.
async function routes(): Promise<string[]> {
  if (process.argv.length > 3) return process.argv.slice(3)
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name, value, url: base }])
  const api = ctx.request
  const progs = (await (await api.get(`${base}/api/programs`)).json()) as { programs: { id: string; state: string }[] }
  const acts = (await (await api.get(`${base}/api/activity`)).json()) as { actions?: { id: string }[] }
  await ctx.close()
  const r = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/passbook', '/instructions', '/instructions/new', '/vault', '/safeguards', '/security', '/workspace', '/ask', '/readiness', '/more', '/evidence', '/notifications', '/vault/mandate', '/vault/treasury', '/vault/convert', '/vault/policy', '/vault/records']
  const p = progs.programs.find((x) => x.state === 'active')
  if (p) r.push(`/instructions/${p.id}`)
  const a = acts.actions?.[0]
  if (a) r.push(`/record/${a.id}`)
  const convs = (await (await fetch(`${base}/api/conversations`, { headers: { cookie: fx.cookie } })).json().catch(() => ({}))) as { conversations?: { id: string }[] }
  if (convs.conversations?.[0]) r.push(`/ask?c=${convs.conversations[0].id}`)
  const cases = (await (await fetch(`${base}/api/evidence/cases`, { headers: { cookie: fx.cookie } })).json().catch(() => ({}))) as { cases?: { id: string }[] }
  if (cases.cases?.[0]) r.push(`/evidence/${encodeURIComponent(cases.cases[0].id)}`)
  return r
}

const list = await routes()
for (const theme of themes) {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1 })
    await ctx.addCookies([{ name, value, url: base }])
    const page = await ctx.newPage()
    for (const r of list) {
      const errors: string[] = []
      const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) }
      page.on('console', onConsole)
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
      const typed = process.env.QED_TYPE ? `${r}${r.includes('?') ? '&' : '?'}type=${process.env.QED_TYPE}` : r
      await page.goto(base + typed, { waitUntil: 'networkidle' }).catch((e: unknown) => errors.push(String(e).slice(0, 200)))
      await page.waitForTimeout(700)
      const fault = await page.getByText('This page could not be drawn').count() > 0
      // A full-page photograph draws what is pinned to the window where the first window ended: the docked Ask and the
      // bars would sit across the middle of the page, so they are drawn where a scrolled page would show them.
      await page.addStyleTag({ content: '.app { position: relative !important; } .ask-dock { position: absolute !important; bottom: 16px !important; } .bottombar { position: absolute !important; bottom: 0 !important; }' }).catch(() => undefined)
      const file = `${(r === '/' ? 'home' : r.slice(1).replace(/\//g, '_').replace(/\?c=.*/, '_conversation')).replace(/[^a-z0-9_-]/gi, '')}-${w}-${theme}.png`
      await page.screenshot({ path: join(out, file), fullPage: true, animations: 'disabled' })
      report[`${r} ${w} ${theme}`] = { errors, fault }
      page.off('console', onConsole)
    }
    await ctx.close()
    // the signed-out screens (no session): signing in, creating an account, recovering with a code
    if (process.argv.length <= 3) {
      const out1 = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1 })
      const p1 = await out1.newPage()
      for (const [name, button] of [['welcome', null], ['welcome_new', 'Create an account'], ['welcome_recover', 'Recover your account']] as const) {
        await p1.goto(base + '/', { waitUntil: 'networkidle' }).catch(() => {})
        if (button) await p1.getByRole('button', { name: button }).click().catch(() => {})
        await p1.waitForTimeout(500)
        await p1.screenshot({ path: join(out, `${name}-${w}-${theme}.png`), fullPage: true, animations: 'disabled' })
        report[`${name} ${w} ${theme}`] = { errors: [], fault: (await p1.getByText('This page could not be drawn').count()) > 0 }
      }
      await out1.close()
    }
  }
}
await browser.close()
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`)
const bad = Object.entries(report).filter(([, v]) => v.fault || v.errors.length)
console.log(`${Object.keys(report).length} screens photographed into ${out}; ${bad.length} with errors or a fault page`)
for (const [k, v] of bad) console.log(`  ${k}: ${v.fault ? 'FAULT PAGE ' : ''}${v.errors.join(' | ')}`)
