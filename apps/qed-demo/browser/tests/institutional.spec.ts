/**
 * The institutional desk, end to end (R13, I1 and I2): two business workspaces record what each owes the other and each side
 * agrees; a netting cycle offsets them; the paying workspace's amount band asks two of its members to sign the net payment;
 * only when the second signs does the cycle settle, once, in the paper bank. The database is the judge of what took effect.
 * Three people, three browsers, three passkeys.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function createAccount(page: Page, handle: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Member ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
}
async function openHousehold(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Sections' }).first()).toBeVisible()
}
async function startBusiness(page: Page, name: string): Promise<void> {
  await page.goto('/workspace')
  await page.getByLabel('Business name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await openHousehold(page)
}
const bank = (ws: string): string => query<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, ws)[0]!.t

test('two businesses net what they owe each other; the payer\'s amount band asks two members to sign; it settles once, after the second', async ({ browser }) => {
  const pa = await (await browser.newContext()).newPage()
  const pb = await (await browser.newContext()).newPage()
  const pc = await (await browser.newContext()).newPage()
  await addAuthenticator(pa); await addAuthenticator(pb); await addAuthenticator(pc)
  const a = unique('na'), b = unique('nb'), c = unique('nc')
  const nameA = `Asha Traders ${a}`, nameB = `Ravi Exports ${b}`
  await createAccount(pa, a); await openHousehold(pa)
  await createAccount(pb, b); await openHousehold(pb)
  await createAccount(pc, c); await openHousehold(pc)

  // Business A: one owner. Business B: an owner and an approver, and a band: from Rs 1,00,000 two members must sign.
  await startBusiness(pa, nameA)
  await startBusiness(pb, nameB)
  await pb.goto('/workspace')
  await pb.getByLabel('Their handle').fill(c)
  await pb.getByLabel('Role').selectOption('approver')
  await pb.getByRole('button', { name: 'Add member' }).click()
  // giving a member authority waits out the protection delay (Q-048: 6 s on this stack, 72 hours in the product)
  await expect(pb.getByText(`@${c}`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await pb.getByRole('button', { name: 'Add a band' }).click()
  await pb.getByLabel('Band 1: from this amount').fill('100000')
  await pb.getByLabel('Band 1: signatures').fill('2')
  await pb.getByRole('button', { name: 'Save who must sign' }).click()
  await expect(pb.getByText('In force now')).toBeVisible()
  // the screen says who checks what: the chain's count on a vault, QED alone for bands and limits
  await expect(pb.getByTestId('enforcement').first()).toContainText('QED alone checks')
  const [wsA] = query<{ id: string }>('SELECT id FROM users WHERE display_name = ?', nameA)
  const [wsB] = query<{ id: string; policy_json: string }>('SELECT id, policy_json FROM users WHERE display_name = ?', nameB)
  expect(JSON.parse(wsB!.policy_json)).toMatchObject({ signers: 1, bands: [{ fromPaise: 10_000_000, signers: 2 }] })

  // the codes the two sides give each other
  await pa.goto('/workspace/desk')
  await pb.goto('/workspace/desk')
  const codeA = (await pa.getByTestId('ws-code').textContent())!, codeB = (await pb.getByTestId('ws-code').textContent())!
  expect(codeA).toMatch(/^ws-/); expect(codeB).toMatch(/^ws-/)

  // A records "B owes us 3,00,000"; B agrees. B records "A owes us 1,20,000"; A agrees.
  await pa.getByLabel("The other workspace's code").fill(codeB)
  await pa.getByLabel('Amount', { exact: true }).fill('300000')
  await pa.getByLabel('What it is for').fill('Invoice 14')
  await pa.getByRole('button', { name: 'Record the claim' }).click()
  await pb.reload()
  await expect(pb.getByText(`You owe ${nameA} ₹3,00,000`)).toBeVisible()
  await pb.getByRole('button', { name: /^Agree/ }).click()
  await expect(pb.getByText('Both sides agreed').first()).toBeVisible()
  await pb.getByLabel("The other workspace's code").fill(codeA)
  await pb.getByLabel('Amount', { exact: true }).fill('120000')
  await pb.getByLabel('What it is for').fill('Freight 9')
  await pb.getByRole('button', { name: 'Record the claim' }).click()
  await pa.reload()
  await expect(pa.getByText(`You owe ${nameB} ₹1,20,000`)).toBeVisible()
  await pa.getByRole('button', { name: /^Agree/ }).click()
  // the click's request may still be in flight: wait for the stored state rather than reading it once
  await expect.poll(() => query<{ state: string }>(`SELECT state FROM netting_claims WHERE creditor_ws = ? OR debtor_ws = ?`, wsA!.id, wsA!.id).map((r) => r.state)).toEqual(['agreed', 'agreed'])

  // A proposes the cycle: Rs 4,20,000 of claims become one payment of Rs 1,80,000 from B to A
  await pa.getByLabel('Net with (codes)').fill(codeB)
  await pa.getByRole('button', { name: 'Propose a netting cycle' }).click()
  await expect(pa.getByText('₹4,20,000 of claims become ₹1,80,000 of payments')).toBeVisible()
  await expect(pa.getByText('saves ₹2,40,000')).toBeVisible()
  const [cycle] = query<{ id: string; terms_json: string }>(`SELECT id, terms_json FROM netting_cycles WHERE proposed_by_ws = ?`, wsA!.id)
  expect(JSON.parse(cycle!.terms_json).payments).toEqual([{ from: wsB!.id, to: wsA!.id, paise: 18_000_000 }])

  // B agrees to the terms, then signs its payment: above the band, so one signature is not enough
  const bankBefore = { a: bank(wsA!.id), b: bank(wsB!.id) }
  await pb.reload()
  await pb.getByRole('button', { name: 'Agree to these terms' }).click()
  await pb.getByRole('button', { name: 'Sign my payment of ₹1,80,000' }).click()
  await pb.getByRole('button', { name: 'Sign with your passkey' }).click()
  await expect(pb.getByText('Signed: 1 of 2')).toBeVisible()
  const [ap] = query<{ id: string; required_signers: number; confirmed_at: number | null; purpose: string }>(`SELECT id, required_signers, confirmed_at, purpose FROM approvals WHERE user_id = ? AND purpose = 'netting'`, wsB!.id)
  expect(ap).toMatchObject({ required_signers: 2, confirmed_at: null })
  expect(query<{ state: string }>('SELECT state FROM netting_cycles WHERE id = ?', cycle!.id)[0]!.state).toBe('open')
  expect([bank(wsA!.id), bank(wsB!.id)]).toEqual([bankBefore.a, bankBefore.b]) // nothing has moved

  // the approver of B finds it in the queue and signs the same document: now, and only now, the cycle settles
  await pc.reload()
  await pc.getByRole('button', { name: /account menu$/ }).click()
  await pc.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: `${nameB} (approver)` })
  await pc.goto('/workspace')
  await expect(pc.getByText('1 of 2 signatures')).toBeVisible()
  await pc.getByRole('button', { name: 'Review and sign' }).click()
  await pc.getByRole('button', { name: 'Sign with your passkey' }).click()
  await expect(pc.getByText('Nothing is waiting for a signature.')).toBeVisible()

  expect(query<{ person_id: string }>('SELECT person_id FROM approval_signatures WHERE approval_id = ?', ap!.id)).toHaveLength(2)
  expect(query<{ state: string }>('SELECT state FROM netting_cycles WHERE id = ?', cycle!.id)[0]!.state).toBe('settled')
  expect(BigInt(bank(wsA!.id))).toBe(BigInt(bankBefore.a) + 18_000_000n)
  expect(BigInt(bank(wsB!.id))).toBe(BigInt(bankBefore.b) - 18_000_000n)
  expect(query<{ state: string }>('SELECT DISTINCT state FROM netting_claims WHERE cycle_id = ?', cycle!.id)).toEqual([{ state: 'netted' }])
  expect(query<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE kind = 'netting' AND ref = ?`, `netting:${cycle!.id}`)[0]!.n).toBe(2)

  // what A's screen shows is what the database holds
  await pa.reload()
  await expect(pa.getByText('Settled: ₹4,20,000 of claims become ₹1,80,000 of payments')).toBeVisible()
  await expect(pa.getByText('Receives ₹1,80,000')).toBeVisible()
  await expect(pa.getByText(/Simulated: the money moves between two paper bank accounts/).first()).toBeVisible()
})
