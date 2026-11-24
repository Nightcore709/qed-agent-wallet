/**
 * The Portfolio lab's routes over HTTP (server/api.ts, R12) against the real API server: a session is needed; a new
 * household sees its books, the research run with its file hashes and its own certificates; the checker answers a
 * request in the wire format exactly as the Python checker answered it; a mix cannot be proposed with nothing to mix.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import fixtures from '../shared/kernel/coverage.fixtures.json'
import { authenticatorFor, signUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)

describe('the Portfolio lab routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-lab-api-'))
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

  it('needs a session', async () => {
    const anon = client()
    for (const [m, p] of [['GET', '/api/lab'], ['GET', '/api/lab/research'], ['GET', '/api/lab/certificates'], ['POST', '/api/lab/certificates/check'], ['POST', '/api/lab/hedge'], ['POST', '/api/lab/proposals/rebalance']] as const) {
      expect((await anon.call(m, p, {})).status, `${m} ${p}`).toBe(401)
    }
  })

  it('a new household: its books, the research with hashes, its certificates, the checker, and no mix to propose', async () => {
    const a = client()
    await signUp(a.ok, authenticatorFor(PORT), 'lab-owner', 'Lab Owner')
    expect((await a.call('GET', '/api/lab')).status).toBe(409) // not set up yet
    await a.ok('POST', '/api/household', { opening: { bank: 90_000_000 }, profile: { income: 18_000_000 } })
    const v = await a.ok('GET', '/api/lab')
    expect(v.books.bank).toBe(90_000_000)
    expect(v.allocation.proposable).toBe(false)
    expect(v.terms.some((t: J) => t.id === 'lab.tax.model' && t.status === 'modelled')).toBe(true)
    const r = await a.ok('GET', '/api/lab/research')
    expect(r.label).toBe('Research: historical simulation on public data')
    expect(r.source.files.every((f: J) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    const c = await a.ok('GET', '/api/lab/certificates?declared=1')
    expect(c.cases.map((x: J) => x.id)).toEqual(['save-guarantee', 'save-bank'])
    // the default household's loan instalments are due within 30 days: no sovereign bills, so no guarantee by
    // construction; the bank balance covers them, a contractual promise
    expect(c.cases[0].outcome.status).toBe('ABSTAIN')
    expect(c.cases[1].outcome.status).toBe('CERTIFIED_CONTRACTUAL')
    const rec = (fixtures.recorded as J[]).find((x) => x.name === 'cvar_10pct_usd6040_fhs_ewma')!
    const o = (await a.ok('POST', '/api/lab/certificates/check', rec.request)).outcome
    expect([o.status, o.request_hash, o.evidence.model.cvar_ucb95]).toEqual([rec.expect.status, rec.expect.request_hash, rec.expect.evidence.model.cvar_ucb95])
    expect(o.property).toMatch(/MODEL BOUND, NOT A GUARANTEE/)
    const bad = await a.call('POST', '/api/lab/hedge', { usd: 25_000, due: 'soon' })
    expect([bad.status, bad.json.error?.fields]).toEqual([400, { due: 'A date, YYYY-MM-DD.' }])
    const none = await a.call('POST', '/api/lab/proposals/rebalance', {})
    expect([none.status, none.json.error?.code]).toEqual([409, 'not_proposable'])
  })

  it('R13 (review M3): the open checker answers the worst covering-calendar request at once, and stays responsive', async () => {
    const a = client()
    await signUp(a.ok, authenticatorFor(PORT), 'lab-dos', 'Lab Visitor')
    const calendar = { name: 'weekends', holidays: [], covers_from: '2026-01-01', covers_to: '2027-12-31' }
    const reserve = { type: 'reserve', as_of: '2026-11-24', currency: 'INR', horizon_days: 90, obligations: [{ id: 'x', due: '2026-12-20', currency: 'INR', amount_minor: 1 }], positions: [], instruments: [], calendar }
    const t = Date.now()
    for (const lead of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const o = (await a.ok('POST', '/api/lab/certificates/check', { ...reserve, payment_lead_business_days: lead })).outcome
      expect(o.reasons.map((r: J) => r.code)).toEqual(['BAD_INPUT'])
    }
    const lag = (await a.ok('POST', '/api/lab/certificates/check', { ...reserve, instruments: [{ id: 'b', kind: 'sovereign_zero', currency: 'INR', issuer: 'Government of India', issuer_is_currency_sovereign: true, maturity: '2026-12-04', face_per_lot_minor: 100, payment_lag_business_days: 2 ** 40 }], positions: [{ instrument_id: 'b', lots: 1, custody: 'RBI Retail Direct', custody_kind: 'sovereign_registry' }] })).outcome
    expect(lag.reasons.map((r: J) => r.code)).toEqual(['BAD_INPUT'])
    expect(Date.now() - t).toBeLessThan(5_000)
    expect((await a.call('GET', '/api/lab/research')).status).toBe(200) // the server is still answering
  })
})
