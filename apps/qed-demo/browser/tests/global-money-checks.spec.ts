/**
 * The M9 checks (DESIGN.md) on the panels the global-money work added (R13 second pass): balances by currency (Home and Save),
 * the paper desk and a goal in another currency (Save), a payee abroad and a payment abroad (Spend), each with money in other
 * currencies held and a look-alike payee waiting for its confirmation. At 320, 390, 1024 and 1440 px in both themes: axe 0
 * (WCAG 2.0 to 2.2 A and AA), nothing wider than the window, and the glass-contrast script's pixel measurement (text over what
 * is really behind it) at 1440 and 390 px. Its own stack (synthetic prices, no network, no chain).
 *
 * QED_CHECKS_OUT: a folder to write the measurement results to (the contrast script's JSON); the session cookie the script
 * needs is written there for the run and removed after, and is never printed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_CHECKS_PORT ?? extraPort(78))
const OUT = process.env.QED_CHECKS_OUT ?? ''
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

async function approveSheet(page: Page, title: string, action: string): Promise<void> {
  const sheet = page.getByRole('dialog', { name: title })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: `${action} with your passkey` }).click()
  await expect(sheet).toBeHidden()
}

test('the new panels pass axe, overflow and glass-contrast checks at four widths in both themes', async ({ browser }) => {
  test.setTimeout(420_000)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const handle = `chk${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)

  // ---- the household: yen and dinars held, a payee in the United States, and a look-alike waiting for its confirmation
  await page.goto(`${s.base}/save`)
  const desk = page.locator('section.fx-desk')
  for (const [code, amount] of [['JPY', '50000'], ['BHD', '25.500']] as const) {
    await desk.getByLabel('Into').selectOption(code)
    await desk.getByRole('button', { name: 'Receive' }).click()
    await desk.getByLabel(`Amount in ${code}`).fill(amount)
    await desk.getByRole('button', { name: 'Get a quote' }).click()
    await approveSheet(page, 'Approve this conversion', 'Approve and convert')
  }
  await page.goto(`${s.base}/pay`)
  const ab = page.locator('section#abroad')
  const addPayee = async (fields: [string, string][], name: string) => {
    await ab.getByRole('button', { name: 'Add a payee abroad' }).click()
    const form = ab.getByRole('form', { name: 'Add a payee abroad' })
    await form.getByLabel('Payee\'s name').fill(name)
    for (const [label, value] of fields) await form.getByLabel(label).fill(value)
    await form.getByRole('button', { name: 'Add this payee abroad' }).click()
    return form
  }
  await addPayee([['Routing number', '021000021'], ['Account number', '123456789']], 'Anita Rao')
  await expect(ab.getByRole('radio', { name: /^Anita Rao/ })).toBeChecked()
  const twin = await addPayee([['Routing number', '021000021'], ['Account number', '123456788']], 'Anita Rao')
  await expect(twin.getByText('This payee looks like one you already have', { exact: true })).toBeVisible()
  const cookie = (await ctx.cookies()).find((c) => c.name === 'qed_session')
  expect(cookie).toBeTruthy()

  // ---- axe and overflow, at four widths in both themes, on the screens that carry the panels (the look-alike note is open on Spend)
  const found: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    for (const width of [320, 390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width <= 390 ? 800 : 900 })
      for (const route of ['/', '/save', '/pay']) {
        await page.goto(`${s.base}${route}`)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        if (route === '/pay') {
          const f = await addPayee([['Routing number', '021000021'], ['Account number', '123456788']], 'Anita Rao')
          await expect(f.getByText('This payee looks like one you already have', { exact: true })).toBeVisible()
        }
        await page.waitForTimeout(300)
        const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        for (const v of r.violations) found.push(`${scheme} ${width} ${route}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        if (wide > 0) found.push(`${scheme} ${width} ${route}: overflows sideways by ${wide}px`)
      }
    }
  }
  expect(found).toEqual([])

  // ---- glass contrast: pixels, not computed colours, at 1440 and 390 in both themes
  if (OUT) {
    mkdirSync(OUT, { recursive: true })
    const file = join(OUT, '.fixture-cookie.json')
    writeFileSync(file, JSON.stringify({ cookie: `${cookie!.name}=${cookie!.value}` }), { mode: 0o600 })
    try {
      for (const scheme of ['light', 'dark']) {
        for (const [w, h] of [[1440, 900], [390, 844]]) {
          const out = join(OUT, `glass-contrast-${scheme}-${w}.json`)
          execFileSync('node', ['scripts/glass-contrast.ts', s.base, '/,/save,/pay', scheme, String(w), String(h), out], { env: { ...process.env, QED_FIXTURE_FILE: file }, stdio: 'pipe', timeout: 150_000 })
        }
      }
    } finally { rmSync(file, { force: true }) }
  }
  expect(errors).toEqual([])
  await ctx.close()
})
