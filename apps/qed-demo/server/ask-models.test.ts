/**
 * Ask on the Anthropic API (server/ask-models.ts, model-prices.ts) against a stand-in API: nothing leaves this machine.
 * The stand-in answers GET /v1/models and POST /v1/messages in the shapes the SDK returns (a message with model,
 * stop_reason, content and usage, usage.iterations included), and fails with the SDK's own error classes, made by
 * Anthropic.APIError.generate from a status, as the SDK makes them from a response. Covered: which model a question goes
 * to, fallback on each kind of failure with the same messages, the bound on retries, refusal and step-down under each
 * spending limit, the record of the model that answered (from the response), the cost arithmetic, and the limits
 * surviving a restart. How the real API answers is NOT VERIFIED here: that is scripts/ask-model-check.ts, run once in
 * production by the operator.
 */
import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { API_SCHEMA, ask, ProposalSchema } from './ai.ts'
import { anthropicApi, answerViaApi, type ApiRequest, type ApiResponse, AskModelError, askModelsView, buildRequest, classifyTurn, ModelCatalog, type ModelApi, type Route, sessionKeyOf, settleInterrupted, spendOf, useModelApiForTests, type Who } from './ask-models.ts'
import { type AskModelsConfig, type Db, FakeClock, loadConfig, openDb } from './core.ts'
import { costMicros, costOfUsage, estimateInputTokens, PRICES, usdText, worstCaseMicros } from './model-prices.ts'
import { makeKit } from './testkit.ts'

const FABLE = 'claude-fable-5-2', OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5'
const ALL = [FABLE, OPUS, SONNET]
const T0 = Date.parse('2026-11-25T10:00:00+05:30')
const WHO: Who = { userId: 'usr_test', personId: 'usr_test', sessionKey: 'session-a' }
const DEMANDING: Route = { tier: 'demanding', why: 'it asks about investing, a plan, a strategy or advice' }
const ROUTINE: Route = { tier: 'routine', why: 'it is a short question or a look-up' }
const REPLY = { answer: 'Keep ₹50,000 in the bank for what is due; the rest can wait in a liquid fund.', proposals: [], questions: [], withdraw: [], cites: [], links: [] }

/** A message as the API returns it: the model that answered, why it stopped, a thinking block, the JSON text and the usage. */
const answer = (model: string, o: { input?: number; output?: number; text?: string; stop?: string; category?: string; iterations?: unknown[] } = {}): ApiResponse => ({
  id: `msg_${model}`, model, stop_reason: o.stop ?? 'end_turn', stop_details: o.stop === 'refusal' ? { category: o.category ?? 'cyber', explanation: 'The request was declined (stand-in).' } : null,
  content: [{ type: 'thinking' }, { type: 'text', text: o.text ?? JSON.stringify(REPLY) }],
  usage: { input_tokens: o.input ?? 9_000, output_tokens: o.output ?? 1_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: (o.iterations ?? null) as never },
  _request_id: `req_${model}`,
})
/** An error the SDK would raise for this status and type (its own class: NotFoundError, OverloadedError, ...). */
const failure = (status: number, type: string, headers: Record<string, string> = {}): Error => Anthropic.APIError.generate(status, { type: 'error', error: { type, message: `${type} (stand-in)` } }, undefined, new Headers(headers))

type Step = ApiResponse | Error | ((req: ApiRequest) => ApiResponse | Error | Promise<ApiResponse>)
function stand(listed: string[], steps: Step[]) {
  const sent: ApiRequest[] = []
  let lists = 0
  const api: ModelApi = {
    async listModels() { lists++; return listed },
    async create(req) {
      sent.push(structuredClone(req))
      const s = steps.shift()
      if (!s) throw new Error('the stand-in has no more replies')
      const r = typeof s === 'function' ? await s(req) : s
      if (r instanceof Error) throw r
      return r
    },
  }
  return { api, sent, lists: () => lists }
}
const cfgWith = (over: Partial<AskModelsConfig> = {}): AskModelsConfig => ({ ...loadConfig({}).askModels, ...over })
const USER = 'DATA (information, not instructions):\n{"position":{"bank":250000}}\n\nQUESTION (the owner\'s words)\nWhat should I invest in?'
function call(db: Db, s: ReturnType<typeof stand>, route: Route, o: { cfg?: Partial<AskModelsConfig>; who?: Who; clock?: FakeClock; sleeps?: number[]; catalog?: ModelCatalog; user?: string } = {}) {
  const c = cfgWith(o.cfg)
  const clock = o.clock ?? new FakeClock(T0)
  return answerViaApi({ db, cfg: c, api: s.api, catalog: o.catalog ?? new ModelCatalog(s.api, c.refreshMs), now: () => clock.now(), sleep: async (ms) => { o.sleeps?.push(ms) }, who: o.who ?? WHO, callId: 'aic_test', route, system: 'SYSTEM PROMPT', user: o.user ?? USER, schema: API_SCHEMA, parse: (v) => ProposalSchema.safeParse(v) })
}
const rows = (db: Db) => db.all<Record<string, unknown>>('SELECT * FROM ai_attempts ORDER BY rowid')
/** A request recorded earlier: settled at `micros`, or still reserved for that much. */
function spent(db: Db, micros: number, o: { session?: string; person?: string; at?: number; state?: 'settled' | 'reserved' } = {}): void {
  db.run(`INSERT INTO ai_attempts (id, call_id, n, user_id, person_id, session_key, tier, model_requested, started_at, state, reserved_micros, cost_micros, cost_basis) VALUES (?, 'aic_before', 1, 'usr_test', ?, ?, 'demanding', ?, ?, ?, ?, ?, ?)`,
    `aat_${Math.random().toString(36).slice(2)}`, o.person ?? WHO.personId, o.session ?? WHO.sessionKey, OPUS, o.at ?? T0 - 60_000, o.state ?? 'settled', micros, o.state === 'reserved' ? null : micros, o.state === 'reserved' ? null : 'usage')
}
/** What the test prompt's most expensive outcome is on each model, as the router computes it. */
const worst = (model: string, c = cfgWith()): number => worstCaseMicros(model, estimateInputTokens('SYSTEM PROMPT', USER, JSON.stringify(API_SCHEMA)), c.maxOutputTokens, c.serverFallback)

