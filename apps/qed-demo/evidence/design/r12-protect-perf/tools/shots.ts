/**
 * Photographs of /protect for inspection: the top of the page and the on-chain wallet's tiles (where the mandate part
 * now loads after the page draws), at a phone (light) and a computer (dark).   node shots.ts <fixture.json> <outdir>
 * The fixture's cookie is read from its file at run time and never printed.
 */
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
const [fxFile, out] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(fxFile!, 'utf8')) as { base: string; cookie: string }
const [name, value] = [fx.cookie.slice(0, fx.cookie.indexOf('=')), fx.cookie.slice(fx.cookie.indexOf('=') + 1)]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [tag, vp, scheme] of [['phone-light', { width: 390, height: 844 }, 'light'], ['desk-dark', { width: 1440, height: 900 }, 'dark']] as const) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce', ...(tag.startsWith('phone') ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  await ctx.addCookies([{ name, value, url: fx.base }])
  const page = await ctx.newPage()
  await page.goto(fx.base + '/protect', { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForSelector('.pr-hero', { timeout: 20_000 })
  await page.waitForSelector('.pr-mandate .vt-wmandate', { timeout: 20_000 }).catch(() => console.log(`${tag}: the mandate part did not appear`))
  await page.screenshot({ path: `${out}/protect-${tag}-top.png` })
  const tile = page.locator('.pr-mandate').first()
  await tile.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/protect-${tag}-mandate.png` })
  console.log(`${tag}: mandate text "${((await tile.textContent()) ?? '').slice(0, 90)}…"`)
  await ctx.close()
}
await browser.close()
