/**
 * The operator's model check (scripts/ask-model-check.ts) against a stand-in API: it lists, asks each preferred model
 * that is listed once, with QED's own schema, and prints the model asked and the model that answered, latency, tokens
 * and cost; it never prints the credential. No request leaves this machine.
 */
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { redactor, runCheck } from '../scripts/ask-model-check.ts'
import { API_SCHEMA } from './ai.ts'
import type { ApiRequest, ModelApi } from './ask-models.ts'

const REPLY = JSON.stringify({ answer: 'ready', proposals: [], questions: [], withdraw: [], cites: [], links: [] })
const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']

describe('scripts/ask-model-check.ts', () => {
  it('asks each listed model once with QED\'s schema at low effort, and prints the model that answered, latency, tokens and cost', async () => {
    const sent: ApiRequest[] = []
    const api: ModelApi = {
      listModels: async () => ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      create: async (req) => { sent.push(req); return { id: 'msg_1', model: req.model, stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: REPLY }], usage: { input_tokens: 2_100, output_tokens: 120 }, _request_id: 'req_1' } },
    }
    const lines: string[] = []
    const r = await runCheck(api, { models: MODELS, maxTokens: 2_048, effort: 'low', timeoutMs: 60_000 }, (l) => lines.push(l))
    expect(sent.map((x) => [x.model, x.max_tokens, x.output_config?.effort, x.output_config?.format])).toEqual([
      ['claude-opus-5-5', 2_048, 'low', { type: 'json_schema', schema: API_SCHEMA }],
      ['claude-sonnet-5-5', 2_048, 'low', { type: 'json_schema', schema: API_SCHEMA }],
    ])
    expect(r.ok).toBe(true)
    expect(r.results.map((x) => [x.model, x.outcome])).toEqual([['claude-fable-5-2', 'not listed'], ['claude-opus-5-5', 'answered'], ['claude-sonnet-5-5', 'answered']])
    expect(r.totalMicros).toBe(2_100 * 4 + 120 * 20 + 2_100 * 2 + 120 * 10)
    const text = lines.join('\n')
    expect(text).toMatch(/claude-fable-5-2: NOT listed: Ask will not use it/)
    expect(text).toMatch(/claude-opus-5-5: answered by claude-opus-5-5 in \d+ ms; stop reason end_turn; the reply parsed against QED's schema; input 2100 tokens \(QED estimated \d+\), output 120; cost US\$0\.0108; request id req_1\./)
    expect(text).toMatch(/Total: US\$0\.0162 for 2 requests/)
  })
  it('a failure is printed with its kind and status, and the run is not ok; nothing in the output carries the credential', async () => {
    const key = 'sk-ant-api03-PLACEHOLDER-for-the-test-0123456789'
    const api: ModelApi = {
      listModels: async () => MODELS,
      create: async (req) => { if (req.model === 'claude-fable-5-2') throw Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: `Overloaded (key ${key} echoed by a careless proxy)` } }, undefined, new Headers()); return { id: 'm', model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer": 1}' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    }
    const lines: string[] = []
    const clean = redactor({ ANTHROPIC_API_KEY: key })
    const r = await runCheck(api, { models: MODELS, maxTokens: 2_048, effort: 'low', timeoutMs: 60_000 }, (l) => lines.push(clean(l)))
    expect(r.ok).toBe(false)
    const text = lines.join('\n')
    expect(text).toMatch(/claude-fable-5-2: no answer: overloaded \(HTTP 529, overloaded_error\)/)
    expect(text).toMatch(/claude-opus-5-5: .*the reply did NOT parse against QED's schema/)
    expect(text).not.toContain(key)
    expect(text).not.toMatch(/sk-ant-/)
    expect(text).toContain('[credential]')
  })
  it('when the model list cannot be read, nothing is asked', async () => {
    let asked = 0
    const api: ModelApi = { listModels: async () => { throw Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers()) }, create: async () => { asked++; throw new Error('not reached') } }
    const lines: string[] = []
    const r = await runCheck(api, { models: MODELS, maxTokens: 2_048, effort: 'low', timeoutMs: 60_000 }, (l) => lines.push(l))
    expect([r.ok, asked]).toEqual([false, 0])
    expect(lines.join('\n')).toMatch(/GET \/v1\/models failed: auth \(HTTP 401\)/)
  })
})
