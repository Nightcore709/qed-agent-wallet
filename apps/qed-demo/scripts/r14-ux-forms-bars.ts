/**
 * R14 (UX forms): is anything unreachable under the top bar or the bottom navigation? For each page and width: the last
 * line of the page against the dock at the end of the scroll, and keyboard focus (Tab) against both bars. Needs the design fixture.
 *   node scripts/r14-ux-forms-bars.ts [widths]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const fx = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'design-fixture.json'), 'utf8')) as { base: string; cookie: string }
const widths = (process.argv[2] ?? '1440,1024,768,390').split(',').map(Number)
const pages = ['/earn', '/instructions/new?kind=goal', '/security', '/protect']
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let bad = 0
for (const w of widths) {
  const c = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, reducedMotion: 'reduce' })
  await c.addCookies([{ name: fx.cookie.slice(0, fx.cookie.indexOf('=')), value: fx.cookie.slice(fx.cookie.indexOf('=') + 1), url: fx.base }])
  const p = await c.newPage()
  for (const path of pages) {
    await p.goto(fx.base + path); await p.waitForLoadState('networkidle').catch(() => undefined); await p.waitForTimeout(1200)
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(500)
    const end = await p.evaluate(() => {
      const dock = document.querySelector('.dock')!.getBoundingClientRect()
      const els = [...document.querySelectorAll<HTMLElement>('main *, .app > *')].filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() && e.offsetParent && !e.closest('.dock, .topbar, .sr, [hidden], .skip, details:not([open]) > :not(summary)') && e.getBoundingClientRect().width >= 4 && e.getBoundingClientRect().height >= 4 && getComputedStyle(e).position !== 'fixed')
      const last = Math.max(...els.map((e) => e.getBoundingClientRect().bottom))
      return { dockTop: Math.round(dock.top), last: Math.round(last) }
    })
    const endOk = end.last <= end.dockTop
    // keyboard: Tab through the page; every focused control must be clear of both bars
    await p.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur() })
    let hidden = 0, n = 0
    for (let i = 0; i < 140; i++) {
      await p.keyboard.press('Tab'); await p.waitForTimeout(40)
      const r = await p.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        if (!a || a === document.body || a.closest('.topbar, .dock') || /^Skip to/.test(a.textContent ?? '')) return null
        const b = a.getBoundingClientRect(), top = document.querySelector('.topbar')!.getBoundingClientRect().bottom, dock = document.querySelector('.dock')!.getBoundingClientRect().top
        if (!b.width || !b.height) return null
        return b.top < top - 1 || b.bottom > dock + 1 ? `${a.tagName} "${(a.textContent ?? a.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(b.top)}-${Math.round(b.bottom)} bars ${Math.round(top)}/${Math.round(dock)}` : 'ok'
      })
      if (r === null) continue
      n++; if (r !== 'ok') { hidden++; if (hidden < 4) console.log('   hidden:', r) }
    }
    if (!endOk || hidden) bad++
    console.log(`[bars] ${w}px ${path}: page ends ${end.last <= end.dockTop ? 'clear of' : 'UNDER'} the dock (${end.last} vs ${end.dockTop}); focus under a bar: ${hidden} of ${n}`)
  }
  await c.close()
}
await browser.close()
console.log(bad ? `[bars] ${bad} page(s) with a fault` : '[bars] all clear')
