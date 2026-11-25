/**
 * Ask as a conversation (R7-092), in the browser, against the scripted test double (the interface labels it so): a
 * request for two things opened as two drafts at once; a correction that replaces one proposal without editing it; a
 * cancellation that QED handles itself, with no model call; the records a reply rests on shown with values that match
 * the ledger; a figure the records do not hold flagged; and where to act linked. The database is the judge.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { fromAmountText } from '../../shared/amount-text.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('ask')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}
const rupees = (text: string): number => Math.round(Number(text.replace(/[^\d.]/g, '')) * 100)

test('a conversation: two things asked become two drafts at once, a correction replaces a proposal, and "cancel that" withdraws without asking the model', async ({ page }) => {
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto('/ask')
  await expect(page.getByText('Answered by a scripted test double, not a model.')).toBeVisible()
  // the screen says what is sent with a question, and that payees go only as anonymous labels (N-005)
  await expect(page.getByText(/Payees are sent only as anonymous labels, never their names or addresses/)).toBeVisible()

  // 1. two things in one question
  await page.getByLabel('Your question').fill('Invest ₹2,000 every month in the Nifty 50 index fund, and park my idle cash.')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await page.waitForURL(/\/ask\?c=cnv_/)
  const turns = page.locator('ol.thread > li')
  await expect(turns).toHaveCount(1)
  const t1 = turns.nth(0)
  await expect(t1.getByText('Written by a scripted test double, not a model')).toBeVisible()
  // the made-up figure is flagged; the owner's own ₹2,000 is not
  const flagged = t1.getByRole('alert').filter({ hasText: 'Not found in your records' }).or(t1.locator('.note').filter({ hasText: 'Not found in your records' }))
  await expect(flagged).toContainText('₹7,77,777')
  await expect(flagged).not.toContainText('₹2,000')
  // the records it rests on, with the values the ledger holds
  const bankShown = await t1.locator('dt', { hasText: 'Bank balance' }).locator('xpath=following-sibling::dd[1]').innerText()
  const [bank] = query<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ? AND a.code = 'bank'`, person!.id)
  expect(BigInt(rupees(bankShown))).toBe(fromAmountText(bank!.s, 'the bank balance'))
  await expect(t1.getByRole('link', { name: 'Your standing instructions' })).toBeVisible()
  await expect(t1.getByRole('link', { name: 'Your floor and reserve' })).toBeVisible()
  await expect(t1.getByText('Drafted by a scripted test double, not a model. No licensed adviser has reviewed it')).toHaveCount(2)
  // both opened as drafts together
  await t1.getByRole('button', { name: 'Open all 2 as drafts' }).click()
  await expect(page.getByText('Opened 2 drafts')).toBeVisible()
  const drafts = query<{ origin: string; state: string }>(`SELECT origin, state FROM programs WHERE user_id = ? ORDER BY created_at`, person!.id)
  expect(drafts).toHaveLength(2)
  for (const d of drafts) expect(d).toMatchObject({ state: 'draft', origin: expect.stringMatching(/^proposal:prp_/) })

  // 2. a correction: the earlier invest proposal is replaced, not edited, and the earlier turn went to the model
  await page.getByLabel('Reply, correct a proposal, or say “cancel”').fill('Make it ₹3,000 instead')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(turns).toHaveCount(2)
  await expect(t1.getByText('Replaced after your correction')).toBeVisible()
  await expect(t1.getByText(/You had opened this version as a draft; that draft is unchanged/)).toBeVisible()
  // titled as the cards show them: QED's own words for what each one does
  await expect(turns.nth(1).getByText('Corrects "Invest ₹2,000 in UTI Nifty 50 Index Fund".')).toBeVisible()
  const [conv] = query<{ id: string }>('SELECT id FROM conversations WHERE person_id = ?', person!.id)
  const props = query<{ id: string; state: string; amount: number }>(`SELECT id, state, json_extract(params_json, '$.params.amount') amount FROM proposals WHERE conversation_id = ? AND kind = 'invest' ORDER BY ts`, conv!.id)
  expect(props.map((p) => [p.state, p.amount])).toEqual([['superseded', 200_000], ['new', 300_000]])
  const calls = query<{ sent_json: string }>('SELECT sent_json FROM ai_calls WHERE conversation_id = ? ORDER BY ts', conv!.id)
  expect(calls).toHaveLength(2)
  expect(calls[1]!.sent_json).toContain(props[0]!.id)

  // 3. cancel: QED withdraws the open proposal itself; the draft already opened stays a draft
  await page.getByLabel('Reply, correct a proposal, or say “cancel”').fill('cancel that')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(turns).toHaveCount(3)
  const t3 = turns.nth(2)
  await expect(t3.getByText('Handled by QED\'s own code; no model was asked')).toBeVisible()
  await expect(t3.getByText(/^Withdrawn: "Invest ₹3,000 in UTI Nifty 50 Index Fund"\. Nothing was signed/)).toBeVisible()
  expect(query('SELECT COUNT(*) n FROM ai_calls WHERE conversation_id = ?', conv!.id)[0]).toEqual({ n: 2 })
  expect(query<{ state: string }>('SELECT state FROM proposals WHERE id = ?', props[1]!.id)[0]!.state).toBe('dismissed')
  expect(query<{ n: number }>(`SELECT COUNT(*) n FROM programs WHERE user_id = ? AND state = 'draft'`, person!.id)[0]!.n).toBe(2)

  // the conversation is kept: after a reload it opens as it was, titled with its first question, and is the current one
  // among the conversations (Meridian keeps them in a rail beside the thread on a wide window, behind a "Conversations"
  // button on a narrow one)
  await page.reload()
  await expect(turns).toHaveCount(3)
  await expect(page.getByRole('heading', { level: 1, name: /Invest ₹2,000 every month/ })).toBeVisible()
  const listed = page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Invest ₹2,000 every month/ })
  await expect(listed).toBeVisible()
  await expect(listed).toHaveAttribute('aria-current', 'page')
})
