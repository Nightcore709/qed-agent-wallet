/**
 * The owner signs an instruction in a real browser, closes the browser, and the engine carries on.
 *
 *   npm run build && node scripts/away.ts [minutesAway] [report.json]
 *
 * Everything runs against an isolated copy of QED that this script starts: its own database in a scratch directory,
 * its own engine and its own API, which also serves the built interface, on a port nothing else uses. So no other
 * window, tab or tool can be connected to it, and what the API reports as open interfaces is the whole truth.
 *
 *   1. Chrome opens the interface. Through the page, as a person would: create an account, open the paper
 *      household, write an instruction (buy ₹200 of bitcoin every two minutes, on its own), read the document and
 *      sign it with a passkey (a virtual platform authenticator in Chrome).
 *   2. The first run completes with the interface still open.
 *   3. Chrome is closed. From here the API is sampled every two seconds for the number of interface connections
 *      it holds. Runs that fall due are executed by the engine alone.
 *   4. After the time away, Chrome is started again, the owner signs in, and the passbook is read back from the
 *      page: the runs that happened while away are there, each with a receipt.
 *
 * Prices are live public market data; the money is paper. It changes nothing outside its scratch directory.
 */
import { chromium, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { addAuthenticator } from '../browser/support/passkey.ts'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const minutesAway = Number(process.argv[2] ?? 10)
const out = process.argv[3] ?? join(app, 'evidence', 'away.json')
const shots = out.replace(/\.json$/, '')
/**
 * A picture of the whole page as a reader would meet it: from the top. The bar at the top is pinned to the window,
 * so a full-page picture taken while the page is scrolled draws that bar across the middle of the page.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(150)
  await page.screenshot({ path: join(shots, name), fullPage: true })
}
const port = Number(process.env.QED_AWAY_PORT ?? 5196)
const base = `http://127.0.0.1:${port}`
const dir = mkdtempSync(join(tmpdir(), 'qed-away-'))
const dbPath = join(dir, 'qed.db')
const env = { ...process.env, QED_DB: dbPath, QED_API_PORT: String(port), QED_WEB_PORT: String(port), QED_AI_PROVIDER: 'none' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ist = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST'))
if (!existsSync(join(app, 'dist', 'index.html'))) { console.error('The interface has not been built. Run "npm run build" first: this script opens the built interface, served by its own API.'); process.exit(2) }
mkdirSync(shots, { recursive: true })

const procs: ChildProcess[] = []
const stderr: string[] = []
function start(cmd: 'engine' | 'api'): void {
  const c = spawn(process.execPath, [join(app, 'server', 'main.ts'), cmd], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stderr?.on('data', (d: Buffer) => { const s = d.toString(); if (!s.includes('ExperimentalWarning') && !s.includes('--trace-warnings')) stderr.push(`[${cmd}] ${s.trim().slice(0, 300)}`) })
  procs.push(c)
}
const stopAll = (): void => { for (const p of procs) p.kill('SIGTERM') }
process.on('exit', stopAll)

function q<T = Record<string, any>>(sql: string, ...p: (string | number)[]): T[] { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(...p) as T[] } finally { d.close() } }
async function until<T>(what: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms: number, every = 500): Promise<T | null> { const end = Date.now() + ms; for (;;) { const v = await what(); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }
const health = async (): Promise<{ interfaces: number | null; engine: boolean | null }> => { try { const j = (await (await fetch(`${base}/api/health`)).json()) as { interfaces?: number; engine?: { running?: boolean } }; return { interfaces: j.interfaces ?? null, engine: j.engine?.running ?? null } } catch { return { interfaces: null, engine: null } } }

interface Step { name: string; expected: string; observed: string; pass: boolean; at: string | null }
const steps: Step[] = []
function step(name: string, expected: string, observed: string, pass: boolean): void {
  steps.push({ name, expected, observed, pass, at: ist(Date.now()) })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${observed})`)
}

// ---- the interface count, sampled for the whole run
const samples: { t: number; interfaces: number | null; engine: boolean | null }[] = []
let sampling = true
const sampler = (async () => { while (sampling) { samples.push({ t: Date.now(), ...(await health()) }); await sleep(2000) } })()
const between = (from: number, to: number) => samples.filter((s) => s.t >= from && s.t <= to)
function transitions(): { at: string | null; interfaces: number | null }[] {
  const list: { at: string | null; interfaces: number | null }[] = []
  let last: number | null | undefined
  for (const s of samples) if (s.interfaces !== last) { list.push({ at: ist(s.t), interfaces: s.interfaces }); last = s.interfaces }
  return list
}

const handle = `away${randomBytes(3).toString('hex')}`
const pageErrors: string[] = []
const watch = (page: Page): void => { page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200))); page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200)) }) }
const launch = () => chromium.launch({ channel: 'chrome', headless: true, timeout: 60_000 })
let current: Page | null = null

try {
  start('api'); start('engine')
  const up = await until(async () => (await health()).engine === true, 30_000)
  if (!up) throw new Error('The isolated engine and API did not come up within 30 seconds.')
  // Wait for live prices: an autonomous purchase needs a fresh venue price and an independent one that agrees.
  const fresh = (id: string, type: string): boolean => (q<{ recv_ts: number }>('SELECT recv_ts FROM quotes WHERE instrument_id = ? AND price_type = ?', id, type)[0]?.recv_ts ?? 0) > Date.now() - 15_000
  const priced = await until(() => fresh('coindcx:BTCINR', 'ask') && fresh('binance:BTCUSDT', 'bid') && fresh('coindcx:USDTINR', 'bid'), 120_000, 1000)
  step('Live prices arrived on the isolated engine', 'fresh venue and independent prices for bitcoin within two minutes', priced ? 'fresh' : 'not all fresh after 120 s', !!priced)

  // ---- 1. through the interface, as a person would
  let browser = await launch()
  let page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watch(page); current = page
  // The owner's passkey: a virtual platform authenticator answering as Touch ID would (user verified).
  const passkey = await addAuthenticator(page)
  const openedAt = Date.now()
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Away Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await page.waitForSelector('.home', { timeout: 15_000 })
  // since the Clear redesign the bank statement is under Activity, at /passbook
  await page.goto(base + '/passbook')
  await page.waitForSelector('table.ledger', { timeout: 15_000 })
  await page.goto(base + '/instructions/new?kind=invest')
  await page.getByLabel('Buy').selectOption('coindcx:BTCINR')
  await page.getByLabel('With this much each time').fill('200')
  await page.getByLabel('How often').selectOption('every')
  await page.getByLabel('Minutes between runs').fill('2')
  await page.getByRole('radio', { name: /On its own/ }).check()
  const signButton = page.getByRole('button', { name: 'Review and sign' })
  await until(async () => (await signButton.isEnabled()) && (await page.locator('.instrument').first().innerText()).includes('₹200'), 15_000, 300)
  await shot(page, '1-instruction-before-signing.png')
  const documentText = (await page.locator('.instrument').first().innerText()).replace(/\s+/g, ' ').slice(0, 600)
  await signButton.click()
  // Every 2 minutes under a ₹20,000 monthly limit contradicts itself (R7-093): the owner accepts it explicitly.
  const accept = page.getByRole('button', { name: 'Accept and continue to signing' })
  if (await accept.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    for (const box of await page.getByRole('checkbox', { name: /^I accept:/ }).all()) await box.check()
    await accept.click()
  }
  const force = page.getByRole('button', { name: 'Sign and put in force with your passkey' })
  await force.waitFor({ timeout: 15_000 })
  await force.click()
  await page.waitForURL(/\/instructions\/prg_/, { timeout: 15_000 })
  const programId = new URL(page.url()).pathname.split('/').pop()!
  const signedAt = Date.now()
  const prog = q<{ state: string; live_version: number }>('SELECT state, live_version FROM programs WHERE id = ?', programId)[0]
  const approval = q<{ method: string | null; doc_hash: string }>(`SELECT a.method, a.doc_hash FROM approvals a WHERE a.subject LIKE ? AND a.consumed_at IS NOT NULL ORDER BY a.confirmed_at DESC LIMIT 1`, `%${programId}%`)[0]
  step('The instruction was signed through the interface', 'in force, approved by a passkey signature over the exact document', `instruction ${prog?.state}, version ${prog?.live_version}; approved by ${approval?.method ?? 'nothing'}; document ${approval?.doc_hash?.slice(0, 12)}…`, prog?.state === 'active' && approval?.method === 'passkey')

  // ---- 2. the first run, interface open
  const runsOf = () => q<{ id: string; state: string; due_at: number; started_at: number | null; finished_at: number | null; reason: string | null; occurrence: string }>('SELECT id, state, due_at, started_at, finished_at, reason, occurrence FROM runs WHERE program_id = ? ORDER BY due_at', programId)
  const firstDone = await until(() => runsOf().find((r) => r.state === 'done'), 240_000, 1000)
  await sleep(2500)
  await shot(page, '2-interface-open-first-run.png')
  const openSamples = between(signedAt, Date.now())
  step('A first run completed with the interface open', 'one run done; the API holds at least one interface connection', `${firstDone ? `run due ${ist(firstDone.due_at)} done` : 'no run done within 4 minutes'}; interface connections at the samples: ${[...new Set(openSamples.map((s) => s.interfaces))].join(', ')}`, !!firstDone && openSamples.every((s) => (s.interfaces ?? 0) >= 1))

  // ---- 3. close the browser and stay away (the passkey goes with the owner, as a synced passkey would)
  const credentials = await passkey.credentials()
  current = null
  await browser.close()
  const closedAt = Date.now()
  const gone = await until(async () => (await health()).interfaces === 0, 10_000, 250)
  const goneAfterMs = Date.now() - closedAt
  step('Closing the browser closed every interface connection', 'the API reports none within ten seconds', gone ? `none, ${goneAfterMs} ms after the browser exited` : 'still connected after 10 s', !!gone)
  console.log(`[away] browser closed at ${ist(closedAt)}; staying away for ${minutesAway} minutes`)
  const awayFrom = Date.now()
  let seen = runsOf().filter((r) => r.finished_at).length
  while (Date.now() < awayFrom + minutesAway * 60_000) {
    await sleep(5000)
    const done = runsOf().filter((r) => r.finished_at)
    if (done.length > seen) { for (const r of done.slice(seen)) console.log(`[away]   run due ${ist(r.due_at)}: ${r.state}`); seen = done.length }
  }
  const awayTo = Date.now()

  // ---- what happened while away
  const awaySamples = between(awayFrom, awayTo)
  const withInterface = awaySamples.filter((s) => s.interfaces !== 0)
  step('No interface was open at any point while away', `zero interface connections at every sample for ${minutesAway} minutes`, `${awaySamples.length} samples two seconds apart; ${withInterface.length} with a connection or no answer; engine reported running at ${awaySamples.filter((s) => s.engine).length}`, awaySamples.length > minutesAway * 20 && withInterface.length === 0 && awaySamples.every((s) => s.engine === true))
  const runs = runsOf()
  const actions = q<{ id: string; run_id: string; state: string; economic_id: string; times_json: string; recon_state: string; receipt_id: string | null; error: string | null; created_at: number }>('SELECT id, run_id, state, economic_id, times_json, recon_state, receipt_id, error, created_at FROM actions WHERE program_id = ? ORDER BY created_at', programId)
  const awayRuns = runs.filter((r) => r.due_at >= awayFrom && r.due_at <= awayTo - 20_000)
  const detail = awayRuns.map((r) => {
    const a = actions.filter((x) => x.run_id === r.id)
    const t = JSON.parse(a[0]?.times_json ?? '{}') as Record<string, number>
    const end = t.reconciled ?? r.finished_at ?? r.due_at
    return {
      due: ist(r.due_at), outcome: r.state, reason: r.reason, startedAfterDueMs: r.started_at === null ? null : r.started_at - r.due_at, actions: a.length,
      decided: ist(t.decided), sent: ist(t.submitted), executed: ist(t.executed), comparedWithVenue: a[0]?.recon_state ?? null, reconciled: ist(t.reconciled), receipt: a[0]?.receipt_id ?? null,
      interfaceConnectionsDuringIt: [...new Set(between(r.due_at - 3000, end + 3000).map((s) => s.interfaces))],
    }
  })
  const expectedRuns = Math.floor((awayTo - 20_000 - awayFrom) / 120_000)
  step('Runs that fell due while away were executed by the engine alone', `about ${expectedRuns} runs, two minutes apart, each done once, started when due, with no interface connected`,
    `${awayRuns.length} fell due: ${awayRuns.filter((r) => r.state === 'done').length} done, ${awayRuns.filter((r) => r.state !== 'done').map((r) => r.state).join(', ') || 'none otherwise'}; started ${Math.max(0, ...detail.map((d) => d.startedAfterDueMs ?? 0))} ms after due at most; interface connections during them: ${[...new Set(detail.flatMap((d) => d.interfaceConnectionsDuringIt))].join(', ')}`,
    awayRuns.length >= expectedRuns - 1 && awayRuns.length > 0 && awayRuns.every((r) => r.state === 'done') && detail.every((d) => d.actions === 1 && d.interfaceConnectionsDuringIt.length === 1 && d.interfaceConnectionsDuringIt[0] === 0 && (d.startedAfterDueMs ?? 1e9) < 10_000))
  step('Each of them was compared with the venue and has a receipt', 'reconciled, one receipt each, no occurrence twice', `${detail.filter((d) => d.comparedWithVenue === 'reconciled').length} reconciled, ${detail.filter((d) => d.receipt).length} receipts; ${new Set(runs.map((r) => r.occurrence)).size} distinct occurrences for ${runs.length} runs; ${new Set(actions.map((a) => a.economic_id)).size} distinct orders for ${actions.length} actions`,
    detail.every((d) => d.comparedWithVenue === 'reconciled' && !!d.receipt) && new Set(runs.map((r) => r.occurrence)).size === runs.length && new Set(actions.map((a) => a.economic_id)).size === actions.length)

  // ---- 4. come back
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watch(page); current = page
  const reopenedAt = Date.now()
  // The same passkey on the reopened browser, as a synced passkey would be, and sign in with it.
  const again = await addAuthenticator(page)
  await again.load(credentials)
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await page.waitForSelector('.statement', { timeout: 15_000 })
  await page.getByRole('button', { name: /Show earlier entries/ }).click().catch(() => {})
  await sleep(1500)
  const bought = await page.locator('table.ledger tr', { hasText: /Bought .* BTC/ }).count()
  await shot(page, '3-passbook-after-return.png')
  const doneTotal = runs.filter((r) => r.state === 'done').length
  step('Back at the interface, the passbook shows what happened while away', `${doneTotal} purchases listed, each attributed to the instruction`, `${bought} purchase lines on the page; ${doneTotal} runs done on record`, bought >= doneTotal && doneTotal > 1)
  await page.goto(`${base}/instructions/${programId}`)
  await page.waitForSelector('.instrument', { timeout: 15_000 })
  await sleep(800)
  await shot(page, '4-instruction-after-return.png')
  const sys = await page.evaluate(async () => (await fetch('/api/system')).json()) as { receipts: { ok: boolean; count: number }; ledger: { breaks: unknown[] }; recon: { ok: boolean } | null }
  step('The books hold after it all', 'ledger consistent, receipts chained, books agree with the venue', `ledger breaks ${sys.ledger.breaks.length}; receipt chain ${sys.receipts.ok ? 'intact' : 'broken'} (${sys.receipts.count}); against the venue ${sys.recon?.ok ? 'agrees' : 'does not agree or not compared'}`, sys.ledger.breaks.length === 0 && sys.receipts.ok && !!sys.recon?.ok)
  step('The interface raised no error', 'no page error and no console error in either visit', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none', pageErrors.length === 0)
  await browser.close()
  sampling = false; await sampler

  const report = {
    what: 'An instruction signed in the browser kept running after the browser was closed',
    stack: { isolated: true, apiAndInterface: base, database: dbPath, note: 'Started by this script; nothing else knows the port, so the interface connections the API reports are all there are.' },
    timeline: { interfaceOpened: ist(openedAt), signed: ist(signedAt), browserClosed: ist(closedAt), awayFrom: ist(awayFrom), awayTo: ist(awayTo), interfaceReopened: ist(reopenedAt) },
    instruction: { id: programId, document: documentText },
    interfaceConnections: { samples: samples.length, everySeconds: 2, whileAway: { samples: awaySamples.length, withAConnectionOrNoAnswer: withInterface.length }, changes: transitions() },
    runsWhileAway: detail,
    allRuns: runs.map((r) => ({ due: ist(r.due_at), outcome: r.state, reason: r.reason, interface: r.due_at < closedAt ? 'open' : r.due_at <= awayTo ? 'closed' : 'reopened' })),
    steps, passed: steps.filter((s) => s.pass).length, of: steps.length,
    screenshots: ['1-instruction-before-signing.png', '2-interface-open-first-run.png', '3-passbook-after-return.png', '4-instruction-after-return.png'].map((f) => join(shots, f).replace(`${app}/`, '')),
    notShown: ['The computer staying on: if it sleeps or is shut down the engine stops, and runs due in that time are recorded as missed and never executed late (evidence/20261120-overnight-sleep.json).', 'A hosted engine: this is one computer. Running the engine elsewhere is a production decision, not something shown here.', 'Real money: every order is a paper order against the live order book.'],
    serverErrors: stderr,
  }
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
  console.log(`[away] ${report.passed} of ${report.of} passed. Report: ${out}`)
  stopAll()
  process.exit(report.passed === report.of ? 0 : 1)
} catch (e) {
  sampling = false
  console.error('[away] stopped:', e instanceof Error ? e.message : e)
  // Leave a picture of where the interface was, so a failed journey can be understood.
  if (current) { try { await current.screenshot({ path: join(shots, 'failure.png'), fullPage: true }); console.error(`[away] the page was at ${current.url()}; see ${join(shots, 'failure.png')}`) } catch { /* the browser is gone */ } }
  writeFileSync(out, `${JSON.stringify({ what: 'The away demonstration did not complete', error: e instanceof Error ? e.message : String(e), steps, serverErrors: stderr }, null, 1)}\n`)
  stopAll()
  process.exit(1)
}
