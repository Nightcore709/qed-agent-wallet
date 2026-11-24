/**
 * Review M4 (24 Nov 2026): with no delivery adapter (QED_DELIVERY=none), the pages said "Check your email" and "Confirmation
 * sent" although nothing could be sent. These are the words the server refuses with and the pages say instead: that this
 * installation cannot send, that the email way is not available here, and what to use instead (the saved codes).
 */
import { describe, expect, it } from 'vitest'
import { CANNOT_SEND, noDeliveryWords, outboxWords } from './delivery-words.ts'

describe('words for an installation that cannot send messages', () => {
  const cases = ['reset', 'recover', 'address'] as const

  it('each says the installation cannot send, and points at the saved recovery codes', () => {
    expect(CANNOT_SEND).toBe('This installation of QED cannot send email or text messages')
    for (const c of cases) {
      const w = noDeliveryWords(c)
      expect(w.startsWith(CANNOT_SEND), c).toBe(true)
      expect(w, c).toMatch(/saved recovery code/)
    }
  })

  it('none of them says or implies that a message was sent', () => {
    for (const c of cases) expect(noDeliveryWords(c), c).not.toMatch(/\bsent\b|on its way|check your email|we emailed|was emailed/i)
  })

  it('each names what is not available here', () => {
    expect(noDeliveryWords('reset')).toMatch(/password cannot be reset by email here/)
    expect(noDeliveryWords('recover')).toMatch(/recovery cannot start by email here/)
    expect(noDeliveryWords('recover')).toMatch(/recovery contact/)
    expect(noDeliveryWords('address')).toMatch(/cannot confirm an email address or a phone number here/)
  })
})

/**
 * R13 (notifications): with the local test outbox (this build's only adapter) nothing is sent either, yet the pages said
 * "Check your email: a message is on its way to that address" and "Confirmation sent to …" above a note saying no email
 * or text message is sent from this computer. Simulated delivery is never presented as a real message: these are the
 * words the pages say for a message kept in the simulated outbox.
 */
describe('words for a message kept in the simulated outbox', () => {
  const cases = ['reset', 'recover', 'confirm'] as const

  it('none says or implies that a message was sent or is on its way, and each says where it is kept', () => {
    for (const c of cases) {
      const w = outboxWords(c, 'asha@example.com')
      expect(`${w.title} ${w.body}`, c).not.toMatch(/(?<!not )\bsent to\b|on its way|check your email|we emailed|was emailed|confirmation sent/i)
      expect(w.title, c).toMatch(/simulated outbox/i)
      expect(w.body, c).toMatch(/nothing was sent|not sent/i)
    }
  })

  it('says how long the kept link works, as the real message would, and names the address only as typed', () => {
    expect(outboxWords('reset', 'asha').body).toBe('If an account with a confirmed email address matches “asha”, the message that would go to that address is kept in the simulated outbox on this computer: nothing was sent. Its link works once, for 30 minutes.')
    expect(outboxWords('recover', 'asha').body).toBe('If an account with a confirmed email address matches “asha”, the recovery link that would go to that address is kept in the simulated outbox on this computer: nothing was sent. It works once, for an hour.')
    expect(outboxWords('confirm', 'asha@example.com')).toEqual({ title: 'Kept in the simulated outbox, not sent to asha@example.com', body: 'Open the link in the kept message, or type its code under Security and recovery: nothing was sent. The address receives your security notices once confirmed.' })
  })
})
