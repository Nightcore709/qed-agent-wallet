/**
 * R14 (Priority 3, core): photographs of onboarding, Home and the balance chart as rendered, before and after the shared
 * layout rules (DESIGN.md "R14 layout rules"). A fresh household, as the owner's screenshots show, and the design
 * fixture's household with activity (scripts/design-fixture.ts must be running; QED_UI names the interface to read).
 *
 *   QED_UI=http://localhost:13670 node scripts/r14-core-shots.ts <label> [widths] [themes]
 *
 * Writes evidence/design/r14-core/<label>/<screen>-<width>-<theme>-<part>.png: `top` and `end` are the window at the
 * start and at the end of the page (where a sticky summary and the bars show their faults), `mid` is the window part of
 * the way down (text under the bars), `full` is the whole page. Width 720x2 is 1440 px at 200% zoom.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type BrowserContext, chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string; dir: string }
const base = process.env.QED_UI ?? fx.base
const label = process.argv[2] ?? 'shots'
const widths = (process.argv[3] ?? '1440,1024,900,768,390,720x2').split(',')
const themes = (process.argv[4] ?? 'dark,light').split(',') as ('dark' | 'light')[]
const out = join(app, 'evidence', 'design', 'r14-core', label)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })

const sizeOf = (w: string): { width: number; height: number; scale: number } => {
  const [px, x] = w.split('x')
  const width = Number(px), scale = x ? Number(x) : 1
  return { width, height: scale > 1 ? 450 : width < 600 ? 844 : 900, scale }
}
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
}
/** The window at the top, part of the way down, at the end, and the whole page. */
async function parts(page: Page, name: string, which = ['top', 'mid', 'end', 'full']): Promise<void> {
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
  for (const part of which) {
    if (part === 'full') {
      await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(120)
      // every block is revealed first (motion.ts waits for a block to be scrolled to)
      await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) } window.scrollTo(0, 0) })
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(out, `${name}-full.png`), fullPage: true })
      continue
    }
    const y = part === 'top' ? 0 : part === 'end' ? max : Math.round(max * 0.45)
    await page.evaluate((v) => window.scrollTo(0, v), y)
    await page.waitForTimeout(450)
    await page.screenshot({ path: join(out, `${name}-${part}.png`) })
  }
}
async function passkey(page: Page): Promise<void> {
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
}
/**
 * The API allows 20 new accounts an hour from one address. A full set of photographs creates more than that, so the
 * counter is cleared in the fixture's own scratch database before each account, as the browser suite does on its own
 * stack (browser/support/stack.ts allowSignups). Nothing else is written; the limit stays in the product.
 */
function allowSignups(): void {
  const d = new DatabaseSync(join(fx.dir, 'qed.db'))
  try { d.exec('PRAGMA busy_timeout = 5000'); d.prepare("DELETE FROM rate_limits WHERE key LIKE 'signup:%'").run() } finally { d.close() }
}
async function signUp(page: Page, handle: string): Promise<void> {
  allowSignups()
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Rishu Chauhan')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Open your paper household' }).waitFor()
}
const stamp = Date.now().toString(36)

for (const theme of themes) {
  for (const w of widths) {
    const s = sizeOf(w)
    const tag = `${w}-${theme}`
    const fresh: BrowserContext = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, colorScheme: theme })
    const page = await fresh.newPage()
    await passkey(page)
    // ---- onboarding, in rupees and then in US dollars (the prefix of every amount field must follow)
    await signUp(page, `r14${stamp}${w.replace('x', 'z')}${theme[0]}`)
    await settle(page)
    await parts(page, `onboarding-inr-${tag}`, ['top', 'end', 'full'])
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByLabel('Home currency').selectOption('USD')
    await page.getByText(/Starting figures are the rupee example|The example figures are converted/).waitFor()
    await settle(page)
    await parts(page, `onboarding-usd-${tag}`, ['top', 'end', 'full'])
    // ---- a fresh rupee household's Home, as in the owner's screenshots
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByLabel('Home currency').selectOption('INR')
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: 'Open the household' }).click()
    await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Here is your money' }).waitFor()
    await settle(page)
    await parts(page, `home-fresh-${tag}`)
    await page.goto(`${base}/save`); await settle(page)
    await parts(page, `save-fresh-${tag}`, ['mid', 'full'])
    await fresh.close()

    // ---- a fresh US-dollar household: Home and Save (no rupee sign may appear anywhere)
    const usd: BrowserContext = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, colorScheme: theme })
    const pu = await usd.newPage()
    await passkey(pu)
    await signUp(pu, `r14u${stamp}${w.replace('x', 'z')}${theme[0]}`)
    await pu.getByLabel('Home currency').selectOption('USD')
    await pu.getByText(/Starting figures are the rupee example|The example figures are converted/).waitFor()
    await pu.waitForTimeout(400)
    await pu.getByRole('button', { name: 'Open the household' }).click()
    await pu.getByRole('heading', { level: 1 }).filter({ hasText: 'Here is your money' }).waitFor()
    await settle(pu)
    await parts(pu, `home-usd-${tag}`, ['top', 'full'])
    const rupee = await pu.evaluate(() => (document.body.innerText.match(/₹/g) ?? []).length)
    await pu.goto(`${base}/save`); await settle(pu)
    await parts(pu, `save-usd-${tag}`, ['mid', 'full'])
    const rupeeSave = await pu.evaluate(() => (document.body.innerText.match(/₹/g) ?? []).length)
    console.log(`[r14-core-shots] ${tag}: rupee signs on a USD household's Home ${rupee}, Save ${rupeeSave}`)
    await usd.close()

    // ---- the fixture's household: Home and Save with activity (the chart with its events)
    const rich = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, colorScheme: theme })
    await rich.addCookies([{ name: fx.cookie.slice(0, fx.cookie.indexOf('=')), value: fx.cookie.slice(fx.cookie.indexOf('=') + 1), url: base }])
    const p2 = await rich.newPage()
    await p2.goto(`${base}/`); await settle(p2)
    await parts(p2, `home-rich-${tag}`)
    const chart = p2.locator('.hm-horizon')
    if (await chart.count()) { await chart.scrollIntoViewIfNeeded(); await p2.waitForTimeout(300); await chart.screenshot({ path: join(out, `chart-home-rich-${tag}.png`) }) }
    await p2.goto(`${base}/save`); await settle(p2)
    await parts(p2, `save-rich-${tag}`, ['full'])
    await rich.close()
    console.log(`[r14-core-shots] ${label} ${tag}`)
  }
}
await browser.close()
