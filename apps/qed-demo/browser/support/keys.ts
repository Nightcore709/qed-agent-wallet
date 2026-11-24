/**
 * Keyboard-only helpers for the journeys in tests/keyboard-*.spec.ts (D2): reach a control with Tab and operate it with
 * Enter, Space, arrows or typing; every stop is checked for a visible focus indicator; a walk through a page checks the
 * order and that focus is not trapped. Nothing here clicks, fills or scripts a control. A screen-reader review is not
 * part of it and has not been done.
 */
import { expect, type Locator, type Page } from './test.ts'

/**
 * The key that moves focus to the next control. Safari's default (and so WebKit's) is that Tab reaches text fields only
 * and Option+Tab reaches every control, unless the person turns on "Press Tab to highlight each item"; that is the
 * browser's setting, not the page's, so WebKit journeys press Option+Tab (measured: Tab alone gave i,BODY,i,BODY on a
 * page of two buttons, a field and a link; Option+Tab gave all four).
 */
export const tab = (page: Page, back = false): string => `${page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+' : ''}${back ? 'Shift+' : ''}Tab`

export interface Stop { name: string; tag: string; x: number; y: number; fixed: boolean; ring: string }

/** What the focused element is and how its focus is drawn, read in the page. */
async function readFocus(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    // past the last control, Chrome puts focus on the body and Firefox hands it to the browser's own controls (the page no longer has focus)
    if (!el || el === document.body || el === document.documentElement || !document.hasFocus()) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const drawn = (c: CSSStyleDeclaration) => ({
      outline: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 2 && !/(\/ ?0|, 0)\)$/.test(c.outlineColor),
      shadow: c.boxShadow !== 'none' && /\b[1-9]\d*px\b/.test(c.boxShadow.replace(/\([^)]*\)/g, '')),
    })
    // the control itself, or a field that wraps it and lights up while it holds focus (the Ask bar, a search row)
    let own = drawn(cs)
    for (let a: HTMLElement | null = el.parentElement, n = 0; a && n < 3 && !own.outline && !own.shadow; a = a.parentElement, n++) if (a.matches(':focus-within')) own = drawn(getComputedStyle(a))
    const outline = own.outline, shadow = own.shadow
    let fixed = false
    for (let n: HTMLElement | null = el; n; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') { fixed = true; break } }
    const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby')!.split(' ')[0]!)?.textContent || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent || el.getAttribute('title') || el.id || ''
    return { name: label.replace(/\s+/g, ' ').trim().slice(0, 60), tag: el.tagName.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top + window.scrollY), fixed, ring: outline ? 'outline' : shadow ? 'shadow' : 'none' }
  })
}

/** The focused element has a visible focus indicator (outline of 2 px or more, or a drawn shadow) and is on screen. */
export async function expectFocusVisible(page: Page, what = 'the focused control'): Promise<Stop> {
  const s = await readFocus(page)
  expect(s, `${what}: something has focus`).not.toBeNull()
  expect(s!.ring, `${what} ("${s!.name}") shows where focus is`).not.toBe('none')
  const inView = await page.evaluate(() => { const r = document.activeElement!.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth })
  expect(inView, `${what} ("${s!.name}") is on screen`).toBe(true)
  return s!
}

/** Press Tab until the target has focus (it must be in the tab order within `max` presses), then check its focus indicator. */
export async function tabTo(page: Page, target: Locator, max = 160): Promise<void> {
  await expect(target).toBeVisible({ timeout: 20_000 })
  for (let i = 0; i <= max; i++) {
    if (await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 1000 }).catch(() => false)) { await expectFocusVisible(page, target.toString()); return }
    await page.keyboard.press(tab(page))
  }
  throw new Error(`Not reachable with Tab within ${max} presses: ${target.toString()}`)
}
export const press = async (page: Page, target: Locator, key = 'Enter'): Promise<void> => { await tabTo(page, target); await page.keyboard.press(key) }
/** Reach a field, replace what is in it, and type. */
export const type = async (page: Page, target: Locator, text: string): Promise<void> => { await tabTo(page, target); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(text) }
/**
 * Reach a select and choose an option by its text, typed (type-ahead), then Enter to commit if the browser opened its
 * list. Arrow keys alone are not used: on macOS they only open the list, on other systems they change the value.
 */
