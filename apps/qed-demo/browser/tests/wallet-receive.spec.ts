/**
 * Receiving on the on-chain wallet (R12 task comparison, T10-b): the Treasury page gives the address of the owner's own
 * account on this chain with the chain written before it (eip155:<chain id>:<address>), copies it whole, and checks an
 * address someone gives you against it; the same address on another chain is not it.
 */
import { expect, type Page, test } from '../support/test.ts'
import { household, railGet } from '../support/vault.ts'
import { AxeBuilder } from '@axe-core/playwright'

async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test('the wallet gives an address to receive at, copies it whole, and checks an address you were given', async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await household(browser)
  const p = a.page
  const st = await railGet(`/workspaces/${a.railId}/state`)
  const owner = String(st.roles.owner), chain = Number(st.network.chainId)
  const id = `eip155:${chain}:${owner}`
  await p.goto('/vault/treasury')
  const rc = p.getByRole('region', { name: 'Receive' })
  await expect(rc.getByText(id, { exact: true })).toBeAttached()
  await expect(rc.getByText(`local test chain, id ${chain}`, { exact: false })).toBeVisible()
  await accessible(p, 'section.vt-receive')
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await rc.getByRole('button', { name: 'Copy the address' }).click()
  await expect(rc.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(id)
  const check = rc.getByLabel('Check an address you were given')
  const verdict = rc.getByRole('status')
  await check.fill(owner.slice(0, -1) + (owner.endsWith('0') ? '1' : '0'))
  await expect(verdict).toHaveText('It is not this address. Do not use it.')
  await check.fill(`eip155:1:${owner}`)
  await expect(verdict).toHaveText('It is not this address. Do not use it.')
  await check.fill(owner.toLowerCase())
  await expect(verdict).toHaveText(`It is this address. It names no chain: it is for the local test chain, id ${chain}.`)
  await check.fill(id)
  await expect(verdict).toHaveText('It is this address.')
})
