/**
 * An automated accessibility and layout pass over every screen of the running interface.
 *
 *   node scripts/a11y.ts [report.json]          (the engine, the API and the interface must be running)
 *
 * For each screen it runs axe-core's WCAG 2.0, 2.1 and 2.2 level A and AA rules in light and dark at desktop and
 * phone width, checks at seven widths that nothing overflows sideways, and walks it with Tab and Shift+Tab at
 * three sizes to check that a control taking focus is never hidden under a bar pinned to the window (axe has no
 * rule for that). It checks that the keyboard reaches a skip link first and that the focused control is visibly
 * outlined, and that the approval sheet works by keyboard alone. It signs in as the review account, reading the
 * credentials from data/review-account.json. It opens pages and reads them; the one thing it does is prepare a
 * vault deposit to open the approval sheet with the keyboard, and cancel it without approving (when the vault
 * service is running).
 *
 * An automated pass finds a minority of accessibility faults. It does not replace a keyboard walk of each journey
 * or a reading with a screen reader, and the report says so.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(app, 'evidence', 'accessibility.json')
const base = process.env.QED_UI ?? 'http://localhost:5174'
// QED_FIXTURE=1: use the design fixture's session (scripts/design-fixture.ts) instead of the review account's password.
const fixture = process.env.QED_FIXTURE === '1' ? JSON.parse(readFileSync(join(app, 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string } : null
const cred = fixture ? { handle: '', password: '' } : JSON.parse(readFileSync(join(app, 'data', 'review-account.json'), 'utf8')) as { handle: string; password: string }
// 640 is what a 1280 px window shows at 200% zoom; 320 is the same window at 400% (the reflow criterion).
const WIDTHS = [320, 360, 390, 640, 768, 1024, 1440]

const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 60_000 })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
// A fault while drawing a screen is caught by the interface, which then shows a short apology. That apology passes
// every accessibility rule, so a broken screen once went through this script unnoticed. A screen that shows it, or
// that logs an error to the console, is a failure here.
const consoleErrors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${new URL(page.url()).pathname.replace(/(prg|act|rcp)_[a-z0-9]+/g, '$1_…').replace(/\/job\/[0-9a-f-]+/, '/job/…')}: ${m.text().replace(/\s+/g, ' ').slice(0, 160)}`) })
const broken: { screen: string; route: string }[] = []

if (fixture) {
  await context.addCookies([{ name: fixture.cookie.slice(0, fixture.cookie.indexOf('=')), value: fixture.cookie.slice(fixture.cookie.indexOf('=') + 1), url: base }])
  await page.goto(base + '/')
} else {
  await page.goto(base + '/')
  await page.getByRole('button', { name: /Account created before passkeys/ }).click()
  await page.getByLabel('Handle').fill(cred.handle)
  await page.getByLabel('Password').fill(cred.password)
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click()
}
await page.waitForSelector('.home', { timeout: 15_000 })

const ids = await page.evaluate(async () => {
  const j = async (u: string) => (await fetch(u)).json()
  const progs = (await j('/api/programs')).programs as { id: string; kind: string; state: string }[]
  const acts = (await j('/api/activity?limit=120')).actions as { id: string; state: string; receiptId: string | null }[]
  // The vault is a separate service. When it is not running, its inner screens are left out and the report says so.
  const jobs = await fetch('/api/vault/jobs?limit=30').then(async (r) => (r.ok ? ((await r.json()).jobs as { id: string; result?: { outcome?: string } }[]) : [])).catch(() => [])
  return {
    vaultJob: jobs.find((x) => x.result?.outcome === 'executed')?.id ?? '', vaultRefusal: jobs.find((x) => x.result?.outcome === 'refused')?.id ?? '', vaultUp: jobs.length > 0,
    active: progs.find((p) => p.state === 'active' && p.kind === 'invest')?.id ?? '', guard: progs.find((p) => p.kind === 'floor' || p.kind === 'exit')?.id ?? '', draft: progs.find((p) => p.state === 'draft')?.id ?? '',
    done: acts.find((a) => a.state === 'done')?.id ?? '', refused: acts.find((a) => a.state === 'blocked')?.id ?? '', receipt: acts.find((a) => a.receiptId)?.receiptId ?? '',
  }
})
const routes: [string, string][] = ([
  ['Home', '/'], ['Spend', '/pay'], ['Save', '/save'], ['Grow', '/holdings'], ['Protect', '/protect'], ['Activity', '/activity'], ['Statement', '/passbook'], ['Instructions', '/instructions'], ['Choose a kind of instruction', '/instructions/new'], ['Write an instruction', '/instructions/new?kind=invest'],
  ['An instruction in force', `/instructions/${ids.active}`], ['A protective instruction', `/instructions/${ids.guard}`], ['A draft instruction', `/instructions/${ids.draft}`],
  ['Earn', '/earn'], ['On-chain wallet', '/vault'], ...(ids.vaultUp ? [['Wallet: pay and set aside', '/vault/treasury'], ['Wallet: convert', '/vault/convert'], ['Wallet: mandate', '/vault/mandate'], ['Wallet: automatic conversions', '/vault/policy'], ['Wallet: attack tests', '/vault/lab'], ['Wallet: scenarios', '/vault/runs'], ['Wallet: records', '/vault/records'], ['Wallet: an operation, executed', `/vault/job/${ids.vaultJob}`], ['Wallet: an operation, refused', `/vault/job/${ids.vaultRefusal}`]] as [string, string][] : []),
  ['Safeguards', '/safeguards'], ['Security', '/security'], ['Workspace', '/workspace'], ['Readiness', '/readiness'], ['Ask', '/ask'], ['More (phone menu)', '/more'],
  ['Evidence', '/evidence'], ['Notifications', '/notifications'],
  ['A record, done', `/record/${ids.done}`], ['A record, refused', `/record/${ids.refused}`], ['A receipt', `/receipts/${ids.receipt}`],
] as [string, string][]).filter(([, r]) => !/\/(instructions|record|receipts|job)\/$/.test(r)) // a kind of screen the account has no example of is left out

async function settle(p: Page): Promise<void> { try { await p.waitForSelector('main h1, main .statement, main .home', { timeout: 10_000 }) } catch { /* reported as a missing heading below */ } await p.waitForTimeout(700) }

