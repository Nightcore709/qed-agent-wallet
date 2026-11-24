/**
 * What QED says when an installation has no way to send email or text messages (QED_DELIVERY=none: the default with a
 * public origin until a provider is configured, server/delivery.ts). The server refuses with these words and the pages
 * that would otherwise promise a message say them instead (review M4): nothing is said to be sent when nothing can be,
 * and each says what works here instead, the saved recovery codes.
 */
export type NoDeliveryCase = 'reset' | 'recover' | 'address'
export const CANNOT_SEND = 'This installation of QED cannot send email or text messages'

export function noDeliveryWords(what: NoDeliveryCase): string {
  switch (what) {
    case 'reset': return `${CANNOT_SEND}, so a password cannot be reset by email here. If you have lost the password, recover the account with one of your saved recovery codes and a code from your recovery contact.`
    case 'recover': return `${CANNOT_SEND}, so a recovery cannot start by email here. Recover with one of your saved recovery codes and a code from your recovery contact, or the account's password.`
    case 'address': return `${CANNOT_SEND}, so it cannot confirm an email address or a phone number here, or reach you outside QED. Keep your saved recovery codes: on this installation they are your way back in.`
  }
}

/**
 * What the pages say for a message the local test outbox kept (QED_DELIVERY=outbox, this build's only adapter): it was not
 * sent, so it is never said to be on its way or sent (R13: simulated delivery is never presented as a real message). The
 * address is named as the person typed it; whether an account matches is not said, as with a real message.
 */
export type OutboxCase = 'reset' | 'recover' | 'confirm'
export function outboxWords(what: OutboxCase, typed: string): { title: string; body: string } {
  switch (what) {
    case 'reset': return { title: 'Kept in the simulated outbox, not sent', body: `If an account with a confirmed email address matches “${typed}”, the message that would go to that address is kept in the simulated outbox on this computer: nothing was sent. Its link works once, for 30 minutes.` }
    case 'recover': return { title: 'Kept in the simulated outbox, not sent', body: `If an account with a confirmed email address matches “${typed}”, the recovery link that would go to that address is kept in the simulated outbox on this computer: nothing was sent. It works once, for an hour.` }
    case 'confirm': return { title: `Kept in the simulated outbox, not sent to ${typed}`, body: 'Open the link in the kept message, or type its code under Security and recovery: nothing was sent. The address receives your security notices once confirmed.' }
  }
}
