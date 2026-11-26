/**
 * R14 (UX final): reflow at 640 px CSS width (1280 px at 200% zoom) and at 320 px. For each page: sideways scroll, text boxes
 * that overlap, text clipped by its own box (overflow hidden/clip), and keyboard focus: the focus ring is drawn and the
 * focused control is clear of both bars. Needs the design fixture. Pages: Home, Spend, Save, Grow, Earn, Protect, Activity,
 * the instruction form; sign-in is logged out.
 *   node scripts/r14-ux-final-reflow.ts [widths]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const fx = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const widths = (process.argv[2] ?? '640,320').split(',').map(Number)
const pages = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity?view=list', '/instructions/new?kind=goal', 'signin']
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let bad = 0
for (const w of widths) {
  for (const path of pages) {
    const c = await browser.newContext({ viewport: { width: w, height: 800 }, reducedMotion: 'reduce' })
    if (path !== 'signin') await c.addCookies([{ name: fx.cookie.slice(0, fx.cookie.indexOf('=')), value: fx.cookie.slice(fx.cookie.indexOf('=') + 1), url: fx.base }])
    const p = await c.newPage()
    await p.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
    await p.goto(fx.base + (path === 'signin' ? '/' : path)); await p.waitForLoadState('networkidle').catch(() => undefined); await p.waitForTimeout(1200)
    const r = await p.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const wide = [...document.querySelectorAll<HTMLElement>('body *')].filter((e) => { const b = e.getBoundingClientRect(); return e.offsetParent && b.width > 0 && b.right > vw + 1 && !e.closest('[hidden], .sr, .skip, .sr-only') && !e.matches('i.la, i.lb, i.lc, .grain, .skip, .skip *') && !(e.closest('.ledger-wrap, [class*=scroll], pre, .scroll-x, [data-scroll], .secnav')) && getComputedStyle(e).position !== 'fixed' }).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 24)} right=${Math.round(e.getBoundingClientRect().right)}`)
      const clipped = [...document.querySelectorAll<HTMLElement>('main *, .access *')].filter((e) => { const cs = getComputedStyle(e); return e.offsetParent && /hidden|clip/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 2 && (e.textContent ?? '').trim() && cs.textOverflow !== 'ellipsis' && !e.closest('.sr, .sr-only') }).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 24)} ${e.scrollWidth}>${e.clientWidth}`)
      const leaves = [...document.querySelectorAll<HTMLElement>('main *, .access *')].filter((e) => e.offsetParent && e.children.length === 0 && (e.textContent ?? '').trim().length > 1 && !e.closest('.sr, details:not([open]) > :not(summary), [hidden], svg') && getComputedStyle(e).position !== 'absolute' && getComputedStyle(e).visibility !== 'hidden')
      const rs = leaves.map((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return { t: (e.textContent ?? '').trim().slice(0, 18), rects: [...rg.getClientRects()] } })
      const over: string[] = []
      for (let i = 0; i < rs.length && over.length < 4; i++) for (let j = i + 1; j < rs.length && over.length < 4; j++) {
        if (leaves[i]!.contains(leaves[j]!) || leaves[j]!.contains(leaves[i]!)) continue
        if (rs[i]!.rects.some((a) => rs[j]!.rects.some((b) => a.width > 2 && b.width > 2 && a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 3 && b.top < a.bottom - 3))) over.push(`${rs[i]!.t} / ${rs[j]!.t}`)
      }
      return { sideways: document.documentElement.scrollWidth - vw, wide, clipped, over }
    })
    // keyboard: Tab through; the focused control draws a ring and sits clear of the bars
    let noRing = 0, hidden = 0, n = 0; const names: string[] = []
    for (let i = 0; i < 70; i++) {
      await p.keyboard.press('Tab'); await p.waitForTimeout(25)
      const f = await p.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        if (!a || a === document.body || a.matches('[role=region]') || /^Skip to/.test(a.textContent ?? '') || a.closest('.topbar, .dock')) return null
        const b = a.getBoundingClientRect(); if (!b.width) return null
        const cs = getComputedStyle(a), top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0, dock = document.querySelector('.dock')?.getBoundingClientRect().top ?? 1e9
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && /\d+px/.test(cs.boxShadow))
        return { ring, hid: b.top < top - 1 || b.bottom > dock + 1 || b.right < 0 || b.left > innerWidth, name: (a.textContent ?? a.id).trim().slice(0, 24) }
      })
      if (!f) continue
      n++; if (!f.ring) noRing++; if (f.hid) { hidden++; names.push(f.name) }
    }
    const ok = r.sideways <= 0 && !r.wide.length && !r.clipped.length && !r.over.length && !noRing && !hidden
    if (!ok) bad++
    console.log(`[reflow] ${w}px ${path.padEnd(28)} ${ok ? 'ok   ' : 'FAULT'} sideways ${r.sideways} focus(n=${n}) noRing ${noRing} hidden ${hidden}${names.length ? ' [' + names.join('|') + ']' : ''}${r.wide.length ? ' wide ' + r.wide.join('; ') : ''}${r.clipped.length ? ' clipped ' + r.clipped.join('; ') : ''}${r.over.length ? ' overlap ' + r.over.join('; ') : ''}`)
    await c.close()
  }
}
await browser.close()
console.log(bad ? `[reflow] ${bad} fault(s)` : '[reflow] all clear')
