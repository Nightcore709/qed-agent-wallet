/**
 * The built interface under its Content-Security-Policy (R13 hardening; ASVS 5.0 V3.4.3, V3.4.7). The page's policy has a
 * nonce made for each response, no 'unsafe-inline' for scripts or styles, and reports violations to /api/csp-report; Trusted
 * Types are reported, not enforced. This journey signs up, opens every main screen, and holds that the browser blocked
 * nothing and reported nothing: no `securitypolicyviolation` event (enforced or report-only), no violation report sent, and
 * no console error. A screen that set an inline style attribute, injected a <style> element or a script without the nonce,
 * or loaded anything from another origin, would fail here. At the end, a control: a script without the nonce and an inline
 * style attribute, added on purpose, are blocked, seen and reported, so the instruments are shown to work.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { allowSignups } from '../support/stack.ts'
import { newOwner } from '../support/vault.ts'

const SCREENS = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/instructions', '/safeguards', '/security', '/workspace', '/vault', '/ask', '/evidence', '/passbook', '/tax', '/notifications', '/readiness', '/more']

test('every main screen runs under the nonce policy with nothing blocked, reported or logged as an error', async ({ page }) => {
  test.setTimeout(180_000)
  allowSignups()
  await addAuthenticator(page)
  const errors: string[] = [], reports: string[] = [], policies: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/csp-report') reports.push(r.postData() ?? '') })
  page.on('response', (r) => { if (r.request().resourceType() === 'document') policies.push(r.headers()['content-security-policy'] ?? '') })
  // every violation the browser sees, enforced or report-only, recorded in the page before any script of QED runs
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] }
    w.__violations = []
    document.addEventListener('securitypolicyviolation', (e) => { w.__violations.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`) })
  })
  await newOwner(page)
  const seen: string[] = []
  for (const path of SCREENS) {
    await page.goto(path)
    await expect(page.locator('#root')).not.toBeEmpty()
    await page.waitForLoadState('networkidle').catch(() => { /* the live event stream keeps one request open */ })
    await page.waitForTimeout(400)
    seen.push(...await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations.splice(0)))
  }
  // the document's policy is the nonce policy on every load, with a different nonce each time
  expect(policies.length).toBeGreaterThanOrEqual(SCREENS.length)
  expect(policies.every((p) => /script-src 'nonce-[A-Za-z0-9_-]+';/.test(p) && !/unsafe-inline|strict-dynamic/.test(p))).toBe(true)
  expect(new Set(policies.map((p) => /'nonce-([^']+)'/.exec(p)?.[1])).size).toBe(policies.length)
  expect({ violations: seen, reports, errors }).toEqual({ violations: [], reports: [], errors: [] })

  // The control: the same instruments see a violation when there is one. A script without the nonce and an inline style
  // attribute are blocked, each is an event, and the browser reports them to /api/csp-report.
  const ran = await page.evaluate(() => {
    const w = window as unknown as { __injected?: boolean; __violations: string[] }
    const s = document.createElement('script'); s.textContent = 'window.__injected = true'; document.body.appendChild(s)
    const d = document.createElement('div'); d.setAttribute('style', 'outline: 3px solid red'); document.body.appendChild(d)
    return w.__injected === true
  })
  expect(ran).toBe(false)
  // (the script added by script is also a Trusted Types sink: a report-only violation besides, which is expected)
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).map((v) => v.split(' ').slice(0, 2).join(' '))).toEqual(expect.arrayContaining(['enforce script-src-elem', 'enforce style-src-attr']))
  await expect.poll(() => reports.length, { timeout: 15_000 }).toBeGreaterThan(0)
})
