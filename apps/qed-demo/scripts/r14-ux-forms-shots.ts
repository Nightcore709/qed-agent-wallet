/**
 * R14 (UX forms): photographs and DOM checks of Instructions' form, Earn, Protect's deletion block and the shell bars.
 *   node scripts/r14-ux-forms-shots.ts <label> [widths]      (the design fixture must be running: scripts/design-fixture.ts)
 * Writes evidence/design/r14-ux-forms/<label>/<page>-<width>.png (the whole page) and prints overlap findings.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string; dir: string }
const base = process.env.QED_UI ?? fx.base
const label = process.argv[2] ?? 'shots'
const widths = (process.argv[3] ?? '1440,1024,768,390').split(',').map(Number)
const out = join(app, 'evidence', 'design', 'r14-ux-forms', label)
mkdirSync(out, { recursive: true })
const pages: [string, string][] = [['ins-goal', '/instructions/new?kind=goal'], ['ins-invest', '/instructions/new?kind=invest'], ['earn', '/earn'], ['security', '/security']]
const KINDS = ['goal', 'invest', 'swp', 'sweep', 'paydown', 'bills', 'exit', 'floor', 'rebalance', 'split']
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const settle = async (p: Page): Promise<void> => { await p.waitForLoadState('networkidle').catch(() => undefined); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(600) }
/** Overlap: any two of a form's labels, controls and hints whose boxes intersect (the fields of one form). */
const overlaps = (p: Page): Promise<string[]> => p.evaluate(() => {
  const els = [...document.querySelectorAll<HTMLElement>('#compose-form .field > label, #compose-form .field > .hint, #compose-form .field > .err, #compose-form .field > :is(input, select, textarea, .money)')].filter((e) => e.offsetParent)
  const r = els.map((e) => ({ e, b: e.getBoundingClientRect() }))
  const bad: string[] = []
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i]!.b, b = r[j]!.b
    if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`${r[i]!.e.className || r[i]!.e.tagName}:${(r[i]!.e.textContent ?? '').slice(0, 24)} x ${r[j]!.e.className || r[j]!.e.tagName}:${(r[j]!.e.textContent ?? '').slice(0, 24)}`)
  }
  return bad
})
async function freshAccount(w: number, tag: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const c = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: 'dark' })
  const page = await c.newPage()
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  const client = await c.newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  const d = new DatabaseSync(join(fx.dir, 'qed.db')); try { d.exec('PRAGMA busy_timeout = 5000'); d.prepare("DELETE FROM rate_limits WHERE key LIKE 'signup:%'").run() } finally { d.close() }
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`ux${tag}${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Test Person')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Open your paper household' }).waitFor()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Here is your money' }).waitFor()
  return { page, close: () => c.close() }
}
for (const w of widths) {
  if (process.env.UX_EMPTY) {
    const f = await freshAccount(w, String(w))
    for (const [name, path] of [['earn-empty', '/earn'], ['security-empty', '/security']] as const) {
      await f.page.goto(base + path); await settle(f.page)
      await f.page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)) } window.scrollTo(0, 0) })
      await f.page.waitForTimeout(300)
      await f.page.screenshot({ path: join(out, `${name}-${w}.png`), fullPage: true })
    }
    await f.close(); continue
  }
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: 'dark' })
  await ctx.addCookies([{ name: fx.cookie.slice(0, fx.cookie.indexOf('=')), value: fx.cookie.slice(fx.cookie.indexOf('=') + 1), url: base }])
  const page = await ctx.newPage()
  for (const [name, path] of pages) {
    await page.goto(base + path); await settle(page)
    if (name === 'ins-goal') { await page.getByLabel('What it is for').fill('A holiday'); await page.getByLabel('How much', { exact: true }).fill('60000'); const d = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10); await page.getByLabel('By', { exact: true }).fill(d); await page.waitForTimeout(1200) }
    if (name === 'ins-invest') { await page.getByRole('radio', { name: /Ask me each time/ }).check().catch(() => undefined); await page.waitForTimeout(900) }
    await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)) } window.scrollTo(0, 0) })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, `${name}-${w}.png`), fullPage: true })
  }
  // every kind's form: overlaps among its labels, controls and hints
  for (const k of KINDS) {
    await page.goto(`${base}/instructions/new?kind=${k}`); await settle(page)
    const bad = await overlaps(page)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    console.log(`[ux-forms] ${w}px kind=${k}: field overlaps ${bad.length}${bad.length ? ' ' + JSON.stringify(bad.slice(0, 3)) : ''}${wide ? ' HORIZONTAL SCROLL' : ''}`)
  }
  await ctx.close()
}
await browser.close()