interface Finding { screen: string; route: string; width: number; scheme: string; rule: string; impact: string | null | undefined; help: string; nodes: number; example: string; target: string }
const findings: Finding[] = []
const structure: { screen: string; h1: number; headingOrder: string; title: string }[] = []
const overflow: { screen: string; width: number; scrollWidth: number }[] = []
let runs = 0

for (const [screen, route] of routes) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(base + route)
      await settle(page)
      // Two copies of Playwright's types are installed (the test runner's and axe's); the page object is the same at run time.
      const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      runs++
      for (const v of r.violations) findings.push({ screen, route, width, scheme, rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, example: (v.nodes[0]?.html ?? '').replace(/\s+/g, ' ').slice(0, 220), target: String(v.nodes[0]?.target?.[0] ?? '') })
      if (scheme === 'light' && width === 1440) {
        if (await page.getByText('This page could not be drawn').count()) broken.push({ screen, route })
        const s = await page.evaluate(() => { const hs = [...document.querySelectorAll('main h1, main h2, main h3')].map((h) => Number(h.tagName[1])); let ok = true; for (let i = 1; i < hs.length; i++) if (hs[i]! - hs[i - 1]! > 1) ok = false; return { h1: document.querySelectorAll('h1').length, order: ok ? 'in order' : `skips a level: ${hs.join(' ')}`, title: document.title } })
        structure.push({ screen, h1: s.h1, headingOrder: s.order, title: s.title })
      }
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(base + route)
    await settle(page)
    const sw = await page.evaluate(() => document.documentElement.scrollWidth)
    if (sw > width) overflow.push({ screen, width, scrollWidth: sw })
  }
}

// Keyboard: the first Tab reaches the skip link; then every stop on the passbook has a visible focus outline.
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(base + '/')
await settle(page)
await page.keyboard.press('Tab')
const first = await page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return { text: (e?.textContent ?? '').trim().slice(0, 60), href: e?.getAttribute('href') ?? '' } })
const stops: { what: string; outlined: boolean }[] = []
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab')
  const s = await page.evaluate(() => { const e = document.activeElement as HTMLElement | null; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { what: `${e.tagName.toLowerCase()} ${(e.textContent ?? e.getAttribute('aria-label') ?? '').trim().slice(0, 40)}`, outlined: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 } })
  if (!s) break
  stops.push(s)
}

