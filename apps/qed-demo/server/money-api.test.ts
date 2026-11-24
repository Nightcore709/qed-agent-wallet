/**
 * Other currencies and payments abroad over HTTP against the real API server (R13): balances by currency with a priced
 * total that names its rates; an executable quote approved with the passkey and filled once; a payment abroad sent on its
 * paper route and reconciled; an unsupported route refused with its reason; a household elsewhere refused the desk.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { approve, authenticatorFor, signIn } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)
const PW = 'a long enough pass phrase for this test'

describe('money in other currencies, over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-money-api-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }
  async function household(handle: string, profile: J = {}) {
    const first = client(), key = authenticatorFor(PORT)
    await first.ok('POST', '/api/auth/signup', { handle, password: PW, displayName: handle })
    const b = await first.ok('POST', '/api/security/passkeys/begin')
    await first.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const pk = client(); await signIn(pk.ok, key)
    await pk.ok('POST', '/api/household', { profile })
    return { key, pk }
  }

  it('converts and pays abroad at three precisions; refuses an unsupported route with its reason', async () => {
    const { key, pk } = await household('globe-owner')
    const m0 = await pk.ok('GET', '/api/money')
    expect(m0.balances.map((b: J) => b.currency)).toEqual(['INR'])
    expect(m0.zone).toBe('Asia/Kolkata')
    expect(m0.references.find((r: J) => r.currency === 'USD')).toMatchObject({ kind: 'reference' })
    for (const [buy, amount] of [['JPY', '50000'], ['BHD', '10.500']]) {
      const q = await pk.ok('POST', '/api/fx/quote', { sell: 'INR', buy, amount, fixed: 'buy' })
      await approve(pk.ok, key, q.approvalId, q.docHash)
      const f = await pk.ok('POST', '/api/fx/convert', { approvalId: q.approvalId })
      expect(f).toMatchObject({ duplicate: false, spreadBps: expect.any(Number), feeText: '₹50.00' })
    }
    const m1 = await pk.ok('GET', '/api/money')
    expect(m1.balances.map((b: J) => [b.currency, b.text])).toEqual([['INR', expect.stringMatching(/^₹/)], ['JPY', 'JPY 50,000'], ['BHD', 'BHD 10.500']])
    expect(m1.total.text).toMatch(/^₹/)
    expect(m1.total.lines.filter((l: J) => l.currency !== 'INR').every((l: J) => l.rate && l.source && l.observedText)).toBe(true)

    const payee = await pk.ok('POST', '/api/abroad/payees', { name: 'Anita Rao', country: 'US', currency: 'USD', routing: '021000021', account: '123456789' })
    const pv = await pk.ok('POST', '/api/abroad/prepare', { payeeId: payee.id, amount: '250.00', purpose: 'family', from: 'INR' })
    await approve(pk.ok, key, pv.approvalId, pv.docHash)
    const paid = await pk.ok('POST', '/api/abroad/pay', { approvalId: pv.approvalId })
    expect(paid).toMatchObject({ state: 'in_transit', amountText: 'USD 250.00', reconciliation: { state: 'reconciled' } })
    expect((await pk.ok('GET', `/api/abroad/payments/${paid.id}`)).route.name).toMatch(/Paper wire/)

    const de = await pk.ok('POST', '/api/abroad/payees', { name: 'Jonas Weber', country: 'DE', currency: 'USD', account: 'DE89370400440532013000' })
    const refused = await pk.call('POST', '/api/abroad/prepare', { payeeId: de.id, amount: '10.00', purpose: 'family', from: 'INR' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ error: expect.objectContaining({ code: 'route_not_offered' }) })
    expect(JSON.stringify(refused.json)).toMatch(/No paper route sends USD to Germany/)
  })

  it('a household that lives elsewhere is refused the paper desk, with the reason', async () => {
    const { pk } = await household('globe-elsewhere', { jurisdiction: 'SG', timeZone: 'Asia/Singapore' })
    expect((await pk.ok('GET', '/api/money')).zone).toBe('Asia/Singapore')
    const r = await pk.call('POST', '/api/fx/quote', { sell: 'INR', buy: 'USD', amount: '10.00', fixed: 'buy' })
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.json)).toMatch(/only to households in India.*Singapore/)
  })
})
