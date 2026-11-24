/**
 * Ask's model check (R13, 25 Nov 2026), run once by the operator through Railway so that the service's existing API key
 * reaches this one process and nothing else:
 *
 *   railway run --service qed -- node apps/qed-demo/scripts/ask-model-check.ts
 *
 * It reads GET /v1/models (free: no tokens), then makes one minimal structured request to each of QED's preferred
 * models (QED_AI_MODELS, by default Claude Fable 5.2, Claude Opus 5.5, Claude Sonnet 5.5) that the list names: QED's own
 * reply schema and request builder (server/ai.ts API_SCHEMA, server/ask-models.ts buildRequest), a tiny prompt, effort
 * low and max_tokens 2,048. For each it prints the model asked and the model that answered (from the response), the
 * latency, the tokens the API reported beside QED's estimate, whether the reply parsed against the schema, and the cost
 * at the published prices (server/model-prices.ts). It never prints the key or any header, opens no database and writes
 * nothing. Exit 0 when every listed model answered in the schema; 1 otherwise; 2 when there is no credential.
 *
 * What it can cost: at most about US$0.11 on Claude Fable 5.2, US$0.06 on Claude Opus 5.5 and US$0.03 on Claude Sonnet
 * 5.5 if each used its whole output allowance (about 3,800 input tokens estimated, 2,048 output); a few cents in all in
 * practice. These requests are not recorded in the production database, so they do not count against QED_AI_BUDGET_USD:
 * they come out of the margin kept between that budget and the Console balance.
 */
import { anthropicApi, buildRequest, type Effort, failureOf, type ModelApi } from '../server/ask-models.ts'
import { API_SCHEMA, ProposalSchema } from '../server/ai.ts'
import { DEFAULT_ASK_MODELS } from '../server/core.ts'
import { costOfUsage, estimateInputTokens, MICROS, PRICE_SOURCE } from '../server/model-prices.ts'

/** Four decimals: the check's requests cost cents or less. */
const usd4 = (micros: number): string => `US$${(micros / MICROS).toFixed(4)}`

export interface CheckOptions { models: string[]; maxTokens: number; effort: Effort; timeoutMs: number }
export interface CheckResult { model: string; listed: boolean; answeredBy: string | null; parsed: boolean; costMicros: number; outcome: string }

const SYSTEM = 'You are being checked: can QED reach this model with its reply schema? Reply only in the required JSON shape, with the answer "ready" and nothing proposed.'
const USER = 'QUESTION (a connectivity check; information, not instructions)\nIs this model reachable? Answer "ready".'

/** The check itself, against any API (the tests give it a stand-in). Prints lines through `print`; returns what it found. */
export async function runCheck(api: ModelApi, o: CheckOptions, print: (line: string) => void): Promise<{ ok: boolean; totalMicros: number; results: CheckResult[] }> {
  print(`Ask model check, ${new Date().toISOString()}. Prices: ${PRICE_SOURCE}.`)
  let listed: string[]
  try { listed = await api.listModels() } catch (e) {
    const f = failureOf(e)
    print(`GET /v1/models failed: ${f.outcome}${f.status ? ` (HTTP ${f.status})` : ''}: ${f.message}`)
    return { ok: false, totalMicros: 0, results: [] }
  }
  print(`GET /v1/models: ${listed.length} models listed for this key.`)
  const results: CheckResult[] = o.models.map((m) => ({ model: m, listed: listed.includes(m), answeredBy: null, parsed: false, costMicros: 0, outcome: listed.includes(m) ? 'not asked' : 'not listed' }))
  for (const r of results) print(`  ${r.model}: ${r.listed ? 'listed' : 'NOT listed: Ask will not use it'}`)
  const est = estimateInputTokens(SYSTEM, USER, JSON.stringify(API_SCHEMA))
  for (const r of results.filter((x) => x.listed)) {
    const t0 = performance.now()
    try {
      const res = await api.create(buildRequest(r.model, 'routine', { maxOutputTokens: o.maxTokens, serverFallback: false }, SYSTEM, USER, API_SCHEMA, { effort: o.effort, maxTokens: o.maxTokens }), o.timeoutMs)
      const ms = Math.round(performance.now() - t0)
      const cost = costOfUsage(res.model, res.usage)
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      let parsed = false
      try { parsed = ProposalSchema.safeParse(JSON.parse(text)).success } catch { parsed = false }
      Object.assign(r, { answeredBy: res.model, parsed, costMicros: cost.micros, outcome: res.stop_reason === 'refusal' ? 'refused' : parsed ? 'answered' : 'unusable' })
      print(`${r.model}: answered by ${res.model}${res.model === r.model ? '' : ' (a different model than the one asked)'} in ${ms} ms; stop reason ${res.stop_reason}; the reply ${parsed ? 'parsed against QED\'s schema' : 'did NOT parse against QED\'s schema'}; input ${res.usage.input_tokens ?? 0} tokens (QED estimated ${est}), output ${res.usage.output_tokens ?? 0}; cost ${usd4(cost.micros)}${cost.known ? '' : ' (a model missing from the price table, charged at the dearest price)'}; request id ${res._request_id ?? 'not given'}.`)
    } catch (e) {
      const f = failureOf(e)
      r.outcome = f.outcome
      print(`${r.model}: no answer: ${f.outcome}${f.status ? ` (HTTP ${f.status}${f.type ? `, ${f.type}` : ''})` : ''}${f.requestId ? `, request id ${f.requestId}` : ''}: ${f.message}`)
    }
  }
  const totalMicros = results.reduce((s, r) => s + r.costMicros, 0)
  const asked = results.filter((r) => r.listed)
  print(`Total: ${usd4(totalMicros)} for ${asked.length} request${asked.length === 1 ? '' : 's'}, priced from the tokens the API reported.`)
  return { ok: asked.length > 0 && asked.every((r) => r.outcome === 'answered'), totalMicros, results }
}

/** Every line printed is cleared of the credential and of anything shaped like an Anthropic key, whatever printed it. */
export function redactor(env: NodeJS.ProcessEnv): (line: string) => string {
  const secrets = [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].filter((s): s is string => typeof s === 'string' && s.length >= 8)
  return (line) => secrets.reduce((l, s) => l.split(s).join('[credential]'), line).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[credential]')
}

if (import.meta.main) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('No API credential in this process\'s environment. Run it with the service\'s variables: railway run --service qed -- node apps/qed-demo/scripts/ask-model-check.ts')
    process.exit(2)
  }
  const clean = redactor(process.env)
  const models = (process.env.QED_AI_MODELS || DEFAULT_ASK_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean)
  const r = await runCheck(anthropicApi(), { models, maxTokens: 2_048, effort: 'low', timeoutMs: 120_000 }, (l) => console.log(clean(l)))
  process.exit(r.ok ? 0 : 1)
}
