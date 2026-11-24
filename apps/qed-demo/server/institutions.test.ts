/**
 * The institution side, SIMULATED (N-015, N-016, N-020, N-021; N-004 on the paper side). Real institutions are EXT-14 and stay
 * external: nothing here connects to one, and every record that is not a real bank's says it is a simulation.
 */
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { clearOutboundRequests, identityFor, institutionDoor, outboundRequests, QED_CLIENT_ID, withAgentIdentity } from './agent-identity.ts'
import { LocalPaperBank, setPaperBank } from './bank-mandates.ts'
import { assertNoWider, CHANNELS, type ChannelTerms, channelTermsOf, DATA_SCOPES, derive, PAPER_CEILINGS, remainingCapacity, type Signed } from './channel-terms.ts'
import { AppError, type Db, FakeClock, openDb } from './core.ts'
import { saveProfile } from './household.ts'
import { assertConnectable, connectable, connectionSummary, INSTITUTION_TERMS, STALE_AFTER_DAYS, staleRecords, termsOf } from './institution-terms.ts'
import { entitlementFor, entitlementRecord, institutionsView, setUpInstitution, setupsOf, UCC_4A } from './institution-setup.ts'
import { Market } from './market.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { makeKit, T0 } from './testkit.ts'
import { buildVenues } from './venues.ts'
import { addMember, createBusiness, ROLES, type Role } from './workspaces.ts'

const DAY = 86_400_000
const code = (fn: () => unknown): string | undefined => { try { fn() } catch (e) { return e instanceof AppError ? e.code : String(e) } return undefined }

