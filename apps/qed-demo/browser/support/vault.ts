/**
 * Steps of the on-chain vault journeys, shared by the browser tests: a fresh household, setting up and accepting its
 * vault, approving what a sheet shows with the passkey, and reading the vault service's own state to compare with
 * the screen. `base` is '' for the main stack and an extra stack's address otherwise.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, expect, type Page } from '@playwright/test'
import { ChainSocket } from '../../chain/rail/chain-socket.ts'
import { addAuthenticator } from './passkey.ts'
import { query as mainQuery, RAIL_PORT, readState } from './stack.ts'

type Query = <T = Record<string, unknown>>(sql: string, ...params: (string | number)[]) => T[]
const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
/** With QED_SHOTS=<folder>, the screens a journey passes through are saved there for reading (evidence, review). */
export const shot = async (page: Page, name: string): Promise<void> => { if (process.env.QED_SHOTS) await page.screenshot({ path: join(process.env.QED_SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' }) }

/** The saved codes each account made by newOwner saved when they were offered after sign-up, by handle (H2 needs one for some actions). */
export const signupCodes = new Map<string, string[]>()
export async function newOwner(page: Page, base = ''): Promise<string> {
  const handle = unique('vlt')
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  // R14 (F1): the codes are made with the first device and shown once on the screen after it
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  signupCodes.set(handle, await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts())
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

/** Where a stack's vault service answers, and its token (read from its folder; the browser never holds it). */
export interface RailAt { port: number; dir: string }
export const mainRail = (): RailAt => ({ port: RAIL_PORT, dir: join(readState().dir, 'vault') })
export async function railGet(path: string, at: RailAt = mainRail()): Promise<Record<string, any>> {
  const token = readFileSync(join(at.dir, 'rail.token'), 'utf8').trim()
  return (await fetch(`http://127.0.0.1:${at.port}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<Record<string, any>>
}

const sockets = new Map<string, ChainSocket>()
/**
 * A JSON-RPC call to a stack's own local chain, made as its vault service makes it (F-14, R13): over the chain's private
 * socket, which the service names in `rail/anvil.endpoint.json` beside the chain's pid file. The chain's TCP listener is
 * on a port that browsers and Node's fetch refuse, so a test reads the chain this way; it runs as the same user, the only
 * one who may open the socket. The file is read at each call: a restarted chain has a new socket.
 */
export async function chainCall(method: string, params: unknown[] = [], at: RailAt = mainRail()): Promise<any> {
  const { socket } = JSON.parse(readFileSync(join(at.dir, 'rail', 'anvil.endpoint.json'), 'utf8')) as { socket: string }
  let s = sockets.get(socket)
  if (!s) { s = new ChainSocket(socket); sockets.set(socket, s) }
  return s.rpc(method, params)
}
export const vaultRecord = (personId: string, q: Query = mainQuery) => JSON.parse(q<{ value: string }>('SELECT value FROM meta WHERE key = ?', `vault.workspace:${personId}`)[0]!.value) as { railId: string; request: { origin: string; owner: { signers: { x: string; y: string }[] } } }

export async function setUpVault(page: Page, base = ''): Promise<void> {
  await page.goto(`${base}/vault`)
  await expect(page.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  await shot(page, '01-set-up')
  await page.getByRole('button', { name: 'Confirm with your passkey and set it up' }).click()
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  await shot(page, '02-awaiting-acceptance')
}

/** Approve what the sheet shows: one passkey prompt per digest, then the job runs on the chain. */
export async function approve(page: Page, signs: RegExp, outcome = 'Completed'): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await shot(page, `sheet-${Date.now()}`)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(page.locator('.page-head').getByText(outcome, { exact: true })).toBeVisible({ timeout: 60_000 })
  await shot(page, `job-${Date.now()}`)
}

export const treasury = (page: Page) => page.getByRole('region', { name: 'Treasury', exact: true })

export async function accept(page: Page, base = ''): Promise<void> {
  await page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
  await approve(page, /Your owner account runs these 2 calls.*acceptOwnership/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('accepted ownership of the treasury and reserve vaults')
  await page.goto(`${base}/vault`)
  await expect(treasury(page).locator('.lead')).toHaveText('₹1,00,000.00')
}

/**
 * A fresh household in its own browser context, with its own passkey, whose vault is set up and accepted. The context
 * is closed when the test ends (support/test.ts), so its page does not stay live in the worker for later tests.
 */
export async function household(browser: Browser, base = '', q: Query = mainQuery): Promise<{ page: Page; personId: string; railId: string }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await addAuthenticator(page)
  const handle = await newOwner(page, base)
  const personId = q<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
  await setUpVault(page, base)
  await accept(page, base)
  return { page, personId, railId: vaultRecord(personId, q).railId }
}
