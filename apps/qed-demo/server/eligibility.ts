/**
 * Where each thing QED offers is offered (R7-057: "The registry records each instrument's jurisdiction, eligibility and
 * integration status; the product refuses ineligible instruments with the reason; unavailable integrations are named with
 * their dependency"; R13 section 6).
 *
 * Every offer states: the jurisdictions whose households it is offered to (on paper), where its venue or route is based,
 * the capability of the jurisdiction research it falls under, and how it is integrated, with what a real integration
 * would depend on. A household elsewhere is refused with the reason, and the reason says what real money would need there
 * in the research's own words (server/legal.ts routeOf; research, not legal advice). Nothing here opens a real-money
 * route: legal.ts assertRealMoney stays the only gate for that, and no agreement is recorded.
 *
 * The paper bank, the paper desk, the paper routes and the paper venues are modelled on India, so each is offered to
 * households in India only. Reference figures are shown everywhere and can be bought nowhere.
 */
import { AppError } from './core.ts'
import { LEGAL_JURISDICTIONS, loadAgreements, loadMatrix, routeOf } from './legal.ts'
import type { InstrumentKind } from './registry.ts'

export const JURISDICTION_NAMES: Readonly<Record<string, string>> = { IN: 'India', US: 'the United States', UK: 'the United Kingdom', EU: 'the European Union', SG: 'Singapore', AE: 'the United Arab Emirates' }

export interface Offer {
  id: string
  name: string
  /** The capability of the jurisdiction research (C1 to C11) a real version would fall under; 'none' for reference figures. */
  capability: string
  /** Households in these jurisdictions are offered it, on paper. */
  offeredIn: readonly string[]
  /** Where the venue or the route is based. */
  basedIn: string
  integration: { status: 'paper' | 'reference-only'; dependency: string }
}

export const FX_DESK_OFFER: Offer = {
  id: 'paper-fx-desk', name: 'The paper FX desk', capability: 'C4', offeredIn: ['IN'], basedIn: 'IN',
  integration: { status: 'paper', dependency: 'Prices from recorded reference rates and moves no money. Real conversions would need a licensed partner for cross-border payments and foreign exchange (capability C4); no agreement is recorded.' },
}

/** What an instrument of the registry is, where, and how it is integrated. */
export function instrumentOffer(i: { id: string; kind: InstrumentKind; venue: string; name: string; tradable: boolean }): Offer {
  if (i.tradable && i.kind === 'mutual_fund') {
    return { id: i.id, name: i.name, capability: 'C7', offeredIn: ['IN'], basedIn: 'IN', integration: { status: 'paper', dependency: 'A paper fund registrar (paper-mf) that executes at the NAVs AMFI publishes. Real orders would need a licensed partner for fund orders in India (capability C7); no agreement is recorded.' } }
  }
  if (i.tradable) {
    return { id: i.id, name: i.name, capability: 'C6', offeredIn: ['IN'], basedIn: 'IN', integration: { status: 'paper', dependency: `A paper exchange (${i.venue}) priced from a public order book. Real trading would need QED's own registration or a partner for digital assets (capability C6); no agreement is recorded.` } }
  }
  return { id: i.id, name: i.name, capability: 'none', offeredIn: LEGAL_JURISDICTIONS, basedIn: 'IN', integration: { status: 'reference-only', dependency: 'Shown for reference only: nothing can be bought or sold at it, anywhere.' } }
}

const nameOf = (j: string): string => JURISDICTION_NAMES[j] ?? j
const listOf = (js: readonly string[]): string => (js.length === 1 ? nameOf(js[0]!) : `${js.slice(0, -1).map(nameOf).join(', ')} and ${nameOf(js.at(-1)!)}`)

/** What the research says real money would need for this capability in this jurisdiction. */
function realMoneyWords(capability: string, jurisdiction: string): string {
  if (capability === 'none') return ''
  try {
    const r = routeOf(loadMatrix(), loadAgreements(), capability, jurisdiction)
    return ` With real money in ${nameOf(jurisdiction)}, ${r.capabilityName.toLowerCase()} would need: ${r.missing}`
  } catch {
    return ' The jurisdiction research could not be read, so no route there is judged open.'
  }
}

/** Refuses an offer to a household that lives where it is not offered, with the reason. */
export function assertOffered(o: Offer, jurisdiction: string): void {
  if (o.offeredIn.includes(jurisdiction)) return
  throw new AppError(403, 'not_offered_here', `${o.name} is offered, on paper, only to households in ${listOf(o.offeredIn)}; this household is in ${nameOf(jurisdiction)}.${realMoneyWords(o.capability, jurisdiction)}`)
}