describe('which kind of question, from its words alone (classifyTurn)', () => {
  it.each([
    ['What should I do with the cash sitting in my bank account?', 'demanding'],
    ['I want to invest a fixed amount every month. What would that look like?', 'demanding'],
    ['Pay my electricity bill, then move what is left to the liquid fund.', 'demanding'],
    ['1. pay the card\n2. sweep the rest', 'demanding'],
    ['Pay the plumber ₹2,000 and add my landlord as a payee', 'demanding'],
    ['Is my card due before my salary? And is that a problem?', 'demanding'],
    ['How much is in my bank account?', 'routine'],
    ['When is my next bill due?', 'routine'],
    ['Make it ₹3,000 instead.', 'routine'],
    ['Why?', 'routine'],
  ])('%s: %s', (q, tier) => { expect(classifyTurn(q).tier).toBe(tier) })
  it('the answer to one of QED\'s own questions is routine; a long message is demanding', () => {
    expect(classifyTurn('Every month on the 5th, please', { answersQuestion: true })).toEqual({ tier: 'routine', why: 'it answers a question QED asked' })
    expect(classifyTurn(Array.from({ length: 45 }, () => 'word').join(' '))).toMatchObject({ tier: 'demanding', why: 'it is long (45 words)' })
  })
})

describe('the price table and the cost arithmetic (model-prices.ts)', () => {
  it('the published prices, US$ per million tokens (Anthropic pricing page, read 25 Nov 2026)', () => {
    expect(PRICES[FABLE]).toMatchObject({ input: 8, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2, output: 40 })
    expect(PRICES[OPUS]).toMatchObject({ input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 })
    expect(PRICES[SONNET]).toMatchObject({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 })
  })
  it('tokens times the price per million is micro-dollars, rounded up; a cache write at the 1-hour rate; an unknown model at the dearest', () => {
    const t = { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 }
    expect(costMicros(FABLE, t)).toEqual({ micros: 160_000, known: true }) // 10,000 x $8 + 2,000 x $40 per million = US$0.16
    expect(costMicros(OPUS, t).micros).toBe(80_000)
    expect(costMicros(SONNET, t).micros).toBe(40_000)
    expect(costMicros(SONNET, { input: 0, output: 0, cacheRead: 12_345, cacheWrite: 1_000 }).micros).toBe(1_235 + 4_000) // 1,234.5 rounded up; 1,000 x $4
    expect(costMicros('claude-unknown-9', t)).toEqual({ micros: 160_000, known: false })
  })
  it('usage.iterations, when present, is what is billed: each attempt at its own model\'s price', () => {
    const c = costOfUsage('claude-opus-4-8', { input_tokens: 9_000, output_tokens: 1_200, iterations: [{ type: 'message', model: FABLE, input_tokens: 9_000, output_tokens: 300 }, { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 9_000, output_tokens: 1_200 }] })
    expect(c.micros).toBe(72_000 + 12_000 + 45_000 + 30_000)
    expect(c.parts.map((p) => p.model)).toEqual([FABLE, 'claude-opus-4-8'])
    expect(costOfUsage(SONNET, { input_tokens: 1_000, output_tokens: 100 }).micros).toBe(2_000 + 1_000)
  })
  it('the most a request can cost: the whole output allowance, and the dearest fallback model when the server fallback is on', () => {
    expect(worstCaseMicros(FABLE, 12_388, 8_000)).toBe(99_104 + 320_000)
    expect(worstCaseMicros(OPUS, 12_388, 8_000)).toBe(49_552 + 160_000)
    expect(worstCaseMicros(SONNET, 12_388, 8_000)).toBe(24_776 + 80_000)
    expect(worstCaseMicros(FABLE, 12_388, 8_000, true)).toBe(419_104 + 61_940 + 200_000)
    expect(estimateInputTokens('')).toBe(1_500)
    expect(estimateInputTokens('a'.repeat(22), '₹')).toBe(12 + 1_500) // 25 bytes / 2.2, rounded up
    expect([usdText(419_104), usdText(4_000), usdText(12_500_000), usdText(0)]).toEqual(['US$0.42', 'US$0.004', 'US$12.50', 'US$0.00'])
  })
})

