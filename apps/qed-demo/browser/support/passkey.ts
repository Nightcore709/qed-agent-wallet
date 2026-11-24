/**
 * A virtual platform authenticator for a Playwright page, through the Chrome DevTools Protocol's WebAuthn domain:
 * resident keys, user verification on (as Touch ID would answer), presence simulated. The page cannot tell it from a
 * real platform authenticator; the server verifies exactly what it would verify for one.
 */
import type { CDPSession, Page } from '@playwright/test'
import { allowSignups } from './stack.ts'

export interface Credential { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number }
export interface VirtualAuthenticator { client: CDPSession; id: string; credentials(): Promise<Credential[]>; setVerified(v: boolean): Promise<void>; remove(): Promise<void>; load(creds: Credential[]): Promise<void> }

export async function addAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  // Every test that creates an account starts here: let the suite's many sign-ups from one address through (see stack.ts).
  allowSignups()
  // The virtual authenticator answers a pending passkey-autofill request at once, with nobody choosing; real browsers
  // wait for the person. Journeys therefore opt their pages out (passkey-autofill.spec.ts opts back in).
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  await page.evaluate(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false }).catch(() => undefined)
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return {
    client, id: authenticatorId,
    credentials: async () => (await client.send('WebAuthn.getCredentials', { authenticatorId })).credentials as Credential[],
    // A passkey synced to another device: the same credential, loaded into this browser's authenticator.
    load: async (creds: Credential[]) => { for (const c of creds) await client.send('WebAuthn.addCredential', { authenticatorId, credential: c }) },
    setVerified: async (v: boolean) => { await client.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: v }) },
    remove: async () => { await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }) },
  }
}
