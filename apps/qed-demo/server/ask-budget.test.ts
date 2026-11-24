/**
 * What the model may cost is bounded per workspace per day and per month (N-012), besides 30 questions an hour per
 * person: a question beyond the workspace's daily budget is refused before any model is called, and says why.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ask, viaScript } from './ai.ts'
import { loadConfig } from './core.ts'
import { makeKit } from './testkit.ts'

const REPLIES = join(import.meta.dirname, '..', 'evidence', '20261122-judge-journey', 'scripted-double-replies.json')
const Q = 'Buy ₹500 of Bitcoin for me every minute, at most 2 times, and never more than ₹1,000 this month.'

describe('the model budget per workspace (N-012)', () => {
  afterEach(() => { delete process.env.QED_ASK_DAILY; delete process.env.QED_ASK_MONTHLY })

  it('a question beyond the daily budget is refused before the model is called, with the reason', async () => {
    process.env.QED_ASK_DAILY = '2'
    const k = makeKit(); k.btc(6_600_000)
    let calls = 0
    const script = viaScript(REPLIES)
    const counted: typeof script = async (...a) => { calls++; return script(...a) }
    for (let i = 0; i < 2; i++) await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, counted)
    expect(calls).toBe(2)
    await expect(ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, counted)).rejects.toMatchObject({ code: 'budget_day', message: expect.stringMatching(/2 questions today, its limit/) })
    expect(calls).toBe(2)
    // a day later the budget starts again
    k.clock.advance(86_400_000 + 1000)
    await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, counted)
    expect(calls).toBe(3)
  })

  it('the monthly budget holds across days', async () => {
    process.env.QED_ASK_MONTHLY = '2'
    const k = makeKit(); k.btc(6_600_000)
    const script = viaScript(REPLIES)
    await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, script)
    k.clock.advance(2 * 86_400_000)
    await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, script)
    k.clock.advance(2 * 86_400_000)
    await expect(ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, script)).rejects.toMatchObject({ code: 'budget_month' })
  })
})

// The R13 security review's lead L-07 (docs/SECURITY-REVIEW-R13.md section 4); scripts/security.ts runs this by its check
// id and records it as one of its checks.
describe('R13 lead checks: the model, for everyone together', () => {
  afterEach(() => { delete process.env.QED_ASK_ALL_HOURLY; delete process.env.QED_ASK_CONCURRENT })

  it('R20 (L-07): questions from many workspaces are bounded together: at most QED_ASK_CONCURRENT model calls at once (the next is refused, not queued), and at most QED_ASK_ALL_HOURLY in an hour', async () => {
    process.env.QED_ASK_CONCURRENT = '2'
    const kits = [makeKit(), makeKit(), makeKit()]
    for (const k of kits) k.btc(6_600_000)
    const script = viaScript(REPLIES)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let running = 0, most = 0
    const held: typeof script = async (...a) => { running++; most = Math.max(most, running); await gate; running--; return script(...a) }
    const all = kits.map((k) => ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, held).then(() => 'answered', (e: { code?: string }) => String(e.code)))
    await new Promise((r) => setTimeout(r, 50))
    release()
    expect((await Promise.all(all)).sort()).toEqual(['answered', 'answered', 'busy'])
    expect(most).toBe(2)
    // the hour's ceiling for the whole installation
    process.env.QED_ASK_ALL_HOURLY = '2'
    const k = makeKit(); k.btc(6_600_000)
    for (let i = 0; i < 2; i++) await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, script)
    await expect(ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: Q }, script)).rejects.toMatchObject({ code: 'busy' })
  })
})