// A control that takes focus must not be wholly hidden by something the page pins to the window (WCAG 2.2, 2.4.11).
// Two bars are pinned here: the one at the top, and on a phone the one at the bottom. Every screen is walked with
// Tab and back with Shift+Tab at three sizes. Found by hand on 20 November 2026: with nothing telling the browser
// how tall the bars are, 123 stops on seven screens came to rest underneath one.
const FOCUS_SIZES: [string, number, number][] = [['1280 by 720', 1280, 720], ['390 by 844', 390, 844], ['640 by 360 (a 1280 by 720 window at 200%)', 640, 360]]
const focusHidden: { screen: string; size: string; control: string; under: string }[] = []
let focusStops = 0
// Stops at least half hidden are named, not only counted, so a report says where to look.
const focusHalfHidden: { screen: string; size: string; control: string; under: string; hidden: number }[] = []
for (const [size, width, height] of FOCUS_SIZES) {
  await page.setViewportSize({ width, height })
  for (const [screen, route] of routes) {
    await page.goto(base + route)
    await settle(page)
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 70; i++) {
        await page.keyboard.press(key)
        const at = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body || el.closest('.topbar, .dock, .ak-foot, .bottombar, .ask-dock, .composer, .skip-link, dialog')) return null
          const r = el.getBoundingClientRect()
          if (r.height === 0 || r.width === 0) return null
          const control = `${el.tagName.toLowerCase()} ${(el.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`
          if (r.bottom <= 0 || r.top >= window.innerHeight) return { control, hidden: 1, under: 'outside the window' }
          let hidden = 0, under = ''
          // The Ask dock is pinned to the foot of the window on a wide screen (R10), as the tab bar is on a narrow one;
          // the Ask composer sticks above either.
          for (const sel of ['.topbar', '.dock', '.ak-foot', '.bottombar', '.ask-dock', '.composer']) {
            const bar = document.querySelector(sel)
            if (!bar || getComputedStyle(bar).display === 'none') continue
            const b = bar.getBoundingClientRect()
            const part = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)) / r.height
            if (part > hidden) { hidden = part; under = sel === '.topbar' ? 'the bar at the top' : sel === '.dock' ? 'the dock' : sel === '.ak-foot' ? "Ask's composer" : sel === '.ask-dock' ? 'the Ask dock' : sel === '.composer' ? 'the Ask composer' : 'the bar at the bottom' }
          }
          return { control, hidden, under }
        })
        if (!at) continue
        focusStops++
        if (at.hidden >= 0.99) focusHidden.push({ screen, size, control: at.control, under: at.under })
        else if (at.hidden >= 0.5) focusHalfHidden.push({ screen, size, control: at.control, under: at.under, hidden: Math.round(at.hidden * 100) / 100 })
      }
    }
  }
}
await page.setViewportSize({ width: 1440, height: 900 })