describe('which model answers', () => {
  it('a demanding question goes to Claude Fable 5.2 at high effort, a routine one to Claude Sonnet 5.5 at low: the same request shape, no sampling or thinking settings', async () => {
    const db = openDb(':memory:')
    const s = stand(ALL, [answer(FABLE), answer(SONNET)])
    const d = await call(db, s, DEMANDING)
    const r = await call(db, s, ROUTINE)
    expect([d.model, r.model]).toEqual([FABLE, SONNET])
    expect(s.sent.map((x) => [x.model, x.output_config?.effort, x.max_tokens])).toEqual([[FABLE, 'high', 8_000], [SONNET, 'low', 8_000]])
    for (const x of s.sent) {
      expect(x.output_config?.format).toEqual({ type: 'json_schema', schema: API_SCHEMA })
      expect(x).not.toHaveProperty('temperature'); expect(x).not.toHaveProperty('thinking'); expect(x).not.toHaveProperty('fallbacks')
      expect(x.system).toBe('SYSTEM PROMPT'); expect(x.messages).toEqual([{ role: 'user', content: USER }])
    }
    expect(d.data).toEqual(REPLY)
    const [a] = rows(db)
    expect(a).toMatchObject({ n: 1, call_id: 'aic_test', tier: 'demanding', model_requested: FABLE, model_answered: FABLE, state: 'settled', outcome: 'answered', http_status: 200, request_id: `req_${FABLE}`, input_tokens: 9_000, output_tokens: 1_500, cost_micros: 72_000 + 60_000, cost_basis: 'usage', reserved_micros: worst(FABLE), session_key: 'session-a' })
    expect(JSON.parse(String(a!.detail_json))).toMatchObject({ effort: 'high', structured: 'parsed', blocks: ['thinking', 'text'], toolCalls: [], stopReason: 'end_turn' })
    expect(d.record).toMatchObject({ tier: 'demanding', answeredBy: FABLE, costUsd: 0.132, attempts: [{ n: 1, model: FABLE, answeredBy: FABLE, outcome: 'answered' }] })
  })
  it('only models GET /v1/models lists: without Claude Fable 5.2 a demanding question goes to Claude Opus 5.5, and says why', async () => {
    const db = openDb(':memory:')
    const s = stand([OPUS, SONNET, 'claude-haiku-5-5'], [answer(OPUS)])
    const r = await call(db, s, DEMANDING)
    expect(r.model).toBe(OPUS)
    expect(r.record.passedOver).toEqual([{ model: FABLE, why: 'not listed for this key by GET /v1/models' }])
    // a routine question when the economical model is not listed: the cheapest that is
    const t = stand([FABLE, OPUS], [answer(OPUS)])
    expect((await call(db, t, ROUTINE)).model).toBe(OPUS)
  })
  it('the list is read when needed and again after its period; when it cannot be read nothing is asked, and it is not asked for again within a minute', async () => {
    const db = openDb(':memory:')
    const clock = new FakeClock(T0)
    const s = stand(ALL, [answer(FABLE), answer(FABLE)])
    const catalog = new ModelCatalog(s.api, 30 * 60_000)
    await call(db, s, DEMANDING, { clock, catalog })
    await call(db, s, DEMANDING, { clock, catalog })
    expect(s.lists()).toBe(1)
    clock.advance(30 * 60_000)
    await catalog.ensure(clock.now())
    expect(s.lists()).toBe(2)
    const broken: ModelApi = { listModels: async () => { throw failure(500, 'api_error') }, create: async () => { throw new Error('must not be called') } }
    const c2 = new ModelCatalog(broken, 30 * 60_000)
    let lists = 0
    const counting: ModelApi = { ...broken, listModels: async () => { lists++; return broken.listModels() } }
    const c3 = new ModelCatalog(counting, 30 * 60_000)
    await expect(answerViaApi({ db, cfg: cfgWith(), api: broken, catalog: c2, now: () => T0, who: WHO, callId: 'aic_x', route: DEMANDING, system: 'S', user: 'U', schema: API_SCHEMA, parse: (v) => ProposalSchema.safeParse(v) })).rejects.toMatchObject({ code: 'no_model', record: null, message: expect.stringMatching(/GET \/v1\/models.*Nothing was asked/) })
    await c3.ensure(T0); await c3.ensure(T0 + 30_000)
    expect(lists).toBe(1)
    await c3.ensure(T0 + 61_000)
    expect(lists).toBe(2)
    expect(rows(db).filter((r) => r.call_id === 'aic_x')).toEqual([])
  })
})

