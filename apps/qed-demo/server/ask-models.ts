/**
 * Ask on the Anthropic API (R13, 25 Nov 2026): which model answers a question, what it may cost, and the record of every
 * request to the API. The model proposes only. Whichever model answers, its reply goes through the same fixed-code checks
 * in server/ai.ts (and ask-guard.ts before any model is asked), then the passkey approval, the policy, the kernel and the
 * co-signer: nothing here changes what a reply may do.
 *
 * Which model (the rule; docs/DEPLOY.md "Ask's models and spending limits" states it too):
 *  1. Each question is demanding or routine, decided from its words by classifyTurn below, with no model call:
 *     routine: the answer to one of Ask's own structured questions, or a short question or look-up;
 *     demanding: anything about investing, a plan, a strategy or advice; several steps; several requests in one
 *     message; or more than 40 words.
 *  2. A demanding question goes to the first model of QED_AI_MODELS (by default Claude Fable 5.2, then Claude Opus 5.5,
 *     then Claude Sonnet 5.5) that GET /v1/models lists for this key and whose most expensive outcome fits every spending
 *     limit; a model dearer than the last must also leave QED_AI_RESERVE_USD of the budget unspent. A routine question
 *     goes to the last, economical model.
 *  3. A request that fails without an answer (model not found, overloaded, rate-limited, a server error, a timeout or a
 *     lost connection, or a request that model rejects) is sent again, the same system prompt and the same message, to
 *     the next model down; at the last model a transient failure is retried on it. At most QED_AI_MAX_ATTEMPTS requests
 *     for one question, with a pause after a transient failure, within twice QED_AI_TIMEOUT_MS. A request that got an
 *     answer is never sent again, even when the answer is a refusal or unusable. An authentication or billing error stops
 *     at once.
 *
 * What it may cost. Every limit is enforced here, in the server, from the ai_attempts table, so it holds across restarts:
 *  per request the output allowance (QED_AI_MAX_OUTPUT_TOKENS) and the prompt size (QED_AI_MAX_INPUT_TOKENS, estimated);
 *  per sign-in session QED_AI_SESSION_USD; per person in any 24 hours QED_AI_PERSON_DAILY_USD; for everyone in any 60
 *  minutes QED_AI_HOURLY_USD; and QED_AI_BUDGET_USD for the installation in all. Before each request its most expensive
 *  outcome is reserved (model-prices.ts worstCaseMicros): a model whose reservation would cross a limit is passed over
 *  for a cheaper one, and when none fits nothing is asked and Ask says which limit was reached. After the request the
 *  reservation becomes the cost of the tokens the response reported, at the published prices; a request that got no
 *  response keeps its reservation as its cost, because it may have been billed. The API has no endpoint for the
 *  account's balance, so QED cannot read what is left in the Console: QED_AI_BUDGET_USD is set below it, with a margin.
 *
 * The API's own refusal fallback ("fallbacks": "default") is off unless QED_AI_SERVER_FALLBACK=1. It can run a model QED
 * did not choose (Claude Opus 4.8, Claude Opus 5 or Claude Sonnet 5), whose cost would then be reserved on every request
 * (about 60% more on Claude Fable 5.2's), and here a refusal is an answer, recorded and shown as one, not a failure.
 */
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { AppError, type AskModelsConfig, type Db, j, newId } from './core.ts'
import { log } from './log.ts'
import { costOfUsage, estimateInputTokens, MICROS, modelName, PRICE_SOURCE, usdText, worstCaseMicros } from './model-prices.ts'

// ------------------------------------------------------------------------------------------------ which kind of question

export type Tier = 'demanding' | 'routine'
export interface Route { tier: Tier; why: string }

