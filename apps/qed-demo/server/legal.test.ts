/**
 * Register N-022: a capability is offered with real money in a jurisdiction only with a recorded partner agreement or
 * licence. Driven by the jurisdiction research's own data (server/legal.ts).
 */
import { describe, expect, it } from 'vitest'
import { type Agreement, assertRealMoney, legalView, LEGAL_JURISDICTIONS, loadAgreements, loadMatrix, routeOf } from './legal.ts'

const m = loadMatrix()
const columns = [...LEGAL_JURISDICTIONS, 'GL']

describe('the real-money gate (N-022)', () => {
  it('refuses every capability in every jurisdiction while no agreement is recorded, naming what is missing in the words of the research', () => {
    let refused = 0
    for (const cap of m.capabilities) for (const j of columns) {
      const cell = cap.cells[j]!
      let message = ''
      try { assertRealMoney(cap.id, j, m, []) } catch (e) { message = (e as Error).message; expect((e as { code: string }).code).toBe('no_legal_route') }
      expect(message, `${cap.id} ${j}`).not.toBe('')
      refused++
      const v = cell.verdict.split(',').map((x) => x.trim())
      if (cell.verdict.trim() === 'build') expect(message).toContain('Architecture only')
      else if (v.includes('X')) expect(message).toContain('Not offered by QED\'s design')
      else {
        if (v.includes('P')) expect(message, `${cap.id} ${j} names its partner model`).toContain(cell.partner_model)
        if (v.includes('L') || v.includes('C')) expect(message, `${cap.id} ${j} names the licence`).toContain(cell.licence)
      }
      expect(message).toContain('only with practice money')
    }
    expect(refused).toBe(m.capabilities.length * columns.length)
    expect(refused).toBe(77)
  })

  it('opens exactly the pair a recorded agreement covers, and only where the research says a route of that kind exists', () => {
    const p = m.capabilities.find((c) => c.cells.IN!.verdict.split(',').map((x) => x.trim()).includes('P'))!
    const partner: Agreement = { capability: p.id, jurisdiction: 'IN', kind: 'partner', holder: 'A licensed partner (test fixture)', reference: 'TEST-1', from: '2026-01-01T00:00:00Z' }
    expect(assertRealMoney(p.id, 'IN', m, [partner]).open).toBe(true)
    for (const j of LEGAL_JURISDICTIONS.filter((x) => x !== 'IN')) expect(routeOf(m, [partner], p.id, j).open, j).toBe(false)
    for (const c of m.capabilities.filter((c) => c.id !== p.id)) expect(routeOf(m, [partner], c.id, 'IN').open, c.id).toBe(false)
    // a partner agreement cannot open what QED's design does not offer
    const x = m.capabilities.flatMap((c) => columns.map((j) => ({ c, j }))).find(({ c, j }) => c.cells[j]!.verdict.trim() === 'X')!
    expect(routeOf(m, [{ ...partner, capability: x.c.id, jurisdiction: x.j }], x.c.id, x.j).open).toBe(false)
  })

  it('an agreement opens its pair only while it is in force', () => {
    const p = m.capabilities.find((c) => c.cells.IN!.verdict.split(',').map((x) => x.trim()).includes('P'))!
    const at = Date.parse('2026-11-24T00:00:00Z')
    const later: Agreement = { capability: p.id, jurisdiction: 'IN', kind: 'partner', holder: 'test', reference: 'T', from: '2027-01-01T00:00:00Z' }
    const ended: Agreement = { ...later, from: '2025-01-01T00:00:00Z', until: '2026-06-01T00:00:00Z' }
    expect(routeOf(m, [later], p.id, 'IN', at).open).toBe(false)
    expect(routeOf(m, [ended], p.id, 'IN', at).open).toBe(false)
    expect(routeOf(m, [{ ...ended, until: '2027-06-01T00:00:00Z' }], p.id, 'IN', at).open).toBe(true)
  })

  it('the readiness view says nothing is open today, and no agreement file is part of this build', () => {
    expect(loadAgreements()).toEqual([])
    const v = legalView(m, [])
    expect(v.open).toBe(0)
    expect(v.pairs).toBe(m.capabilities.length * LEGAL_JURISDICTIONS.length)
    expect(v.researched).toBe('2026-11-23')
  })
})