describe('N-015: the terms registry', () => {
  it('has a record, with URL, version and the date read, for every connector QED has', () => {
    const k = makeKit()
    const venues = buildVenues(k.db, new Market(k.db, k.clock), k.clock)
    const connectors = [venues.crypto, venues.funds, venues.rail, venues.exchange!, venues.debt!].map((v) => (v as unknown as { name: string }).name).concat('paper-fx-desk')
    const missing = connectors.filter((n) => !termsOf(n))
    expect(missing).toEqual([])
    for (const t of INSTITUTION_TERMS) {
      expect(t.termsUrl, t.id).toBeTruthy(); expect(t.termsVersion, t.id).toBeTruthy(); expect(t.readOn, t.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(t.effectiveDate, t.id).toMatch(/^\d{4}-\d{2}(-\d{2})?$/); expect(t.revocationChannel, t.id).toBeTruthy(); expect(t.agentPolicyText, t.id).toBeTruthy()
    }
  })

  it('fails on a stale record: none is stale on the day the terms were read, all are once the allowance has passed', () => {
    expect(staleRecords('2026-11-24')).toEqual([])
    expect(staleRecords('2027-06-01').length).toBe(INSTITUTION_TERMS.length)
    const edge = new Date(Date.parse('2026-11-23T00:00:00Z') + STALE_AFTER_DAYS * DAY).toISOString().slice(0, 10)
    expect(staleRecords(edge).map((t) => t.id)).not.toContain('wells-fargo')
  })

  it('is seeded with the five real banks as read, and every other record is labelled simulated', () => {
    expect(termsOf('wells-fargo')).toMatchObject({ effectiveDate: '2026-11-24', agentPolicy: 'credentials-only', simulated: false, registration: 'not-registered' })
    expect(termsOf('citi')).toMatchObject({ effectiveDate: '2026-11' })
    expect(termsOf('chase')).toBeTruthy()
    expect(termsOf('bank-of-america')).toMatchObject({ effectiveDate: '2026-10-19' })
    expect(termsOf('capital-one')).toMatchObject({ effectiveDate: '2025-12-02' })
    for (const t of INSTITUTION_TERMS.filter((x) => x.simulated)) { expect(t.agentPolicyText).toMatch(/^Simulated/); expect(t.registration).toBe('simulation') }
  })

  it('makes no connection where agent access is only through credentials, nor to a real institution; shows its summary first', () => {
    for (const id of ['wells-fargo', 'citi', 'chase', 'bank-of-america', 'capital-one']) { expect(connectable(termsOf(id)!).ok, id).toBe(false); expect(code(() => assertConnectable(id)), id).toBe('no_connection') }
    expect(connectable(termsOf('wells-fargo')!).reason).toContain('never asks for, holds or uses a bank password')
    expect(assertConnectable('paper-rail').id).toBe('paper-rail')
    expect(code(() => assertConnectable('nowhere'))).toBe('unknown_institution')
    const s = connectionSummary(termsOf('paper-rail')!)
    expect(s.lines.map((l) => l.label)).toEqual(['Kind', 'Terms', 'Agent policy', 'Channel', 'Revocation', 'QED\'s registration'])
    expect(s.lines[0]!.value).toContain('Simulated')
  })
})

describe('N-016 and N-004: channel parameters are never wider than the signed instruction', () => {
  const signed = fc.record({
    maxPerRun: fc.integer({ min: 100, max: 200_000_000 }), maxPerMonth: fc.integer({ min: 100, max: 900_000_000 }), expiresAt: fc.integer({ min: T0 + DAY, max: T0 + 900 * DAY }),
    scope: fc.uniqueArray(fc.constantFrom('a@upi', 'b@upi', 'c@upi', 'balances', 'transactions', 'payments'), { minLength: 1, maxLength: 4 }),
  })

  it('property: for every channel, derived terms are within the instruction on payment maximum, period limit, expiry and scope', () => {
    fc.assert(fc.property(fc.constantFrom(...CHANNELS), signed, (ch, s) => {
      const t = derive(ch, s, T0)
      assertNoWider(t, s) // would throw
      if (ch !== 'data-consent') { expect(t.perPayment!).toBeLessThanOrEqual(s.maxPerRun); expect(t.perMonth!).toBeLessThanOrEqual(s.maxPerMonth); expect(t.perPayment!).toBeLessThanOrEqual(PAPER_CEILINGS[ch].perPayment!) }
      else { expect(t.perPayment).toBeNull(); expect(t.scope.every((x) => DATA_SCOPES.includes(x))).toBe(true) }
      expect(t.expiresAt).toBeLessThanOrEqual(s.expiresAt)
      expect(t.expiresAt).toBeLessThanOrEqual(T0 + PAPER_CEILINGS[ch].days * DAY)
      expect(t.scope.every((x) => (ch === 'data-consent' ? DATA_SCOPES : s.scope).includes(x))).toBe(true)
    }), { numRuns: 300, seed: 7 })
  })

  it('property: any widening of any derived term is refused', () => {
    fc.assert(fc.property(fc.constantFrom('e-mandate', 'vrp-consent') as fc.Arbitrary<'e-mandate' | 'vrp-consent'>, signed.filter((s) => s.scope.some((x) => x.endsWith('@upi'))).map((s) => ({ ...s, scope: s.scope.filter((x) => x.endsWith('@upi')) })), fc.constantFrom('perPayment', 'perMonth', 'expiresAt', 'scope'), (ch, s, field) => {
      const t: ChannelTerms = derive(ch, s, T0)
      const wide: ChannelTerms = field === 'scope' ? { ...t, scope: [...t.scope, 'evil@upi'] } : { ...t, [field]: { perPayment: s.maxPerRun, perMonth: s.maxPerMonth, expiresAt: s.expiresAt }[field as 'perPayment' | 'perMonth' | 'expiresAt'] + 1 }
      expect(code(() => assertNoWider(wide, s))).toBe('channel_wider')
    }), { numRuns: 200, seed: 11 })
  })

  it('a data consent never carries a payment scope or limit', () => {
    const t = derive('data-consent', { maxPerRun: 1, maxPerMonth: 1, expiresAt: T0 + DAY, scope: ['balances', 'payments'] }, T0)
    expect(t).toMatchObject({ perPayment: null, perMonth: null, scope: ['balances'] })
    expect(code(() => assertNoWider({ ...t, scope: ['balances', 'payments'] }, { maxPerRun: 1, maxPerMonth: 1, expiresAt: T0 + DAY, scope: ['balances', 'payments'] }))).toBe('channel_wider')
  })

  it('remaining capacity is the period limit less what is used, never below zero', () => {
    const t = derive('e-mandate', { maxPerRun: 300_000, maxPerMonth: 1_000_000, expiresAt: T0 + DAY, scope: ['a@upi'] }, T0)
    expect([remainingCapacity(t, 0), remainingCapacity(t, 400_000), remainingCapacity(t, 2_000_000)]).toEqual([1_000_000, 600_000, 0])
    expect(remainingCapacity(derive('data-consent', { maxPerRun: 1, maxPerMonth: 1, expiresAt: T0 + DAY, scope: [] }, T0), 5)).toBeNull()
  })

  afterEach(() => { setPaperBank(new LocalPaperBank()) })
  it('a mandate is created from the signed instruction, never wider, and recorded; the bank refuses terms above its own ceilings', () => {
    const k = makeKit()
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_power', k.userId, 'City Power', 'power@upi', 'utility', k.clock.now(), k.clock.now())
    const expiresAt = k.clock.now() + 30 * DAY
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    const [m] = channelTermsOf(k.db, k.userId, d.programId)
    expect(m).toMatchObject({ channel: 'e-mandate', institution: 'paper-rail', simulated: true, perPayment: 300_000, perMonth: 1_000_000, expiresAt, scope: ['power@upi'], reference: expect.stringMatching(/^PB-MANDATE-/) })
    const wide = derive('e-mandate', { maxPerRun: 300_000, maxPerMonth: 1_000_000, expiresAt, scope: ['power@upi'] }, k.clock.now())
    expect(code(() => new LocalPaperBank().register('pmd_x', { ...wide, perPayment: PAPER_CEILINGS['e-mandate'].perPayment! + 1 }))).toBe('bank_ceiling')
  })
})

function business(db: Db, roles: Role[]) {
  const mk = (h: string) => { const id = `usr_${h}`; db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, h, h, T0); return id }
  const owner = mk('owner')
  const ws = createBusiness(db, owner, 'Asha Traders', T0)
  roles.forEach((r, i) => { mk(`m${i}`); addMember(db, ws, { personId: owner, role: 'owner' }, `m${i}`, r, T0) })
  return { ws, owner, asker: { workspaceId: ws, personId: owner, role: 'owner' as Role } }
}

