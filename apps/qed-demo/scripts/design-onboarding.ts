/**
 * Photographs the first run as a new person meets it, on the running design fixture (scripts/design-fixture.ts):
 * signing in, creating an account (passkey or password), the recovery codes, the passkey step of a password account,
 * opening the household, and Home's "Finish setting up". Each run creates one throwaway local account with a password
 * made here; it is never printed. Nothing is approved.
 *
 *   node scripts/design-onboarding.ts <label>        writes evidence/design/<label>/onboard-<step>-<width>-<theme>.png
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string }
const label = process.argv[2] ?? 'onboarding'
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })
const widths = (process.env.QED_WIDTHS ?? '1440,390').split(',').map(Number)
const themes = (process.env.QED_THEMES ?? 'light,dark').split(',') as ('light' | 'dark')[]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const shot = async (p: Page, step: string, w: number, theme: string) => { await p.waitForTimeout(450); await p.screenshot({ path: join(out, `onboard-${step}-${w}-${theme}.png`), fullPage: true, animations: 'disabled' }) }
let n = 0
for (const theme of themes) {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1 })
    const p = await ctx.newPage()
    await p.goto(fx.base + '/', { waitUntil: 'networkidle' })
    await shot(p, '1-signin', w, theme)
    await p.getByRole('button', { name: 'Create an account' }).click()
    await p.getByText('Choose your handle (optional)').click()
    const handle = `look${Date.now().toString(36)}${n++}`
    await p.getByLabel('Handle').fill(handle)
    await p.getByLabel('Name to sign with').fill('Kavya Iyer')
    // R14: the ordinary sign-up is an email address and a password
    await p.getByLabel('Email', { exact: true }).fill(`${handle}@example.in`)
    await p.getByLabel('Password', { exact: true }).fill(`${randomBytes(9).toString('base64url')} phrase`)
    await shot(p, '2-create', w, theme)
    await p.getByRole('button', { name: 'Create account', exact: true }).click()
    await p.getByRole('heading', { name: 'Faster, more secure access' }).waitFor()
    await shot(p, '4-passkey', w, theme)
    await p.getByRole('button', { name: 'Not now' }).click()
    await p.getByRole('button', { name: 'Open the household' }).waitFor()
    await shot(p, '5-household', w, theme)
    await p.getByRole('button', { name: 'Open the household' }).click()
    await p.getByRole('heading', { level: 1, name: 'Your money' }).waitFor()
    await p.waitForTimeout(1200)
    await shot(p, '6-home', w, theme)
    // the first run of the on-chain wallet (nothing set up yet) and Security for an account with no passkey
    await p.goto(fx.base + '/vault', { waitUntil: 'networkidle' })
    await p.getByRole('heading', { level: 1 }).waitFor()
    await p.waitForTimeout(800)
    await shot(p, '7-wallet', w, theme)
    await p.goto(fx.base + '/security', { waitUntil: 'networkidle' })
    await p.getByRole('heading', { level: 1 }).waitFor()
    await p.waitForTimeout(600)
    await shot(p, '8-security', w, theme)
    await ctx.close()
  }
}
await browser.close()
console.log(`first run photographed into ${out}`)
