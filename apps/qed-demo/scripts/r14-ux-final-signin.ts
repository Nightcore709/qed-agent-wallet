/**
 * R14 (UX final): the sign-in and create-account views with Google configured (a local stand-in issuer): screenshots at
 * 1440 and 390 px, and the DOM measures of the three methods' buttons (size, alignment, icon centring) and an overlap check.
 *   node --experimental-strip-types scripts/r14-ux-final-signin.ts <before|after> [width...]
 */
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { startOidcStandIn } from '../server/oidc-standin.ts'
import { extraPort, startExtraStack } from '../browser/support/stack.ts'

const tag = process.argv[2] ?? 'after'
const widths = process.argv.slice(3).map(Number)
const W = widths.length ? widths : [1440, 390, 320]
const PORT = extraPort(60), IDP = extraPort(62)
const idp = await startOidcStandIn({ port: IDP, clientId: 'c.apps.example', clientSecret: 'secret-secret-secret', redirectUris: [`http://localhost:${PORT}/auth/google/callback`] })
const s = await startExtraStack(PORT, { QED_GOOGLE_CLIENT_ID: 'c.apps.example', QED_GOOGLE_CLIENT_SECRET: 'secret-secret-secret', QED_GOOGLE_ISSUER: idp.issuer })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let bad = 0
try {
  for (const w of W) {
    const c = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: 'reduce', colorScheme: (process.env.SCHEME as 'light' | 'dark') ?? 'light' })
    const p = await c.newPage()
    await p.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
    for (const view of ['in', 'new'] as const) {
      await p.goto(s.base + '/'); await p.waitForLoadState('networkidle')
      if (view === 'new') await p.getByRole('button', { name: 'Create an account' }).click()
      await p.getByRole('button', { name: /Google/ }).waitFor()
      await p.waitForTimeout(400)
      const m = await p.evaluate(() => {
        const card = document.querySelector('.access')!.getBoundingClientRect()
        const btns = [...document.querySelectorAll<HTMLElement>('.access .btn.lg')].filter((b) => b.textContent && !/^Sign in with your password|Create account$/.test('') )
        const rows = btns.map((b) => {
          const r = b.getBoundingClientRect()
          const mark = b.querySelector('.g-mark, svg')?.getBoundingClientRect()
          // text line box: a Range over the label's text nodes
          const rg = document.createRange(); const tn = [...b.childNodes].filter((n) => n.nodeType === 3); rg.setStartBefore(tn[0] ?? b.lastChild!); rg.setEndAfter(tn[tn.length - 1] ?? b.lastChild!)
          const t = rg.getClientRects()[0]!
          return { name: (b.textContent ?? '').trim().slice(0, 32), x: +(r.left - card.left).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), markDy: mark ? +((mark.top + mark.bottom) / 2 - (t.top + t.bottom) / 2).toFixed(2) : null, gap: mark ? +(t.left - mark.right).toFixed(1) : null }
        })
        // overlap: no two visible leaf boxes in the card intersect
        const leaves = [...document.querySelectorAll<HTMLElement>('.access *')].filter((e) => e.offsetParent && !e.closest('details:not([open])') && e.children.length === 0 && (e.textContent ?? '').trim() && !e.closest('.or'))
        const hit: string[] = []
        for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
          const a = leaves[i]!.getBoundingClientRect(), b = leaves[j]!.getBoundingClientRect()
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hit.push(`${leaves[i]!.textContent!.slice(0, 20)} / ${leaves[j]!.textContent!.slice(0, 20)}`)
        }
        const groups = [...document.querySelectorAll('.access-act')].map((g) => { const r = g.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)] })
        return { rows, hit, scrollX: document.documentElement.scrollWidth > innerWidth, groups }
      })
      const sizes = new Set(m.rows.map((r) => `${r.x}/${r.w}`))
      const ok = m.hit.length === 0 && !m.scrollX && sizes.size === 1
      if (!ok) bad++
      console.log(`[signin ${tag}] ${w}px ${view}: ${ok ? 'ok' : 'FAULT'}`, JSON.stringify(m))
      await p.screenshot({ path: join(import.meta.dirname, '..', 'evidence', 'design', 'r14-ux-final', `signin-${view}-${w}-${tag}${process.env.SCHEME === 'dark' ? '-dark' : ''}.png`), fullPage: true })
    }
    await c.close()
  }
} finally { await browser.close(); await s.stop(); await idp.close() }
process.exit(bad ? 1 : 0)
