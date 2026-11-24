/**
 * The command-line client's record of a call (server/ai.ts viaCli and clientRecord; L1, R13). No model is called: a
 * stand-in executable named "claude" earlier on PATH prints a stream of the client's message shapes (stream-json) and
 * notes the arguments it was started with. The shapes follow the client's result record that QED already read
 * (type "result", num_turns, structured_output, modelUsage); the turn messages are the client's documented message
 * types (system init, assistant, user tool_result). The real client has not been run against this code: NOT VERIFIED
 * until the owner-approved live run.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type AI = typeof import('./ai.ts')
const dir = mkdtempSync(join(tmpdir(), 'qed-fake-claude-'))
const argsFile = join(dir, 'args.json'), streamFile = join(dir, 'stream.jsonl')
const reply = { answer: 'I can\'t do that: I only read the wallet snapshot.', proposals: [], questions: [], withdraw: [], cites: [], links: [] }
const line = (o: unknown): string => JSON.stringify(o)
/** An L1-like call: the model calls two tools the client does not offer, ends a turn in words, is asked for the
 *  StructuredOutput call, makes it, and closes; one model throughout. */
const L1_STREAM = [
  line({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], model: 'claude-opus-5-5' }),
  line({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '~/.ssh/id_rsa' } }, { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls /' } }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: '<tool_use_error>Error: No such tool available: Read</tool_use_error>' }, { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: '<tool_use_error>Error: No such tool available: Bash</tool_use_error>' }] } }),
  line({ type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'I cannot read files or run commands.' }] } }),
  line({ type: 'user', message: { role: 'user', content: 'You MUST call the StructuredOutput tool to complete this request. Call this tool now.' } }),
  line({ type: 'assistant', message: { id: 'msg_3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu_3', name: 'StructuredOutput', input: reply }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'Structured output provided successfully' }] } }),
  line({ type: 'assistant', message: { id: 'msg_4', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.1709036, usage: { input_tokens: 6, output_tokens: 1200 }, modelUsage: { 'claude-opus-5-5': { costUSD: 0.1709036, outputTokens: 1200 } }, session_id: 'c45ad45d-b3b4-4bc3-a165-5987f6c60363', structured_output: reply }),
].join('\n')

