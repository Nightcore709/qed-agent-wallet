/**
 * An institution terms registry (N-015). One record for each institution QED has a connector for, and for each real bank whose
 * terms were read, with the terms' version and effective date, the date they were read, what they say about an agent acting
 * for a customer, the channel an agent may use, how a revocation reaches the institution, and QED's registration status.
 *
 * Every institution QED can connect to today is SIMULATED: the paper bank, the paper exchange and the paper desks are QED's
 * own local stand-ins, and their records say so. The real banks' records are references only (read 23 Nov 2026, from
 * docs/research/qed-fin-infra-compliance/20261123-bank-agent-terms.md): none has a connector, because a bank whose terms give an
 * agent no channel but the customer's own credentials is never connected to (QED never asks for, holds or uses a bank
 * password), and QED holds no registration with any real institution (EXT-14). A record read more than STALE_AFTER_DAYS ago
 * is stale, and a test fails on a missing or stale one.
 */
import { refused } from './core.ts'

export type AgentPolicy = 'simulation' | 'credentials-only' | 'identified-agent-required' | 'data-channel-offered' | 'not-addressed'
export interface InstitutionTerms {
  id: string; name: string; simulated: boolean
  termsUrl: string; termsVersion: string
  /** YYYY-MM-DD, or YYYY-MM where the institution gave no day. */
  effectiveDate: string
  /** The day the terms were read (YYYY-MM-DD). */
  readOn: string
  agentPolicy: AgentPolicy; agentPolicyText: string
  /** The channel an agent may use at this institution, or null where there is none. */
  channel: string | null
  revocationChannel: string
  registration: 'simulation' | 'not-registered'
}
export const STALE_AFTER_DAYS = 90

const SIM_URL = 'docs/standards/FINANCIAL-DATA.md#simulated-institutions'
const sim = (id: string, name: string, channel: string, revocation: string, text: string): InstitutionTerms => ({
  id, name, simulated: true, termsUrl: SIM_URL, termsVersion: 'qed-simulation-v1', effectiveDate: '2026-11-24', readOn: '2026-11-24',
  agentPolicy: 'simulation', agentPolicyText: `Simulated: ${text} It answers an agent that identifies itself as one, and refuses a request that does not.`, channel, revocationChannel: revocation, registration: 'simulation',
})
const real = (r: Omit<InstitutionTerms, 'simulated' | 'channel' | 'registration' | 'readOn'> & { channel?: string | null }): InstitutionTerms => ({ ...r, simulated: false, channel: r.channel ?? null, registration: 'not-registered', readOn: '2026-11-23' })

export const INSTITUTION_TERMS: readonly InstitutionTerms[] = [
  sim('paper-rail', 'The paper bank', 'e-mandate and payment API on this QED installation', 'The paper bank\'s revoke call, which answers with its own reference', 'QED\'s local stand-in for a bank, with standing debit mandates and UPI, IMPS, NEFT and RTGS style rails. No real money moves.'),
  sim('paper-crypto', 'The paper exchange', 'order API on this QED installation', 'Cancelling an order, which the paper exchange acknowledges', 'QED\'s local stand-in for a crypto exchange, filling against recorded order books.'),
  sim('paper-mf', 'The paper fund registrar', 'order API on this QED installation', 'Cancelling an order before its NAV day', 'QED\'s local stand-in for a fund registrar, allotting units at a recorded NAV.'),
  sim('paper-exchange', 'The paper securities exchange desk', 'order API on this QED installation', 'Cancelling an order, which the desk acknowledges', 'QED\'s local stand-in for a securities exchange desk.'),
  sim('paper-gsec', 'The paper government-securities desk', 'order API on this QED installation', 'Cancelling an order, which the desk acknowledges', 'QED\'s local stand-in for a government-securities desk.'),
  sim('paper-fx-desk', 'The paper foreign-exchange desk', 'conversion API on this QED installation', 'None: a conversion settles at once on paper', 'QED\'s local stand-in for a foreign-exchange desk.'),
  real({ id: 'wells-fargo', name: 'Wells Fargo (reference only)', termsUrl: 'https://www.wellsfargo.com/online-banking/online-access-agreement/upcoming/', termsVersion: 'Online Access Agreement, Version Effective November 24, 2026', effectiveDate: '2026-11-24',
    agentPolicy: 'credentials-only', agentPolicyText: 'Section 15: an AI agent given the customer\'s login credentials acts as the customer, its instructions deemed authorised by the customer, at the customer\'s own risk. No agent channel is described.', revocationChannel: 'The customer must be able to evidence a revocation (section 15(f)).' }),
  real({ id: 'citi', name: 'Citi (reference only)', termsUrl: 'https://www.citi.com/tandc/view-printable-version', termsVersion: 'Online User Agreement, last updated November 2026, section H', effectiveDate: '2026-11',
    agentPolicy: 'credentials-only', agentPolicyText: 'Section H cautions against third-party AI agents; an agent given online credentials is treated as authorised by the customer. No agent channel is described.', revocationChannel: 'Not stated in the section read.' }),
  real({ id: 'chase', name: 'Chase (reference only)', termsUrl: 'https://www.chase.com/digital/resources/terms-of-use', termsVersion: 'chase.com Terms of use, "Rev. Aug. 2016" with an undated AI agent section', effectiveDate: '2016-08',
    agentPolicy: 'identified-agent-required', agentPolicyText: 'An agent may use Chase systems only if it identifies itself as an AI agent at all times and labels its traffic; Chase may limit or end agent access. No channel for acting on a customer\'s account is described.', revocationChannel: 'Not stated.' }),
  real({ id: 'bank-of-america', name: 'Bank of America (reference only)', termsUrl: 'https://www.bankofamerica.com/online-banking/service-agreement.go', termsVersion: 'Online Banking Service Agreement', effectiveDate: '2026-10-19',
    agentPolicy: 'not-addressed', agentPolicyText: 'No third-party AI-agent clause in the text read; sharing credentials with a third party is not allowed (section 4.B).', revocationChannel: 'Not stated.' }),
  real({ id: 'capital-one', name: 'Capital One (reference only)', termsUrl: 'https://www.capitalone.com/legal/corporate/terms/', termsVersion: 'Online Banking Terms and Datasharing Terms, last modified 2 Dec 2025', effectiveDate: '2025-12-02',
    agentPolicy: 'data-channel-offered', agentPolicyText: 'No agent clause; automatic devices may not monitor or copy the service (section 17.4). Data sharing is requested through Capital One under its Datasharing Terms and can be revoked on its website, prospectively.', channel: 'Datasharing Terms (read access only)', revocationChannel: 'On Capital One\'s website, prospectively.' }),
]

