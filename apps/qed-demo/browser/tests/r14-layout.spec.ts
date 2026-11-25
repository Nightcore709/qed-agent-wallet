/**
 * The R14 layout rules (DESIGN.md, "R14 layout rules") on the rendered screens of a stack of its own (synthetic prices,
 * no network, no chain). Each check is a fault the owner marked on a screenshot on 25 Nov 2026:
 *
 *   L4  a household in US dollars read a rupee sign in every amount field. The sign, the grouping and the decimal
 *       places of every amount field follow the household's currency, at set-up as the currency is chosen and on every
 *       screen afterwards; what is typed is booked as that currency's own minor units.
 *   L2  the summary beside the set-up form stopped at the top of the window with a hole under it at the end of the page.
 *       It starts level with the form and ends level with it.
 *   L1  page text read through the top bar, and the bottom navigation covered controls. The bars are solid, the page ends
 *       clear of the navigation, and nothing that takes focus by keyboard sits under either bar, at five widths.
 *   L5  the balance chart's labels ran over the line and each other, and the pointer's label sat on the axis figures.
 *       Marks touch nothing, every marked day is named under the chart, and the label stays inside the plot.
 *
 * The stylesheet's own writing is read too (::before, ::after): the rupee sign lived in a CSS rule, where a page's
 * text does not show it and the earlier journey (home-currency.spec.ts) could not see it.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_R14_LAYOUT_PORT ?? extraPort(86))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

async function signUp(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Open your paper household' })).toBeVisible()
}

/** Every amount field on the page: the sign the stylesheet draws, where it ends, where the digits begin, and the digits. */
const amountFields = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.money')].map((m) => {
  const input = m.querySelector('input')!
  const b = getComputedStyle(m, '::before')
  return { sign: b.content.replace(/^"|"$/g, ''), signEnd: parseFloat(b.left) + parseFloat(b.width), digitsFrom: parseFloat(getComputedStyle(input).paddingLeft), value: input.value, label: input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? '' : input.getAttribute('aria-label') ?? '' }
}))
/** Every rupee sign a person would read on the page: in its text, and in what the stylesheet writes before or after an element. */
const rupeeSigns = (page: Page) => page.evaluate(() => {
  const found = [...document.body.innerText.matchAll(/.{0,40}₹.{0,24}/g)].map((m) => `text: ${m[0].replace(/\s+/g, ' ')}`)
  for (const el of document.body.querySelectorAll('*')) for (const which of ['::before', '::after']) {
    if (getComputedStyle(el, which).content.includes('₹')) found.push(`stylesheet: ${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')}${which}`)
  }
  return found
})