// The approval sheet, with the keyboard only. Enter on a button opens it with focus inside; Tab never leaves it;
// Escape closes it; focus comes back to the button. A sheet that drops focus leaves a keyboard user at the top of
// the page (found by hand on 20 November 2026: a busy button was disabled, lost focus, and nothing gave it back).
const motion: { sheetSeconds: number | null; sheetSecondsReduced: number | null; longestTransitionReduced: number | null } = { sheetSeconds: null, sheetSecondsReduced: null, longestTransitionReduced: null }
let sheet: { opened: boolean; focusInsideOnOpen: boolean; labelled: boolean; stopsChecked: number; /** Tab stops that landed on the page behind the sheet. */ stopsOutside: number; closedByEscape: boolean; focusReturnedTo: string } | null = null
if (ids.vaultUp) {
  await page.goto(base + '/vault/treasury')
  await settle(page)
  const opener = page.locator('section[aria-labelledby="tm-h"]').getByRole('button', { name: 'Deposit' })
  if (await opener.count()) {
    await opener.focus()
    await page.keyboard.press('Enter')
    const opened = await page.locator('dialog.sheet[open]').waitFor({ timeout: 20_000 }).then(() => true, () => false)
    await page.waitForTimeout(500)
    const inside = () => page.evaluate(() => { const d = document.querySelector('dialog.sheet[open]'); return !!(d && document.activeElement && d.contains(document.activeElement)) })
    const focusInsideOnOpen = opened && await inside()
    // The sheet's entrance is the one animation left in the interface. Its length as the page computes it.
    motion.sheetSeconds = opened ? await page.locator('dialog.sheet[open]').evaluate((d) => parseFloat(getComputedStyle(d).animationDuration)) : null
    const labelled = opened && await page.locator('dialog.sheet[open]').evaluate((d) => { const id = d.getAttribute('aria-labelledby'); return !!(id && document.getElementById(id)?.textContent?.trim()) })
    // Past the last control, Tab may go to the browser's own toolbar (the page then reports its body as focused) and
    // come back. That is allowed. What must never take focus is anything of the page behind the sheet.
    const behind = () => page.evaluate(() => { const d = document.querySelector('dialog.sheet[open]'); const a = document.activeElement; return !!(a && a !== document.body && !(d && d.contains(a))) })
    let outside = 0, checked = 0
    for (let i = 0; opened && i < 12; i++) { await page.keyboard.press('Tab'); checked++; if (await behind()) outside++ }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
    const closedByEscape = (await page.locator('dialog.sheet[open]').count()) === 0
    const focusReturnedTo = await page.evaluate(() => (document.activeElement === document.body ? 'the top of the page' : (document.activeElement?.textContent ?? '').trim().slice(0, 40)))
    sheet = { opened, focusInsideOnOpen, labelled, stopsChecked: checked, stopsOutside: outside, closedByEscape, focusReturnedTo }
    // The same sheet for someone who has asked their system for less motion: it must appear at once.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await opener.focus()
    await page.keyboard.press('Enter')
    if (await page.locator('dialog.sheet[open]').waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      motion.sheetSecondsReduced = await page.locator('dialog.sheet[open]').evaluate((d) => parseFloat(getComputedStyle(d).animationDuration))
      motion.longestTransitionReduced = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('*')].map((e) => Math.max(...getComputedStyle(e).transitionDuration.split(',').map((t) => parseFloat(t) || 0)))))
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    await page.emulateMedia({ reducedMotion: null })
  }
}
const sheetOk = !sheet || (sheet.opened && sheet.focusInsideOnOpen && sheet.labelled && sheet.stopsOutside === 0 && sheet.closedByEscape && sheet.focusReturnedTo === 'Deposit')
// No more than a fifth of a second normally; effectively nothing when less motion is asked for.
const motionOk = !sheet || ((motion.sheetSeconds ?? 9) <= 0.2 && (motion.sheetSecondsReduced ?? 9) <= 0.001 && (motion.longestTransitionReduced ?? 9) <= 0.001)
await browser.close()

