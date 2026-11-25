/**
 * Email through Postmark's HTTP API (QED_DELIVERY=postmark), with fetch alone: no library, no new dependency.
 *
 * One POST to {base}/email per message, with the Server API token in X-Postmark-Server-Token, a 10 second limit and no
 * redirects followed (a redirect would carry the token somewhere else). Postmark's MessageID is the message's provider
 * reference. Link tracking and open tracking are off: a link in a message must reach the page as written, and a token in
 * it is not Postmark's to rewrite or count.
 *
 * Outcomes (dispatchQueued in delivery.ts acts on them):
 *   sent     Postmark answered 200 with ErrorCode 0 and a MessageID.
 *   retry    HTTP 429, 5xx (Postmark's 100 offline, 101 internal error), a timeout, or no answer: the message stays
 *            queued and is tried again for a short while.
 *   failed   anything else: 4xx and 422 with an ErrorCode (10 token, 300 validation, 406 inactive recipient, ...), a 200
 *            whose answer has no MessageID (whether it was sent is unknown, so it is not sent twice).
 *
 * Nothing here logs, and no error text holds a message body, a link, a token or an address: Postmark's own "Message" is
 * not copied (it can quote the recipient), only a fixed reading of its ErrorCode. Error codes as Postmark's API overview
 * lists them (https://postmarkapp.com/developer/api/overview, read 26 Nov 2026).
 */
import { type DeliveryAdapter, DeliveryError } from './delivery.ts'
import type { PostmarkConfig } from './postmark-config.ts'

export const POSTMARK_TIMEOUT_MS = 10_000

/** Fixed readings of Postmark's ErrorCode, for the stored reason. Never Postmark's own text. */
export const POSTMARK_CODES: Record<number, string> = {
  10: 'the server token was not accepted',
  100: 'Postmark is offline for maintenance',
  101: 'Postmark had an internal error',
  300: 'the message failed Postmark\'s validation (an address, a field or a size)',
  402: 'invalid JSON',
  403: 'an invalid request field',
  406: 'the recipient address is inactive at Postmark (it bounced or was reported as spam)',
  412: 'while the Postmark account is pending approval, every recipient must share the From address\'s domain',
  413: 'the Postmark account is not approved to send email',
  422: 'invalid Server or Account',
  1235: 'the message stream does not exist on this Postmark server',
  1236: 'sending is not supported for this message stream',
  1480: 'this computer\'s address is not allowed by the Postmark server\'s IP restriction',
}

export function postmarkAdapter(cfg: PostmarkConfig, fetchImpl: typeof fetch = fetch): DeliveryAdapter {
  return {
    name: 'postmark', simulated: false,
    async send(m) {
      if (m.channel !== 'email') throw new DeliveryError('Postmark is the email adapter: text messages are not sent through it.', false)
      let res: Response
      try {
        res = await fetchImpl(`${cfg.baseUrl}/email`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(POSTMARK_TIMEOUT_MS),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': cfg.token },
          body: JSON.stringify({ From: cfg.from, To: m.to, Subject: m.subject, TextBody: m.body, MessageStream: cfg.stream, TrackOpens: false, TrackLinks: 'None', Tag: m.purpose.slice(0, 1000) }),
        })
      } catch (e) {
        // a timeout, no connection, or a redirect: nothing says Postmark took it, so it is tried again for a while
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
        throw new DeliveryError(timedOut ? `Postmark did not answer within ${POSTMARK_TIMEOUT_MS / 1000} seconds.` : 'Postmark could not be reached.', true)
      }
      let answer: { ErrorCode?: unknown; MessageID?: unknown } = {}
      try { const parsed: unknown = JSON.parse((await res.text()).slice(0, 20_000)); if (parsed && typeof parsed === 'object') answer = parsed as typeof answer } catch { /* not JSON: judged by the status */ }
      const code = typeof answer.ErrorCode === 'number' ? answer.ErrorCode : null
      if (res.status === 200 && code === 0) {
        if (typeof answer.MessageID === 'string' && answer.MessageID.length >= 8 && answer.MessageID.length <= 100) return { providerRef: answer.MessageID }
        throw new DeliveryError('Postmark answered without a MessageID, so it is not known whether the message was sent; it is not sent again.', false)
      }
      const retry = res.status === 429 || res.status >= 500
      const why = res.status === 429 ? 'Postmark asked QED to slow down (HTTP 429)' : code !== null && POSTMARK_CODES[code] ? POSTMARK_CODES[code] : 'see Postmark\'s error codes'
      throw new DeliveryError(`Postmark ${retry ? 'could not take it now' : 'refused it'} (HTTP ${res.status}${code !== null ? `, error ${code}` : ''}): ${why}.`, retry)
    },
  }
}