const INVESTING = /\b(?:invest\w*|portfolio\w*|allocat\w*|strateg\w*|rebalanc\w*|diversif\w*|retire\w*|pension|sips?|mutual funds?|index funds?|equit(?:y|ies)|stocks?|shares|bonds?|gold|bitcoin|crypto\w*|returns?|yields?|interest rates?|risk\w*|hedg\w*|tax\w*|plan|plans|planning|goals?|optimi[sz]\w*|compar\w*|trade-?offs?|pros and cons|better off|should (?:i|we)|would you|recommend\w*|advi[cs]\w*|ideas?|afford\w*)\b/i
const STEPS = /\b(?:then|after that|afterwards|and also|finally|secondly|thirdly)\b|\bfirst\b[^.?!]*\b(?:then|next|after)\b/i
const LIST = /(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/
const ACT = '(?:pay|buy|sell|move|send|set up|invest|transfer|sweep|park|cancel|add|stop|start|save|repay|clear|top up|withdraw|rebalance|split)'
const TWO_ACTIONS = new RegExp(`\\b${ACT}\\b[^.?!\\n]*(?:\\band\\b|,)\\s*(?:also\\s+)?${ACT}\\b`, 'i')

/**
 * Demanding or routine, from the words alone (no model is asked). When in doubt a question is demanding: the owner put
 * the quality of the answer first, within the limits.
 */
export function classifyTurn(question: string, o: { answersQuestion?: boolean } = {}): Route {
  if (o.answersQuestion) return { tier: 'routine', why: 'it answers a question QED asked' }
  if (INVESTING.test(question)) return { tier: 'demanding', why: 'it asks about investing, a plan, a strategy or advice' }
  if (LIST.test(question) || STEPS.test(question)) return { tier: 'demanding', why: 'it gives several steps' }
  if ((question.match(/\?/g) ?? []).length >= 2 || TWO_ACTIONS.test(question)) return { tier: 'demanding', why: 'it asks for more than one thing' }
  const words = question.trim().split(/\s+/).filter(Boolean).length
  if (words > 40) return { tier: 'demanding', why: `it is long (${words} words)` }
  return { tier: 'routine', why: 'it is a short question or a look-up' }
}

// ------------------------------------------------------------------------------------------------ the API and its models

export type Effort = 'low' | 'medium' | 'high'
/**
 * How hard each model thinks (output_config.effort; thinking itself is each model's adaptive default, which these three
 * models do not let a request turn off). Demanding questions: high on Claude Fable 5.2 (its recommended start) and Claude
 * Opus 5.5 (one above its default), medium on Claude Sonnet 5.5; routine questions: low, the recommended level for chat.
 */
export function effortFor(model: string, tier: Tier): Effort {
  if (tier === 'routine') return 'low'
  return model === 'claude-fable-5-2' || model === 'claude-opus-5-5' ? 'high' : 'medium'
}

export type ApiRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
/** What QED reads of a response: the model that answered, why it stopped, its blocks and the usage it reported. */
export interface ApiResponse {
  id: string; model: string; stop_reason: string | null
  stop_details?: { category?: string | null; explanation?: string | null } | null
  content: { type: string; text?: string; name?: string }[]
  usage: Parameters<typeof costOfUsage>[1] & { inference_geo?: string | null; service_tier?: string | null }
  _request_id?: string | null
}
/** The two calls Ask makes. A stand-in answers them in the tests; nothing else of the SDK is used. */
export interface ModelApi {
  /** GET /v1/models: the ids this key may use. Free: it uses no tokens. */
  listModels(): Promise<string[]>
  /** POST /v1/messages, once. No retry inside: each retry is a request QED decides, reserves and records. */
  create(params: ApiRequest, timeoutMs: number): Promise<ApiResponse>
}
export function anthropicApi(): ModelApi {
  // the credential is read from this process's environment by the SDK; QED never reads, prints or logs it
  const client = new Anthropic({ maxRetries: 0 })
  return {
    async listModels() { const ids: string[] = []; for await (const m of client.models.list({ limit: 100 })) ids.push(m.id); return ids },
    async create(params, timeoutMs) { return (await client.beta.messages.create(params, { timeout: timeoutMs })) as unknown as ApiResponse },
  }
}

/** One request, as every attempt sends it: the same system prompt, message and reply schema whichever model is asked. */
export function buildRequest(model: string, tier: Tier, cfg: Pick<AskModelsConfig, 'maxOutputTokens' | 'serverFallback'>, system: string, user: string, schema: Record<string, unknown>, over: { effort?: Effort; maxTokens?: number } = {}): ApiRequest {
  return {
    model, max_tokens: over.maxTokens ?? cfg.maxOutputTokens,
    output_config: { effort: over.effort ?? effortFor(model, tier), format: { type: 'json_schema', schema } },
    ...(cfg.serverFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    system, messages: [{ role: 'user', content: user }],
  }
}

/** The models this key may use, from GET /v1/models: read when the API starts, every QED_AI_MODELS_REFRESH_MIN, and when stale. */
export class ModelCatalog {
  private ids: Set<string> | null = null
  private at = 0
  private failedAt = -Infinity
  private lastError: string | null = null
  private readonly missing = new Set<string>()
  private pending: Promise<void> | null = null
  private readonly api: ModelApi
  private readonly refreshMs: number
  constructor(api: ModelApi, refreshMs: number) { this.api = api; this.refreshMs = refreshMs }
  /** Read the list now. If it cannot be read, the last list stays in force and the error is kept for the screens. */
  refresh(now: number): Promise<void> {
    this.pending ??= this.api.listModels().then(
      (ids) => { this.ids = new Set(ids); this.at = now; this.lastError = null; this.missing.clear() },
      (e: unknown) => { this.failedAt = now; this.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200); log('api', 'warn', 'model list unreadable', { error: this.lastError }) },
    ).finally(() => { this.pending = null })
    return this.pending
  }
  /** Read it when there is none or it is older than the refresh period; after a failure, not more than once a minute. */
  async ensure(now: number): Promise<void> {
    if ((!this.ids || now - this.at >= this.refreshMs) && now - this.failedAt >= 60_000) await this.refresh(now)
  }
  available(id: string): boolean { return !!this.ids?.has(id) && !this.missing.has(id) }
  /** Why a model is not available, in words. */
  unavailable(id: string): string { return this.missing.has(id) ? 'the API answered "not found" for it; passed over until the list is read again' : 'not listed for this key by GET /v1/models' }
  /** A model the API answered "not found" for: passed over until the list is read again. */
  markMissing(id: string): void { this.missing.add(id) }
  view(): { listed: string[] | null; readAt: number | null; error: string | null } { return { listed: this.ids ? [...this.ids].sort() : null, readAt: this.ids ? this.at : null, error: this.lastError } }
}

let service: { api: ModelApi; catalog: ModelCatalog } | null = null
/** The API client and its model list, one for the process. */
export function modelService(cfg: Pick<AskModelsConfig, 'refreshMs'>): { api: ModelApi; catalog: ModelCatalog } {
  if (!service) { const api = anthropicApi(); service = { api, catalog: new ModelCatalog(api, cfg.refreshMs) } }
  return service
}
/** When the API starts (server/api.ts): close what a stopped process left in flight, read the list now and then every period. */
export function startModelCatalog(db: Db, cfg: AskModelsConfig, now: () => number): () => void {
  settleInterrupted(db, cfg, now())
  const s = modelService(cfg)
  void s.catalog.refresh(now())
  const timer = setInterval(() => { void s.catalog.refresh(now()) }, cfg.refreshMs)
  timer.unref()
  return () => clearInterval(timer)
}
/** Tests only: a stand-in for the API (null: the real client again, made on next use). */
export function useModelApiForTests(api: ModelApi | null, refreshMs = 30 * 60_000): ModelCatalog | null {
  service = api ? { api, catalog: new ModelCatalog(api, refreshMs) } : null
  return service?.catalog ?? null
}

// ------------------------------------------------------------------------------------------------ what has been spent

export interface Who { userId: string; personId: string; sessionKey: string }
/** The session as the records name it: a one-way digest of the session's stored hash, so the two cannot be matched. */
export const sessionKeyOf = (sessionHash: string): string => createHash('sha256').update(`qed/ask-session/v1\n${sessionHash}`).digest('hex').slice(0, 32)

/** Settled rows count at their cost; rows in flight (or left by a stopped process) at what was reserved for them. */
const COMMITTED = `COALESCE(SUM(CASE WHEN state = 'settled' THEN COALESCE(cost_micros, reserved_micros) ELSE reserved_micros END), 0)`
function committed(db: Db, where: string, ...args: (string | number)[]): number {
  return Number(db.get<{ n: number }>(`SELECT ${COMMITTED} n FROM ai_attempts${where ? ` WHERE ${where}` : ''}`, ...args)?.n ?? 0)
}
export interface Spend { budget: number; hour: number; person: number | null; session: number | null }
export function spendOf(db: Db, who: Who | null, now: number): Spend {
  return {
    budget: committed(db, ''),
    hour: committed(db, 'started_at > ?', now - 3_600_000),
    person: who ? committed(db, 'person_id = ? AND started_at > ?', who.personId, now - 86_400_000) : null,
    session: who ? committed(db, 'session_key = ?', who.sessionKey) : null,
  }
}

export type Cap = 'session' | 'person' | 'hour' | 'budget' | 'reserve'
export interface Blocked { cap: Cap; limit: number; used: number; need: number }
/** The first limit a request costing at most `worst` would cross, or null when it fits them all. */
export function blockedBy(cfg: AskModelsConfig, s: Spend, worst: number, economical: boolean): Blocked | null {
  const limits: [Cap, number, number][] = [['session', cfg.session, s.session ?? 0], ['person', cfg.personDay, s.person ?? 0], ['hour', cfg.hourly, s.hour], ['budget', cfg.budget, s.budget]]
  for (const [cap, limit, used] of limits) if (used + worst > limit) return { cap, limit, used, need: worst }
  if (!economical && s.budget + worst + cfg.reserve > cfg.budget) return { cap: 'reserve', limit: cfg.budget - cfg.reserve, used: s.budget, need: worst }
  return null
}
const CODES: Record<Cap, string> = { session: 'ai_budget_session', person: 'ai_budget_person', hour: 'ai_budget_hour', budget: 'ai_budget_spent', reserve: 'ai_budget_spent' }
/** Why nothing can be asked, in the person's terms. */
export function capWords(b: Blocked, cfg: AskModelsConfig): string {
  const set = `a question needs up to ${usdText(b.need)} set aside before it is asked`
  switch (b.cap) {
    case 'session': return `This sign-in has used ${usdText(b.used)} of its ${usdText(b.limit)} allowance for model answers, and ${set}. Nothing was asked. Signing in again starts a new allowance, within ${usdText(cfg.personDay)} a person in 24 hours.`
    case 'person': return `You have used ${usdText(b.used)} of your ${usdText(b.limit)} allowance for model answers in 24 hours, and ${set}. Nothing was asked. It frees up as your questions pass 24 hours old.`
    case 'hour': return `Everyone together has used ${usdText(b.used)} of QED's ${usdText(b.limit)} allowance for model answers in the last hour, and ${set}. Nothing was asked. Try again later in the hour.`
    default: return `QED's budget for model answers on this installation is spent: ${usdText(b.used)} of ${usdText(cfg.budget)}, counted from every model request it has recorded. Ask is read-only until the owner adds to it: nothing new is asked of a model, and your conversations and proposals stay as they are.`
  }
}
/** Why a model was passed over for a cheaper one. */
function passWords(b: Blocked, cfg: AskModelsConfig, economical: string): string {
  if (b.cap === 'reserve') return `the last ${usdText(cfg.reserve)} of the budget is kept for ${modelName(economical)}`
  const of = { session: 'this sign-in\'s', person: 'your 24-hour', hour: 'the hour\'s', budget: 'the installation\'s' }[b.cap]
  return `its most expensive outcome, ${usdText(b.need)}, would cross ${of} limit of ${usdText(b.limit)} (${usdText(b.used)} used)`
}

/** Rows a stopped process left 'reserved' are closed as interrupted, at what was reserved for them: they may have been billed. */
export function settleInterrupted(db: Db, cfg: Pick<AskModelsConfig, 'timeoutMs'>, now: number): number {
  return db.run(`UPDATE ai_attempts SET state = 'settled', outcome = 'interrupted', cost_micros = reserved_micros, cost_basis = 'reserved', ended_at = ? WHERE state = 'reserved' AND started_at < ?`, now, now - 2 * cfg.timeoutMs - 60_000).changes
}

/** A first question on the test household, rounded up (measured 25 Nov 2026: 23,952 bytes with the reply schema, 12,388 estimated tokens). */
export const NOMINAL_INPUT_TOKENS = 13_000
export const ROUTING_RULE = 'A demanding question (about investing, a plan, a strategy or advice, several steps or requests, or a long one) goes to the best model this key may use whose most expensive outcome fits the spending limits; a short question or look-up, and the answer to a question QED asked, goes to the economical model.'

export interface ModelsView {
  order: { id: string; name: string; listed: boolean | null }[]
  /** Where a demanding and a routine question would go now, at a typical size; null: nowhere. */
  demanding: string | null
  routine: string | null
  listReadAt: number | null
  listError: string | null
  spentUsd: { budget: number; budgetLimit: number; hour: number; hourLimit: number; person: number | null; personLimit: number; session: number | null; sessionLimit: number }
  /** Set when not even a routine question fits: Ask is read-only, and this says why. */
  readOnly: { code: string; message: string } | null
  rule: string
  priceSource: string
}
/** What the screens say about the models and the limits, for this person and session (who null: the installation only). */
export function askModelsView(db: Db, cfg: AskModelsConfig, catalog: ModelCatalog | null, who: Who | null, now: number): ModelsView {
  const v = catalog?.view() ?? { listed: null, readAt: null, error: null }
  const s = spendOf(db, who, now)
  const economical = cfg.order[cfg.order.length - 1]!
  const fits = (m: string): Blocked | null => blockedBy(cfg, s, worstCaseMicros(m, NOMINAL_INPUT_TOKENS, cfg.maxOutputTokens, cfg.serverFallback), m === economical)
  const usable = (m: string): boolean => (v.listed ? !!catalog?.available(m) : true)
  const routineModel = [...cfg.order].reverse().find(usable) ?? null
  const blocked = routineModel ? fits(routineModel) : null
  const usd = (m: number | null): number | null => (m === null ? null : m / MICROS)
  return {
    order: cfg.order.map((id) => ({ id, name: modelName(id), listed: v.listed ? !!catalog?.available(id) : null })),
    demanding: cfg.order.find((m) => usable(m) && !fits(m)) ?? null,
    routine: routineModel && !blocked ? routineModel : null,
    listReadAt: v.readAt, listError: v.error,
    spentUsd: { budget: s.budget / MICROS, budgetLimit: cfg.budget / MICROS, hour: s.hour / MICROS, hourLimit: cfg.hourly / MICROS, person: usd(s.person), personLimit: cfg.personDay / MICROS, session: usd(s.session), sessionLimit: cfg.session / MICROS },
    readOnly: blocked ? { code: CODES[blocked.cap], message: capWords(blocked, cfg) } : null,
    rule: ROUTING_RULE, priceSource: PRICE_SOURCE,
  }
}

// ------------------------------------------------------------------------------------------------ asking, with fallback

type Outcome = 'answered' | 'refused' | 'unusable' | 'not_found' | 'overloaded' | 'rate_limited' | 'server_error' | 'timeout' | 'connection' | 'bad_request' | 'permission' | 'auth' | 'billing' | 'error'
interface Failure { outcome: Outcome; status: number | null; requestId: string | null; type: string | null; message: string; next: 'down' | 'transient' | 'stop'; billed: 'none' | 'maybe'; retryAfterMs: number | null }
/**
 * What a failed request means. The API rejects 4xx requests before a model runs, and 429 and 529 before it starts, so
 * those cost nothing. A timeout, a lost connection, any other 5xx or an error of unknown kind may have been billed, so
 * its reservation is kept as its cost (NOT VERIFIED against a billing statement: the conservative reading).
 */
export function failureOf(e: unknown): Failure {
  const f = (outcome: Outcome, next: Failure['next'], billed: Failure['billed'], status: number | null = null): Failure => {
    const api = e instanceof Anthropic.APIError ? e : null
    const ra = api?.headers?.get?.('retry-after')
    const secs = ra !== undefined && ra !== null && ra !== '' ? Number(ra) : NaN
    return { outcome, next, billed, status, requestId: api?.requestID ?? null, type: api?.type ?? null, message: (e instanceof Error ? e.message : String(e)).slice(0, 300), retryAfterMs: Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null }
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError) return f('timeout', 'transient', 'maybe')
  if (e instanceof Anthropic.APIConnectionError) return f('connection', 'transient', 'maybe')
  if (e instanceof Anthropic.APIError) {
    const s = typeof e.status === 'number' ? e.status : null, t = e.type
    if (s === 401 || t === 'authentication_error') return f('auth', 'stop', 'none', s)
    if (s === 402 || t === 'billing_error') return f('billing', 'stop', 'none', s)
    if (s === 404 || t === 'not_found_error') return f('not_found', 'down', 'none', s)
    if (s === 429 || t === 'rate_limit_error') return f('rate_limited', 'transient', 'none', s)
    if (s === 529 || t === 'overloaded_error') return f('overloaded', 'transient', 'none', s)
    if (s === 504 || t === 'timeout_error') return f('timeout', 'transient', 'maybe', s)
    if (s !== null && s >= 500) return f('server_error', 'transient', 'maybe', s)
    if (s === 403 || t === 'permission_error') return f('permission', 'down', 'none', s)
    if (s === 400 || s === 413 || s === 422 || t === 'invalid_request_error') return f('bad_request', 'down', 'none', s)
    return f('error', 'stop', 'none', s)
  }
  return f('error', 'stop', 'maybe')
}
const OUTCOME_WORDS: Record<Outcome, string> = {
  answered: 'answered', refused: 'declined', unusable: 'answered, but not in the reply shape', not_found: 'not available to this key', overloaded: 'overloaded',
  rate_limited: 'rate-limited', server_error: 'a server error', timeout: 'no answer in time', connection: 'the connection was lost', bad_request: 'the request was rejected for that model',
  permission: 'not permitted for this key', auth: 'the key was not accepted', billing: 'refused for billing (the account may have no credit left)', error: 'an unexpected error',
}

export interface AttemptView { n: number; model: string; answeredBy: string | null; outcome: Outcome; status: number | null; costUsd: number; basis: 'usage' | 'reserved' | 'none'; latencyMs: number }
/** What a question's attempts were, kept with the call (ai_calls.usage_json) and shown on the turn and on /judge. */
export interface CallRecord {
  tier: Tier; why: string; passedOver: { model: string; why: string }[]; attempts: AttemptView[]; costUsd: number; priceSource: string
  answeredBy?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; stopReason?: string | null
}
/** A question Ask could not have answered. `record` is null when nothing was sent to the API (no call is then recorded). */
export class AskModelError extends AppError {
  readonly record: CallRecord | null
  readonly lastModel: string | null
  constructor(status: number, code: string, message: string, record: CallRecord | null, lastModel: string | null = null) { super(status, code, message); this.record = record; this.lastModel = lastModel }
}

export interface ParseResult<T> { success: boolean; data?: T; error?: { issues: { message: string; path: PropertyKey[] }[] } }
export interface AskCall<T> {
  db: Db; cfg: AskModelsConfig; api: ModelApi; catalog: ModelCatalog
  /** The records' clock (ai_attempts times; the limits' windows). Latency is measured on the process's own clock. */
  now: () => number
  /** Waits before a retry; the tests pass one that records and does not wait. */
  sleep?: (ms: number) => Promise<void>
  who: Who; callId: string; route: Route
  system: string; user: string
  /** The reply schema sent as the structured output's JSON schema, and the check applied to what comes back. */
  schema: Record<string, unknown>
  parse: (value: unknown) => ParseResult<T>
}
export interface ApiReply<T> { data: T | null; refusal: string | null; model: string; responseId: string | null; latencyMs: number; record: CallRecord }

/**
 * Ask one question of the API under the rule above. Every request is reserved, made and settled in ai_attempts; the
 * reply comes from the first request that got an answer. Throws AskModelError when none did.
 */
export async function answerViaApi<T>(o: AskCall<T>): Promise<ApiReply<T>> {
  const { db, cfg, catalog, who, route } = o
  const t0 = performance.now(), deadline = t0 + 2 * cfg.timeoutMs
  const estIn = estimateInputTokens(o.system, o.user, JSON.stringify(o.schema))
  if (estIn > cfg.maxInputTokens) throw new AskModelError(413, 'ai_prompt_too_large', `This question, with your records and the conversation so far, comes to about ${estIn.toLocaleString('en-IN')} tokens: more than the ${cfg.maxInputTokens.toLocaleString('en-IN')} QED sends to a model at once. Nothing was asked. Start a new conversation, or ask about one thing at a time.`, null)
  await catalog.ensure(o.now())
  const list = catalog.view()
  if (!list.listed) throw new AskModelError(503, 'no_model', `QED could not read which models this installation's key may use (GET /v1/models: ${list.error ?? 'no answer'}). Nothing was asked; try again in a minute.`, null)
  const economical = cfg.order[cfg.order.length - 1]!
  const chain = route.tier === 'demanding' ? [...cfg.order] : [[...cfg.order].reverse().find((m) => catalog.available(m)) ?? economical]
  const passedOver: { model: string; why: string }[] = []
  const pass = (model: string, why: string): void => { const i = passedOver.findIndex((p) => p.model === model); if (i >= 0) passedOver.splice(i, 1); passedOver.push({ model, why }) }
  const attempts: AttemptView[] = []
  const record = (extra: Partial<CallRecord> = {}): CallRecord => ({ tier: route.tier, why: route.why, passedOver: [...passedOver], attempts: [...attempts], costUsd: attempts.reduce((s, a) => s + a.costUsd, 0), priceSource: PRICE_SOURCE, ...extra })
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let from = 0, transient = 0
  let lastBlocked: Blocked | null = null, lastFailure: Failure | null = null, lastModel: string | null = null
  while (attempts.length < cfg.maxAttempts) {
    // the first model from here down that the key may use and whose most expensive outcome fits every limit
    let pick: { model: string; at: number; worst: number } | null = null
    for (let k = from; k < chain.length && !pick; k++) {
      const m = chain[k]!
      if (!catalog.available(m)) { pass(m, catalog.unavailable(m)); continue }
      const worst = worstCaseMicros(m, estIn, cfg.maxOutputTokens, cfg.serverFallback)
      const b = blockedBy(cfg, spendOf(db, who, o.now()), worst, m === economical)
      if (b) { lastBlocked = b; pass(m, passWords(b, cfg, economical)); continue }
      pick = { model: m, at: k, worst }
    }
    if (!pick) break
    // reserved with no await between the check above and this row, so requests made at the same time cannot all pass
    const id = newId('aat', o.now()), n = attempts.length + 1, effort = effortFor(pick.model, route.tier)
    const detail: Record<string, unknown> = { effort, maxTokens: cfg.maxOutputTokens, estimatedInputTokens: estIn, serverFallback: cfg.serverFallback }
    db.run(`INSERT INTO ai_attempts (id, call_id, n, user_id, person_id, session_key, tier, model_requested, started_at, state, reserved_micros, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      id, o.callId, n, who.userId, who.personId, who.sessionKey, route.tier, pick.model, o.now(), pick.worst, j(detail))
    lastModel = pick.model
    const a0 = performance.now()
    try {
      const res = await o.api.create(buildRequest(pick.model, route.tier, cfg, o.system, o.user, o.schema), Math.max(1_000, Math.floor(Math.min(cfg.timeoutMs, deadline - a0))))
      const latencyMs = Math.round(performance.now() - a0)
      const cost = costOfUsage(res.model, res.usage)
      const u = res.usage
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      let outcome: Outcome = 'answered', data: T | null = null, refusal: string | null = null, structured: string
      if (res.stop_reason === 'refusal') {
        outcome = 'refused'; structured = 'none: the model declined'
        const cat = res.stop_details?.category, why = res.stop_details?.explanation
        refusal = `The model declined this request${cat ? ` (category: ${cat})` : ''}${why ? `: ${why}` : '.'}`
      } else {
        let value: unknown = undefined
        try { value = JSON.parse(text) } catch { /* not JSON: reported below */ }
        const p = value === undefined ? null : o.parse(value)
        if (p?.success) { data = p.data ?? null; structured = 'parsed' }
        else {
          outcome = 'unusable'
          const issue = p?.error?.issues[0] ? `${p.error.issues[0].path.join('.') || 'reply'}: ${p.error.issues[0].message}` : 'not JSON'
          structured = `invalid (${issue})`
          refusal = res.stop_reason === 'max_tokens'
            ? `The model ran out of room for its reply (${cfg.maxOutputTokens.toLocaleString('en-IN')} output tokens, thinking included). Nothing was acted on.`
            : `The model's reply did not match the required shape (stop reason: ${res.stop_reason}).`
        }
      }
      Object.assign(detail, {
        stopReason: res.stop_reason, structured, blocks: res.content.map((b) => b.type),
        toolCalls: res.content.filter((b) => /tool_use$/.test(b.type)).map((b) => b.name ?? b.type),
        costParts: cost.parts.map((c) => ({ model: c.model, input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, usd: c.micros / MICROS, priced: c.known })),
        ...(res.stop_details?.category ? { refusalCategory: res.stop_details.category } : {}),
        ...(u.inference_geo ? { inferenceGeo: u.inference_geo } : {}), ...(u.service_tier ? { serviceTier: u.service_tier } : {}),
      })
      db.run(`UPDATE ai_attempts SET state = 'settled', ended_at = ?, outcome = ?, http_status = 200, request_id = ?, model_answered = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_micros = ?, cost_basis = 'usage', latency_ms = ?, detail_json = ? WHERE id = ?`,
        o.now(), outcome, res._request_id ?? null, res.model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, cost.micros, latencyMs, j(detail), id)
      attempts.push({ n, model: pick.model, answeredBy: res.model, outcome, status: 200, costUsd: cost.micros / MICROS, basis: 'usage', latencyMs })
      return {
        data, refusal, model: res.model, responseId: res.id, latencyMs: Math.round(performance.now() - t0),
        record: record({ answeredBy: res.model, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, stopReason: res.stop_reason }),
      }
    } catch (e) {
      const latencyMs = Math.round(performance.now() - a0)
      const fl = failureOf(e)
      const cost = fl.billed === 'maybe' ? pick.worst : 0
      Object.assign(detail, { error: { type: fl.type, message: fl.message } })
      db.run(`UPDATE ai_attempts SET state = 'settled', ended_at = ?, outcome = ?, http_status = ?, request_id = ?, cost_micros = ?, cost_basis = ?, latency_ms = ?, detail_json = ? WHERE id = ?`,
        o.now(), fl.outcome, fl.status, fl.requestId, cost, fl.billed === 'maybe' ? 'reserved' : 'none', latencyMs, j(detail), id)
      attempts.push({ n, model: pick.model, answeredBy: null, outcome: fl.outcome, status: fl.status, costUsd: cost / MICROS, basis: fl.billed === 'maybe' ? 'reserved' : 'none', latencyMs })
      lastFailure = fl
      if (fl.next === 'stop') break
      if (fl.outcome === 'not_found') catalog.markMissing(pick.model)
      if (fl.next === 'down') { from = pick.at + 1; continue }
      // transient: the next model down, or this one again at the bottom, after a pause (the API's retry-after when it gave one)
      transient++
      from = Math.min(pick.at + 1, chain.length - 1)
      const pause = Math.min(8_000, fl.retryAfterMs ?? 500 * 2 ** (transient - 1))
      if (attempts.length >= cfg.maxAttempts || performance.now() + pause + 1_000 >= deadline) break
      await sleep(pause)
    }
  }
  if (!attempts.length) {
    if (lastBlocked) throw new AskModelError(429, CODES[lastBlocked.cap], capWords(lastBlocked, cfg), null)
    throw new AskModelError(503, 'no_model', `None of the models QED may use (${cfg.order.map(modelName).join(', ')}) is listed for this installation's key by GET /v1/models. Nothing was asked.`, null)
  }
  const tried = attempts.map((a) => `${modelName(a.model)}: ${OUTCOME_WORDS[a.outcome]}`).join('; ')
  const fl = lastFailure!
  const cost = attempts.reduce((s, a) => s + a.costUsd, 0)
  const msg = fl.outcome === 'auth' ? 'The model service did not accept this installation\'s API key. Nothing was acted on; the owner must check the key in the Anthropic Console.'
    : fl.outcome === 'billing' ? 'The model service refused the request for billing: the account may have no credit left. Nothing was acted on; the owner must check the account in the Anthropic Console.'
    : `No model answered (${tried}). Nothing was acted on${cost > 0 ? `; ${usdText(Math.round(cost * MICROS))} is counted against the limits, because a request without a response may have been billed` : ''}. Try again in a minute.`
  throw new AskModelError(fl.outcome === 'auth' || fl.outcome === 'billing' ? 503 : 502, 'model_error', msg, record(), lastModel)
}
