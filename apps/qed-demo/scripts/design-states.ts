/**
 * Photographs the interactive states of the design fixture that a static route cannot show: the payment review
 * sheet, the instruction review and signing sheet, the pause sheet and the account menu, at desktop and phone width
 * in light and dark. It opens sheets and closes them again; it never approves or signs anything. Reviewing an
 * instruction saves it as an unsigned draft, so every draft the script made is discarded again at the end.
 *
 *   node scripts/design-states.ts <label>
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const label = process.argv[2] ?? 'states'
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const started = Date.now()

const states: [string, (p: Page) => Promise<void>][] = [
  ['pay-review', async (p) => {
    await p.goto(`${fx.base}/pay`, { waitUntil: 'networkidle' })
    // Spend chooses nobody on arrival: the person chooses who to pay (R12 task comparison)
    await p.getByRole('radiogroup', { name: 'To' }).getByRole('radio').first().check()
    await p.getByLabel('How much').fill('1500')
    await p.getByRole('button', { name: 'See what this would do' }).click()
    await p.getByRole('dialog').waitFor()
  }],
  ['instruction-review', async (p) => {
    await p.goto(`${fx.base}/instructions/new?kind=invest`, { waitUntil: 'networkidle' })
    await p.getByLabel('With this much each time').fill('500')
    await p.getByLabel('Most in one month').fill('2000')
    await p.getByRole('button', { name: 'Review and sign' }).click()
    await p.waitForTimeout(1200)
  }],
  ['pause-sheet', async (p) => {
    await p.goto(`${fx.base}/`, { waitUntil: 'networkidle' })
    await p.getByRole('button', { name: /^(QED active|QED paused|Paused, protection on|QED not running)/ }).click()
    await p.getByRole('dialog').waitFor()
  }],
  ['account-menu', async (p) => {
    await p.goto(`${fx.base}/`, { waitUntil: 'networkidle' })
    await p.getByRole('button', { name: /account menu$/ }).click()
  }],
]

for (const theme of ['light', 'dark'] as const) {
  for (const w of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme })
    await ctx.addCookies([{ name, value, url: fx.base }])
    for (const [n, go] of states) {
      const page = await ctx.newPage()
      try { await go(page); await page.waitForTimeout(500); await page.screenshot({ path: join(out, `${n}-${w}-${theme}.png`), animations: 'disabled' }) }
      catch (e) { console.log(`${n} ${w} ${theme}: ${String(e).slice(0, 200)}`) }
      await page.close()
    }
    await ctx.close()
  }
}
// Discard the unsigned drafts the instruction review saved (they can do nothing, but they clutter the fixture).
{
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name, value, url: fx.base }])
  const csrf = String(((await (await ctx.request.get(`${fx.base}/api/session`)).json()) as { csrf?: string }).csrf ?? '')
  const progs = ((await (await ctx.request.get(`${fx.base}/api/programs`)).json()) as { programs: { id: string; state: string; createdAt: number }[] }).programs
  for (const pr of progs.filter((x) => x.state === 'draft' && x.createdAt >= started)) await ctx.request.post(`${fx.base}/api/programs/${pr.id}/discard-draft`, { headers: { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf }, data: {} })
  await ctx.close()
}
await browser.close()
console.log(`states photographed into ${out}`)
