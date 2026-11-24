/**
 * Eligibility (R7-057; R13 section 6): each instrument and route states the jurisdictions it is offered in, where it is
 * based and how it is integrated; anything else is refused with the reason, which names what real money would need there
 * in the jurisdiction research's own words (server/legal.ts).
 */
import { describe, expect, it } from 'vitest'
import { assertOffered, FX_DESK_OFFER, instrumentOffer, JURISDICTION_NAMES } from './eligibility.ts'
import { prepareConversion } from './fx.ts'
import { previewAction } from './owner.ts'
import { INSTRUMENTS } from './registry.ts'
import { makeKit } from './testkit.ts'

describe('where each thing QED offers is offered', () => {
  it('every instrument states its jurisdiction, where it is offered, and its integration with what that depends on', () => {
    for (const i of INSTRUMENTS) {
      const o = instrumentOffer(i)
      expect(o.offeredIn.length, i.id).toBeGreaterThan(0)
      expect(Object.keys(JURISDICTION_NAMES)).toEqual(expect.arrayContaining([...o.offeredIn, o.basedIn]))
      expect(['paper', 'reference-only']).toContain(o.integration.status)
      expect(o.integration.dependency.length, i.id).toBeGreaterThan(20)
      if (i.tradable) expect(o.offeredIn, i.id).toEqual(['IN'])
    }
    expect(FX_DESK_OFFER).toMatchObject({ capability: 'C4', offeredIn: ['IN'], basedIn: 'IN', integration: { status: 'paper' } })
  })

  it('refuses anywhere else with the reason, in the jurisdiction research\'s own words', () => {
    expect(() => assertOffered(FX_DESK_OFFER, 'IN')).not.toThrow()
    try { assertOffered(FX_DESK_OFFER, 'US'); expect.unreachable() } catch (e) {
      expect(e).toMatchObject({ status: 403, code: 'not_offered_here' })
      const m = (e as Error).message
      expect(m).toMatch(/only to households in India/)
      expect(m).toMatch(/United States/)
      expect(m).toMatch(/licensed partner/) // C4 in the US: verdict P in the research
    }
  })

  it('a household that lives elsewhere is refused a conversion and a fund purchase, with the reason, and nothing moves', async () => {
    const k = makeKit({ start: Date.parse('2026-11-20T05:00:00Z'), profile: { jurisdiction: 'UK' } })
    expect(() => prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'USD', amount: '10.00', fixed: 'buy' })).toThrow(expect.objectContaining({ code: 'not_offered_here' }))
    k.nav('amfi:120716', '2026-11-19', '150.0000')
    await expect(previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 500_000 })).rejects.toMatchObject({ code: 'not_offered_here' })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals')!.n).toBe(0)
  })
})
