/**
 * R14 currency audit: a household in each home currency the set-up offers, read on every screen for a rupee sign it
 * should not carry, in the text and in what the stylesheet writes (::before and ::after), and for an amount field whose
 * sign is not the household's. Reads the interface of a running stack (scripts/design-fixture.ts or a browser stack).
 *
 *   QED_UI=http://localhost:13670 node scripts/r14-currency-audit.ts [currency ...]      default: USD EUR GBP AED SGD
 *
 * Prints one line per finding and writes evidence/design/r14-core/currency-audit.json. A rupee sign is expected, and
 * listed apart as such, where the screen is about rupees whatever the household's currency: test rupees on the on-chain
 * wallet, and the parts closed to a household in another currency, which say they work in rupees only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const app = join(import.meta.dirname, '..')
const base = process.env.QED_UI ?? 'http://localhost:5174'
const currencies = process.argv.slice(2).length ? process.argv.slice(2) : ['USD', 'EUR', 'GBP', 'AED', 'SGD']
const ROUTES = ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/safeguards', '/activity', '/passbook', '/instructions', '/instructions/new', '/instructions/new?kind=goal', '/instructions/new?kind=bills', '/security', '/workspace', '/ask', '/notifications', '/readiness', '/more', '/evidence', '/tax', '/subscriptions', '/commerce', '/desk', '/lab', '/vault', '/data']
const SIGN: Record<string, string> = { USD: 'USD', EUR: '€', GBP: '£', AED: 'AED', SGD: 'SGD', INR: '₹' }

async function passkey(page: Page): Promise<void> {
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
}
/** In the page: every rupee sign a person would read, with the words around it, and every amount field's sign. */
const read = (): { text: string[]; pseudo: string[]; fields: { sign: string; label: string; pad: number; signEnd: number }[] } => {
  const text = [...(document.body.innerText.matchAll(/.{0,48}₹.{0,32}/g))].map((m) => m[0].replace(/\s+/g, ' ').trim())
  const pseudo: string[] = []
  const fields: { sign: string; label: string; pad: number; signEnd: number }[] = []
  for (const el of document.body.querySelectorAll('*')) {
    for (const which of ['::before', '::after']) {
      const c = getComputedStyle(el, which).content
      if (c && c.includes('₹')) pseudo.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}${which}`)
    }
    if (el.classList.contains('money')) {
      const input = el.querySelector('input')
      const b = getComputedStyle(el, '::before')
      const label = input?.id ? (document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? '') : (input?.getAttribute('aria-label') ?? '')
      fields.push({ sign: b.content.replace(/^"|"$/g, ''), label, pad: input ? parseFloat(getComputedStyle(input).paddingLeft) : 0, signEnd: parseFloat(b.left) + parseFloat(b.width) })
    }
  }
  return { text, pseudo, fields }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report: Record<string, Record<string, { text: string[]; pseudo: string[]; wrongFields: string[]; fields: number; overlap: string[] }>> = {}
let findings = 0
for (const ccy of currencies) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await passkey(page)
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(`aud${ccy.toLowerCase()}${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Audit Household')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Open your paper household' }).waitFor()
  if (ccy !== 'INR') { await page.getByLabel('Home currency').selectOption(ccy); await page.getByText(/example figures are converted|Starting figures are/).waitFor() }
  report[ccy] = {}
  const note = async (route: string): Promise<void> => {
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(500)
    const r = await page.evaluate(read)
    const wrongFields = r.fields.filter((f) => f.sign !== SIGN[ccy]).map((f) => `${f.label || '(unnamed)'}: "${f.sign}"`)
    const overlap = r.fields.filter((f) => f.pad < f.signEnd + 4).map((f) => `${f.label}: digits begin at ${f.pad}px, the sign ends at ${Math.round(f.signEnd)}px`)
    report[ccy]![route] = { text: ccy === 'INR' ? [] : r.text, pseudo: ccy === 'INR' ? [] : r.pseudo, wrongFields, fields: r.fields.length, overlap }
    for (const t of report[ccy]![route]!.text) { findings++; console.log(`${ccy} ${route} text: ${t}`) }
    for (const t of report[ccy]![route]!.pseudo) { findings++; console.log(`${ccy} ${route} stylesheet: ${t}`) }
    for (const t of wrongFields) { findings++; console.log(`${ccy} ${route} field: ${t}`) }
    for (const t of overlap) { findings++; console.log(`${ccy} ${route} overlap: ${t}`) }
  }
  await note('(set-up)')
  await page.getByRole('button', { name: 'Open the household' }).click()
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Here is your money' }).waitFor()
  for (const route of ROUTES) { await page.goto(`${base}${route}`); await note(route) }
  console.log(`[audit] ${ccy}: ${Object.values(report[ccy]!).reduce((n, r) => n + r.fields, 0)} amount fields read on ${ROUTES.length + 1} screens`)
  await ctx.close()
}
await browser.close()
const out = join(app, 'evidence', 'design', 'r14-core')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'currency-audit.json'), JSON.stringify({ at: new Date().toISOString(), base, currencies, findings, report }, null, 1))
console.log(`[audit] ${findings} finding${findings === 1 ? '' : 's'}; evidence/design/r14-core/currency-audit.json`)
