/**
 * Judge-facing evidence in QED (N-010): a fresh household whose on-chain wallet has done something reads the case
 * for it in the interface: the eight steps in plain words, the hashes recomputed in the browser, what the case cannot
 * prove and what was left out; and the same case is "not found" to another household. The case itself is assembled
 * by the server from the stack's own records (server/evidence.ts); this test reads what a person would see.
 */
import { expect, test } from '../support/test.ts'
import { household } from '../support/vault.ts'

test('a household reads the evidence for its own wallet operation, step by step, and its hashes check out in the browser; another household cannot open it', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await household(browser)
  await a.page.goto('/evidence')
  // the page is named for what it is; its tabs are the shell's, drawn once (the screen's own second copy of the same
  // three links, "Activity views", was removed in the Bounds redesign as a duplicate navigation landmark)
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('Evidence')
  await expect(a.page.getByRole('navigation', { name: 'Activity pages' }).getByRole('link', { name: 'Evidence' })).toHaveAttribute('aria-current', 'page')
  const first = a.page.locator('table.ledger tbody tr').first().getByRole('link')
  await expect(first).toBeVisible({ timeout: 30_000 })
  await first.click()
  await a.page.waitForURL(/\/evidence\//)
  // opened at its own address (a case id contains a dot), the page is served, not "Not found."
  await a.page.reload()
  // the eight steps, each with its own heading
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8']) await expect(a.page.locator(`#ev-${n}`)).toBeVisible()
  await expect(a.page.getByRole('heading', { name: 'What this case cannot prove' })).toBeVisible()
  await expect(a.page.getByRole('heading', { name: 'What was left out, and why' })).toBeVisible()
  // the browser recomputes every hash itself
  await a.page.getByRole('button', { name: 'Check its hashes here' }).click()
  await expect(a.page.getByText('Every hash matches, recomputed in this browser')).toBeVisible()
  const caseUrl = new URL(a.page.url()).pathname
  // another household: not found, never shown
  const b = await household(browser)
  await b.page.goto(caseUrl)
  await expect(b.page.getByText('That case was not found.')).toBeVisible({ timeout: 20_000 })
})
