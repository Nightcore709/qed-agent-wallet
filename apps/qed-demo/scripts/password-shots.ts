/**
 * Photographs the Password panel under Security and its two sheets (RISK-076: changing and removing a password) on an
 * isolated stack, driven through the built interface, at desktop and phone width in light and dark. One account goes
 * through every state in turn: opened with a password (the panel; the change sheet with a mistake on its field), with a
 * passkey added (the change sheet the passkey confirms; the removal sheet, which offers nothing while there is no
 * recovery contact), with an active recovery contact (the removal sheet, ready), and just after the removal. The
 * accounts and their passwords are made here and never leave the run; the passkeys are a virtual authenticator.
 *
 *   npm run build && node scripts/password-shots.ts [label] [port]     default label password-change, port 5761
 *
 * Writes evidence/design/<label>/<state>-<width>-<theme>.png and report.json: for each photograph, the console errors and
 * the API answers of 400 or more seen since the one before (some are the state being photographed: a wrong password,
 * a wallet not set up yet), axe-core's WCAG 2.0 to 2.2 A and AA violations (the rule set of scripts/a11y.ts, which runs
 * on the design fixture, a passkey household where this panel never shows), and whether the page scrolls sideways.
 * Never touches the review database or the services on 5174 to 5176.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, type Locator, type Page } from '@playwright/test'
import { startExtraStack } from '../browser/support/stack.ts'
import { authenticatorFor, signUp } from './lib/passkey-client.ts'

const app = join(import.meta.dirname, '..')
const label = process.argv[2] ?? 'password-change'
const port = Number(process.argv[3] ?? 5761)
const out = join(app, 'evidence', 'design', label)
mkdirSync(out, { recursive: true })
const COMBOS = [[1440, 'light'], [390, 'light'], [1440, 'dark'], [390, 'dark']] as const

const stack = await startExtraStack(port, {}, { rail: true })
const base = stack.base
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = [], answers: string[] = []
const report: Record<string, { errors: string[]; answers: string[]; axe: string[]; sideways: boolean }> = {}
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  // a refused request is listed by its answer and path below; the browser's own line for it says nothing more
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  page.on('response', (r) => { if (r.status() >= 400) answers.push(`${r.status()} ${new URL(r.url()).pathname}`) })
  // a virtual platform authenticator, as the browser suite uses (browser/support/passkey.ts), set up here directly
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })

  /** One photograph per width and theme: the whole page, or one element (a sheet is photographed in the viewport it covers). */
  async function shoot(state: string, what: 'page' | 'viewport' | Locator): Promise<void> {
    for (const [w, theme] of COMBOS) {
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      if (what === 'page') await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(450)
      const path = join(out, `${state}-${w}-${theme}.png`)
      if (what === 'page' || what === 'viewport') await page.screenshot({ path, fullPage: what === 'page', animations: 'disabled' })
      else await what.screenshot({ path, animations: 'disabled' })
      const axe = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      report[`${state} ${w} ${theme}`] = { errors: errors.splice(0), answers: answers.splice(0), axe: axe.violations.map((v) => `${v.id}: ${v.nodes.length}`), sideways }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
  }

  // the account, opened with a password, and its household
  const handle = `meera${Date.now().toString(36)}`, password = `${randomBytes(9).toString('base64url')} phrase`
  const made = await (await ctx.request.post(`${base}/api/auth/signup`, { data: { handle, password, displayName: 'Meera Nair' }, headers: { 'x-qed-client': 'web' } })).json() as { csrf: string }
  await ctx.request.post(`${base}/api/household`, { data: {}, headers: { 'x-qed-csrf': made.csrf } })
  const go = async (p: Page) => { await p.goto(`${base}/security`, { waitUntil: 'networkidle' }); await p.getByRole('heading', { name: 'Password', exact: true }).waitFor() }
  await go(page)
  const panel = page.getByRole('region', { name: 'Password', exact: true })
  await shoot('security-password-only', 'page')

  const change = page.getByRole('dialog', { name: 'Change your password' })
  await panel.getByRole('button', { name: 'Change password' }).click()
  await change.getByLabel('Current password', { exact: true }).fill('not the password at all')
  await change.getByLabel('New password', { exact: true }).fill(`${randomBytes(9).toString('base64url')} words`)
  await change.getByRole('button', { name: 'Change password' }).click()
  await change.getByText('That is not the password this account has now.').waitFor()
  await shoot('change-sheet-mistake', 'viewport')
  await change.getByRole('button', { name: 'Cancel' }).click()

  // a passkey, after typing the password again
  const note = page.locator('.note').filter({ hasText: 'This account has no passkey' })
  await note.getByLabel('Password').fill(password)
  await note.getByRole('button', { name: 'Create a passkey' }).click()
  await page.getByText('This account has no passkey').waitFor({ state: 'detached' })
  await shoot('password-panel-with-passkey', panel)
  await panel.getByRole('button', { name: 'Change password' }).click()
  await change.getByText('Your passkey is asked for first, unless you confirmed with it here in the last five minutes.', { exact: false }).waitFor()
  await shoot('change-sheet-passkey', 'viewport')
  await change.getByRole('button', { name: 'Cancel' }).click()
  const remove = page.getByRole('dialog', { name: 'Remove your password' })
  await panel.getByRole('button', { name: 'Remove password' }).click()
  await remove.getByRole('list', { name: 'What removing the password needs' }).waitFor()
  await shoot('remove-sheet-not-ready', 'viewport')
  await remove.getByRole('button', { name: 'Keep the password' }).click()

  // a recovery contact with an account of their own accepts; the stack's protection delay is six seconds
  let cookie = '', csrf = ''
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    const json = (await r.json()) as Record<string, any>
    if (typeof json.csrf === 'string') csrf = json.csrf
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(json)}`)
    return json
  }
  const helper = `arjun${Date.now().toString(36)}`
  await signUp(ok, authenticatorFor(port), helper, 'Arjun Rao')
  await page.getByLabel('Their handle').fill(helper)
  await page.getByRole('button', { name: 'Name as recovery contact' }).click()
  await page.getByText(/waiting for them to accept/).waitFor()
  const link = ((await ok('GET', '/api/security')).trustedBy as { id: string }[])[0]!
  await ok('POST', `/api/security/contacts/${link.id}/accept`)
  await page.waitForTimeout(6500)
  await go(page)
  await panel.getByRole('button', { name: 'Remove password' }).click()
  await remove.getByText(`@${helper} is active and can issue you a recovery code.`).waitFor()
  await shoot('remove-sheet-ready', 'viewport')
  await remove.getByRole('button', { name: 'Remove password' }).click()
  await panel.getByText('Password removed', { exact: true }).waitFor()
  await page.waitForTimeout(600)
  await shoot('password-panel-removed', panel)
  await shoot('security-after-removal', 'page')
  await ctx.close()
} finally {
  await browser.close()
  await stack.stop()
}
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`)
const faults = Object.entries(report).filter(([, v]) => v.errors.length || v.axe.length || v.sideways)
const answered = [...new Set(Object.values(report).flatMap((v) => v.answers))]
console.log(`${Object.keys(report).length} photographs in ${out}; ${faults.length} with a console error, an axe violation or a sideways scroll`)
for (const [k, v] of faults) console.log(`  ${k}: ${[...v.errors, ...v.axe, ...(v.sideways ? ['scrolls sideways'] : [])].join(' | ')}`)
console.log(`  API answers of 400 or more seen (expected where the state calls for them): ${answered.join(', ') || 'none'}`)
process.exit(faults.length ? 1 : 0)
