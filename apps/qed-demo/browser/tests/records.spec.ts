/**
 * The person's data rights (N-007), in Protect: the data is exported as one JSON file; the access log shows the sign-in;
 * deleting needs the exact words and (here, already fresh) a passkey confirmation, waits, and can be cancelled; then it is
 * asked for again and takes effect when the wait ends: the personal fields are erased, the books are intact and the account
 * can no longer be used. The wait is shortened on this file's own stack (QED_DELETION_DELAY_SEC); the database is read to
 * check what the screens say.
 */
import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_RECORDS_PORT ?? extraPort(44))
const DELAY_SEC = 20
let s: Awaited<ReturnType<typeof startExtraStack>>
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_DELETION_DELAY_SEC: String(DELAY_SEC) }) })
test.afterAll(async () => { await s?.stop() })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('rec')
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

test('export, the access log, and a deletion that waits, can be cancelled, then erases the personal fields and keeps the books', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const entries = () => s.query<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', person!.id)[0]!.n
  const before = entries()
  expect(before).toBeGreaterThan(0)

  await page.goto(`${s.base}/protect#data`)
  const data = page.getByRole('region', { name: 'Your data' })
  await expect(data).toBeVisible()
  await expect(data.getByRole('heading', { name: /Who used your account, last 365 days/ })).toBeVisible()
  await expect(data.getByRole('row', { name: /Signed in/ }).first()).toBeVisible()

  // everything, as one file
  const dl = page.waitForEvent('download')
  await data.getByRole('button', { name: 'Download my data (JSON)' }).focus()
  await page.keyboard.press('Enter')
  const file = JSON.parse(readFileSync((await (await dl).path())!, 'utf8')) as { format: string; tables: Record<string, unknown[]>; notIncluded: { table: string }[] }
  expect(file.format).toBe('qed-export/1')
  expect((file.tables.users![0] as { handle: string }).handle).toBe(handle)
  expect(file.tables.entries!.length).toBe(before)
  expect(JSON.stringify(file.tables)).not.toContain('pw_hash')
  expect(file.notIncluded.map((n) => n.table)).toContain('person_keys')
  await expect(data.getByRole('row', { name: /Exported your data/ })).toBeVisible()

  // the schedule says what happens, with its sources, and never claims physical erasure
  await data.getByText('Retention schedule: what deleting does to each table').click()
  await expect(data.getByText(/does not claim physical erasure/)).toBeVisible()
  await expect(data.getByRole('row', { name: /^entries Kept .* 5 years from deletion/ })).toBeVisible()
  // each rule names where it was read and how far: since the primary-source pass (4ac8e0a) the Rules' retention period
  // is verified against the Gazette text and said to be not yet in force (docs/research/qed-fin-infra-compliance/
  // 20261124-r13-primary-sources.md, rows PRV-05c to PRV-05e)
  const r2 = data.getByRole('listitem').filter({ hasText: /^R2\. Personal data, traffic data and logs are kept at least one year/ })
  await expect(r2).toContainText('it is not yet in force')
  await expect(r2).toContainText('rows PRV-05c and PRV-05d')
  await expect(r2).toContainText('verified 24 Nov 2026 against the Gazette text')

  // the words are needed; a request waits and is cancelled
  const del = data.getByRole('button', { name: 'Delete my account' })
  await expect(del).toBeDisabled()
  const confirm = data.getByLabel('Type delete my account to confirm')
  await confirm.fill('delete my account')
  await del.focus()
  await page.keyboard.press('Enter')
  await expect(data.getByText(/Deletion is scheduled for/)).toBeVisible()
  expect(s.query('SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = ? AND cancelled_at IS NULL AND applied_at IS NULL', person!.id, 'delete-account')).toHaveLength(1)
  await data.getByRole('button', { name: 'Cancel the deletion' }).click()
  await expect(data.getByLabel('Type delete my account to confirm')).toBeVisible()
  await page.waitForTimeout((DELAY_SEC + 8) * 1000)
  expect(s.query('SELECT 1 FROM erasures WHERE person_id = ?', person!.id)).toHaveLength(0)

  // asked for again, it takes effect when the wait ends
  await data.getByLabel('Type delete my account to confirm').fill('delete my account')
  await data.getByRole('button', { name: 'Delete my account' }).click()
  await expect(data.getByText(/Deletion is scheduled for/)).toBeVisible()
  await expect.poll(() => s.query('SELECT 1 FROM erasures WHERE person_id = ?', person!.id).length, { timeout: 90_000, intervals: [2_000] }).toBe(1)

  const [u] = s.query<{ handle: string; display_name: string; pw_hash: string }>('SELECT handle, display_name, pw_hash FROM users WHERE id = ?', person!.id)
  expect(u).toEqual({ handle: `erased-${person!.id}`, display_name: 'Erased account', pw_hash: '!' })
  expect(s.query('SELECT 1 FROM sessions WHERE user_id = ?', person!.id)).toHaveLength(0)
  expect(s.query('SELECT 1 FROM webauthn_credentials WHERE person_id = ?', person!.id)).toHaveLength(0)
  expect(s.query<{ destroyed_at: number | null; key: unknown }>('SELECT destroyed_at, key FROM person_keys WHERE person_id = ?', person!.id)[0]).toMatchObject({ key: null })
  expect(entries()).toBe(before)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible({ timeout: 20_000 })
})
