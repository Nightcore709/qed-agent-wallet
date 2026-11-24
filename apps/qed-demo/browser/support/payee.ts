/**
 * Adding a payee on Spend as a person does (src/screens/Pay.tsx, AddPayee): the name, the address, "Add this payee".
 * The paper bank's name check answers before the payee is saved (server/name-check.ts); on anything but a match the page
 * shows its answer and asks the person to say they checked the address themselves, which this ticks before adding it
 * anyway. The payee just added is the one chosen, as Spend keeps it.
 */
import { expect, type Page } from '@playwright/test'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function addPayeeOnSpend(page: Page, name: string, address: string): Promise<void> {
  // the form is open when there is no payee yet, and one press away after that: wait for the page to draw either
  const open = page.getByRole('button', { name: 'Add a payee', exact: true }), field = page.getByLabel('Name', { exact: true })
  await expect(open.or(field)).toBeVisible()
  if (await open.isVisible()) await open.click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Payment address').fill(address)
  await page.getByRole('button', { name: 'Add this payee', exact: true }).click()
  const added = page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: new RegExp(`\\(${escapeRe(address)}\\)$`) })
  const asks = page.getByLabel('I checked this address with the payee myself, not from a message or a call')
  await expect(added.or(asks)).toBeVisible()
  if (await asks.isVisible()) {
    await asks.check()
    await page.getByRole('button', { name: /^Add it (anyway|with the name I gave)$/ }).click()
  }
  await expect(added).toBeChecked()
}

/**
 * Choose a payee on Spend as a person does, by pressing its row (Spend chooses nobody on arrival). The radio itself is
 * drawn as the row; a press on the row checks it.
 */
export async function choosePayeeOnSpend(page: Page, address: string): Promise<void> {
  const named = { name: new RegExp(`\\(${escapeRe(address)}\\)$`) }
  const to = page.getByRole('radiogroup', { name: 'To' })
  // the inner locator of `has` is matched inside each label, so it names the radio alone
  await to.locator('label').filter({ has: page.getByRole('radio', named) }).getByText(address, { exact: true }).click()
  await expect(to.getByRole('radio', named)).toBeChecked()
}
