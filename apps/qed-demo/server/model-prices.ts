/**
 * What a call to the Anthropic API costs, from the published price table, for Ask's spending limits (server/ask-models.ts).
 *
 * Source: Anthropic, "Pricing", https://platform.claude.com/docs/en/about-claude/pricing (read 25 Nov 2026; the same
 * figures as the claude-api reference table cached 3 Nov 2026). Prices are US dollars per million tokens for standard
 * inference on the Claude API: no batch discount, no fast mode, no data-residency multiplier, because Ask asks for none
 * of them. A model that is not in this table cannot be budgeted, so Ask never calls it (core.ts refuses it in
 * QED_AI_MODELS), and a response from a model missing here is charged at the dearest price in the table.
 *
 * Amounts are kept in micro-dollars (US$1 = 1,000,000), whole numbers rounded up, so sums never drift. A price per
 * million tokens times a number of tokens is that many micro-dollars.
 *
 * No other module is imported: core.ts (loadConfig) and the model check script read it too.
 */

export interface Price {
  name: string
  /** Base input tokens. */
  input: number
  /** Writing the 5-minute and the 1-hour prompt cache. Ask sets no cache breakpoint; a write is charged at the 1-hour rate. */
  cacheWrite5m: number
  cacheWrite1h: number
  /** Cache hits and refreshes. */
  cacheRead: number
  output: number
}

export const PRICE_SOURCE = 'Anthropic, “Pricing” (platform.claude.com/docs/en/about-claude/pricing), read 25 Nov 2026'

export const PRICES: Readonly<Record<string, Price>> = {
  // the three models Ask chooses between (QED_AI_MODELS)
  'claude-fable-5-2': { name: 'Claude Fable 5.2', input: 8, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2, output: 40 },
  'claude-opus-5-5': { name: 'Claude Opus 5.5', input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  // the models the server-side refusal fallback may hand a request to (only with QED_AI_SERVER_FALLBACK=1)
  'claude-opus-5': { name: 'Claude Opus 5', input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  'claude-opus-4-8': { name: 'Claude Opus 4.8', input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5': { name: 'Claude Sonnet 5', input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
}

/**
 * Where the server-side refusal fallback ("fallbacks": "default", beta server-side-fallback-2026-07-01) may send a
 * declined request (claude-api reference, 25 Nov 2026: Claude Fable 5.2 to Claude Opus 4.8 or Claude Opus 5; Claude
 * Opus 5.5 to Claude Opus 5 or Claude Opus 4.8; Claude Sonnet 5.5 to Claude Sonnet 5). Used only to reserve what such a
 * second run could cost when QED_AI_SERVER_FALLBACK=1.
 */
export const FALLBACK_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'claude-fable-5-2': ['claude-opus-4-8', 'claude-opus-5'],
  'claude-opus-5-5': ['claude-opus-5', 'claude-opus-4-8'],
  'claude-sonnet-5-5': ['claude-sonnet-5'],
}

const DEAREST: Price = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a))
/** The display name of a model id, or the id itself. */
export const modelName = (id: string): string => PRICES[id]?.name ?? id

export interface TokenUse { input: number; output: number; cacheRead: number; cacheWrite: number }
/** What these tokens cost on this model, in micro-dollars rounded up; `known` is false when the model is not in the table. */
export function costMicros(model: string, t: TokenUse): { micros: number; known: boolean } {
  const p = PRICES[model]
  const q = p ?? DEAREST
  const raw = t.input * q.input + t.output * q.output + t.cacheRead * q.cacheRead + t.cacheWrite * q.cacheWrite1h
  return { micros: Math.ceil(raw - 1e-9), known: !!p }
}

/** One billed part of a response: the attempt that answered, or each attempt `usage.iterations` lists. */
export interface CostPart extends TokenUse { model: string; micros: number; known: boolean }
interface UsageLike {
  input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null
  iterations?: ({ type?: string; model?: string | null } & UsageLike)[] | null
}
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const use = (u: UsageLike): TokenUse => ({ input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) })
/**
 * What a response cost. `usage.iterations`, when present, is the API's per-attempt record of what is billed (a declined
 * attempt and the fallback that answered are each listed, at their own model's rates), and the top-level usage covers
 * only the attempt that produced the message; so the iterations are summed when there are any, else the top level is
 * priced at the model that answered. An attempt declined before any output in a category that is not billed is still
 * counted: the cost can be overstated, never understated.
 */
export function costOfUsage(model: string, usage: UsageLike): { micros: number; known: boolean; parts: CostPart[] } {
  const its = Array.isArray(usage.iterations) ? usage.iterations.filter((x) => x && typeof x === 'object') : []
  const parts: CostPart[] = (its.length ? its.map((x) => ({ model: typeof x.model === 'string' && x.model ? x.model : model, t: use(x) })) : [{ model, t: use(usage) }])
    .map(({ model: m, t }) => ({ model: m, ...t, ...costMicros(m, t) }))
  return { micros: parts.reduce((s, p) => s + p.micros, 0), known: parts.every((p) => p.known), parts }
}

/**
 * Input tokens a prompt can be, estimated before the call without asking the API: one token for every 2.2 bytes of
 * UTF-8, plus 1,500 for the reply schema the structured output carries and the request's own framing. JSON with many
 * figures runs at about 2.5 to 3 bytes a token and English prose at about 3 to 4 on the current tokenizer, so the
 * estimate is meant to be high. NOT VERIFIED against this tokenizer's counts until the first live calls: each attempt
 * records the estimate beside the tokens the API reported (ai_attempts.detail_json), and scripts/ask-model-check.ts
 * prints both.
 */
export const BYTES_PER_TOKEN = 2.2
export const REQUEST_OVERHEAD_TOKENS = 1_500
export function estimateInputTokens(...texts: string[]): number {
  return Math.ceil(texts.reduce((s, t) => s + Buffer.byteLength(t, 'utf8'), 0) / BYTES_PER_TOKEN) + REQUEST_OVERHEAD_TOKENS
}

/**
 * The most a call can cost: every input token at the input price and the full output allowance at the output price
 * (the API never returns more output tokens than max_tokens). With the server-side refusal fallback on, the dearest
 * model it may run is added, with the same input and the same allowance: a declined attempt and its fallback are both
 * billed.
 */
export function worstCaseMicros(model: string, inputTokens: number, maxOutput: number, serverFallback = false): number {
  const one = (m: string): number => costMicros(m, { input: inputTokens, output: maxOutput, cacheRead: 0, cacheWrite: 0 }).micros
  const fallback = serverFallback ? Math.max(0, ...(FALLBACK_TARGETS[model] ?? []).map(one)) : 0
  return one(model) + fallback
}

export const MICROS = 1_000_000
/** "US$0.19", "US$0.004", "US$12.50": two decimals, three below a cent so that a small call does not read as nothing. */
export function usdText(micros: number): string {
  const v = micros / MICROS
  return `US$${v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`
}