const byRule = new Map<string, { rule: string; impact: string; help: string; screens: Set<string>; occurrences: number; example: string; target: string }>()
for (const f of findings) { const e = byRule.get(f.rule) ?? { rule: f.rule, impact: String(f.impact ?? ''), help: f.help, screens: new Set<string>(), occurrences: 0, example: f.example, target: f.target }; e.screens.add(f.screen); e.occurrences += f.nodes; byRule.set(f.rule, e) }
const report = {
  what: 'Automated accessibility and layout pass over the running interface',
  at: new Date().toISOString(), interface: base, vaultServiceRunning: ids.vaultUp, screens: routes.map(([s, r]) => ({ screen: s, route: r.replace(/(prg|act|rcp)_[a-z0-9]+/g, '$1_…').replace(/\/job\/[0-9a-f-]+/, '/job/…') })),
  axe: { rules: 'WCAG 2.0, 2.1 and 2.2, levels A and AA', runs, combinations: 'light and dark, at 1440 and 390 px', violations: [...byRule.values()].map((v) => ({ ...v, screens: [...v.screens] })), detail: findings },
  structure: { oneH1Everywhere: structure.every((s) => s.h1 === 1), headingsInOrderEverywhere: structure.every((s) => s.headingOrder === 'in order'), perScreen: structure },
  overflow: { widthsChecked: WIDTHS, screensThatOverflow: overflow },
  keyboard: { firstTabStop: first, stopsChecked: stops.length, stopsWithoutAVisibleOutline: stops.filter((s) => !s.outlined), approvalSheet: sheet ?? 'not checked: the vault service is not running' },
  focusNotHidden: { what: 'Every screen walked with Tab and back with Shift+Tab (70 presses each way): a control that takes focus is not wholly under a bar pinned to the window, nor outside the window (WCAG 2.2, 2.4.11)', sizes: FOCUS_SIZES.map(([n]) => n), screens: routes.length, focusStopsChecked: focusStops, whollyHidden: focusHidden, halfOrMoreHidden: focusHalfHidden.length, halfOrMoreHiddenStops: focusHalfHidden },
  motion: sheet ? { what: 'The approval sheet\'s entrance, the one animation in the interface', seconds: motion.sheetSeconds, secondsWhenLessMotionIsAskedFor: motion.sheetSecondsReduced, longestTransitionWhenLessMotionIsAskedFor: motion.longestTransitionReduced } : 'not checked: the vault service is not running',
  pageErrors,
  screensThatFailedToDraw: broken,
  consoleErrors: [...new Set(consoleErrors)],
  notCovered: ['Reading with a screen reader', 'A keyboard walk of every journey to its end (the approval sheet is opened, tabbed through and closed with the keyboard, not approved)', 'Text enlarged by the browser\'s text-only setting (layout is checked at 640 and 320 px, which is a 1280 px window zoomed to 200% and 400%)', 'Windows high-contrast mode', 'Whether the words themselves are understood'],
}
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
console.log(`[a11y] ${runs} axe runs over ${routes.length} screens: ${byRule.size} rule${byRule.size === 1 ? '' : 's'} violated${byRule.size ? ` (${[...byRule.values()].map((v) => `${v.rule}: ${v.occurrences} on ${v.screens.size} screen${v.screens.size === 1 ? '' : 's'}`).join('; ')})` : ''}.`)
console.log(`[a11y] one h1 everywhere: ${report.structure.oneH1Everywhere}; headings in order: ${report.structure.headingsInOrderEverywhere}; overflow: ${overflow.length ? overflow.map((o) => `${o.screen} at ${o.width} (${o.scrollWidth})`).join('; ') : 'none at ' + WIDTHS.join(', ')}.`)
console.log(`[a11y] first Tab stop: "${first.text}"; ${stops.length} stops checked, ${report.keyboard.stopsWithoutAVisibleOutline.length} without a visible outline. Page errors: ${pageErrors.length}. Report: ${out}`)
console.log(`[a11y] approval sheet by keyboard: ${sheet ? `opened ${sheet.opened}, focus inside ${sheet.focusInsideOnOpen}, labelled ${sheet.labelled}, ${sheet.stopsOutside} of ${sheet.stopsChecked} Tab stops on the page behind it, closed by Escape ${sheet.closedByEscape}, focus back on "${sheet.focusReturnedTo}"` : 'not checked (vault service not running)'}.`)
console.log(`[a11y] focus under a pinned bar: ${focusStops} focus stops over ${routes.length} screens at ${FOCUS_SIZES.length} sizes; wholly hidden ${focusHidden.length}${focusHidden.length ? ` (${focusHidden.slice(0, 3).map((f) => `${f.screen}, ${f.size}: ${f.control} under ${f.under}`).join(' | ')})` : ''}; half or more hidden ${focusHalfHidden.length}${focusHalfHidden.length ? ` (${focusHalfHidden.slice(0, 8).map((f) => `${f.screen}, ${f.size}: ${f.control} under ${f.under}`).join(' | ')})` : ''}.`)
console.log(`[a11y] motion: ${sheet ? `the sheet enters in ${motion.sheetSeconds} s; with less motion asked for, ${motion.sheetSecondsReduced} s, and the longest transition on the page is ${motion.longestTransitionReduced} s` : 'not checked'}.`)
console.log(`[a11y] screens that failed to draw: ${broken.length ? broken.map((b) => b.screen).join(', ') : 'none'}; console errors: ${new Set(consoleErrors).size}${consoleErrors.length ? ` (${[...new Set(consoleErrors)].slice(0, 3).join(' | ')})` : ''}.`)
process.exit(byRule.size || overflow.length || pageErrors.length || broken.length || consoleErrors.length || !sheetOk || !motionOk || focusHidden.length ? 1 : 0)
