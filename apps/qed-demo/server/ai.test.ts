import { describe, expect, it } from 'vitest'
import { ownerFigures, storeProposal } from './ai.ts'
import { buildDraft } from './programs.ts'
import { makeKit } from './testkit.ts'

describe('figures the owner wrote', () => {
  it('reads rupee amounts however they are written, and nothing that is not money', () => {
    expect(ownerFigures('Buy 300 rupees of bitcoin every five minutes, no more than 3,000 rupees in a month').sort((a, b) => a - b)).toEqual([30_000, 300_000])
    expect(ownerFigures('invest ₹5,000 monthly, at most Rs. 60000 in all')).toEqual([500_000, 6_000_000])
    expect(ownerFigures('keep 2 lakh in the bank and park the rest; cap it at 1.5 crore')).toEqual([20_000_000, 1_500_000_000])
    expect(ownerFigures('run it every 5 minutes for 30 days, 12 times')).toEqual([])
    expect(ownerFigures('pay INR 2500.50 to the landlord')).toEqual([250_050])
  })
})

describe('a proposal must not lose a limit the owner stated', () => {
  // Found live on 20 Nov 2026: "no more than 3,000 rupees in a month" came back as a draft with a ceiling of over a crore.
  const ask = 'Buy 300 rupees of bitcoin every five minutes, and ask me before each purchase. No more than 3,000 rupees in a month.'
  const params = { instrumentId: 'coindcx:BTCINR', amount: 30_000, schedule: { type: 'every', minutes: 5 } }

  it('carries the stated monthly limit into the draft, and so into the document that is signed', () => {
    const k = makeKit(); k.btc(6_600_000)
    const p = storeProposal(k.ctx, k.userId, null, 'model', 'invest', 'Invest', 'why', params, 'approve', k.clock.now(), { maxPerMonth: 300_000 }, ownerFigures(ask))
    expect(p.state).toBe('new')
    expect(p.authority).toEqual({ maxPerMonth: 300_000 })
    expect((p.analysis as { warnings: string[] }).warnings.join(' ')).not.toMatch(/does not use/)
    const d = buildDraft(k.ctx, k.userId, 'invest', p.params, { ...p.authority, runMode: 'approve' }, k.clock.now())
    expect(d.authority.maxPerMonth).toBe(300_000)
    expect(d.doc.limits.join(' ')).toMatch(/₹3,000 in one calendar month/)
  })

  it('says so first when a figure the owner wrote is missing from the proposal', () => {
    const k = makeKit(); k.btc(6_600_000)
    const p = storeProposal(k.ctx, k.userId, null, 'model', 'invest', 'Invest', 'why', params, 'approve', k.clock.now(), {}, ownerFigures(ask))
    expect((p.analysis as { warnings: string[] }).warnings[0]).toMatch(/You wrote ₹3,000, and this proposal does not use that figure/)
  })

  it('does not complain about a proposal that uses none of the figures: it answers something else', () => {
    const k = makeKit(); k.btc(6_600_000)
    const p = storeProposal(k.ctx, k.userId, null, 'model', 'floor', 'Hold the floor', 'why', { buffer: 0 }, 'auto', k.clock.now(), {}, ownerFigures(ask))
    expect((p.analysis as { warnings: string[] }).warnings.join(' ')).not.toMatch(/You wrote/)
  })

  it('a limit that contradicts the plan makes the proposal invalid rather than quietly adjusted', () => {
    const k = makeKit(); k.btc(6_600_000)
    const p = storeProposal(k.ctx, k.userId, null, 'model', 'invest', 'Invest', 'why', params, 'approve', k.clock.now(), { maxPerMonth: 10_000 }, [])
    expect(p.state).toBe('invalid')
    expect(p.invalidReason).toMatch(/monthly limit cannot be smaller/)
  })
})

describe('default limits', () => {
  it('the default monthly limit for a frequent schedule is what the household can spare, not what the schedule could consume', () => {
    const k = makeKit(); k.btc(6_600_000)
    const d = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 30_000, schedule: { type: 'every', minutes: 5 } }, undefined, k.clock.now())
    const consumed = Math.ceil((30 * 24 * 60 / 5) * 30_000) // ₹25,92,000 a month
    expect(d.authority.maxPerMonth).toBeLessThan(consumed / 10)
    expect(d.authority.maxPerMonth).toBeGreaterThanOrEqual(30_000)
    expect(d.analysis.warnings.join(' ')).toMatch(/monthly limit is/)
  })
  it('a monthly purchase the household can afford keeps a limit of one purchase a month', () => {
    const k = makeKit(); k.btc(6_600_000)
    const d = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 500_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }, undefined, k.clock.now())
    expect(d.authority.maxPerMonth).toBe(500_000)
  })
})
