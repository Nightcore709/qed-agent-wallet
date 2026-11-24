/**
 * How email and text messages leave QED (R12 section 4): one adapter interface, the local test outbox this build uses,
 * and a provider adapter that is prepared but not configured.
 *
 *   Outbox     the default of the local build (QED_DELIVERY=outbox). A message is stored and shown on the developer
 *              page /dev/outbox under "Simulated delivery: no email or text message was sent". Nothing leaves this
 *              computer, and nothing presents a stored message as one that was sent. Refused with a public origin
 *              (core.ts loadConfig): the page shows reset links to whoever can open it.
 *   None       no adapter (the default with a public origin): a feature that needs a message says that it cannot send one.
 *   Provider   prepared, not configured. A real email or SMS provider needs, before any code may send through it: a
 *              provider account, its credentials kept out of source control, a verified sending domain (SPF, DKIM,
 *              DMARC) for email, sender registration for text messages in India (TRAI's DLT registration of the sender
 *              ID and each message template), and the owner's approval for the spending and for handing addresses and
 *              message contents to that provider (PROVIDER_DEPENDENCY). Until then `providerAdapter` refuses.
 *
 * Messages are plain text. A link points at the one configured origin (core.ts Config.linkOrigin), never at the request's
 * Host header (OWASP Forgot Password Cheat Sheet, "URL tokens"), and carries its token in the fragment, which browsers
 * do not send to any server or in a Referer header.
 *
 * What is kept. The database keeps a link's token only as its SHA-256 and a code only as its scrypt hash (recovery.ts).
 * The outbox also keeps the text of each message, the link and the code in it included, because that text is the
 * simulated delivery. Once the link or code no longer works (used, replaced by a newer one, or expired) both are taken
 * out of the kept text (redactSpent, review L1), so a copy of the database, a backup included, holds no live secret but
 * those of messages still waiting to be used. A message a provider sent keeps no text at all (dispatchQueued).
 */
import { type Config, type Db, newId } from './core.ts'

export type Channel = 'email' | 'sms'
/**
 * tokenId: the one-time token whose link or code the message carries (one_time_tokens.id); secrets: that link and that
 * code exactly as they appear in the body, taken out of the kept text when the token stops working.
 */
export interface Message { channel: Channel; to: string; personId: string | null; purpose: string; subject: string; body: string; tokenId?: string; secrets?: string[] }

export interface DeliveryAdapter {
  readonly name: string
  /** True for the local test outbox: the stored message is the whole delivery, shown as simulated. */
  readonly simulated: boolean
  /** Hand one message to the provider. Resolves with the provider's reference; rejects when it was not accepted. */
  send(m: Message & { id: string }): Promise<{ providerRef: string }>
}

/** The local test outbox: it sends nothing, ever. */
export const OUTBOX: DeliveryAdapter = {
  name: 'local-test-outbox', simulated: true,
  send: async () => { throw new Error('The local test outbox sends nothing: its messages are shown on the developer page only.') },
}

/** What a real provider needs before it may be configured: the exact external dependency, for the owner to decide. */
export const PROVIDER_DEPENDENCY: Record<Channel, string> = {
  email: 'An email provider account (for example Postmark or Amazon SES) with a verified sending domain (SPF, DKIM and DMARC records), an API credential kept outside source control, and the owner\'s approval for its cost and for sending account addresses and security messages to that provider.',
  sms: 'A text-message provider account (for example Twilio, or MSG91 for India), sender ID and message templates registered on TRAI\'s DLT platform for messages to Indian numbers, an API credential kept outside source control, and the owner\'s approval for its cost and for sending phone numbers and security messages to that provider.',
}

/** The provider adapter, prepared and not configured: it refuses, naming what it needs. No code in this build sends. */
export function providerAdapter(channel: Channel): DeliveryAdapter {
  return {
    name: `${channel}-provider-not-configured`, simulated: false,
    send: async () => { throw new Error(`Not configured: ${PROVIDER_DEPENDENCY[channel]}`) },
  }
}

let settings: Pick<Config, 'delivery' | 'linkOrigin'> = { delivery: 'outbox', linkOrigin: 'http://localhost:5174' }
/** Set by the API and the engine from their configuration when they start. */
export function configureDelivery(cfg: Pick<Config, 'delivery' | 'linkOrigin'>): void { settings = { delivery: cfg.delivery, linkOrigin: cfg.linkOrigin } }
export const deliveryMode = (): Config['delivery'] => settings.delivery
export const linkOrigin = (): string => settings.linkOrigin
/** A link to a page of QED with a one-time token in its fragment. */
export const linkTo = (path: string, token: string): string => `${settings.linkOrigin}${path}#token=${token}`

/**
 * Hand a message to the configured adapter. With the outbox it is stored as 'simulated' and that is all. Returns the
 * message's id, or null when no adapter is configured (the caller's answer must not depend on it: see recovery.ts).
 */
