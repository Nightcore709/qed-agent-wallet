/**
 * axe on the Portfolio lab alone (/holdings/lab), with the rules scripts/a11y.ts runs on every other screen (WCAG 2.0,
 * 2.1 and 2.2, levels A and AA), in light and dark at 1440 and 390 px, and in both of its certificate states: as it
 * opens, and with "Every fee and tax I owe ... is among my bills" ticked. Every certificate's disclosure is opened, so
 * the request and its fingerprint are checked too. It signs in with the design fixture's session (read from
 * QED_FIXTURE_FILE at run time, never printed) and only reads; ticking the box changes nothing stored.
 *
 *   QED_FIXTURE_FILE=data/design-fixture.json node scripts/lab-axe.ts <web base> [report.json]
 */
import { AxeBuilder } from '@axe-core/playwright'
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

const [base = 'http://127.0.0.1:6500', out = ''] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(process.env.QED_FIXTURE_FILE ?? 'data/design-fixture.json', 'utf8')) as { cookie: string }
const [name, value] = fx.cookie.split('=') as [string, string]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext()
await ctx.addCookies([{ name, value, url: base }])
const page = await ctx.newPage()
const findings: { state: string; scheme: string; width: number; rule: string; impact: string | null | undefined; nodes: number; example: string }[] = []
let runs = 0, certificates = 0
for (const declared of [false, true]) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(`${base}/holdings/lab`)
      await page.getByRole('heading', { name: 'What QED can promise about your money' }).waitFor({ timeout: 30_000 })
      const box = page.getByRole('checkbox', { name: /Every fee and tax I owe in the next 30 days is among my bills/ })
      if (declared && !(await box.isChecked())) await box.check()
      await page.locator('.lb-certs article.cert').first().waitFor({ timeout: 30_000 })
      await page.waitForTimeout(800)
      for (const d of await page.locator('.lb-certs details.cert-more').all()) await d.evaluate((el) => { (el as HTMLDetailsElement).open = true })
      certificates = Math.max(certificates, await page.locator('.lb-certs article.cert').count())
      const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      runs++
      for (const v of r.violations) findings.push({ state: declared ? 'declared' : 'as opened', scheme, width, rule: v.id, impact: v.impact, nodes: v.nodes.length, example: (v.nodes[0]?.html ?? '').replace(/\s+/g, ' ').slice(0, 200) })
    }
  }
}
await browser.close()
const report = { route: '/holdings/lab', runs, certificatesOnPage: certificates, violations: findings.length, findings }
if (out) writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
console.log(`axe on /holdings/lab: ${runs} runs (2 states x 2 schemes x 2 widths), up to ${certificates} certificates on the page, ${findings.length} violations`)
for (const f of findings) console.log(`  ${f.state} ${f.scheme} ${f.width}px ${f.rule} (${f.impact}, ${f.nodes} nodes): ${f.example}`)
process.exitCode = findings.length ? 1 : 0
