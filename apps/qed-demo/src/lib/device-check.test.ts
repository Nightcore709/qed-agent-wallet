/**
 * What the step "Use your fingerprint, Face ID or device PIN" offers on this device (R14): asked of the browser, never
 * guessed from its name. A device with no user-verifying check of its own is told so and offered a phone or a security
 * key; a browser with no passkeys at all is told that. And the sentence itself is the owner's, word for word.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_SIGN_IN, ENROL_WORDS, NO_DEVICE_CHECK } from '../../shared/access-operations.ts'
import { en } from './i18n-en.ts'
import { deviceCheck } from './passkey.ts'

afterEach(() => { vi.unstubAllGlobals() })
/** A browser whose PublicKeyCredential answers the platform-authenticator question this way. */
function browser(answer: (() => Promise<boolean>) | null): void {
  if (answer === null) { vi.stubGlobal('window', {}); vi.stubGlobal('PublicKeyCredential', undefined); return }
  const PKC = Object.assign(function PublicKeyCredential() { /* a constructor, as browsers have */ }, { isUserVerifyingPlatformAuthenticatorAvailable: answer })
  vi.stubGlobal('window', { PublicKeyCredential: PKC })
  vi.stubGlobal('PublicKeyCredential', PKC)
}

describe('deviceCheck', () => {
  it('this device, when the browser says it has a user-verifying check of its own', async () => {
    browser(async () => true)
    expect(await deviceCheck()).toBe('this-device')
  })
  it('another device, when the browser can use passkeys but this device has no such check', async () => {
    browser(async () => false)
    expect(await deviceCheck()).toBe('other-device')
  })
  it('another device, the careful answer, when the browser cannot say', async () => {
    browser(async () => { throw new Error('not allowed here') })
    expect(await deviceCheck()).toBe('other-device')
  })
  it('none, when the browser has no passkeys at all', async () => {
    browser(null)
    expect(await deviceCheck()).toBe('none')
  })
})

describe('the words of the device step', () => {
  it('are the owner\'s sentence, word for word, on the step itself', () => {
    expect(ENROL_WORDS).toBe('Use your fingerprint, Face ID or device PIN for faster, more secure access.')
    expect(en['passkey.lead']).toBe(ENROL_WORDS)
  })
  it('always name a check that is not a biometric, and never promise one method', () => {
    for (const w of [ENROL_WORDS, DEVICE_SIGN_IN, NO_DEVICE_CHECK]) expect(w).toMatch(/PIN/)
    expect(en['passkey.add']).not.toMatch(/this device/i)
  })
})