test('L4, L2: a US dollar household reads its own sign in every amount field, and the set-up summary ends level with the form', async ({ browser }) => {
  test.setTimeout(240_000)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const handle = `l4${Date.now().toString(36)}`
  await signUp(page, handle)

  // ---- set-up: the rupee by default, then each currency the set-up offers; every field follows at once
  const SIGNS: [string, string][] = [['INR', '₹'], ['EUR', '€'], ['GBP', '£'], ['AED', 'AED'], ['SGD', 'SGD'], ['USD', 'USD']]
  for (const [code, sign] of SIGNS) {
    if (code !== 'INR') { await page.getByLabel('Home currency').selectOption(code); await expect(page.locator('.setup-basis')).toContainText(/converted at [\d.]+ rupees to one /) }
    await expect(page.locator('.money').first()).toHaveAttribute('data-sign', sign)
    const fields = await amountFields(page)
    expect(fields.length, `${code}: ten amount fields at set-up`).toBe(10)
    for (const f of fields) {
      expect(f.sign, `${code}: the sign of "${f.label}"`).toBe(sign)
      expect(f.digitsFrom, `${code}: the digits of "${f.label}" begin after its sign`).toBeGreaterThanOrEqual(f.signEnd + 4)
    }
    // the rupee groups in lakh (8,00,000); every other currency in thousands
    const bank = fields.find((f) => f.label === 'In your bank account')!.value
    if (code === 'INR') expect(bank).toBe('8,00,000'); else expect(bank, `${code} groups in thousands`).toMatch(/^\d{1,3}(,\d{3})*$/)
    if (code !== 'INR') expect(await rupeeSigns(page), `${code}: no rupee sign at set-up`).toEqual([])
  }

  // ---- L2: the summary starts level with the form and, at the end of the page, ends level with it
  const edges = () => page.evaluate(() => { const a = document.querySelector('.setup-side')!.getBoundingClientRect(), f = document.querySelector('.setup-form')!.getBoundingClientRect(); return { sideTop: a.top, sideBottom: a.bottom, formTop: f.top, formBottom: f.bottom, window: innerHeight } })
  for (const height of [700, 900, 1200]) {
    await page.setViewportSize({ width: 1440, height })
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect.poll(async () => { const e = await edges(); return Math.abs(e.sideTop - e.formTop) }, { message: `${height}: starts level` }).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(async () => { const e = await edges(); return Math.abs(e.sideBottom - e.formBottom) }, { message: `${height}: ends level` }).toBeLessThanOrEqual(2)
    const e = await edges()
    expect(e.sideBottom, `${height}: the action is inside the window at the end`).toBeLessThanOrEqual(e.window)
    expect(e.sideTop, `${height}: the summary is inside the window at the end`).toBeGreaterThanOrEqual(0)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => window.scrollTo(0, 0))

  // ---- what is typed is that currency's own amount: 12,345.67 dollars is 1,234,567 cents in the bank
  await page.getByLabel('In your bank account').fill('12,345.67')
  await page.getByLabel('In a fixed deposit').focus()
  await expect(page.getByLabel('In your bank account')).toHaveValue('12,345.67')
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Here is your money')
  const [me] = s.query<{ id: string; profile_json: string }>('SELECT id, profile_json FROM users WHERE handle = ?', handle)
  expect((JSON.parse(me!.profile_json) as { homeCurrency: string }).homeCurrency).toBe('USD')
  expect(s.query<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, me!.id)).toEqual([{ t: '1234567' }])

  // ---- every screen with an amount field: the dollar's sign in each, the digits clear of it, and no rupee sign in the
  // text or in what the stylesheet writes
  let read = 0
  for (const path of ['/', '/save', '/pay', '/safeguards', '/instructions/new?kind=goal', '/instructions/new?kind=bills', '/workspace']) {
    await page.goto(`${s.base}${path}`)
    await expect(page.locator('main').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    const fields = await amountFields(page)
    read += fields.length
    for (const f of fields) {
      expect(f.sign, `${path}: the sign of "${f.label}"`).toBe('USD')
      expect(f.digitsFrom, `${path}: the digits of "${f.label}" begin after its sign`).toBeGreaterThanOrEqual(f.signEnd + 4)
    }
    expect(await rupeeSigns(page), `${path}: no rupee sign`).toEqual([])
  }
  expect(read, 'amount fields were read on those screens').toBeGreaterThanOrEqual(6)

  // ---- Grow: rupee-quoted instruments keep their rupees (a non-rupee household cannot trade them), but the
  // household's own figures are in its own currency (R14: they were written with the rupee formatter)
  await page.goto(`${s.base}/holdings`)
  await expect(page.locator('main').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  for (const name of ['Your worst case', 'Your floor']) {
    const dd = page.locator('dt', { hasText: name }).first().locator('xpath=following-sibling::dd[1]')
    await expect(dd, `Grow: ${name}`).toContainText('USD')
    await expect(dd, `Grow: ${name}`).not.toContainText('₹')
  }
  expect(errors).toEqual([])
  await ctx.close()
})

test('L1, L5: nothing sits under the bars at five widths, and the balance chart\'s marks and label touch nothing', async ({ browser }) => {
  test.setTimeout(300_000)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await signUp(page, `l1${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Here is your money')

  const bars = () => page.evaluate(() => {
    const rect = (sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    // the alpha of a bar's own ground, drawn on a canvas so any colour syntax the browser reports is read the same way
    const alpha = (sel: string) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d')!; g.fillStyle = getComputedStyle(document.querySelector(sel)!).backgroundColor; g.fillRect(0, 0, 1, 1); return g.getImageData(0, 0, 1, 1).data[3]! / 255 }
    return { top: rect('.topbar'), dock: rect('.dock'), main: rect('.main'), topAlpha: alpha('.topbar'), dockAlpha: alpha('.dock'), window: innerHeight }
  })

  for (const [width, height] of [[1440, 900], [1024, 768], [900, 800], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(`${s.base}/`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Here is your money')
    await page.waitForLoadState('networkidle')
    const at = `${width} px`

    // solid bars: the page is never read through one, whether or not the browser draws the blur
    const b0 = await bars()
    expect(b0.topAlpha, `${at}: the top bar is solid`).toBeGreaterThanOrEqual(0.95)
    expect(b0.dockAlpha, `${at}: the bottom navigation is solid`).toBeGreaterThanOrEqual(0.95)
    expect(b0.main.top, `${at}: the page starts under the top bar`).toBeGreaterThanOrEqual(b0.top.bottom)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${at}: no sideways scroll`).toBe(true)

    // by keyboard: whatever takes focus is clear of both bars (the browser scrolls it there; L1)
    let seen = 0
    for (let i = 0; i < 140; i++) {
      await page.keyboard.press('Tab')
      const f = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return null
        const r = el.getBoundingClientRect()
        return { inBar: !!el.closest('.topbar, .dock, .skip-link'), inMain: !!el.closest('.main'), name: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 50), top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
      })
      if (!f || f.inBar || !f.inMain) { if (seen > 0 && f?.inBar) break; continue }
      seen++
      const b = await bars()
      const under = (bar: { top: number; bottom: number; left: number; right: number }) => f.bottom > bar.top + 1 && f.top < bar.bottom - 1 && f.right > bar.left + 1 && f.left < bar.right - 1
      // something taller than the room between the bars cannot clear both: its start must clear the top bar
      if (f.height < b.dock.top - b.top.bottom) expect(under(b.dock), `${at}: "${f.name}" takes focus under the bottom navigation`).toBe(false)
      expect(f.top >= b.top.bottom - 1 || !under(b.top), `${at}: "${f.name}" takes focus under the top bar`).toBe(true)
    }
    expect(seen, `${at}: controls were reached by keyboard`).toBeGreaterThanOrEqual(8)

    // at the end of the page, the page itself ends above the navigation: the last control is never under it
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(async () => { const b = await bars(); return b.main.bottom <= b.dock.top }, { message: `${at}: the page ends above the bottom navigation` }).toBe(true)
  }

  // ---- an address's #anchor lands just under the top bar: clear of it, and not a second bar's height below it
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${s.base}/save#goals`)
  await expect(page.locator('#goals')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => { const t = document.getElementById('goals')!.getBoundingClientRect().top, bar = document.querySelector('.topbar')!.getBoundingClientRect().bottom; return t - bar }), { message: 'the anchor lands just under the top bar' }).toBeLessThanOrEqual(40)
  expect(await page.evaluate(() => document.getElementById('goals')!.getBoundingClientRect().top - document.querySelector('.topbar')!.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(0)

  // ---- L5: Home's balance chart, and Save's
  for (const [path, plotSel, chartSel] of [['/', '.hz-plot', '.horizon'], ['/save', '.sc-plot', '.sc']] as const) {
    await page.goto(`${s.base}${path}`)
    const plot = page.locator(plotSel)
    await plot.scrollIntoViewIfNeeded()
    await expect(plot.locator('.cv-mark').first()).toBeVisible()
    // nothing is written across the line any more: the plot's only words are the dates along its foot
    const chart = await page.evaluate((sel) => {
      const plot = document.querySelector(sel)!
      const marks = [...plot.querySelectorAll('g.cv-mark')].map((g) => { const r = g.querySelector('circle')!.getBoundingClientRect(); return { n: g.textContent ?? '', x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 } })
      const rows = [...plot.closest('.sc, .horizon')!.querySelectorAll('.cv-events li')].map((li) => `${li.querySelector('.cv-what')!.textContent} | ${li.querySelector('.cv-amt')!.textContent}`)
      const words = [...plot.querySelectorAll('svg text')].filter((t) => !t.closest('.cv-mark')).map((t) => t.textContent ?? '')
      return { marks, rows, words }
    }, plotSel)
    expect(chart.marks.length, `${path}: days money moves are marked`).toBeGreaterThanOrEqual(2)
    for (const a of chart.marks) for (const b of chart.marks) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y), `${path}: marks ${a.n} and ${b.n} do not touch`).toBeGreaterThanOrEqual(a.r + b.r)
    // each mark's number names a row under the chart, with the day and the sum
    for (const m of chart.marks) expect(chart.rows.some((r) => new RegExp(`^${m.n}\\. .+\\d{1,2} [A-Z][a-z]{2} \\| [+−].*\\d`).test(r)), `${path}: mark ${m.n} is named under the chart with its day and its amount: ${chart.rows.join(' / ')}`).toBe(true)
    expect(chart.words.every((w) => /^(Today|\d{1,2} [A-Z][a-z]{2}|Empty: .*)$/.test(w)), `${path}: no sentence on the plot (${chart.words.join(' | ')})`).toBe(true)
    // by keyboard: every day read, the label inside the plot (never over the axis figures or the dates), then the statement
    await plot.focus()
    for (const key of ['Home', 'ArrowRight', 'End', 'PageUp', 'PageUp']) {
      await page.keyboard.press(key)
      const tip = page.locator(`${plotSel} .cv-tip`)
      await expect(tip).toBeVisible()
      await expect.poll(async () => page.evaluate((sel) => {
        const p = document.querySelector(sel)!.getBoundingClientRect(), t = document.querySelector(`${sel} .cv-tip`)!.getBoundingClientRect()
        return t.left >= p.left - 1 && t.right <= p.right + 1 && t.top >= p.top - 1 && t.bottom <= p.bottom - 28
      }, plotSel), { message: `${path}: after ${key} the label is inside the plot, above the dates` }).toBe(true)
    }
    await page.keyboard.press('Escape')
    const tools = page.locator(chartSel).first() // the plot is not drawn while the statement is shown
    await tools.getByRole('button', { name: 'Statement' }).click()
    await expect(tools.getByRole('table')).toBeVisible()
    await expect(tools.getByRole('row').nth(1)).toContainText('In your bank account now')
    await tools.getByRole('button', { name: 'Chart', exact: true }).click()
  }
  expect(errors).toEqual([])
  await ctx.close()
})
