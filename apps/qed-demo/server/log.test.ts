/**
 * Operational log lines carry no secret and no personal data (server/log.ts; docs/DEPLOY.md, "Logs"): each kind the code
 * must never log is written into a line here and must not come out, and what an operator needs (service, event, pids,
 * paths, routes, status codes, git revisions) must.
 */
import { describe, expect, it } from 'vitest'
import { formatLine, redact } from './log.ts'

describe('redact', () => {
  const cases: [string, string, string][] = [
    ['a key-encryption key record', 'loaded qedkek1:kek_be39852ab0d42141:AAAAbbbbCCCCddddEEEEffffGGGGhhhh0123456789:0011aabb', 'AAAAbbbbCCCC'],
    ['a cookie header', 'Cookie: __Host-qed_session=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg', 'Zm9vYmFy'],
    ['a session cookie in text', 'sent qed_session=abc123def456; Path=/', 'abc123def456'],
    ['a bearer token', 'authorization header Bearer s3cr3t-T0ken.value', 's3cr3t-T0ken'],
    ['a CSRF header', 'x-qed-csrf: 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['a password in JSON', '{"handle":"asha","password":"correct horse battery"}', 'correct horse'],
    ['recovery codes in JSON', '{"recoveryCodes":["AAAA-BBBB-CCCC-DDDD","EEEE-FFFF-GGGG-HHHH"]}', 'AAAA-BBBB'],
    ['a query string', 'POST /api/ledger?limit=200&q=rent+to+asha failed', 'asha'],
    ['a URL query string', 'fetch https://qed.example.in/reset?token=abc&user=asha', 'user=asha'],
    ['a 32-byte hex secret', 'master 4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a99887766554433221100ffeeddccbbaa99 loaded', '4f3c2b1a0e9d8c7b'],
    ['a private key', 'key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '59c6995e998f97'],
    ['a long base64url token', 'token value dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZSBvayB5ZXM was sent', 'dGhpcyBpcyBh'],
    ['an e-mail address', 'sent the reset link to asha.rao@example.com', 'asha.rao'],
    ['a Postmark server token header', 'sent X-Postmark-Server-Token: 7c1f0e52-aaaa-bbbb-cccc-0123456789ab to postmark', '7c1f0e52'],
    ['a payment handle', 'payment to landlord@upi refused', 'landlord@upi'],
  ]
  for (const [name, line, secret] of cases) {
    it(`removes ${name}`, () => {
      const out = redact(line)
      expect(out).not.toContain(secret)
      expect(redact(out)).toBe(out) // idempotent
    })
  }

  it('keeps what an operator needs: service, event, pid, data paths, routes, status codes and a git revision', () => {
    const line = '[engine] running (pid 4242); database /data/app/qed.db; GET /api/ready 503; revision 0497611c3f0a9b8e7d6c5b4a39281706f5e4d3c2'
    expect(redact(line)).toBe(line)
  })
})

describe('formatLine', () => {
  const at = new Date('2026-11-24T12:00:00.000Z')
  it('writes one JSON object per line in the container, with the time, level, service and event', () => {
    const line = formatLine('api', 'error', 'request failed', { method: 'POST', route: '/api/payees?name=asha', status: 500 }, { QED_LOG_FORMAT: 'json' }, at)
    expect(JSON.parse(line)).toEqual({ ts: '2026-11-24T12:00:00.000Z', level: 'error', svc: 'api', event: 'request failed', method: 'POST', route: '/api/payees?[redacted]', status: 500 })
    expect(line).not.toContain('\n')
  })
  it('never writes a field whose name says secret, whatever its value', () => {
    const line = formatLine('api', 'info', 'x', { password: 'p', csrfToken: 't', cookie: 'c', recoveryCodes: ['a'], body: { handle: 'h' }, kek: 'k', pid: 7 }, { QED_LOG_FORMAT: 'json' }, at)
    const o = JSON.parse(line) as Record<string, unknown>
    for (const k of ['password', 'csrfToken', 'cookie', 'recoveryCodes', 'body', 'kek']) expect(o[k]).toBe('[redacted]')
    expect(o.pid).toBe(7)
  })
  it('is readable text in the local build', () => {
    expect(formatLine('engine', 'info', 'running', { pid: 12, database: '/tmp/q/qed.db' }, {}, at)).toBe('[engine] running pid=12 database=/tmp/q/qed.db')
  })
  it('writes an error as its class and message, redacted', () => {
    const o = JSON.parse(formatLine('api', 'error', 'request failed', { error: new Error('no payee landlord@upi') }, { QED_LOG_FORMAT: 'json' }, at)) as Record<string, unknown>
    expect(o.error).toBe('Error: no payee [redacted-handle]')
  })
})
