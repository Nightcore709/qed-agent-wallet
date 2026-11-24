/**
 * What the sign-in and sign-up pages say the device will ask for (R12: platform words stay accurate and promise no
 * particular biometric method). Each platform's checks are named as examples, always with one that is not a biometric.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceWords } from './passkey.ts'

const as = (userAgent: string, platform = '') => vi.stubGlobal('navigator', { userAgent, userAgentData: { platform } })
afterEach(() => { vi.unstubAllGlobals() })

describe('deviceWords', () => {
  it('names each platform\'s checks as examples, with one that is not a biometric, and never promises one method', () => {
    const cases: [string, string, string][] = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', '', 'its usual check, such as Face ID, Touch ID or its passcode'],
      ['Mozilla/5.0 (Linux; Android 15)', 'Android', 'its usual check, such as a fingerprint, face or screen lock'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)', 'macOS', 'its usual check, such as Touch ID or your Mac\'s password, or a phone nearby'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows', 'its usual check, such as Windows Hello (face, fingerprint or PIN), or a phone nearby'],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux', 'its usual check, such as its screen lock, a phone nearby or a security key'],
    ]
    for (const [ua, platform, words] of cases) {
      as(ua, platform)
      const w = deviceWords()
      expect(w, ua).toBe(words)
      expect(w, ua).toMatch(/^its usual check, such as /)
      expect(w, ua).toMatch(/passcode|password|PIN|screen lock/)
    }
  })
})
