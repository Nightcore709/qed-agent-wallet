/**
 * Test support: a local stand-in for Postmark's email API (POST /email), so that email delivery (server/postmark.ts) is
 * tested end to end without Postmark. It checks the Server API token header, validates the fields the way a sender must
 * supply them, and records each accepted message so a test can read the link inside it. It can be told to fail the next
 * requests (a status and an ErrorCode), to be slow, or to treat an address as inactive.
 *
 * It is not Postmark and nothing presents it as Postmark: QED uses it only on an isolated test stack (QED_TEST_STACK=1,
 * no public origin, an http:// origin on this computer; postmark-config.ts postmarkBaseUrl). Used by tests only.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'

export interface StandInMail { messageId: string; at: number; from: string; to: string; subject: string; textBody: string; stream: string; tag: string; trackLinks: string; trackOpens: boolean }
export interface PostmarkStandIn {
  /** http://127.0.0.1:<port>: the value of QED_POSTMARK_URL. */
  url: string
  port: number
  /** Every accepted message, oldest first. */
  messages: StandInMail[]
  /** Every request, accepted or not: what was sent, for the test of what QED put on the wire. */
  requests: { ok: boolean; status: number; errorCode: number; headers: Record<string, string | undefined>; body: Record<string, unknown> | null }[]
  /** The next requests are answered with these, in order, instead of being accepted. */
  failNext: { status: number; errorCode?: number; text?: string }[]
  /** Addresses Postmark would refuse as inactive (error 406). */
  inactive: Set<string>
  /** Wait this long before answering. */
  delayMs: number
  /** Answer the next request with a redirect to this address instead. */
  redirectTo: string | null
  /** The newest message to an address (and with a subject, when given). */
  last(to: string, subject?: string | RegExp): StandInMail | undefined
  /** The first https?:// link in a message's text. */
  linkIn(m: StandInMail): string
  close(): Promise<void>
}

const body = (req: IncomingMessage): Promise<string> => new Promise((done) => { let b = ''; req.on('data', (c: Buffer) => { if (b.length < 1_000_000) b += c.toString('utf8') }); req.on('end', () => done(b)) })

export async function startPostmarkStandIn(o: { port?: number; token: string }): Promise<PostmarkStandIn> {
  const st: PostmarkStandIn = {
    url: '', port: 0, messages: [], requests: [], failNext: [], inactive: new Set(), delayMs: 0, redirectTo: null,
    last: (to, subject) => [...st.messages].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase() && (subject === undefined || (typeof subject === 'string' ? m.subject === subject : subject.test(m.subject)))),
    linkIn: (m) => /https?:\/\/[^\s]+/.exec(m.textBody)?.[0] ?? '',
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }),
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await body(req)
      const answer = (status: number, errorCode: number, extra: Record<string, unknown> = {}, record: Record<string, unknown> | null = null, ok = false): void => {
        st.requests.push({ ok, status, errorCode, headers: { token: req.headers['x-postmark-server-token'] as string | undefined, accept: req.headers.accept, contentType: req.headers['content-type'] }, body: record })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ErrorCode: errorCode, Message: errorCode === 0 ? 'OK' : 'stand-in refusal', ...extra }))
      }
      if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs))
      if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/email') return answer(404, 0)
      if (st.redirectTo) { const to = st.redirectTo; st.redirectTo = null; res.writeHead(302, { location: to }); return res.end() }
      const forced = st.failNext.shift()
      if (forced) {
        if (forced.text !== undefined) { st.requests.push({ ok: false, status: forced.status, errorCode: forced.errorCode ?? 0, headers: {}, body: null }); res.writeHead(forced.status, { 'content-type': 'text/html' }); return res.end(forced.text) }
        return answer(forced.status, forced.errorCode ?? 0)
      }
      if (req.headers['x-postmark-server-token'] !== o.token) return answer(401, 10)
      let j: Record<string, unknown>
      try { j = JSON.parse(raw) as Record<string, unknown> } catch { return answer(422, 402) }
      const s = (k: string): string => (typeof j[k] === 'string' ? (j[k] as string) : '')
      if (!s('From') || !/^[^@\s]+@[^@\s]+$/.test(s('To')) || !s('Subject') || !s('TextBody')) return answer(422, 300, {}, j)
      if (st.inactive.has(s('To').toLowerCase())) return answer(422, 406, {}, j)
      // a UUID-shaped id, numbered: unique within this stand-in, which is all a test needs (and no cryptography is used here)
      const messageId = `00000000-0000-4000-8000-${String(st.messages.length + 1).padStart(12, '0')}`
      st.messages.push({ messageId, at: Date.now(), from: s('From'), to: s('To'), subject: s('Subject'), textBody: s('TextBody'), stream: s('MessageStream'), tag: s('Tag'), trackLinks: s('TrackLinks'), trackOpens: j.TrackOpens === true })
      answer(200, 0, { To: s('To'), SubmittedAt: new Date().toISOString(), MessageID: messageId }, j, true)
    })()
  })
  await new Promise<void>((done) => server.listen(o.port ?? 0, '127.0.0.1', () => done()))
  st.port = (server.address() as { port: number }).port
  st.url = `http://127.0.0.1:${st.port}`
  return st
}
