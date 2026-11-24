/**
 * Reference rates for the paper bank's foreign currencies (R13 sections 1 and 3). Kept apart from the desk (fx.ts) so that the
 * worst-case figure (valuation.ts) can value foreign balances without depending on the desk, which depends on it.
 */
import type { Market } from './market.ts'
import { type Currency } from '../shared/currency.ts'
import { divRound, makeRate, parseRatio, pow10, type Rate, type Ratio, ratio } from '../shared/instrument.ts'

type Foreign = Exclude<Currency, 'INR'>

// ------------------------------------------------------------------------------------------------ reference rates

/**
 * FBIL reference rates as at 1.00 pm IST on 18 Nov 2026, as displayed on the RBI home page and recorded by the compliance
 * research (docs/research/qed-fin-infra-compliance/20261118-live-data-entitlements.md section 3.7, E44: "Verified as
 * displayed"). Rupees per one unit; FBIL quotes the yen per 100, so one yen is 58.6000 / 100 = 0.586 exactly.
 */
export const FX_RECORDED = {
  source: 'FBIL reference rate as at 1.00 pm IST on 18 Nov 2026, as displayed on the RBI home page (recorded by QED research, E44)',
  observedAt: Date.parse('2026-11-18T07:30:00Z'),
  rates: { USD: '93.3558', GBP: '123.1363', EUR: '102.4994', JPY: '0.586' } as Record<'USD' | 'GBP' | 'EUR' | 'JPY', string>,
} as const
/** How long the recorded rates may price the paper desk: until replaced by newer recorded ones, at most a year. */
const RECORDED_FOR_MS = 365 * 86_400_000
/** How old a live ECB reference may be and still be used (the registry marks it stale after four days). */
const LIVE_FOR_MS = 4 * 86_400_000

/**
 * The Bahraini dinar, from its central bank. The Central Bank of Bahrain's page "Facilities & Interest Rates" (read 24 Nov 2026,
 * robots.txt allows it) lists exchange rates dated 24 Nov 2026 and states, under its Decree (48) of 2001, Article 1: "The BHD
 * against the USD shall be fixed at 1 BHD= 2.659 USD." The dinar's rupee reference is the US dollar's reference times 2.659.
 */
export const CBB_PEG = {
  usdPerBhd: '2.659',
  source: 'Central Bank of Bahrain, Facilities & Interest Rates page (https://www.cbb.gov.bh/facilities-interest-rates/), exchange rates dated 24 Nov 2026: Decree (48) of 2001, Article 1, fixes 1 BHD = 2.659 USD',
  read: 'read 24 Nov 2026',
  pageSha256: '28d66a683cf1ae6538fcb19d982f6e14ef97b6e3a50c54ebe52f9c946cdfe45c',
} as const

/**
 * The currencies whose central bank's own figure could not be read, made up from the US dollar's: synthetic, and labelled so.
 * The Central Bank of the UAE's site answered HTTP 403 to automated reading on 24 Nov 2026 (no bot wall was bypassed). The
 * Monetary Authority of Singapore's statistics page loads its figures by script, its data service needs a key, and the
 * eservices page was down for maintenance; the Singapore dollar floats, so no peg stands in for the figure either.
 */
export const SYNTHETIC_CROSSES: Readonly<Record<'AED' | 'SGD', { perUsd: string; words: string }>> = {
  AED: { perUsd: '3.6725', words: 'UAE dirhams to the US dollar, the peg as generally reported (NOT VERIFIED: the Central Bank of the UAE\'s site answered HTTP 403 to automated reading on 24 Nov 2026)' },
  SGD: { perUsd: '1.30', words: 'Singapore dollars to the US dollar, an illustrative figure (the Singapore dollar floats; NOT VERIFIED: the Monetary Authority of Singapore\'s published rates could not be read on 24 Nov 2026, its statistics page needing script and a key)' },
}

export const INR_ID = 'iso4217:INR'

/** Rupees per one unit of each foreign currency the paper bank holds, as reference rates, at a decision time. */
export function referenceRates(market: Market | null, at: number): Map<Foreign, Rate> {
  const out = new Map<Foreign, Rate>()
  for (const [c, v] of Object.entries(FX_RECORDED.rates) as [Foreign, string][]) {
    out.set(c, makeRate({ base: `iso4217:${c}`, quote: INR_ID, kind: 'reference', mid: v, source: FX_RECORDED.source, label: 'historical', observedAt: FX_RECORDED.observedAt, validUntil: FX_RECORDED.observedAt + RECORDED_FOR_MS }))
  }
  // A fresh ECB reference (via Frankfurter) or a test's, for the two currencies the market follows. Never the synthetic walk.
  for (const c of ['USD', 'EUR'] as const) {
    const t = market?.get(`ecb:${c}INR`, 'reference')
    if (!t || t.provider === 'synthetic' || t.sourceTs === null || t.sourceTs > at || at - t.sourceTs > LIVE_FOR_MS) continue
    let mid: Ratio
    try { mid = parseRatio(t.price) } catch { continue }
    if (mid.n <= 0n) continue
    const live = t.provider === 'frankfurter'
    out.set(c, makeRate({
      base: `iso4217:${c}`, quote: INR_ID, kind: 'reference', mid, label: live ? 'observation' : 'fixture', observedAt: t.sourceTs, validUntil: t.sourceTs + LIVE_FOR_MS,
      source: live ? `ECB euro reference rate of ${new Date(t.sourceTs).toISOString().slice(0, 10)} via Frankfurter` : `a test's reference rate (${t.provider})`,
    }))
  }
  const usd = out.get('USD')!
  const peg = parseRatio(CBB_PEG.usdPerBhd)
  out.set('BHD', makeRate({
    base: 'iso4217:BHD', quote: INR_ID, kind: 'reference', mid: ratio(usd.mid.n * peg.n, usd.mid.d * peg.d), label: 'historical', observedAt: usd.observedAt, validUntil: usd.validUntil,
    source: `${CBB_PEG.source} (page SHA-256 ${CBB_PEG.pageSha256}, ${CBB_PEG.read}), crossed with the US dollar's reference (${usd.source})`,
  }))
  for (const [c, x] of Object.entries(SYNTHETIC_CROSSES) as ['AED' | 'SGD', { perUsd: string; words: string }][]) {
    const per = parseRatio(x.perUsd)
    out.set(c, makeRate({
      base: `iso4217:${c}`, quote: INR_ID, kind: 'reference', mid: ratio(usd.mid.n * per.d, usd.mid.d * per.n), label: 'synthetic', observedAt: usd.observedAt, validUntil: usd.validUntil,
      source: `synthetic: the US dollar's reference (${usd.source}) divided by ${x.perUsd} ${x.words}`,
    }))
  }
  return out
}

/** "93.3558", or six places for a rate that has no short decimal form. */
export function rateText(r: Ratio, places = 6): string {
  const scaled = divRound(r.n * pow10(places), r.d, 'halfExpand')
  const exact = scaled * r.d === r.n * pow10(places)
  const s = scaled.toString().padStart(places + 1, '0')
  let text = `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`
  if (exact) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text
}

