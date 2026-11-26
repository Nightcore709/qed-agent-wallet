/**
 * R14 (UX final): the sign-in and create-account views with Google configured. Each way in is its own group: the device's
 * button with its sentence, then a divider, then Google's button with its own sentence; the three buttons share one size
 * and one alignment at 1440 and 390 px; the Google mark sits on its label's centre line; nothing overlaps or scrolls
 * sideways. Nothing here signs anyone in: a button's look is presentation only and authorises nothing.
 */
import { expect, type Page, test } from '../support/test.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { startOidcStandIn, type StandIn } from '../../server/oidc-standin.ts'

const PORT = extraPort(120), IDP_PORT = extraPort(122)
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>, idp: StandIn
test.beforeAll(async () => {
  idp = await startOidcStandIn({ port: IDP_PORT, clientId: 'grp.apps.example', clientSecret: 'grp-secret-grp-secret', redirectUris: [`http://localhost:${PORT}/auth/google/callback`] })
  s = await startExtraStack(PORT, { QED_GOOGLE_CLIENT_ID: 'grp.apps.example', QED_GOOGLE_CLIENT_SECRET: 'grp-secret-grp-secret', QED_GOOGLE_ISSUER: idp.issuer })
})
test.afterAll(async () => { await s?.stop(); await idp?.close() })

const measure = (page: Page) => page.evaluate(() => {
  const card = document.querySelector('.access')!.getBoundingClientRect()
  const google = document.querySelector<HTMLElement>('[data-method="google"]')!
  const gBtn = google.querySelector<HTMLElement>('.btn')!
  const buttons = [...document.querySelectorAll<HTMLElement>('.access .btn.lg')].map((b) => { const r = b.getBoundingClientRect(); return { name: (b.textContent ?? '').trim(), left: Math.round(r.left - card.left), width: Math.round(r.width), height: Math.round(r.height) } })
  const mark = gBtn.querySelector('.g-mark')!.getBoundingClientRect()
  const rg = document.createRange(); const texts = [...gBtn.childNodes].filter((n) => n.nodeType === 3); rg.setStartBefore(texts[0]!); rg.setEndAfter(texts[texts.length - 1]!)
  const line = rg.getClientRects()[0]!
  const before = google.previousElementSibling as HTMLElement
  const leaves = [...document.querySelectorAll<HTMLElement>('.access *')].filter((e) => e.offsetParent && !e.closest('details:not([open])') && e.children.length === 0 && (e.textContent ?? '').trim() && !e.closest('.or'))
  const overlaps: string[] = []
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i]!.getBoundingClientRect(), b = leaves[j]!.getBoundingClientRect()
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${leaves[i]!.textContent!.slice(0, 20)} / ${leaves[j]!.textContent!.slice(0, 20)}`)
  }
  return {
    buttons, markDy: Math.abs((mark.top + mark.bottom) / 2 - (line.top + line.bottom) / 2), markGap: line.left - mark.right,
    dividerBefore: before.classList.contains('or'), ownSentence: !!google.querySelector('.access-explain'),
    // the Google group starts well below whatever came before it, and is not inside the device's group
    sharesGroup: !!gBtn.closest('[data-method="passkey"]'), overlaps, sideways: document.documentElement.scrollWidth > innerWidth,
  }
})

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  for (const view of ['Sign in', 'Create an account'] as const) {
    test(`${view} at ${w}px: Google is a choice of its own, and the buttons share one size`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h })
      await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
      await page.goto(`${s.base}/`)
      if (view === 'Create an account') await page.getByRole('button', { name: 'Create an account' }).click()
      await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
      const m = await measure(page)
      expect(m.dividerBefore, 'a divider sits before Google').toBe(true)
      expect(m.ownSentence, 'Google has its own sentence').toBe(true)
      expect(m.sharesGroup, 'Google is not inside the device group').toBe(false)
      expect(m.buttons.length, 'three ways in').toBe(view === 'Sign in' ? 3 : 3)
      expect(new Set(m.buttons.map((b) => `${b.left}/${b.width}/${b.height}`)).size, `one size and one alignment: ${JSON.stringify(m.buttons)}`).toBe(1)
      expect(m.markDy, 'the Google mark sits on its label\'s centre line (px)').toBeLessThanOrEqual(1.5)
      expect(m.markGap, 'the mark is a word-space before its label').toBeGreaterThan(2)
      expect(m.overlaps, 'nothing overlaps').toEqual([])
      expect(m.sideways, 'no sideways scroll').toBe(false)
    })
  }
}
