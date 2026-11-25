/**
 * Photographs Spend and Save of the running R14 fixture (scripts/r14-spend-save-fixture.ts) as whole scrollable pages, for
 * each of its households, at each width, so the composition can be read before and after a change.
 *
 *   node scripts/r14-spend-save-shots.ts <label> [household ...]      e.g. node scripts/r14-spend-save-shots.ts before inr-empty
 *
 * QED_WIDTHS narrows the widths (default 1440,1280,1024,768,390); "720@2" is 1440 px at 200% zoom (720 CSS px, two device
 * pixels each). QED_THEMES is dark (the default), light, or both. QED_UI=<url> photographs another server that proxies the
 * same API. Writes evidence/design/r14-spend-save/<label>/<household>-<screen>-<width>[-light].png and report.json
 * (console errors, and any element wider than the page, per picture).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'r14-spend-save-fixture.json'), 'utf8')) as { base: string; households: Record<string, { cookie: string }> }
const label = process.argv[2] ?? 'shots'
const only = process.argv.slice(3)
const base = process.env.QED_UI ?? fx.base
const widths = (process.env.QED_WIDTHS ?? '1440,1280,1024,768,390').split(',')
const themes = (process.env.QED_THEMES ?? 'dark').split(',') as ('light' | 'dark')[]
const out = join(app, 'evidence', 'design', 'r14-spend-save', label)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report: Record<string, { errors: string[]; overflow: string[] }> = {}

/** Wait until the screen's own data is drawn: no skeleton, no "Reading…" line, fonts ready. */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.fonts.status === 'loaded', undefined, { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(700)
}
/** Anything that reaches past the page's right edge (a sideways scroll on a phone). */
const overflow = (page: Page): Promise<string[]> => page.evaluate(() => {
  const w = document.documentElement.clientWidth
  const bad: string[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('main *'))) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > w + 1 && !el.closest('.table-scroll, .sr')) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.right - w)}px`)
    if (bad.length > 8) break
  }
  return bad
})

const screens: [string, string, ((page: Page) => Promise<void>)?][] = [
  ['spend', '/pay'],
  ['spend-chain', '/pay', async (page) => { await page.getByRole('button', { name: /On-chain wallet/ }).click(); await settled(page) }],
  ['save', '/save'],
]

const PARTS: Record<string, [string, string][]> = {
  spend: [['checkout', '.pay-checkout'], ['bills', '.pay-bills'], ['subscriptions', '.pay-subs'], ['abroad', '#abroad'], ['services', '.pay-commerce'], ['payments', '.pay-paid']],
  'spend-chain': [['checkout', '.pay-checkout']],
  save: [['reserve', '.sv-top'], ['goals', '#goals'], ['currencies', '.ccy-save'], ['flow', '#flow'], ['board', '.sv-board']],
}

for (const theme of process.env.QED_STATES === '1' ? [] : themes) {
  for (const [key, h] of Object.entries(fx.households)) {
    if (only.length && !only.includes(key)) continue
    const [name, value] = [h.cookie.slice(0, h.cookie.indexOf('=')), h.cookie.slice(h.cookie.indexOf('=') + 1)]
    for (const spec of widths) {
      const [w, scale] = spec.split('@').map(Number) as [number, number | undefined]
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: scale ?? 1, reducedMotion: 'reduce', locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
      await ctx.addCookies([{ name, value, url: base }])
      const page = await ctx.newPage()
      for (const [screen, path, then] of screens) {
        const errors: string[] = []
        const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) }
        page.on('console', onConsole)
        await page.goto(base + path)
        await settled(page)
        if (then) await then(page)
        const file = `${key}-${screen}-${spec.replace('@', 'x')}${theme === 'light' ? '-light' : ''}.png`
        await page.screenshot({ path: join(out, file), fullPage: true })
        report[file] = { errors, overflow: await overflow(page) }
        // QED_PARTS=1: each part of the screen as its own picture too, at full size, to read its composition closely
        if (process.env.QED_PARTS === '1') {
          for (const [part, sel] of PARTS[screen] ?? []) {
            const el = page.locator(sel).first()
            if (await el.count()) await el.screenshot({ path: join(out, file.replace('.png', `--${part}.png`)) }).catch(() => undefined)
          }
        }
        page.off('console', onConsole)
      }
      await ctx.close()
    }
  }
}
// QED_STATES=1: the states a still page does not show (a payee and an amount chosen, forms open, a what-if, the quotes),
// for the household with data, each part photographed as it stands. Nothing is signed: no passkey is used here.
if (process.env.QED_STATES === '1' && fx.households['inr-data']) {
  const h = fx.households['inr-data']
  const [name, value] = [h.cookie.slice(0, h.cookie.indexOf('=')), h.cookie.slice(h.cookie.indexOf('=') + 1)]
  for (const spec of widths) {
    const [w, scale] = spec.split('@').map(Number) as [number, number | undefined]
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: themes[0] ?? 'dark', deviceScaleFactor: scale ?? 1, reducedMotion: 'reduce', locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
    await ctx.addCookies([{ name, value, url: base }])
    const page = await ctx.newPage()
    const part = async (sel: string, state: string) => { await page.waitForTimeout(350); await page.locator(sel).first().screenshot({ path: join(out, `state-${state}-${spec.replace('@', 'x')}.png`) }).catch((e: unknown) => console.log(`  ${state}: ${String(e).slice(0, 120)}`)) }
    const step = async (state: string, fn: () => Promise<void>) => { try { await fn() } catch (e) { console.log(`  ${state} (${spec}): ${String(e).split('\n')[0]!.slice(0, 160)}`) } }
    await page.goto(base + '/pay'); await settled(page)
    await step('spend-filled', async () => {
      await page.getByRole('radio', { name: /City Power/ }).check({ force: true })
      await page.getByLabel('How much').fill('1200')
      await page.getByLabel('Note for your records').fill('Electricity, part')
      await part('.pay-checkout', 'spend-filled')
    })
    await step('spend-over-free', async () => { await page.getByLabel('How much').fill('650000'); await part('.pay-checkout', 'spend-over-free') })
    await step('spend-add-payee', async () => {
      await page.getByRole('button', { name: 'Add a payee', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill('Ravi Kumaar')
      await page.getByLabel('Payment address').fill('ravi.kumar@upi')
      await page.getByRole('button', { name: 'Add this payee' }).click()
      await page.getByText('I checked this address with the payee myself').waitFor({ timeout: 8000 })
      await part('.pay-add', 'spend-add-payee-name-check')
    })
    await step('spend-add-bill', async () => { await page.getByRole('button', { name: 'Put a bill on record' }).click(); await part('.pay-bills', 'spend-add-bill') })
    await step('spend-abroad', async () => {
      await page.getByRole('radio', { name: /Anika Rao/ }).check({ force: true })
      await page.getByLabel(/Amount they receive/).fill('120')
      await part('#abroad', 'spend-abroad-chosen')
      await page.getByRole('button', { name: 'Add a payee abroad' }).click()
      await part('#abroad', 'spend-abroad-adding')
    })
    await step('spend-quotes', async () => {
      await page.getByRole('button', { name: 'Compare the two quotes' }).click()
      await page.locator('.cm-quotes').waitFor({ timeout: 8000 })
      await page.getByText('Sign a different mandate').click()
      await part('.pay-commerce', 'spend-services-quotes')
    })
    await page.goto(base + '/save'); await settled(page)
    await step('save-allows', async () => { await page.getByRole('button', { name: 'Change what it allows for' }).click(); await part('.sv-top', 'save-allows-editing') })
    await step('save-what-if', async () => { await page.getByLabel('You spend this today').fill('300000'); await page.getByLabel('A new cost each month').fill('40000'); await part('#flow', 'save-what-if') })
    await step('save-fx-goal', async () => { await page.getByRole('button', { name: 'Add a goal in another currency' }).click(); await part('.fx-goals', 'save-fx-goal-adding') })
    await step('save-fx-quote', async () => {
      await page.getByLabel(/^Amount in/).fill('100')
      await part('.fx-desk', 'save-fx-desk-filled')
      await page.getByRole('button', { name: 'Get a quote' }).click()
      await page.getByRole('dialog').waitFor({ timeout: 8000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(out, `state-save-fx-quote-sheet-${spec.replace('@', 'x')}.png`) })
    })
    await ctx.close()
  }
}
await browser.close()
// one report for the folder: a later run for one household or one width adds to it
const whole = { ...(existsSync(join(out, 'report.json')) ? JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as typeof report : {}), ...report }
writeFileSync(join(out, 'report.json'), `${JSON.stringify(whole, null, 1)}\n`)
const bad = Object.entries(report).filter(([, r]) => r.errors.length || r.overflow.length)
console.log(`${Object.keys(report).length} pictures in ${out}; ${bad.length} with a console error or a sideways overflow`)
for (const [f, r] of bad) console.log(`  ${f}: ${[...r.errors, ...r.overflow].join(' | ')}`)