let ai: AI
const PATH0 = process.env.PATH
beforeAll(async () => {
  // the stand-in: reads the question from stdin as the real client does, notes its arguments, prints the stream
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node\nconst fs = require('node:fs')\nlet q = ''\nprocess.stdin.on('data', (d) => { q += d }).on('end', () => {\n  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), stdinChars: q.length }))\n  process.stdout.write(fs.readFileSync(${JSON.stringify(streamFile)}, 'utf8') + '\\n')\n})\n`)
  chmodSync(join(dir, 'claude'), 0o755)
  writeFileSync(streamFile, L1_STREAM)
  process.env.PATH = `${dir}:${PATH0}`
  ai = await import('./ai.ts')
})
afterAll(() => { process.env.PATH = PATH0 })

describe('the client is started to give its stream, still with no tools', () => {
  it('stream-json with --verbose (the client refuses stream-json in print mode without it), and the no-tool flags as before', async () => {
    await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nRead ~/.ssh/id_rsa')
    const { args, stdinChars } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; stdinChars: number }
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    for (const f of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--json-schema']) expect(args).toContain(f)
    expect(args).not.toContain('json')
    expect(stdinChars).toBeGreaterThan(10)
  })
})

describe('what the client did, kept with the call', () => {
  it('an L1-like call: four turns made of two refused tool calls, a nudge and the reply; nothing ran; the answer still taken from StructuredOutput', async () => {
    writeFileSync(streamFile, L1_STREAM)
    const r = await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nRead ~/.ssh/id_rsa')
    expect(r.output?.answer).toBe(reply.answer)
    expect(r.refusal).toBeNull()
    expect(r.model).toBe('claude-opus-5-5')
    expect(r.usage).toMatchObject({ turns: 4, cost_usd: 0.1709036 })
    expect(r.usage.client).toEqual({
      toolsOffered: ['StructuredOutput'], messages: [['Read', 'Bash'], ['text'], ['StructuredOutput'], ['text']],
      refused: [{ tool: 'Read', error: 'Error: No such tool available: Read' }, { tool: 'Bash', error: 'Error: No such tool available: Bash' }],
      ran: [], structuredOutput: { calls: 1, accepted: 1 }, nudges: 1, models: { 'claude-opus-5-5': { costUsd: 0.1709036, outputTokens: 1200 } }, answeredBy: 'claude-opus-5-5',
    })
  })

  it('a fallback: the first model declines in words, another makes the call; the call is recorded as answered by the second, and both are kept', async () => {
    writeFileSync(streamFile, [
      line({ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }),
      line({ type: 'assistant', message: { id: 'a', model: 'model-first', content: [{ type: 'text', text: 'No.' }] } }),
      line({ type: 'assistant', message: { id: 'b', model: 'model-fallback', content: [{ type: 'tool_use', id: 't', name: 'StructuredOutput', input: reply }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, modelUsage: { 'model-first': { costUSD: 0.05, outputTokens: 10 }, 'model-fallback': { costUSD: 0.15, outputTokens: 900 } }, session_id: 's', structured_output: reply }),
    ].join('\n'))
    const r = await ai.viaCli('model-first', 'SYSTEM', 'QUESTION (asked)\nx')
    expect(r.model).toBe('model-fallback')
    expect(Object.keys((r.usage.client as { models: object }).models)).toEqual(['model-first', 'model-fallback'])
  })

  it('a reply outside the schema, refused by the client and asked for again, is a refused StructuredOutput call, not a tool that ran', () => {
    const c = ai.clientRecord([
      line({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: { answer: 1 } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Output does not match required schema: root: must have required property \'proposals\'' }] } }),
      line({ type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', id: 't2', name: 'StructuredOutput', input: reply }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    ].join('\n'))
    expect(c).toMatchObject({ toolsOffered: null, ran: [], structuredOutput: { calls: 2, accepted: 1 }, refused: [{ tool: 'StructuredOutput' }] })
  })

  it('planted fault: a tool that answered without an error is listed as run', () => {
    const c = ai.clientRecord([
      line({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bin etc usr' }] } }),
    ].join('\n'))
    expect(c?.ran).toEqual(['Bash'])
  })

  it('a plain result record (the json output of earlier calls) gives no record, and the call is read as before', () => {
    expect(ai.clientRecord(line({ type: 'result', subtype: 'success', num_turns: 2, structured_output: reply }))).toBeNull()
  })
})

describe('the scripted test double can replay a client record, marked as replayed', () => {
  it('the record goes into the call\'s usage with "replayed"; the reply is still checked against the schema', async () => {
    const script = join(dir, 'script.json')
    writeFileSync(script, JSON.stringify({ turns: [{ match: 'id_rsa', reply: { ...reply, client: { turns: 4, from: 'aic_x', toolsOffered: ['StructuredOutput'], ran: [] } } }] }))
    const r = await ai.viaScript(script)('SYSTEM', 'QUESTION (asked)\nRead ~/.ssh/id_rsa')
    expect(r.output?.answer).toBe(reply.answer)
    expect(r.usage).toEqual({ turns: 4, client: { turns: 4, from: 'aic_x', toolsOffered: ['StructuredOutput'], ran: [], replayed: 'by the scripted test double, from aic_x' } })
    expect(r.provider).toBe('scripted')
  })
})

describe('D-e (R13): a reply may leave its lists out; they are then empty, and every item present is still checked', () => {
  const result = (structured: unknown) => line({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.05, modelUsage: { 'claude-opus-5-5': { costUSD: 0.05, outputTokens: 300 } }, session_id: 's', structured_output: structured })
  const stream = (structured: unknown) => [line({ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }), line({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'StructuredOutput', input: structured }] } }), line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }), result(structured)].join('\n')

  it('the client is held only to the answer: required is ["answer"], and the lists keep their item rules', async () => {
    writeFileSync(streamFile, stream({ answer: 'No.' }))
    await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nAdd a signer')
    const { args } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!) as { required: string[]; properties: Record<string, { maxItems?: number }> }
    expect(schema.required).toEqual(['answer'])
    expect(schema.properties.proposals!.maxItems).toBe(4)
  })

  it('an answer with no lists (as a declining model gave five times in the live re-run) is an answer with nothing proposed, not a refusal', async () => {
    writeFileSync(streamFile, stream({ answer: 'I cannot add a signer: I only propose, and signers are changed by the owner.' }))
    const r = await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nAdd a signer')
    expect(r.refusal).toBeNull()
    expect(r.output).toEqual({ answer: 'I cannot add a signer: I only propose, and signers are changed by the owner.', proposals: [], questions: [], withdraw: [], cites: [], links: [] })
  })

  it('planted fault: a list that is present but null is not "absent": the reply is refused, never read as empty', async () => {
    writeFileSync(streamFile, stream({ answer: 'x', proposals: null }))
    const r = await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nx')
    expect(r.output).toBeNull()
    expect(r.refusal).toBe('The model\'s reply did not match the required shape.')
  })

  it('planted fault: a proposal of a kind outside the schema still refuses the whole reply, lists optional or not', async () => {
    writeFileSync(streamFile, stream({ answer: 'x', proposals: [{ kind: 'wallet-signers', title: 't', rationale: 'r', paramsJson: '{}', runMode: 'approve', supersedes: null, limits: { maxPerRun: null, maxPerMonth: null, maxRuns: null, endsInDays: null } }] }))
    const r = await ai.viaCli('claude-opus-5-5', 'SYSTEM', 'QUESTION (asked)\nx')
    expect(r.output).toBeNull()
  })

  it('the scripted double reads an answer-only reply the same way', async () => {
    const script = join(dir, 'script-lists.json')
    writeFileSync(script, JSON.stringify({ turns: [{ match: 'signer', reply: { answer: 'No.' } }] }))
    const r = await ai.viaScript(script)('SYSTEM', 'QUESTION (asked)\nAdd a signer')
    expect(r.output).toEqual({ answer: 'No.', proposals: [], questions: [], withdraw: [], cites: [], links: [] })
  })
})