export const termsOf = (id: string): InstitutionTerms | undefined => INSTITUTION_TERMS.find((t) => t.id === id)

const DAY = 86_400_000
const dayMs = (iso: string): number => Date.parse(`${iso.length === 7 ? `${iso}-01` : iso}T00:00:00Z`)
/** Records read more than STALE_AFTER_DAYS before `asOf` (a YYYY-MM-DD day). */
export function staleRecords(asOf: string, records: readonly InstitutionTerms[] = INSTITUTION_TERMS): InstitutionTerms[] {
  return records.filter((t) => (dayMs(asOf) - dayMs(t.readOn)) / DAY > STALE_AFTER_DAYS)
}

/** Whether QED may connect to this institution: only a simulated one today, and never one reached only through credentials. */
export function connectable(t: InstitutionTerms): { ok: boolean; reason: string } {
  if (t.agentPolicy === 'credentials-only') return { ok: false, reason: `${t.name}: its terms give an agent no channel but the customer\'s own login credentials, and QED never asks for, holds or uses a bank password. No connection is made.` }
  if (!t.simulated) return { ok: false, reason: `${t.name}: QED holds no registration and no connector for a real institution yet (EXT-14). The terms are recorded for reference only.` }
  return { ok: true, reason: 'A simulated institution on this QED installation.' }
}
export function assertConnectable(id: string): InstitutionTerms {
  const t = termsOf(id)
  if (!t) throw refused('unknown_institution', 'QED has no record of that institution.')
  const c = connectable(t)
  if (!c.ok) throw refused('no_connection', c.reason)
  return t
}

/** What a person is shown before connecting: the terms' version and date, the agent policy, the channel, how a revocation reaches it, and what is simulated. */
export function connectionSummary(t: InstitutionTerms): { id: string; name: string; simulated: boolean; lines: { label: string; value: string }[]; connectable: boolean; reason: string; termsVersion: string } {
  const c = connectable(t)
  return {
    id: t.id, name: t.name, simulated: t.simulated, termsVersion: t.termsVersion, connectable: c.ok, reason: c.reason,
    lines: [
      { label: t.simulated ? 'Kind' : 'Status', value: t.simulated ? 'Simulated: QED\'s own stand-in on this QED installation. Nothing here is a real institution, and no real money moves.' : 'A real institution: terms read for reference, no connection.' },
      { label: 'Terms', value: `${t.termsVersion}, effective ${t.effectiveDate}, read ${t.readOn}` },
      { label: 'Agent policy', value: t.agentPolicyText },
      { label: 'Channel', value: t.channel ?? 'None offered to an agent' },
      { label: 'Revocation', value: t.revocationChannel },
      { label: 'QED\'s registration', value: t.registration === 'simulation' ? 'Simulation only: QED registers itself with its own stand-in' : 'None' },
    ],
  }
}
