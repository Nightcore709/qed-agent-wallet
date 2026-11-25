/**
 * R14 (the remaining screens): whole-page photographs of Grow, Earn, Protect, Ask, Activity, the wallet, workspaces,
 * approvals and notifications, for the design fixture's household (activity on every side) and a fresh one (none).
 *
 *   QED_FIXTURE_FILE=data/rest-fixture.json QED_UI=http://localhost:13800 node scripts/r14-rest-shots.ts <label> [widths] [themes] [rich|fresh|both] [routes]
 *
 * Writes evidence/design/r14-rest/<label>/<household>-<route>-<width>-<theme>.png (the whole scrollable page), and
 * prints each page's horizontal overflow (scrollWidth over the window) so a sideways scroll at 390 px is a finding.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(join(app, process.env.QED_FIXTURE_FILE ?? 'data/design-fixture.json'), 'utf8')) as { base: string; cookie: string; dir: string }
const base = process.env.QED_UI ?? fx.base
const label = process.argv[2] ?? 'shots'
const widths = (process.argv[3] ?? '1440,1024,768,390').split(',')
const themes = (process.argv[4] ?? 'dark').split(',') as ('dark' | 'light')[]
const who = (!process.argv[5] || process.argv[5] === 'both' ? 'rich,fresh' : process.argv[5]).split(',')
const routes = (process.argv[6] ?? '/holdings,/earn,/protect,/ask,/activity,/vault,/workspace,/notifications,/judge').split(',')
const out = join(app, 'evidence', 'design', 'r14-rest', label)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const sizeOf = (w: string) => { const [px, x] = w.split('x'); const width = Number(px), scale = x ? Number(x) : 1; return { width, height: scale > 1 ? 450 : width < 600 ? 844 : 900, scale } }
async function settle(page: Page) { await page.waitForLoadState('networkidle').catch(() => undefined); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500) }
async function passkey(page: Page) {
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
}
function allowSignups() { const d = new DatabaseSync(join(fx.dir, 'qed.db')); try { d.exec('PRAGMA busy_timeout = 5000'); d.prepare("DELETE FROM rate_limits WHERE key LIKE 'signup:%'").run() } finally { d.close() } }
async function signUp(page: Page, handle: string, currency: string) {
  allowSignups()
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Rishu Chauhan')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Open your paper household' }).waitFor()
  if (currency !== 'INR') { await page.getByLabel('Home currency').selectOption(currency); await page.waitForTimeout(500) }
  await page.getByRole('button', { name: 'Open the household' }).click()
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Here is your money' }).waitFor()
}
async function shoot(page: Page, name: string) {
  await settle(page)
  await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) } window.scrollTo(0, 0) })
  await page.waitForTimeout(300)
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight }))
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
  // QED_CLIP="y,h" also writes a window of the page, from y, h tall, as <name>-clip.png (for reading a long page in parts)
  if (process.env.QED_CLIP) { const [y, h] = process.env.QED_CLIP.split(',').map(Number); await page.screenshot({ path: join(out, `${name}-clip.png`), fullPage: true, clip: { x: 0, y: y!, width: ov.iw, height: Math.min(h!, ov.h - y!) } }) }
  console.log(`${name} height=${ov.h}${ov.sw > ov.iw ? ` OVERFLOW ${ov.sw}>${ov.iw}` : ''}`)
}
const stamp = Date.now().toString(36)
const ck = fx.cookie
for (const theme of themes) for (const w of widths) {
  const s = sizeOf(w)
  const tag = `${w}-${theme}`
  for (const hh of who) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, colorScheme: theme })
    const page = await ctx.newPage()
    if (hh === 'rich') await ctx.addCookies([{ name: ck.slice(0, ck.indexOf('=')), value: ck.slice(ck.indexOf('=') + 1), url: base }])
    else if (hh === 'fresh' || hh === 'usd') { await passkey(page); await signUp(page, `r14r${stamp}${w}${theme[0]}${hh[0]}`, hh === 'usd' ? 'USD' : 'INR') }
    for (const r of routes) {
      await page.goto(`${base}${r}`)
      await shoot(page, `${hh}-${r.replace(/[\/?=]/g, '_').replace(/^_/, '')}-${tag}`)
    }
    await ctx.close()
  }
}
await browser.close()