export async function choose(page: Page, select: Locator, want: string | RegExp | { value: string }): Promise<void> {
  await tabTo(page, select)
  const opts = await select.locator('option').evaluateAll((o) => o.map((x) => ({ value: (x as HTMLOptionElement).value, text: (x.textContent ?? '').trim() })))
  const hit = opts.find((o) => typeof want === 'string' ? o.text === want : want instanceof RegExp ? want.test(o.text) : o.value === want.value)
  if (!hit) throw new Error(`No option ${String(typeof want === 'object' && 'value' in want ? want.value : want)} in ${select.toString()}`)
  await page.keyboard.type(hit.text.slice(0, 24))
  if ((await select.inputValue()) !== hit.value) await page.keyboard.press('Enter')
  await expect(select, `${select.toString()} shows ${hit.text}`).toHaveValue(hit.value)
}
/** Reach a radio group and choose a radio by arrow keys (a group is one tab stop; arrows move and check). */
export async function radio(page: Page, target: Locator): Promise<void> {
  const group = target.evaluate((el) => (el as HTMLInputElement).name)
  const name = await group
  const peers = page.locator(`input[type=radio][name="${name}"]`)
  const n = await peers.count()
  let first: Locator | null = null
  for (let i = 0; i < n; i++) if (await peers.nth(i).isChecked()) first = peers.nth(i)
  await tabTo(page, first ?? peers.first())
  for (let i = 0; i <= n && !(await target.isChecked()); i++) await page.keyboard.press('ArrowDown')
  await expect(target).toBeChecked()
  await expectFocusVisible(page, 'the radio group')
}

/** A sheet that has just opened holds the focus: a keyboard user starts inside it, not behind it. */
export async function focusInDialog(page: Page): Promise<void> {
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true)
}
/** Focus is in the open sheet, or has gone up to the browser's own controls (a modal dialog's page behind it is inert): never on the page behind. */
const inSheetOrChrome = (page: Page): Promise<boolean> => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || a === document.documentElement || !!a.closest('dialog[open]') })
/** Tab and Shift+Tab inside an open sheet stay inside it (the trap is deliberate and escapable), and Escape closes it and returns focus to what opened it. */
export async function sheetKeepsFocusAndEscapes(page: Page, opener: Locator): Promise<void> {
  await focusInDialog(page)
  const seen = new Set<string>()
  for (let i = 0; i < 14; i++) { await page.keyboard.press(tab(page)); expect(await inSheetOrChrome(page), 'Tab never reaches the page behind the sheet').toBe(true); if (await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))) { const s = await expectFocusVisible(page, 'a control in the sheet'); seen.add(`${s.tag}:${s.name}`) } }
  for (let i = 0; i < 3; i++) { await page.keyboard.press(tab(page, true)); expect(await inSheetOrChrome(page), 'Shift+Tab never reaches the page behind the sheet').toBe(true) }
  expect(seen.size, 'the sheet has more than one place to stop').toBeGreaterThan(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener, 'focus returns to what opened the sheet').toBeFocused()
}

/**
 * Tab through the page from the top until focus leaves it (the end of the page) or comes back to the first stop.
 * Checks: every stop shows a focus indicator and is reached on screen; nothing has a positive tabindex; the order
 * follows the page (a step back up is allowed only into the next column); focus is never stuck on one control; and
 * Shift+Tab from the end walks back through the same stops. Returns the stops.
 */
export async function walkPage(page: Page, max = 220): Promise<Stop[]> {
  await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur() })
  const positive = await page.evaluate(() => [...document.querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0).map((e) => e.outerHTML.slice(0, 80)))
  expect(positive, 'no positive tabindex').toEqual([])
  const stops: Stop[] = []
  let ended = false, leftPage = false, same = 0
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(tab(page))
    const s = await readFocus(page)
    if (!s) { ended = true; leftPage = true; break }
    const key = `${s.tag}|${s.name}|${s.x}|${s.y}`
    if (stops.length && key === `${stops[0]!.tag}|${stops[0]!.name}|${stops[0]!.x}|${stops[0]!.y}`) { ended = true; break }
    expect(s.ring, `stop ${stops.length + 1} <${s.tag}> "${s.name}" shows where focus is`).not.toBe('none')
    const prev = stops.at(-1)
    // a time or date field is one element with several Tab stops (hour, minute, period); more than six on one is a trap
    same = prev && key === `${prev.tag}|${prev.name}|${prev.x}|${prev.y}` ? same + 1 : 0
    // headless Firefox has no browser controls to hand focus to, so past the last control it stays on it: the end of the page, not a trap
    if (same > 5 && (await page.evaluate(() => { const all = [...document.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((e) => e.getClientRects().length); return all.at(-1) === document.activeElement }))) { ended = true; leftPage = false; break }
    expect(same, `focus moved on from "${prev?.name}"`).toBeLessThanOrEqual(5)
    if (prev && !prev.fixed && !s.fixed && s.y < prev.y - 24) expect(s.x, `a step back up from "${prev.name}" to "${s.name}" goes into another column`).toBeGreaterThanOrEqual(prev.x + 100)
    stops.push(s)
  }
  expect(ended, `focus leaves the page or returns to its start within ${max} presses (no trap)`).toBe(true)
  expect(stops.length, 'the page has controls').toBeGreaterThan(3)
  // backwards: from past the end, Shift+Tab lands on the last stop, then the one before it, then the one before that
  if (leftPage && stops.length > 3) {
    for (let k = 1; k <= 3; k++) { await page.keyboard.press(tab(page, true)); const s = await readFocus(page); expect(s?.name, `Shift+Tab walks back to stop ${stops.length - k + 1}`).toBe(stops[stops.length - k]!.name) }
  }
  return stops
}
