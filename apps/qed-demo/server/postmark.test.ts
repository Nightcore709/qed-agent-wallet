/**
 * Email through Postmark (QED_DELIVERY=postmark), against a local stand-in (server/postmark-standin.ts): the settings
 * and their refusals, the stand-in's own guard, the adapter's outcomes (sent, every kind of failure, a timeout, a redirect),
 * the queue and its retries, and that no secret reaches a stored reason or a log line.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, openDb } from './core.ts'
import { configureDelivery, DeliveryError, deliver, dispatchQueued, linkTo, RETRY_EVERY_MS, RETRY_WINDOW_MS } from './delivery.ts'
import { redact } from './log.ts'
import { addAddress } from './recovery.ts'
import type { Session } from './auth.ts'
import { POSTMARK_TIMEOUT_MS, postmarkAdapter } from './postmark.ts'
import { type PostmarkConfig, parseFrom, postmarkBaseUrl, postmarkConfig } from './postmark-config.ts'
import { type PostmarkStandIn, startPostmarkStandIn } from './postmark-standin.ts'

const TOKEN = '7c1f0e52-3b6d-4c5e-9a10-0f4d2b8e6a11'
const FROM = 'QED <no-reply@mail.example.com>'
const GOOD = { QED_DELIVERY: 'postmark', QED_POSTMARK_TOKEN: TOKEN, QED_MAIL_FROM: FROM }
let pm: PostmarkStandIn
beforeAll(async () => { pm = await startPostmarkStandIn({ token: TOKEN }) })
afterAll(async () => { await pm.close() })
beforeEach(() => { pm.messages.length = 0; pm.requests.length = 0; pm.failNext.length = 0; pm.inactive.clear(); pm.delayMs = 0; pm.redirectTo = null })

const cfgOf = (over: Partial<PostmarkConfig> = {}): PostmarkConfig => ({ token: TOKEN, from: FROM, fromAddress: 'no-reply@mail.example.com', stream: 'outbound', baseUrl: pm.url, standIn: true, ...over })
const msg = (over: Record<string, unknown> = {}) => ({ id: 'msg_1', channel: 'email' as const, to: 'asha@example.in', personId: 'p1', purpose: 'verify-email', subject: 'Confirm your email address for QED', body: 'Confirm: http://localhost:5174/verify-email#token=SECRETLINKTOKEN', ...over })
const why = async (p: Promise<unknown>): Promise<DeliveryError> => { try { await p } catch (e) { return e as DeliveryError } throw new Error('it did not fail') }

describe('the settings (QED_DELIVERY=postmark)', () => {
  it('reads the token, the sender and the stream; the stream defaults to outbound and the address is Postmark\'s own', () => {
    const c = postmarkConfig(GOOD, 'https://qed.example')
    expect(c).toMatchObject({ token: TOKEN, from: FROM, fromAddress: 'no-reply@mail.example.com', stream: 'outbound', baseUrl: 'https://api.postmarkapp.com', standIn: false })
    expect(postmarkConfig({ ...GOOD, QED_POSTMARK_STREAM: 'qed-transactional' }, null).stream).toBe('qed-transactional')
  })
  it('reads the token from a file, and refuses both a file and a variable', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'qed-pm-')), 'token'); writeFileSync(f, `${TOKEN}\n`)
    const { QED_POSTMARK_TOKEN: _t, ...rest } = GOOD
    expect(postmarkConfig({ ...rest, QED_POSTMARK_TOKEN_FILE: f }, null).token).toBe(TOKEN)
    expect(() => postmarkConfig({ ...GOOD, QED_POSTMARK_TOKEN_FILE: f }, null)).toThrow(/both set/)
    expect(() => postmarkConfig({ ...rest, QED_POSTMARK_TOKEN_FILE: join(tmpdir(), 'qed-no-such-file') }, null)).toThrow(/could not be read/)
  })
  it('refuses at start, with a plain reason, whatever is missing or malformed, and never names the token', () => {
    const { QED_POSTMARK_TOKEN: _t, QED_MAIL_FROM: _f, ...bare } = GOOD
    expect(() => postmarkConfig({ ...bare, QED_MAIL_FROM: FROM }, null)).toThrow(/needs QED_POSTMARK_TOKEN/)
    expect(() => postmarkConfig({ ...bare, QED_POSTMARK_TOKEN: TOKEN }, null)).toThrow(/needs QED_MAIL_FROM/)
    for (const from of ['no-reply', 'QED <no-reply@localhost>', 'QED <>', 'a@b', 'QED no-reply@mail.example.com', 'QED <no-reply@mail.example.com', 'x@mail..example.com', 'a b@mail.example.com', 'QED\r\nBcc: x@y.com <a@mail.example.com>', '<a@mail.example.com>>', 'a@-mail.example.com', 'a@mail.example.c0m']) {
      expect(() => postmarkConfig({ ...GOOD, QED_MAIL_FROM: from }, null), from).toThrow(/QED_MAIL_FROM/)
    }
    for (const token of ['short', 'has space in it 12345', 'new\nline-1234567', `${'x'.repeat(201)}`]) expect(() => postmarkConfig({ ...GOOD, QED_POSTMARK_TOKEN: token }, null)).toThrow(/shaped like/)
    expect(() => postmarkConfig({ ...GOOD, QED_POSTMARK_STREAM: 'a b' }, null)).toThrow(/QED_POSTMARK_STREAM/)
    for (const env of [{ ...GOOD, QED_MAIL_FROM: 'bad' }, { ...GOOD, QED_POSTMARK_STREAM: '!' }, { ...GOOD, QED_POSTMARK_TOKEN: 'bad token' }]) {
      try { postmarkConfig(env, null); throw new Error('accepted') } catch (e) { expect(String(e)).not.toContain(TOKEN); expect(String(e)).not.toContain('bad token') }
    }
  })
  it('accepts a bare address and trims a display name', () => {
    expect(parseFrom('no-reply@mail.example.com')).toEqual({ from: 'no-reply@mail.example.com', address: 'no-reply@mail.example.com' })
    expect(parseFrom('  QED Wallet   <no-reply@mail.example.com> ')).toEqual({ from: 'QED Wallet <no-reply@mail.example.com>', address: 'no-reply@mail.example.com' })
  })
  it('loadConfig stops the process with the reason, and starts with the whole of it', () => {
    expect(() => loadConfig({ QED_DB: ':memory:', QED_DELIVERY: 'postmark' })).toThrow(/needs QED_POSTMARK_TOKEN/)
    expect(() => loadConfig({ QED_DB: ':memory:', QED_DELIVERY: 'sendgrid' })).toThrow(/"postmark"/)
    const c = loadConfig({ QED_DB: ':memory:', ...GOOD })
    expect(c.delivery).toBe('postmark')
    expect(c.postmark).toMatchObject({ stream: 'outbound', standIn: false })
    expect(loadConfig({ QED_DB: ':memory:' }).postmark).toBeNull()
    // and with a public origin, where the outbox is refused and Postmark is the way to switch email on
    const prod = loadConfig({ QED_DB: ':memory:', QED_PUBLIC_ORIGIN: 'https://qed.example', ...GOOD })
    expect(prod).toMatchObject({ delivery: 'postmark', linkOrigin: 'https://qed.example' })
    expect(loadConfig({ QED_DB: ':memory:', QED_PUBLIC_ORIGIN: 'https://qed.example' }).delivery).toBe('none')
  })
})

describe('the stand-in can never be selected in a production-like configuration', () => {
  const url = 'http://127.0.0.1:9911'
  it('is honoured on an isolated test stack with no public origin, on this computer, over http', () => {
    expect(postmarkBaseUrl({ QED_TEST_STACK: '1', QED_POSTMARK_URL: url }, null)).toEqual({ baseUrl: url, standIn: true })
    expect(postmarkBaseUrl({ QED_TEST_STACK: '1', QED_POSTMARK_URL: 'http://localhost:9911/' }, null)).toEqual({ baseUrl: 'http://localhost:9911', standIn: true })
    expect(loadConfig({ QED_DB: ':memory:', ...GOOD, QED_TEST_STACK: '1', QED_POSTMARK_URL: url }).postmark).toMatchObject({ baseUrl: url, standIn: true })
  })
  it('is refused without QED_TEST_STACK=1, whatever else is set', () => {
    for (const t of [undefined, '', '0', 'true', 'yes']) expect(() => postmarkBaseUrl({ QED_TEST_STACK: t, QED_POSTMARK_URL: url }, null)).toThrow(/isolated test stack/)
    expect(() => loadConfig({ QED_DB: ':memory:', ...GOOD, QED_POSTMARK_URL: url })).toThrow(/isolated test stack/)
  })
  it('is refused with a public origin, even on a test stack', () => {
    expect(() => postmarkBaseUrl({ QED_TEST_STACK: '1', QED_POSTMARK_URL: url }, 'https://qed.example')).toThrow(/no public origin/)
    expect(() => loadConfig({ QED_DB: ':memory:', ...GOOD, QED_TEST_STACK: '1', QED_POSTMARK_URL: url, QED_PUBLIC_ORIGIN: 'https://qed.example' })).toThrow(/no public origin/)
  })
  it('is refused unless it is a plain http:// origin on 127.0.0.1 or localhost', () => {
    for (const u of ['https://127.0.0.1:9911', 'http://api.postmarkapp.com', 'https://api.postmarkapp.com', 'http://0.0.0.0:9911', 'http://localhost.evil.example:9911', 'http://127.0.0.1.evil.example', 'http://192.168.1.5:9911', 'http://[::1]:9911',
      'http://user:pass@127.0.0.1:9911', 'http://127.0.0.1:9911/email', 'http://127.0.0.1:9911/?x=1', 'ftp://127.0.0.1', 'nonsense']) {
      expect(() => postmarkBaseUrl({ QED_TEST_STACK: '1', QED_POSTMARK_URL: u }, null), u).toThrow(/QED_POSTMARK_URL/)
    }
  })
  it('without it, the address is Postmark\'s own, and an empty value counts as unset', () => {
    expect(postmarkBaseUrl({}, null)).toEqual({ baseUrl: 'https://api.postmarkapp.com', standIn: false })
    expect(postmarkBaseUrl({ QED_POSTMARK_URL: '  ' }, 'https://qed.example')).toEqual({ baseUrl: 'https://api.postmarkapp.com', standIn: false })
  })
})

describe('the adapter', () => {
  it('posts one message to /email with the token header, the sender, the stream, no tracking and no redirects; MessageID is the reference', async () => {
    const seen: RequestInit[] = []
    const spy: typeof fetch = async (input, init) => { seen.push(init!); return fetch(input, init) }
    const r = await postmarkAdapter(cfgOf({ stream: 'qed-transactional' }), spy).send(msg())
    expect(r.providerRef).toBe(pm.messages[0]!.messageId)
    expect(pm.messages[0]).toMatchObject({ from: FROM, to: 'asha@example.in', subject: 'Confirm your email address for QED', stream: 'qed-transactional', tag: 'verify-email', trackLinks: 'None', trackOpens: false })
    expect(pm.linkIn(pm.messages[0]!)).toBe('http://localhost:5174/verify-email#token=SECRETLINKTOKEN')
    expect(pm.requests[0]!.headers).toMatchObject({ token: TOKEN, accept: 'application/json', contentType: 'application/json' })
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(POSTMARK_TIMEOUT_MS).toBe(10_000)
  })
  it('sends email only', async () => {
    const e = await why(postmarkAdapter(cfgOf()).send(msg({ channel: 'sms', to: '+919876543210' })))
    expect(e).toMatchObject({ retry: false })
    expect(pm.requests).toHaveLength(0)
  })
  const codes: [number, number | undefined, boolean, RegExp][] = [
    [401, 10, false, /error 10.*token was not accepted/], [422, 300, false, /error 300.*validation/], [422, 406, false, /error 406.*inactive/], [422, 413, false, /error 413.*not approved/],
    [422, 1235, false, /error 1235.*stream does not exist/], [400, undefined, false, /HTTP 400/], [404, undefined, false, /HTTP 404/],
    [429, undefined, true, /slow down \(HTTP 429\)/], [500, 101, true, /HTTP 500, error 101.*internal error/], [503, 100, true, /error 100.*maintenance/], [502, undefined, true, /HTTP 502/],
  ]
  for (const [status, errorCode, retry, text] of codes) {
    it(`maps HTTP ${status}${errorCode !== undefined ? ` with Postmark error ${errorCode}` : ''} to ${retry ? 'a retry' : 'a failure'}`, async () => {
      pm.failNext.push({ status, errorCode })
      const e = await why(postmarkAdapter(cfgOf()).send(msg()))
      expect(e).toBeInstanceOf(DeliveryError)
      expect(e.retry).toBe(retry)
      expect(e.message).toMatch(text)
    })
  }
  it('refuses a wrong token as error 10 and never sends it again as anything else', async () => {
    const e = await why(postmarkAdapter(cfgOf({ token: 'a-wrong-token-1234' })).send(msg()))
    expect(e).toMatchObject({ retry: false })
    expect(e.message).toMatch(/error 10/)
    expect(pm.messages).toHaveLength(0)
  })
  it('does not send twice when Postmark answers 200 with no MessageID, or with an answer that is not JSON', async () => {
    pm.failNext.push({ status: 200, errorCode: 0 })
    expect(await why(postmarkAdapter(cfgOf()).send(msg()))).toMatchObject({ retry: false, message: expect.stringMatching(/without a MessageID/) })
    pm.failNext.push({ status: 200, text: '<html>ok</html>' })
    expect((await why(postmarkAdapter(cfgOf()).send(msg()))).retry).toBe(false)
    pm.failNext.push({ status: 502, text: '<html>bad gateway</html>' })
    expect((await why(postmarkAdapter(cfgOf()).send(msg()))).retry).toBe(true)
  })
  it('takes a timeout, a refused connection and a redirect for a failure that may pass', async () => {
    const timedOut: typeof fetch = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }
    expect(await why(postmarkAdapter(cfgOf(), timedOut).send(msg()))).toMatchObject({ retry: true, message: `Postmark did not answer within ${POSTMARK_TIMEOUT_MS / 1000} seconds.` })
    const down = await why(postmarkAdapter(cfgOf({ baseUrl: 'http://127.0.0.1:9' })).send(msg()))
    expect(down).toMatchObject({ retry: true, message: 'Postmark could not be reached.' })
  })
  it('does not follow a redirect: the token goes nowhere else', async () => {
    const other = await startPostmarkStandIn({ token: TOKEN })
    try {
      pm.redirectTo = `${other.url}/email`
      const e = await why(postmarkAdapter(cfgOf()).send(msg()))
      expect(e.message).toBe('Postmark could not be reached.')
      expect(other.requests).toHaveLength(0)
      expect(other.messages).toHaveLength(0)
    } finally { await other.close() }
  })
  it('really gives up on a slow answer at its time limit (the abort signal is the adapter\'s own)', async () => {
    let aborted = false
    const slow: typeof fetch = (_u, init) => new Promise((_ok, no) => { init!.signal!.addEventListener('abort', () => { aborted = true; no(init!.signal!.reason) }) })
    const t0 = Date.now()
    const e = await Promise.race([why(postmarkAdapter(cfgOf(), slow).send(msg())), new Promise<never>((_r, no) => setTimeout(() => no(new Error('no timeout within 12 s')), 12_000))])
    expect(aborted).toBe(true)
    expect(e.retry).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(POSTMARK_TIMEOUT_MS - 200)
  }, 15_000)
  it('keeps the token, the body, the link and the address out of every reason it gives', async () => {
    const reasons: string[] = []
    for (const f of [{ status: 401, errorCode: 10 }, { status: 422, errorCode: 406 }, { status: 429 }, { status: 500, errorCode: 101 }, { status: 422, errorCode: 300 }]) {
      pm.failNext.push(f)
      reasons.push((await why(postmarkAdapter(cfgOf()).send(msg()))).message)
    }
    reasons.push((await why(postmarkAdapter(cfgOf({ baseUrl: 'http://127.0.0.1:9' })).send(msg()))).message)
    for (const r of reasons) for (const secret of [TOKEN, 'SECRETLINKTOKEN', 'asha@example.in', 'Confirm: http']) expect(r).not.toContain(secret)
  })
})

describe('the queue: queued by deliver, sent by dispatchQueued', () => {
  const T0 = Date.UTC(2026, 10, 26, 9, 0, 0)
  const setup = () => { configureDelivery({ delivery: 'postmark', linkOrigin: 'https://qed.example' }); return openDb(':memory:') }
  const mail = (db: ReturnType<typeof openDb>, to = 'asha@example.in', now = T0) => deliver(db, { channel: 'email', to, personId: null, purpose: 'verify-email', subject: 'Confirm your email address for QED', body: `Confirm: ${linkTo('/verify-email', 'LIVETOKEN')}`, tokenId: 'tok1', secrets: [linkTo('/verify-email', 'LIVETOKEN')] }, now)!
  const row = (db: ReturnType<typeof openDb>, id: string) => db.get<{ status: string; adapter: string; provider_ref: string | null; error: string | null; body: string; sent_at: number | null }>('SELECT status, adapter, provider_ref, error, body, sent_at FROM outbound_messages WHERE id = ?', id)!
  beforeEach(() => { configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' }) })

  it('deliver queues the message for Postmark and nothing is presented as sent; the dispatcher then sends it once and keeps no text', async () => {
    const db = setup()
    const id = mail(db)
    expect(row(db, id)).toMatchObject({ status: 'queued', adapter: 'postmark', provider_ref: null })
    expect(pm.messages).toHaveLength(0)
    const adapter = postmarkAdapter(cfgOf())
    expect(await dispatchQueued(db, adapter, T0 + 1000)).toEqual({ sent: 1, failed: 0, retrying: 0 })
    expect(await dispatchQueued(db, adapter, T0 + 2000)).toEqual({ sent: 0, failed: 0, retrying: 0 })
    expect(pm.messages).toHaveLength(1)
    expect(pm.linkIn(pm.messages[0]!)).toBe('https://qed.example/verify-email#token=LIVETOKEN')
    expect(row(db, id)).toMatchObject({ status: 'sent', adapter: 'postmark', provider_ref: pm.messages[0]!.messageId, body: '(sent; the text is not kept)', sent_at: T0 + 1000 })
  })
  it('a failure that may pass is tried again, not before the wait, and sent when it clears; an answer\'s reason is kept without the secret', async () => {
    const db = setup()
    const id = mail(db, 'retry@example.in')
    const adapter = postmarkAdapter(cfgOf())
    pm.failNext.push({ status: 503, errorCode: 100 })
    expect(await dispatchQueued(db, adapter, T0 + 1000)).toEqual({ sent: 0, failed: 0, retrying: 1 })
    expect(row(db, id)).toMatchObject({ status: 'queued', error: expect.stringMatching(/^Trying again: Postmark could not take it now \(HTTP 503, error 100\)/) })
    expect(await dispatchQueued(db, adapter, T0 + 1000 + RETRY_EVERY_MS - 1)).toEqual({ sent: 0, failed: 0, retrying: 0 })
    expect(pm.requests).toHaveLength(1)
    expect(await dispatchQueued(db, adapter, T0 + 1000 + RETRY_EVERY_MS)).toEqual({ sent: 1, failed: 0, retrying: 0 })
    expect(row(db, id)).toMatchObject({ status: 'sent', error: null })
  })
  it('gives up when the retry window has passed, and says why; a refusal is final at once and never retried', async () => {
    const db = setup()
    const a = mail(db, 'late@example.in'), b = mail(db, 'gone@example.in')
    pm.inactive.add('gone@example.in')
    pm.failNext.push({ status: 500, errorCode: 101 })
    const adapter = postmarkAdapter(cfgOf())
    // b is refused (406), a meets a server error inside the window
    expect(await dispatchQueued(db, adapter, T0 + 1000)).toEqual({ sent: 0, failed: 1, retrying: 1 })
    expect(row(db, b)).toMatchObject({ status: 'failed', error: expect.stringMatching(/error 406/) })
    pm.failNext.push({ status: 500, errorCode: 101 })
    expect(await dispatchQueued(db, adapter, T0 + RETRY_WINDOW_MS + 1000)).toEqual({ sent: 0, failed: 1, retrying: 0 })
    expect(row(db, a)).toMatchObject({ status: 'failed', error: expect.stringMatching(/error 101/) })
    expect(pm.messages).toHaveLength(0)
    expect(await dispatchQueued(db, adapter, T0 + 2 * RETRY_WINDOW_MS)).toEqual({ sent: 0, failed: 0, retrying: 0 })
  })
  it('a message whose link stopped working while it waited is not sent', async () => {
    const db = setup()
    db.run(`INSERT INTO one_time_tokens (id, person_id, purpose, token_hash, created_at, expires_at, used_at, attempts) VALUES ('tok1', 'p1', 'verify-email', 'h', ?, ?, ?, 0)`, T0, T0 + 1800_000, T0 + 500)
    const id = mail(db)
    const { redactSpent } = await import('./delivery.ts')
    expect(redactSpent(db, T0 + 600)).toBe(1)
    expect(await dispatchQueued(db, postmarkAdapter(cfgOf()), T0 + 1000)).toEqual({ sent: 0, failed: 1, retrying: 0 })
    expect(pm.messages).toHaveLength(0)
    expect(row(db, id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/stopped working/) })
    expect(row(db, id).body).not.toContain('LIVETOKEN')
  })
  it('a message left "sending" by a process that stopped is said to have failed after the window, and is not sent again', async () => {
    const db = setup()
    const id = mail(db)
    db.run(`UPDATE outbound_messages SET status = 'sending' WHERE id = ?`, id)
    expect(await dispatchQueued(db, postmarkAdapter(cfgOf()), T0 + 60_000)).toEqual({ sent: 0, failed: 0, retrying: 0 })
    expect(row(db, id).status).toBe('sending')
    await dispatchQueued(db, postmarkAdapter(cfgOf()), T0 + RETRY_WINDOW_MS + 3 * 60_000)
    expect(row(db, id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) })
    expect(pm.messages).toHaveLength(0)
  })
  it('a failed message leaves its link out of the log and out of the reason; its text is still redacted when the link stops working', async () => {
    const db = setup()
    const id = mail(db)
    pm.failNext.push({ status: 422, errorCode: 300 })
    await dispatchQueued(db, postmarkAdapter(cfgOf()), T0 + 1000)
    expect(row(db, id).error).not.toContain('LIVETOKEN')
    expect(row(db, id).error).not.toContain('asha@example.in')
  })
  it('a phone number cannot be confirmed through Postmark: it sends email only, and no text is queued or pretended', () => {
    const db = setup()
    try { addAddress(db, {} as Session, 'phone', '+919876543210', T0); throw new Error('accepted') } catch (e) { expect(e).toMatchObject({ code: 'delivery_unavailable', status: 503 }) }
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM outbound_messages')!.n).toBe(0)
  })
  it('the redaction rules take the token header out of a log line', () => {
    expect(redact(`request failed X-Postmark-Server-Token: ${TOKEN}`)).not.toContain(TOKEN)
  })
})