export function deliver(db: Db, m: Message, now: number): string | null {
  if (settings.delivery === 'none') return null
  const id = newId('msg', now)
  const body = m.body.slice(0, 4000)
  // The same text with its link and code taken out, kept beside it for when they stop working (redactSpent).
  const redacted = m.tokenId ? (m.secrets ?? []).filter(Boolean).reduce((b, secret) => b.split(secret).join(REMOVED), body) : null
  db.run('INSERT INTO outbound_messages (id, person_id, channel, to_address, purpose, subject, body, created_at, status, adapter, token_id, body_redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, m.personId, m.channel, m.to, m.purpose, m.subject.slice(0, 200), body, now, 'simulated', OUTBOX.name, m.tokenId ?? null, redacted)
  return id
}

/** What stands in a kept message for a link or a code that no longer works. */
export const REMOVED = '[removed: no longer valid]'

/**
 * Take the link and the code out of every kept message whose one-time token no longer works: used, replaced by a newer
 * one, or expired (review L1). Called where a token is spent or replaced, and by the engine's tick for those that expire.
 */
export function redactSpent(db: Db, now: number): number {
  return db.run(`UPDATE outbound_messages SET body = COALESCE(body_redacted, body), redacted_at = ? WHERE redacted_at IS NULL AND token_id IN
    (SELECT id FROM one_time_tokens WHERE used_at IS NOT NULL OR replaced_at IS NOT NULL OR expires_at <= ?)`, now, now).changes
}

/**
 * Prepared for a provider: send every queued message with the given adapter, once each, recording the outcome. Nothing
 * in this build queues a message (the outbox stores them as simulated), so this runs only in its own test, with a fake.
 * A sent message's body is replaced by a note, so a link it carried is not kept beside the database's other records.
 */
export async function dispatchQueued(db: Db, adapter: DeliveryAdapter, now: number, limit = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0
  for (const m of db.all<{ id: string; person_id: string | null; channel: Channel; to_address: string; purpose: string; subject: string; body: string }>(`SELECT * FROM outbound_messages WHERE status = 'queued' ORDER BY created_at LIMIT ?`, limit)) {
    // claimed first, so a second dispatcher cannot send it again
    if (db.run(`UPDATE outbound_messages SET status = 'sending' WHERE id = ? AND status = 'queued'`, m.id).changes !== 1) continue
    try {
      const r = await adapter.send({ id: m.id, channel: m.channel, to: m.to_address, personId: m.person_id, purpose: m.purpose, subject: m.subject, body: m.body })
      db.run(`UPDATE outbound_messages SET status = 'sent', sent_at = ?, provider_ref = ?, adapter = ?, body = '(sent; the text is not kept)', body_redacted = NULL WHERE id = ?`, now, r.providerRef, adapter.name, m.id)
      sent++
    } catch (e) {
      db.run(`UPDATE outbound_messages SET status = 'failed', error = ?, adapter = ? WHERE id = ?`, (e instanceof Error ? e.message : String(e)).slice(0, 300), adapter.name, m.id)
      failed++
    }
  }
  return { sent, failed }
}

/** The developer page's list: newest first. Every row is a simulated message; the page says so above them all. */
export function outboxView(db: Db, limit = 60): { simulated: true; notice: string; messages: { id: string; channel: Channel; to: string; purpose: string; subject: string; body: string; createdAt: number; status: string }[] } {
  return {
    simulated: true,
    notice: 'Simulated delivery: no email or text message was sent.',
    messages: db.all<{ id: string; channel: Channel; to_address: string; purpose: string; subject: string; body: string; created_at: number; status: string }>('SELECT id, channel, to_address, purpose, subject, body, created_at, status FROM outbound_messages ORDER BY created_at DESC, id DESC LIMIT ?', Math.max(1, Math.min(200, limit)))
      .map((m) => ({ id: m.id, channel: m.channel, to: m.to_address, purpose: m.purpose, subject: m.subject, body: m.body, createdAt: m.created_at, status: m.status })),
  }
}

/** "a•••@gmail.com": enough for the owner to recognise an address in a notice, not enough to read it off a screen. */
export function maskAddress(kind: 'email' | 'phone', address: string): string {
  if (kind === 'phone') return address.length > 4 ? `${'•'.repeat(Math.max(0, address.length - 4))}${address.slice(-4)}` : address
  const at = address.lastIndexOf('@')
  if (at < 1) return '•••'
  return `${address[0]}•••${address.slice(at)}`
}

/** What every security notice outside QED ends with: what to do if it was not the person, and where. */
const DISPUTE = (origin: string): string => `If this was not you, open QED at ${origin}/security from a device that has one of your passkeys: suspend a passkey you do not recognise, end every session, and cancel a recovery or a request for approval authority you did not start. A recovery contact can also cancel a recovery for you.`

/**
 * Tell the person on every address they have confirmed, beside the notice inside QED (NIST SP 800-63B-4 section 4.6:
 * every non-postal address; section 4.2.3: every account recovery). Email gets the whole notice; a phone gets a short
 * text that names the event and says to open QED, because a text message is the lower-assurance channel (SECURITY.md,
 * "Text messages"). `extra` names addresses that must hear of it although they are no longer confirmed ones (the old
 * address of a change, an address just removed); with `onlyExtra` only those are sent to.
 */
export function notifyChannels(db: Db, personId: string, n: { kind: string; title: string; body: string }, now: number, extra: { kind: 'email' | 'phone'; address: string }[] = [], onlyExtra = false): number {
  if (settings.delivery === 'none') return 0
  const points = onlyExtra ? [] : db.all<{ kind: 'email' | 'phone'; address: string }>(`SELECT kind, address FROM contact_points WHERE person_id = ? AND verified_at IS NOT NULL AND removed_at IS NULL`, personId)
  const seen = new Set<string>()
  let n_ = 0
  for (const p of [...points, ...extra]) {
    const key = `${p.kind}:${p.address.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    if (p.kind === 'email') deliver(db, { channel: 'email', to: p.address, personId, purpose: `notice:${n.kind}`, subject: `QED: ${n.title}`, body: `${n.title}.\n\n${n.body}\n\n${DISPUTE(settings.linkOrigin)}\n\nThis message is about your QED account. QED never asks for a password, a passkey or a code by email.` }, now)
    else deliver(db, { channel: 'sms', to: p.address, personId, purpose: `notice:${n.kind}`, subject: 'QED security notice', body: `QED: ${n.title}. If this was not you, open QED on a device with your passkey. QED never asks for a code by text.` }, now)
    n_++
  }
  return n_
}