describe('fallback without losing context: each kind of failure', () => {
  it.each<[string, () => Error, string, number[], number]>([
    ['model not found (404)', () => failure(404, 'not_found_error'), 'not_found', [], 0],
    ['overloaded (529)', () => failure(529, 'overloaded_error'), 'overloaded', [500], 0],
    ['rate-limited (429), with retry-after', () => failure(429, 'rate_limit_error', { 'retry-after': '2' }), 'rate_limited', [2_000], 0],
    ['a server error (500)', () => failure(500, 'api_error'), 'server_error', [500], 1],
    ['a timeout', () => new Anthropic.APIConnectionTimeoutError(), 'timeout', [500], 1],
    ['a lost connection', () => new Anthropic.APIConnectionError({ message: 'socket hang up' }), 'connection', [500], 1],
    ['a request the model rejects (400)', () => failure(400, 'invalid_request_error'), 'bad_request', [], 0],
    ['not permitted for this model (403)', () => failure(403, 'permission_error'), 'permission', [], 0],
  ])('%s: the same messages go to the next model down', async (_name, make, outcome, pauses, keptAtReserved) => {
    const db = openDb(':memory:')
    const sleeps: number[] = []
    const s = stand(ALL, [make(), answer(OPUS)])
    const r = await call(db, s, DEMANDING, { sleeps })
    expect(r.model).toBe(OPUS)
    expect(s.sent.map((x) => x.model)).toEqual([FABLE, OPUS])
    expect(s.sent[1]!.system).toBe(s.sent[0]!.system)
    expect(s.sent[1]!.messages).toEqual(s.sent[0]!.messages)
    expect(s.sent[1]!.output_config?.format).toEqual(s.sent[0]!.output_config?.format)
    expect(sleeps).toEqual(pauses)
    const [first, second] = rows(db)
    // a failure with no response may have been billed: it keeps what was reserved for it; an HTTP refusal costs nothing
    expect(first).toMatchObject({ n: 1, model_requested: FABLE, model_answered: null, state: 'settled', outcome, cost_micros: keptAtReserved ? worst(FABLE) : 0, cost_basis: keptAtReserved ? 'reserved' : 'none' })
    expect(second).toMatchObject({ n: 2, model_requested: OPUS, model_answered: OPUS, outcome: 'answered' })
    expect(r.record.attempts.map((a) => a.outcome)).toEqual([outcome, 'answered'])
    expect(r.record.costUsd).toBeCloseTo((Number(first!.cost_micros) + Number(second!.cost_micros)) / 1e6, 6)
  })
  it('a model the API does not find is passed over for the next questions too, until the list is read again', async () => {
    const db = openDb(':memory:')
    const s = stand(ALL, [failure(404, 'not_found_error'), answer(OPUS), answer(OPUS)])
    const catalog = new ModelCatalog(s.api, 30 * 60_000)
    await call(db, s, DEMANDING, { catalog })
    const again = await call(db, s, DEMANDING, { catalog })
    expect(s.sent.map((x) => x.model)).toEqual([FABLE, OPUS, OPUS])
    expect(again.record.passedOver[0]).toEqual({ model: FABLE, why: 'the API answered "not found" for it; passed over until the list is read again' })
  })
  it('authentication and billing errors stop at once: no other model is asked', async () => {
    for (const [status, type, words] of [[401, 'authentication_error', /did not accept this installation's API key/], [402, 'billing_error', /refused the request for billing: the account may have no credit left/]] as const) {
      const db = openDb(':memory:')
      const s = stand(ALL, [failure(status, type), answer(OPUS)])
      const e = await call(db, s, DEMANDING).catch((x: unknown) => x) as AskModelError
      expect(e).toBeInstanceOf(AskModelError)
      expect(e).toMatchObject({ status: 503, code: 'model_error', lastModel: FABLE, message: expect.stringMatching(words) })
      expect(s.sent).toHaveLength(1)
      expect(e.record?.attempts).toEqual([expect.objectContaining({ model: FABLE, outcome: status === 401 ? 'auth' : 'billing', costUsd: 0 })])
    }
  })
  it('retries are bounded: three requests at most, down the order, with growing pauses; at the last model a transient failure is retried on it', async () => {
    const db = openDb(':memory:')
    const sleeps: number[] = []
    const s = stand(ALL, [failure(529, 'overloaded_error'), failure(529, 'overloaded_error'), failure(529, 'overloaded_error'), answer(SONNET)])
    const e = await call(db, s, DEMANDING, { sleeps }).catch((x: unknown) => x) as AskModelError
    expect(e).toMatchObject({ status: 502, code: 'model_error', message: expect.stringMatching(/No model answered \(Claude Fable 5\.2: overloaded; Claude Opus 5\.5: overloaded; Claude Sonnet 5\.5: overloaded\)\. Nothing was acted on/) })
    expect(s.sent.map((x) => x.model)).toEqual([FABLE, OPUS, SONNET])
    expect(sleeps).toEqual([500, 1_000])
    expect(rows(db)).toHaveLength(3)
    const t = stand(ALL, [failure(529, 'overloaded_error'), failure(503, 'api_error'), answer(SONNET)])
    const r = await call(openDb(':memory:'), t, ROUTINE, { sleeps: [] })
    expect(t.sent.map((x) => x.model)).toEqual([SONNET, SONNET, SONNET])
    expect(r.model).toBe(SONNET)
  })
  it('a request that got an answer is never sent again: a refusal, a reply outside the schema, a reply cut off at max_tokens', async () => {
    for (const [res, outcome, words] of [
      [answer(FABLE, { stop: 'refusal', category: 'cyber' }), 'refused', /declined this request \(category: cyber\)/],
      [answer(FABLE, { text: '{"answer": 3}' }), 'unusable', /did not match the required shape/],
      [answer(FABLE, { text: '{"answer": "Keep', stop: 'max_tokens' }), 'unusable', /ran out of room for its reply \(8,000 output tokens/],
    ] as const) {
      const db = openDb(':memory:')
      const s = stand(ALL, [res, answer(OPUS)])
      const r = await call(db, s, DEMANDING)
      expect(s.sent).toHaveLength(1)
      expect(r).toMatchObject({ data: null, model: FABLE, refusal: expect.stringMatching(words) })
      expect(rows(db)).toEqual([expect.objectContaining({ outcome, cost_basis: 'usage', cost_micros: 132_000 })])
    }
  })
})

describe('the model that answered is recorded from the response, not the request', () => {
  it('a request to Claude Fable 5.2 answered by another model (the API\'s own fallback): that model is recorded, and every attempt it lists is paid for', async () => {
    const db = openDb(':memory:')
    const iterations = [{ type: 'message', model: FABLE, input_tokens: 9_000, output_tokens: 300 }, { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 9_000, output_tokens: 1_200 }]
    const s = stand(ALL, [answer('claude-opus-4-8', { output: 1_200, iterations })])
    const r = await call(db, s, DEMANDING)
    expect(r.model).toBe('claude-opus-4-8')
    expect(rows(db)[0]).toMatchObject({ model_requested: FABLE, model_answered: 'claude-opus-4-8', cost_micros: 159_000 })
    expect(JSON.parse(String(rows(db)[0]!.detail_json)).costParts).toEqual([
      { model: FABLE, input: 9_000, output: 300, cacheRead: 0, cacheWrite: 0, usd: 0.084, priced: true },
      { model: 'claude-opus-4-8', input: 9_000, output: 1_200, cacheRead: 0, cacheWrite: 0, usd: 0.075, priced: true },
    ])
  })
  it('a model missing from the price table is charged at the dearest price, and marked so', async () => {
    const db = openDb(':memory:')
    const r = await call(db, stand(ALL, [answer('claude-fable-9')]), DEMANDING)
    expect(r.model).toBe('claude-fable-9')
    expect(rows(db)[0]).toMatchObject({ model_answered: 'claude-fable-9', cost_micros: 9_000 * 8 + 1_500 * 40 })
    expect(JSON.parse(String(rows(db)[0]!.detail_json)).costParts[0].priced).toBe(false)
  })
  it('with QED_AI_SERVER_FALLBACK=1 the request carries the fallback, and its run is reserved too', async () => {
    const db = openDb(':memory:')
    const s = stand(ALL, [answer(FABLE)])
    await call(db, s, DEMANDING, { cfg: { serverFallback: true } })
    expect(s.sent[0]).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    expect(rows(db)[0]!.reserved_micros).toBe(worst(FABLE, cfgWith({ serverFallback: true })))
    expect(worst(FABLE, cfgWith({ serverFallback: true }))).toBeGreaterThan(worst(FABLE))
  })
})

describe('the spending limits: refuse, or step down a model, before anything is asked', () => {
  it('a session near its limit steps a demanding question down to the best model that still fits, and says why', async () => {
    const db = openDb(':memory:')
    spent(db, 1_000_000 - worst(OPUS)) // Claude Opus 5.5 fits exactly; Claude Fable 5.2 does not
    const s = stand(ALL, [answer(OPUS)])
    const r = await call(db, s, DEMANDING)
    expect(s.sent.map((x) => x.model)).toEqual([OPUS])
    expect(r.record.passedOver).toEqual([{ model: FABLE, why: expect.stringMatching(/^its most expensive outcome, US\$0\.\d+, would cross this sign-in's limit of US\$1\.00/) }])
  })
  it.each<[string, Partial<AskModelsConfig>, Parameters<typeof spent>[2], string, RegExp]>([
    ['the session', {}, {}, 'ai_budget_session', /This sign-in has used US\$0\.99 of its US\$1\.00 allowance/],
    ['the person, in 24 hours', { session: 5_000_000 }, { session: 'session-b' }, 'ai_budget_person', /You have used US\$0\.99 of your US\$1\.00 allowance for model answers in 24 hours/],
    ['the hour, for everyone', { session: 5_000_000, personDay: 5_000_000 }, { session: 'session-b', person: 'usr_other' }, 'ai_budget_hour', /Everyone together has used US\$0\.99 of QED's US\$1\.00 allowance/],
    ['the installation\'s budget', { session: 5_000_000, personDay: 5_000_000, hourly: 5_000_000, reserve: 0 }, { session: 'session-b', person: 'usr_other', at: T0 - 2 * 86_400_000 }, 'ai_budget_spent', /budget for model answers on this installation is spent: US\$0\.99 of US\$1\.00.*Ask is read-only/],
  ])('when not even the economical model fits %s, nothing is asked and Ask says which limit', async (_n, over, at, code, words) => {
    const db = openDb(':memory:')
    const limits = { session: 1_000_000, personDay: 1_000_000, hourly: 1_000_000, budget: 1_000_000, ...over }
    spent(db, 990_000, at)
    const s = stand(ALL, [answer(SONNET)])
    const e = await call(db, s, ROUTINE, { cfg: limits }).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 429, code, record: null, message: expect.stringMatching(words) })
    expect(s.sent).toHaveLength(0)
    expect(rows(db)).toHaveLength(1) // only the row spent earlier: nothing reserved for a request that was not made
  })
  it('a spend older than the window no longer counts: the hour after 60 minutes, the person after 24 hours; the session and the budget for ever', async () => {
    const db = openDb(':memory:')
    spent(db, 990_000, { at: T0 - 3_600_001, session: 'session-old' })
    spent(db, 5_000, { at: T0 - 86_400_001, session: 'session-older' })
    spent(db, 7_000, { session: 'session-a' })
    expect(spendOf(db, WHO, T0)).toEqual({ budget: 1_002_000, hour: 7_000, person: 997_000, session: 7_000 })
  })
  it('the end of the budget is kept for the economical model: dearer models are passed over first', async () => {
    const db = openDb(':memory:')
    const s = stand(ALL, [answer(OPUS)])
    const r = await call(db, s, DEMANDING, { cfg: { budget: worst(OPUS) + 500_000, reserve: 500_000 } })
    expect(s.sent.map((x) => x.model)).toEqual([OPUS])
    expect(r.record.passedOver).toEqual([{ model: FABLE, why: 'the last US$0.50 of the budget is kept for Claude Sonnet 5.5' }])
  })
  it('requests in flight count at what is reserved for them: two questions at once cannot both take the last of a limit', async () => {
    const db = openDb(':memory:')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const s = stand(ALL, [async () => { await gate; return answer(FABLE) }, answer(OPUS)])
    const limit = worst(FABLE) + worst(OPUS)
    const first = call(db, s, DEMANDING, { cfg: { session: limit, budget: 50_000_000 } })
    await new Promise((r) => setTimeout(r, 10))
    expect(rows(db)).toEqual([expect.objectContaining({ state: 'reserved', model_requested: FABLE, reserved_micros: worst(FABLE) })])
    const second = await call(db, s, DEMANDING, { cfg: { session: limit, budget: 50_000_000 } })
    expect(second.model).toBe(OPUS)
    release()
    expect((await first).model).toBe(FABLE)
    // reconciled: each reservation replaced by the cost the response reported
    expect(rows(db).map((r) => [r.model_requested, r.state, r.cost_micros])).toEqual([[FABLE, 'settled', 132_000], [OPUS, 'settled', 66_000]])
  })
  it('a prompt larger than QED_AI_MAX_INPUT_TOKENS is refused before anything is asked', async () => {
    const s = stand(ALL, [answer(FABLE)])
    await expect(call(openDb(':memory:'), s, DEMANDING, { cfg: { maxInputTokens: 4_000 }, user: 'x'.repeat(20_000) })).rejects.toMatchObject({ status: 413, code: 'ai_prompt_too_large', record: null })
    expect(s.sent).toHaveLength(0)
  })
  it('what the screens show: where a question would go now, and why Ask is read-only when nothing fits', async () => {
    const db = openDb(':memory:')
    const s = stand(ALL, [])
    const catalog = new ModelCatalog(s.api, 30 * 60_000)
    await catalog.refresh(T0)
    const c = cfgWith()
    expect(askModelsView(db, c, catalog, WHO, T0)).toMatchObject({ demanding: FABLE, routine: SONNET, readOnly: null, order: [{ id: FABLE, name: 'Claude Fable 5.2', listed: true }, { id: OPUS, listed: true }, { id: SONNET, listed: true }], spentUsd: { budget: 0, budgetLimit: 12.5, hourLimit: 3, personLimit: 2, sessionLimit: 1 } })
    spent(db, 12_450_000, { session: 'session-b', person: 'usr_other', at: T0 - 2 * 86_400_000 })
    expect(askModelsView(db, c, catalog, WHO, T0)).toMatchObject({ demanding: null, routine: null, readOnly: { code: 'ai_budget_spent', message: expect.stringMatching(/US\$12\.45 of US\$12\.50.*Ask is read-only until the owner adds to it/) } })
  })
})

describe('the real SDK client, against a local stand-in server on 127.0.0.1 (no request leaves this machine)', () => {
  it('lists the models, sends the request QED builds, reads the response; an overload and a timeout are the SDK\'s own errors, not retried by the SDK', async () => {
    const seen: { method: string; url: string; key: string | undefined; body: Record<string, unknown> | null }[] = []
    let posts = 0
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d: Buffer) => { raw += d.toString('utf8') }).on('end', () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : null
        seen.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers.authorization, body })
        if ((req.url ?? '').startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ data: ALL.map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-11-01T00:00:00Z' })), has_more: false, first_id: FABLE, last_id: SONNET }))
        }
        posts++
        if (posts === 1) { res.writeHead(529, { 'content-type': 'application/json', 'request-id': 'req_overloaded' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })) }
        if (posts === 2) return // never answered: the client's timeout ends it
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_ok' })
        res.end(JSON.stringify({ id: 'msg_ok', type: 'message', role: 'assistant', model: body?.model, content: [{ type: 'text', text: JSON.stringify(REPLY) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 9_000, output_tokens: 1_500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const before = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY }
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    process.env.ANTHROPIC_API_KEY = 'test-placeholder-not-a-key'
    try {
      const api = anthropicApi()
      expect(await api.listModels()).toEqual(ALL)
      const db = openDb(':memory:')
      const sleeps: number[] = []
      const r = await call(db, { api, sent: [], lists: () => 0 }, DEMANDING, { sleeps, cfg: { timeoutMs: 3_000 } })
      expect(r.model).toBe(SONNET)
      const sent = seen.filter((s) => s.method === 'POST')
      expect(sent.map((s) => [s.url.split('?')[0], s.body?.model])).toEqual([['/v1/messages', FABLE], ['/v1/messages', OPUS], ['/v1/messages', SONNET]])
      expect(sent[0]!.key).toBe('Bearer test-placeholder-not-a-key') // SDK 1.5.0 sends the key as a bearer credential
      expect(sent[0]!.body).toEqual({ model: FABLE, max_tokens: 8_000, output_config: { effort: 'high', format: { type: 'json_schema', schema: API_SCHEMA } }, system: 'SYSTEM PROMPT', messages: [{ role: 'user', content: USER }] })
      expect(sleeps).toEqual([500, 1_000])
      expect(rows(db).map((x) => [x.model_requested, x.outcome, x.http_status, x.request_id, x.cost_basis])).toEqual([
        [FABLE, 'overloaded', 529, 'req_overloaded', 'none'], [OPUS, 'timeout', null, null, 'reserved'], [SONNET, 'answered', 200, 'req_ok', 'usage'],
      ])
    } finally {
      // the environment as it was (a base URL may be set for this process by whatever runs the tests)
      for (const [k, v] of [['ANTHROPIC_BASE_URL', before.base], ['ANTHROPIC_API_KEY', before.key]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      server.closeAllConnections(); server.close()
    }
  })
})

describe('the limits survive a restart: they are counted from the database', () => {
  it('spent and in-flight amounts are read back after the database is closed and opened again; a request a stopped process left is closed at its reservation', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qed-ask-models-')), 'qed.db')
    let db = openDb(path)
    await call(db, stand(ALL, [answer(FABLE)]), DEMANDING)
    spent(db, 300_000, { state: 'reserved', at: T0 - 3_600_000 }) // the process stopped while this request was in flight
    const before = spendOf(db, WHO, T0)
    expect(before.budget).toBe(132_000 + 300_000)
    db.close()
    db = openDb(path)
    expect(spendOf(db, WHO, T0)).toEqual(before)
    expect(settleInterrupted(db, cfgWith(), T0)).toBe(1)
    expect(db.get('SELECT state, outcome, cost_micros, cost_basis FROM ai_attempts WHERE reserved_micros = 300000')).toEqual({ state: 'settled', outcome: 'interrupted', cost_micros: 300_000, cost_basis: 'reserved' })
    expect(spendOf(db, WHO, T0)).toEqual(before)
    // and the limits still bind: a budget below what is recorded refuses after the restart
    const s = stand(ALL, [answer(SONNET)])
    await expect(call(db, s, ROUTINE, { cfg: { budget: 500_000, reserve: 0 } })).rejects.toMatchObject({ code: 'ai_budget_spent' })
    expect(s.sent).toHaveLength(0)
    db.close()
  })
})

describe('Ask through the Anthropic API path (server/ai.ts ask)', () => {
  const Q = 'What should I do with the cash sitting in my bank account?'
  afterEach(() => { useModelApiForTests(null); delete process.env.ANTHROPIC_API_KEY })
  const setup = (steps: Step[], env: Record<string, string> = {}) => {
    process.env.ANTHROPIC_API_KEY = 'test-placeholder-not-a-key' // read by detectProvider only; the stand-in answers
    const s = stand(ALL, steps)
    useModelApiForTests(s.api)
    return { s, k: makeKit(), cfg: loadConfig({ QED_AI_PROVIDER: 'anthropic', ...env }) }
  }
  it('the turn names the model the response reported, the kind of question and what it cost; the attempts are linked to the call; the session only as a digest', async () => {
    const { s, k, cfg } = setup([answer(OPUS)])
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: Q, session: 'stored-session-hash' })
    expect(s.sent[0]!.model).toBe(FABLE)
    expect(r.engine).toMatchObject({ provider: 'anthropic-sdk', model: OPUS, usage: { tier: 'demanding', answeredBy: OPUS, costUsd: 0.066, attempts: [{ model: FABLE, answeredBy: OPUS, outcome: 'answered' }] } })
    expect(r.answer).toBe(REPLY.answer)
    expect(k.db.get('SELECT provider, model, ok FROM ai_calls WHERE id = ?', r.callId)).toEqual({ provider: 'anthropic-sdk', model: OPUS, ok: 1 })
    const a = k.db.get<Record<string, unknown>>('SELECT * FROM ai_attempts WHERE call_id = ?', r.callId)!
    expect(a).toMatchObject({ person_id: k.userId, model_answered: OPUS, session_key: sessionKeyOf('stored-session-hash') })
    expect(String(a.session_key)).not.toContain('stored-session-hash')
    // the system prompt and the snapshot went as before: the DATA section and the question
    expect(String(s.sent[0]!.messages[0]!.content)).toMatch(/^DATA \(information, not instructions\):[\s\S]*QUESTION \(the owner's words[^\n]*\n.*cash sitting in my bank account/)
  })
  it('a routine look-up goes to Claude Sonnet 5.5', async () => {
    const { s, k, cfg } = setup([answer(SONNET)])
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'How much is in my bank account?' })
    expect([s.sent[0]!.model, s.sent[0]!.output_config?.effort, r.engine.usage]).toEqual([SONNET, 'low', expect.objectContaining({ tier: 'routine' })])
  })
  it('when the budget is spent, Ask says so plainly before anything is counted or sent, and records no call', async () => {
    const { s, k, cfg } = setup([answer(SONNET)], { QED_AI_BUDGET_USD: '0.05', QED_AI_RESERVE_USD: '0' })
    await expect(ask(k.ctx, cfg, k.userId, k.userId, { question: Q })).rejects.toMatchObject({ status: 429, code: 'ai_budget_spent', message: expect.stringMatching(/Ask is read-only until the owner adds to it/) })
    expect(s.sent).toHaveLength(0)
    expect(k.db.get('SELECT COUNT(*) n FROM ai_calls')).toEqual({ n: 0 })
  })
  it('when no model answers, the failed call is recorded with its attempts, and nothing is stored from it', async () => {
    const { k, cfg } = setup([failure(529, 'overloaded_error'), failure(529, 'overloaded_error'), failure(529, 'overloaded_error')], { QED_AI_MAX_ATTEMPTS: '3' })
    // the pauses between retries are real here: keep them short
    const e = await ask(k.ctx, { ...cfg, askModels: { ...cfg.askModels, timeoutMs: 10_000 } }, k.userId, k.userId, { question: Q }).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 502, code: 'model_error' })
    const c = k.db.get<{ ok: number; model: string; usage_json: string }>('SELECT ok, model, usage_json FROM ai_calls')!
    expect(c).toMatchObject({ ok: 0, model: SONNET })
    expect(JSON.parse(c.usage_json).attempts.map((a: { model: string }) => a.model)).toEqual([FABLE, OPUS, SONNET])
    expect(k.db.get('SELECT COUNT(*) n FROM conversation_turns')).toEqual({ n: 0 })
    expect(k.db.get('SELECT COUNT(*) n FROM proposals')).toEqual({ n: 0 })
  })
  it('the request the API path sends is the one buildRequest makes, whichever model it goes to', () => {
    const r = buildRequest(OPUS, 'demanding', cfgWith(), 'S', 'U', API_SCHEMA)
    expect(Object.keys(r).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system'])
  })
})
