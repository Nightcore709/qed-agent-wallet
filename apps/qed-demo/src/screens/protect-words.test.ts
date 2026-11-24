/**
 * Security and Safeguards say the same things the same way (finish review, 23 Nov): one name for a session that is not
 * a browser, a shortened delay said as shortened with what it normally is, and the pause named rather than "it". And
 * a passkey is said with what unlocks it only where the name the server gave it says which system made it (R10 §7).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pauseWords } from './Safeguards.tsx'
import { delayWords, eventWords, sessionDevice, unlockWords } from './Security.tsx'

describe('Security and Safeguards: the same words for the same things', () => {
  it('names a session by its browser and system, and anything that is not a browser as such, on both pages', () => {
    expect(sessionDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome on a Mac')
    expect(sessionDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS')
    expect(sessionDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Firefox on Windows')
    expect(sessionDevice('node')).toBe('A program, not a browser')
    expect(sessionDevice('undici')).toBe('A program, not a browser')
    expect(sessionDevice('curl/8.4.0')).toBe('A program, not a browser')
    expect(sessionDevice(null)).toBe('An unnamed device')
  })

  it('says of a shortened delay what it is here and what it normally is, and of a normal one just what it is', () => {
    expect(delayWords(6_000)).toBe('6 seconds here (72 hours normally)')
    expect(delayWords(1_000)).toBe('1 second here (72 hours normally)')
    expect(delayWords(60_000)).toBe('1 minute here (72 hours normally)')
    expect(delayWords(2 * 3600_000)).toBe('2 hours here (72 hours normally)')
    expect(delayWords(72 * 3600_000)).toBe('72 hours')
  })

  it('says what the pause is doing, not "it"', () => {
    expect(pauseWords(null)).toBe('The pause is off: instructions in force run as signed.')
    expect(pauseWords({ protectiveContinues: false })).toBe('The pause is on: nothing runs.')
    expect(pauseWords({ protectiveContinues: true })).toBe('The pause is on: nothing runs except protective selling, as you chose.')
    expect(pauseWords({ protectiveContinues: true, reason: 'Paused by you' })).toBe('The pause is on: nothing runs except protective selling, as you chose.')
  })

  it('a pause someone else made is not said to be the owner\'s choice (R13: attribution on every screen)', () => {
    // a recovery contact's pause, and one made with a saved code from the signed-out page, keep protective selling on
    // by rule (server/recovery.ts contactPause, server/stop-with-code.ts): the owner did not choose it
    for (const reason of ['Paused by your recovery contact @asha', 'Paused with a saved recovery code, from the signed-out page']) {
      const w = pauseWords({ protectiveContinues: true, reason })
      expect(w).not.toMatch(/as you chose/)
      expect(w).toBe(`The pause is on: nothing runs except protective selling. ${reason}; a pause made that way keeps protective selling that runs without asking going, and one set to ask first still waits for a passkey approval before each sale.`)
    }
    expect(pauseWords({ protectiveContinues: false, reason: 'Paused by your recovery contact @asha' })).toBe('The pause is on: nothing runs. Paused by your recovery contact @asha.')
  })

  it('the security history says what a pause by a saved code or a contact did, and only claims protective selling kept running when it did', () => {
    expect(eventWords({ kind: 'paused-with-saved-code', detail: { already: false, protectiveContinues: true } })).toBe('QED was paused with a saved recovery code, from the signed-out page (protective selling kept running)')
    expect(eventWords({ kind: 'paused-by-contact', detail: { already: false, protectiveContinues: true } })).toBe('Your recovery contact paused QED for you (protective selling kept running)')
    // QED was already paused, with protective selling stopped too: nothing changed, and nothing kept running
    expect(eventWords({ kind: 'paused-with-saved-code', detail: { already: true, protectiveContinues: false } })).toBe('A saved recovery code was used to pause QED from the signed-out page; it was already paused, so nothing changed (protective selling stays stopped)')
    expect(eventWords({ kind: 'paused-by-contact', detail: { already: true, protectiveContinues: false } })).toBe('Your recovery contact asked to pause QED for you; it was already paused, so nothing changed (protective selling stays stopped)')
    expect(eventWords({ kind: 'paused-by-contact', detail: { already: true, protectiveContinues: true } })).toBe('Your recovery contact asked to pause QED for you; it was already paused, so nothing changed (protective selling kept running)')
    // a confirmation the simulated outbox kept is not said to be sent (R13: simulated delivery is never presented as real)
    expect(eventWords({ kind: 'email-confirmation-sent', detail: { address: 'a•••@gmail.com', simulated: true } })).toBe('A confirmation for an email address was kept in the simulated outbox, not sent')
    expect(eventWords({ kind: 'phone-confirmation-sent', detail: { address: '••••••1234', simulated: true } })).toBe('A confirmation for a phone number was kept in the simulated outbox, not sent')
    // an event recorded before R13 says only whether it was already paused: nothing is claimed about protective selling
    expect(eventWords({ kind: 'paused-with-saved-code', detail: { already: true } })).toBe('A saved recovery code was used to pause QED from the signed-out page; it was already paused, so nothing changed')
  })
})

describe('a passkey, said with what unlocks it', () => {
  // The names the server gives a passkey nobody named (server/passkeys.ts nameOf), read from its source so the two
  // cannot drift apart: every name that says a system has words for what unlocks it there.
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'server', 'passkeys.ts'), 'utf8')
  const body = /function nameOf\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const named = [...body.matchAll(/'(Passkey on [^']+)'/g)].map((m) => m[1]!)

  it('has words for every system the server names a passkey after', () => {
    expect(named.length).toBeGreaterThanOrEqual(4)
    for (const n of named) expect(unlockWords(n), n).toMatch(/^Unlocked by /)
  })

  // R12: the platform's checks are named as examples ("such as"), always with one that is not a biometric, so that no
  // particular biometric method is promised: the device may have none, or the person may not use it.
  it('says the platform\'s own unlock for each, as examples, always with one that is not a biometric', () => {
    expect(unlockWords('Passkey on a Mac')).toBe('Unlocked by the Mac\'s own check, such as Touch ID or its password')
    expect(unlockWords('Passkey on an iPhone or iPad')).toBe('Unlocked by the device\'s own check, such as Face ID, Touch ID or its passcode')
    expect(unlockWords('Passkey on Android')).toBe('Unlocked by the device\'s own check, such as a fingerprint, face or screen lock')
    expect(unlockWords('Passkey on Windows')).toBe('Unlocked by Windows Hello, such as a face, fingerprint or PIN')
    for (const n of named) expect(unlockWords(n), n).toMatch(/such as .*(password|passcode|screen lock|PIN)/)
  })

  it('claims nothing for a name the owner chose, or a plain "Passkey"', () => {
    expect(unlockWords('Work laptop')).toBeNull()
    expect(unlockWords('Passkey')).toBeNull()
    expect(unlockWords('My Mac')).toBeNull()
  })
})

describe('the three kinds of protection, told apart in words (R11: observations, configured policies, independent enforcement)', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { BY_WORD, KIND_WORD, KindTag, SetAndEnforced } = await import('../ui/kinds.tsx')
  const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')

  it('gives each kind its own words', () => {
    expect(new Set(Object.values(KIND_WORD)).size).toBe(3)
    expect(KIND_WORD).toEqual({ watched: 'Watched', set: 'Set by you', enforced: 'Enforced' })
  })

  it('names who enforces, and never shows a kind by its mark alone', () => {
    for (const by of ['server', 'cosigner', 'chain'] as const) {
      const html = renderToStaticMarkup(createElement(KindTag, { kind: 'enforced', by }))
      expect(text(html)).toBe(`Enforced by ${BY_WORD[by]}`)
      expect(html).toContain('aria-hidden="true"')
    }
    expect(text(renderToStaticMarkup(createElement(KindTag, { kind: 'watched' })))).toBe('Watched')
    expect(text(renderToStaticMarkup(createElement(SetAndEnforced, { by: 'server' })))).toBe("Set by youEnforced by QED's server")
  })
})
