import { describe, expect, it } from 'vitest'
import { isOpen, parseRisks, readiness, severityOf } from './readiness.ts'

const HEAD = ['| ID | Risk | Sev | Status | Control | Source |', '|---|---|---|---|---|---|']

/** The parts of the view these tests read. */
interface Reason { id: string; says: string; severity: string; standing: string }
interface AreaView { id: string; title: string; reasons: Reason[] }
interface View {
  ready: boolean; verdict: string; because: string
  blockers: { kind: string; id: string; title: string; detail: string; severity: string; area?: string }[]
  build: { revision: string | null }; release: { id: string | null }
  risks: { open: Record<string, number>; operations: number; undescribed: number; areas: AreaView[]; lower: AreaView[] } | null
  requirements: { total: number; met: number; partly: number; notMet: number; blocked: number; operations: number }
}
const view = (sources: Parameters<typeof readiness>[0]) => readiness(sources) as unknown as View
const reasons = (areas: AreaView[]) => areas.flatMap((a) => a.reasons.map((r) => ({ area: a.title, ...r })))

describe('readiness: what this build is, and why it is not ready for real money (R7-088, R7-098)', () => {
  it('reads each risk at its latest standing: an update row replaces severity and status, the title stays the original', () => {
    const md = [...HEAD,
      '| RISK-001 | A key not revoked | High | Accepted by owner 23 Oct | Revoke | R2 |',
      '| RISK-002 | Drift between source and release | Medium | Open | Decide | R2 |',
      '| RISK-003 | Unlocated citations | High (time-bound) | Open | Locate | R2 |',
      '| RISK-003 (update, 20 Nov) | Citations located | Low | Closed 20 Nov: every citation found | — | R6 |',
      '| RISK-004 | Owner key held by the service | High for any real-money path | Open | Passkey account | R6 |',
      '| RISK-004 (update, 22 Nov) | — | High | Partly mitigated: owners\' vaults only | — | R7 |',
      '| RISK-005 | Shared docs overwritten | Med | Mitigated 17 Nov | Lock | Setup |',
    ].join('\n')
    const risks = parseRisks(md)
    expect(risks.map((r) => r.id)).toEqual(['RISK-001', 'RISK-002', 'RISK-003', 'RISK-004', 'RISK-005'])
    expect(risks.find((r) => r.id === 'RISK-003')).toMatchObject({ title: 'Unlocated citations', severity: 'Low', open: false, updated: true })
    expect(risks.find((r) => r.id === 'RISK-004')).toMatchObject({ title: 'Owner key held by the service', severity: 'High', open: true })
    expect(risks.find((r) => r.id === 'RISK-001')).toMatchObject({ severity: 'High', open: true })
    expect(risks.find((r) => r.id === 'RISK-005')).toMatchObject({ severity: 'Medium', open: false })
  })

  it('reads an update written in the title cell, and an update with no severity or a wording note keeps the standing before it', () => {
    const md = [...HEAD,
      '| RISK-015 | Floor guarantee overstated | High | Open | Calibrate | doc 03 |',
      '| RISK-015 (update) | Wording: "unconditional" now reads "market-independent" | — | Superseding note | — | D-034 |',
      '| RISK-053 | Signers fixed at set-up | High for any real-money path | Open | Build it | R7 |',
      '| RISK-053 | (Update, 22 Nov) Signers can now be added and removed | High for any real-money path | Partly mitigated | — | R7 |',
      '| RISK-070 | A viewer can read other members\' questions | Low | Open | Hide them | review |',
      '| RISK-070 | (Update, 22 Nov, night) Fixed in part | — | Partly mitigated | — | review |',
    ].join('\n')
    const risks = parseRisks(md)
    expect(risks.find((r) => r.id === 'RISK-015')).toMatchObject({ title: 'Floor guarantee overstated', severity: 'High', status: 'Open', open: true })
    expect(risks.find((r) => r.id === 'RISK-053')).toMatchObject({ title: 'Signers fixed at set-up', severity: 'High', status: 'Partly mitigated', open: true, updated: true })
    expect(risks.find((r) => r.id === 'RISK-070')).toMatchObject({ title: 'A viewer can read other members\' questions', severity: 'Low', status: 'Partly mitigated', open: true })
  })

  it('names severities however they are qualified, and keeps a partial mitigation open', () => {
    expect(['Critical', 'High (time-bound)', 'High for any real-money path', 'Med', 'Medium', 'Low for this build', 'n/a'].map(severityOf)).toEqual(['Critical', 'High', 'High', 'Medium', 'Medium', 'Low', 'Unknown'])
    expect(isOpen('Open')).toBe(true)
    expect(isOpen('Known limitation')).toBe(true)
    expect(isOpen('Mitigated 17 Nov')).toBe(false)
    expect(isOpen('Mitigated in part: owners\' vaults')).toBe(true)
    expect(isOpen('Partly mitigated')).toBe(true)
    expect(isOpen('Closed 22 Nov')).toBe(false)
    // a risk the ledger records as fixed is not an open blocker (claims review F3)
    expect(isOpen('Fixed in `83d2ace` (refused before the vault service is asked)')).toBe(false)
    expect(isOpen('Fixed in part')).toBe(true)
  })

  it('never shows an entry about the team\'s credentials, keys, incidents, deployment, billing or logistics: it counts it, and shows the rest in plain words by area with the register id one step down', () => {
    const md = [...HEAD,
      '| RISK-001 | Pre-23 Oct Anthropic API key not revoked after 21 Oct Railway incident (security + billing exposure) | High | Accepted by owner 23 Oct | Owner to revoke in provider console (Q-017). Agents must never handle keys | VERIFICATION_MATRIX.md |',
      '| RISK-002 | Public GitHub source ≠ live release | Medium | Open | Owner decision Q-002 | Claude R2 |',
      '| RISK-003 | Unlocated citations in QED PRIOR_ART.md could undermine credibility at the 29 Nov final | High (time-bound) | Open | Q-003 before 29 Nov | Claude R2 |',
      '| RISK-023 | Signing-path compromise: a compromised UI shows one thing while the owner signs another | Critical | Open (design) | D-026 trusted display | EV-024 |',
      '| RISK-034 | A kernel built from doc 03\'s original T5 wording lets an agent move value out through liabilities it creates | High | Mitigated in research code (X1 fixed; D-043); open for other channels | — | EV-036 |',
      '| RISK-034 (update, 20 Nov) | Not closed by X1\'s first fix | High within the model | See EV-045 for what is fixed in X1 and what is a limit of the model | — | X8 |',
      '| RISK-042 | The wallet\'s reserve covers only what is on record | Med | Open, stated in the interface | The "more may be needed" line | EV-039 |',
    ].join('\n')
    const v = view({ risks: md, requirements: { entries: [], sections: [] } })
    const text = JSON.stringify(v)
    for (const leak of ['RISK-001', 'RISK-002', 'RISK-003', 'Anthropic', 'API key', 'Railway', 'incident', 'billing', 'GitHub', 'PRIOR_ART', 'citations', '29 Nov', 'EV-0', 'D-0', 'Q-0', 'doc 03', 'T5', 'X1', 'Claude']) expect(text).not.toContain(leak)
    expect(v.risks!.operations).toBe(3)
    expect(v.risks!.undescribed).toBe(0)
    expect(v.risks!.open).toEqual({ Critical: 1, High: 1, Medium: 1, Low: 0, Unknown: 0 })
    // critical and high, grouped by area, each reason its register id and its standing in words
    const top = reasons(v.risks!.areas)
    expect(top.map((r) => [r.id, r.severity, r.standing])).toEqual([['RISK-023', 'Critical', 'Open'], ['RISK-034', 'High', 'Open']])
    expect(v.risks!.areas.map((a) => a.title)).toEqual(['Signing and who can act', 'What the protections promise'])
    for (const r of top) expect(r.says).toMatch(/^[A-Z].{30,}\.$/)
    expect(reasons(v.risks!.lower).map((r) => [r.id, r.severity, r.standing])).toEqual([['RISK-042', 'Medium', 'Open']])
    // the blockers are the same reasons, in the same words
    const risky = v.blockers.filter((b) => b.kind === 'risk')
    expect(risky.map((b) => b.id)).toEqual(['RISK-023', 'RISK-034'])
    expect(risky.map((b) => b.title)).toEqual(top.map((r) => r.says))
    expect(v.because).toMatch(/: 2 standing, 2 open critical or high risks, /)
  })

  it('an open risk with no plain words yet is counted, never shown in the register\'s words, and still blocks when it is critical or high', () => {
    const md = [...HEAD,
      '| RISK-998 | Something new found in the floor monitor at the 29 Nov rehearsal | High | Open | Fix | EV-099 |',
      '| RISK-999 | Another new thing | Low | Open | Look | EV-100 |',
    ].join('\n')
    const v = view({ risks: md, requirements: { entries: [], sections: [] } })
    const text = JSON.stringify(v)
    for (const leak of ['RISK-998', 'RISK-999', 'Something new', 'Another new thing', 'rehearsal']) expect(text).not.toContain(leak)
    expect(v.risks!.undescribed).toBe(2)
    expect(v.risks!.areas).toEqual([])
    const risky = v.blockers.filter((b) => b.kind === 'risk')
    expect(risky).toEqual([{ kind: 'risk', id: 'not-yet-described', title: '1 open critical or high risk in the register is not yet described on this page', detail: 'It counts as a reason this build is not ready until it is.', severity: 'High' }])
  })

  it('leaves out the requirements about the team\'s own working method and logistics, counts them, and says each remaining one plainly by area', () => {
    const entries = [
      { id: 'R7-001', section: 'S1', title: 'One requirements and evidence register', status: 'Met', needs: 'C', level: 'C' },
      { id: 'R7-003', section: 'S1', title: 'The approved release, its deployment, credentials, public contracts, live accounts and production resources stay unchanged; no push, deployment, public transaction, key rotation or real funds', status: 'Not met', needs: 'C', level: '-' },
      { id: 'R7-083', section: 'S7', title: 'Published testnet keys are not reused; their retirement or rotation decision prepared for the release phase', status: 'Partly', needs: 'D', level: '-' },
      { id: 'R7-010', section: 'S3', title: 'OWASP ASVS 5.0 Level 3: every applicable control met with evidence', status: 'Not met', needs: 'C', level: '-' },
      { id: 'R7-073', section: 'S7', title: 'Passkeys and platform authenticators with step-up', status: 'Partly', needs: 'P', level: 'I' },
      { id: 'R7-058', section: 'S6', title: 'Identity (KYC) prepared to the point of the provider dependency', status: 'Blocked', needs: 'C', level: '-' },
      { id: 'R7-020', section: 'S3', title: 'Privacy and custody requirements investigated', status: 'Met', needs: 'D', level: 'D' },
    ]
    const sections = [{ id: 'S1', title: 'Working method and boundaries (mandate sections 1, 2, 10, 11)' }, { id: 'S3', title: 'Standards and acceptance criteria (section 3)' }, { id: 'S6', title: 'Financial depth and science (section 6)' }, { id: 'S7', title: 'Authority, security, custody and operations (section 7)' }]
    const v = view({ risks: [...HEAD].join('\n'), requirements: { entries, sections } })
    const text = JSON.stringify(v)
    for (const leak of ['R7-001', 'R7-003', 'R7-083', 'deployment', 'credentials', 'testnet keys']) expect(text).not.toContain(leak)
    expect(v.requirements).toEqual({ total: 4, met: 1, partly: 1, notMet: 1, blocked: 1, operations: 3 })
    const reqs = v.blockers.filter((b) => b.kind === 'requirement')
    expect(reqs.map((b) => [b.id, b.area, b.severity, b.detail])).toEqual([
      ['R7-010', 'Standards and acceptance criteria', 'High', 'Not met, and nothing checks it yet. It counts as met only with a component test.'],
      ['R7-073', 'Authority, security, custody and operations', 'Medium', 'Met in part, checked so far by a test through the API. It counts as met only with a journey through the app in a browser.'],
      ['R7-058', 'Financial depth and science', 'High', 'Blocked on something outside this work, and nothing checks it yet. It counts as met only with a component test.'],
    ])
  })

  it('on this repository\'s own records it is never ready: the standing blockers are always there, with the build and release named, and nothing of the team\'s own operations shows', () => {
    const r = readiness() as unknown as View
    expect(r.ready).toBe(false)
    expect(r.verdict).toBe('Not ready for real money')
    expect(r.blockers.filter((b) => b.kind === 'standing').map((b) => b.id)).toEqual(['test-build', 'no-independent-review'])
    expect(r.release.id).toBe('qed-20261023-health-gate-v3')
    expect(r.build.revision === null || /^[0-9a-f]{40}$/.test(r.build.revision)).toBe(true)
    const text = JSON.stringify({ ...r, build: null, release: null, evidence: null })
    expect(text).not.toMatch(/Anthropic|API key|Railway|billing|PRIOR_ART|citation|29 Nov|\bEV-\d{3}\b|\bD-\d{3}\b|\bQ-\d{3}\b|doc 03|Codex|Claude|GitHub/i)
    expect(r.risks!.operations).toBeGreaterThan(0)
    expect(r.requirements.operations).toBeGreaterThan(0)
    // Every open risk in the register is either written in plain words for this page or counted as the team's own
    // operations. A new risk fails this until it is placed (server/readiness.ts, PLAIN or OPERATIONS).
    expect(r.risks!.undescribed, 'an open risk in docs/shared/RISK_REGISTER.md has no plain words in server/readiness.ts (PLAIN) and is not listed as the team\'s own operations (OPERATIONS)').toBe(0)
  })
})