describe('N-020: a business\'s bank entitlements and the Article 4A disclosure', () => {
  const shown = termsOf('paper-rail')!.termsVersion
  const setup = (db: Db, asker: { workspaceId: string; personId: string; role: Role }, extra: Record<string, unknown> = {}) => setUpInstitution(db, asker, { institution: 'paper-rail', termsVersion: shown, ...extra }, T0)

  it('maps each workspace role to a bank entitlement, never more than the role has', () => {
    expect(ROLES.map((r) => entitlementFor(r).bankRole)).toEqual(['company administrator', 'user administrator', 'approver', 'initiator', 'view only'])
    expect(entitlementFor('viewer')).toMatchObject({ canInitiate: false, canApprove: false, canAdministerUsers: false })
    expect(entitlementFor('operator')).toMatchObject({ canInitiate: true, canApprove: false })
    expect(entitlementFor('approver')).toMatchObject({ canInitiate: false, canApprove: true })
  })

  it('refuses a business set-up with no dual control: the owner alone both starts and approves, which is one person', () => {
    const db = openDb(':memory:'), { asker } = business(db, ['viewer'])
    expect(entitlementRecord(db, asker.workspaceId)).toMatchObject({ kind: 'business', dualControl: false })
    expect(code(() => setup(db, asker))).toBe('entitlement_missing')
    expect(setupsOf(db, asker.workspaceId)).toEqual([])
  })

  it('allows it once a different person can approve, and records the entitlements mapped from the roles', () => {
    const db = openDb(':memory:'), { asker } = business(db, ['approver', 'operator'])
    const s = setup(db, asker)
    expect(s).toMatchObject({ institution: 'paper-rail', termsVersion: shown, disclosure: null, entitlement: { dualControl: true } })
    expect(s.entitlement.members.map((m) => m.bankRole).sort()).toEqual(['approver', 'company administrator', 'initiator'])
    expect(db.get('SELECT 1 FROM audit WHERE action = ?', 'institution.setup')).toBeTruthy()
    expect(code(() => setup(db, asker))).toBe('already_set_up')
  })

  it('a US business workspace must acknowledge the Article 4A disclosure; one elsewhere is not asked', () => {
    const us = openDb(':memory:'), a = business(us, ['approver'])
    saveProfile(us, a.ws, { jurisdiction: 'US' })
    const view = institutionsView(us, a.ws, INSTITUTION_TERMS.filter((t) => t.simulated))
    expect(view.disclosure).toMatchObject({ version: UCC_4A.version })
    expect(UCC_4A.text).toContain('the risk stays with your business')
    expect(code(() => setup(us, a.asker))).toBe('disclosure_required')
    expect(code(() => setup(us, a.asker, { disclosureAcknowledged: 'yes' }))).toBe('disclosure_required')
    expect(setup(us, a.asker, { disclosureAcknowledged: true }).disclosure).toMatchObject({ version: UCC_4A.version, acknowledgedAt: T0 })
    const india = openDb(':memory:'), b = business(india, ['approver'])
    expect(institutionsView(india, b.ws, []).disclosure).toBeNull()
    expect(setup(india, b.asker).disclosure).toBeNull()
  })

  it('a personal workspace needs no dual control; only an owner or admin sets up; stale terms and real banks are refused', () => {
    const db = openDb(':memory:')
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_p', 'p', 'p', '!', ?, 'person')`, T0)
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES ('usr_p', 'usr_p', 'owner', ?, 'usr_p')`, T0)
    const me = { workspaceId: 'usr_p', personId: 'usr_p', role: 'owner' as Role }
    expect(code(() => setup(db, { ...me, role: 'operator' }))).toBe('not_permitted')
    expect(code(() => setUpInstitution(db, me, { institution: 'paper-rail', termsVersion: 'qed-simulation-v0' }, T0))).toBe('terms_changed')
    expect(code(() => setUpInstitution(db, me, { institution: 'wells-fargo', termsVersion: termsOf('wells-fargo')!.termsVersion }, T0))).toBe('no_connection')
    expect(setup(db, me).entitlement.kind).toBe('person')
  })
})

describe('N-021: an agent identity on every request to an institution', () => {
  it('every call to every simulated institution carries QED\'s agent identity, as a software agent that never presents as a person', () => {
    clearOutboundRequests()
    const k = makeKit()
    const v = buildVenues(k.db, new Market(k.db, k.clock), k.clock)
    v.rail.get('x'); v.rail.chooseRail(1000n, 'ravi.kumar@upi'); v.crypto.get('y'); v.funds.get('z'); v.exchange!.get('q'); v.debt!.get('r')
    const reqs = outboundRequests()
    expect(new Set(reqs.map((r) => r.institution))).toEqual(new Set(['paper-rail', 'paper-crypto', 'paper-mf', 'paper-exchange', 'paper-gsec']))
    expect(reqs.length).toBeGreaterThanOrEqual(6)
    for (const r of reqs) expect(r.identity, `${r.institution}.${r.operation}`).toMatchObject({ clientId: QED_CLIENT_ID, kind: 'software-agent', presentsAsPerson: false, registration: 'simulation' })
  })

  it('the institution refuses a request without the identity or one presenting as a person, and the wrapper cannot send one', () => {
    const base = { institution: 'paper-rail', operation: 'submit', at: 0, via: 'agent-api' as const }
    expect(code(() => institutionDoor({ ...base, identity: null }))).toBe('agent_identity_missing')
    expect(code(() => institutionDoor({ ...base, identity: { ...identityFor('w'), presentsAsPerson: true as unknown as false } }))).toBe('agent_identity_missing')
    expect(code(() => institutionDoor({ ...base, identity: identityFor('w') }))).toBeUndefined()
    clearOutboundRequests()
    const wrapped = withAgentIdentity('paper-rail', { submit: (n: number) => n + 1, rate: 3 }, () => 5)
    expect(wrapped.submit(1)).toBe(2); expect(wrapped.rate).toBe(3)
    expect(outboundRequests()).toHaveLength(1)
    expect(outboundRequests()[0]).toMatchObject({ operation: 'submit', at: 5, identity: { clientId: QED_CLIENT_ID } })
  })

  it('no connector uses a browser session: the identity is the only credential, and no connector module reads a cookie or a session', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['agent-identity.ts', 'institution-terms.ts', 'channel-terms.ts', 'institution-setup.ts', 'bank-mandates.ts']) expect(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), f).not.toMatch(/cookie|session_id|sessionId|req\.headers/i)
  })
})
