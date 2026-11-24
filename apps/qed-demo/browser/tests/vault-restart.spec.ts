/**
 * Two households across a restart of every service (R7-048, in part): each sets up and accepts its own vault and one
 * pauses it; then QED's engine and API, the vault service and its local chain are all stopped and started again on
 * the same data. Afterwards each household sees its own vault as before, the paused one is still paused on the chain
 * and on the screen, the other is not, and the passkey still signs: resuming works. Runs on a stack of its own, so
 * stopping it disturbs no other test.
 */
import { expect, test } from '../support/test.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { approve, household, railGet, treasury } from '../support/vault.ts'

const PORT = Number(process.env.QED_RESTART_PORT ?? extraPort(14))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { test.setTimeout(180_000); s = await startExtraStack(PORT, {}, { rail: true }) })
test.afterAll(async () => { await s?.stop() })

test('two households keep their own vaults across a restart of every service; a paused vault stays paused and its passkey still signs', async ({ browser }) => {
  test.setTimeout(360_000)
  const at = { port: s.railPort, dir: `${s.dir}/vault` }
  const [a, b] = await Promise.all([household(browser, s.base, s.query), household(browser, s.base, s.query)])
  await a.page.getByRole('button', { name: 'Pause the wallet' }).click()
  await approve(a.page, /Your owner account runs this call.*pause/)
  const before = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  expect(before[0].treasury.paused).toBe(true)
  expect(before[1].treasury.paused).toBe(false)

  await s.restart()

  const after = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  for (const i of [0, 1]) {
    expect(after[i]!.treasury.balance).toBe(before[i]!.treasury.balance)
    expect(after[i]!.treasury.paused).toBe(before[i]!.treasury.paused)
    expect(after[i]!.roles.owner).toBe(before[i]!.roles.owner)
  }
  // the screens, after a reload with the same sessions
  await a.page.goto(`${s.base}/vault`)
  await expect(treasury(a.page).getByText('Paused')).toBeVisible({ timeout: 20_000 })
  await expect(treasury(a.page).locator('.lead')).toHaveText('₹1,00,000.00')
  await b.page.goto(`${s.base}/vault`)
  await expect(treasury(b.page).locator('.lead')).toHaveText('₹1,00,000.00')
  await expect(treasury(b.page).getByText('Paused')).toHaveCount(0)
  // the passkey still signs after the restart: A resumes its vault
  await a.page.getByRole('button', { name: 'Resume the wallet' }).click()
  await approve(a.page, /Your owner account runs this call.*unpause/)
  expect((await railGet(`/workspaces/${a.railId}/state`, at)).treasury.paused).toBe(false)
  expect((await railGet(`/workspaces/${b.railId}/state`, at)).treasury.paused).toBe(false)
})
