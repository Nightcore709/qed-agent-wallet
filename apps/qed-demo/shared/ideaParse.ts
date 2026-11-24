/**
 * Reading an investment idea written in plain words (R13, the Grow journey's first step), by fixed rules, not a
 * model: "₹50,000 into the Nifty 50 index fund", "a monthly SIP of ₹5,000 in the flexi cap fund", "buy bitcoin",
 * "move idle cash to a liquid fund". What the words leave open becomes a question; nothing is guessed that matters
 * (an amount, which fund of two, once or every month). The result is a draft plan, never an order: every later step
 * re-checks it against the household's books, and only a plan the server validates can be signed.
 */

export interface IdeaInstrument { id: string; name: string; kind: string; category?: string }
export interface IdeaPlan {
  /** buy: put money into an investment; park: move idle cash into a liquid fund */
  action: 'buy' | 'park'
  instrumentId: string | null
  /** paise; null until the owner says */
  amount: number | null
  cadence: 'once' | 'monthly' | null
}
export interface Question { key: 'instrument' | 'amount' | 'cadence'; text: string; choices?: { value: string; label: string }[] }
export interface IdeaReading { plan: IdeaPlan; heard: string[]; questions: Question[]; refusal: string | null }

/** Which words name which investment. Order matters: the more specific first ("next 50" before "nifty 50"). */
const NAMES: { id: string; re: RegExp; words: string }[] = [
  { id: 'amfi:120684', re: /\bnifty\s*next\s*50\b|\bnext\s*50\b/i, words: 'the Nifty Next 50 index fund' },
  { id: 'amfi:120716', re: /\bnifty(\s*50|\s*fifty)?\b/i, words: 'the Nifty 50 index fund' },
  { id: 'amfi:122639', re: /\bflexi\s*-?\s*cap\b|\bparag\b|\bppfas\b|\bflexi\b/i, words: 'the flexi cap fund' },
  { id: 'amfi:148381', re: /\bs\s*&\s*p\s*500\b|\bs\s*and\s*p\b|\bus\s+(stocks?|shares|market|index)\b|\bamerican\s+(stocks?|shares|market)\b/i, words: 'the S&P 500 index fund' },
  { id: 'amfi:119788', re: /\bgold\b/i, words: 'the gold fund' },
  { id: 'amfi:118701', re: /\bliquid\s*fund\b|\bliquid\b/i, words: 'the liquid fund' },
  { id: 'amfi:119110', re: /\bovernight\b/i, words: 'the overnight fund' },
  { id: 'amfi:119771', re: /\barbitrage\b/i, words: 'the arbitrage fund' },
  { id: 'coindcx:BTCINR', re: /\bbitcoin\b|\bbtc\b/i, words: 'bitcoin' },
  { id: 'coindcx:ETHINR', re: /\bether(eum)?\b|\beth\b/i, words: 'ether' },
  { id: 'coindcx:USDTINR', re: /\btether\b|\busdt\b/i, words: 'tether (USDT)' },
]
const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7 }

/** The amount in rupees written in the text (with the instrument's own name removed first, so "Nifty 50" is not 50). */
export function amountOf(text: string): number | null {
  const m = /(?:₹|\brs\.?|\binr\b|\brupees?\b)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr|l)?\b(?!\s*%)/i.exec(text)
  if (!m) return null
  const n = Number(m[1]!.replace(/,/g, '')) * (m[2] ? UNIT[m[2].toLowerCase()] ?? 1 : 1)
  if (!Number.isFinite(n) || n <= 0) return null
  const paise = Math.round(n * 100)
  return Number.isSafeInteger(paise) ? paise : null
}

export function readIdea(text: string, investable: IdeaInstrument[]): IdeaReading {
  const t = text.trim().replace(/\s+/g, ' ')
  const heard: string[] = []
  if (!t) return { plan: { action: 'buy', instrumentId: null, amount: null, cadence: null }, heard, questions: [], refusal: 'Write an idea, or pick one.' }
  if (/\b(sell|redeem|exit|cash out|withdraw)\b/i.test(t)) return { plan: { action: 'buy', instrumentId: null, amount: null, cadence: null }, heard, questions: [], refusal: 'This journey tests ideas for putting money in. To sell or redeem, use "Buy or sell" on Grow; QED shows the estimate before you approve.' }
  if (/\b(borrow|loan|leverage|margin|futures?|options?|short)\b/i.test(t)) return { plan: { action: 'buy', instrumentId: null, amount: null, cadence: null }, heard, questions: [], refusal: 'QED does not borrow, use leverage or trade derivatives for you: what you could lose would not be limited to what you put in.' }
  const park = /\b(idle|spare|extra|surplus)\s+(cash|money)\b|\bpark\b|\bsweep\b/i.test(t)
  const ids = investable.map((i) => i.id)
  let instrumentId: string | null = null
  let rest = t
  for (const n of NAMES) {
    if (!ids.includes(n.id)) continue
    const m = n.re.exec(rest)
    if (m) { instrumentId = n.id; heard.push(n.words); rest = rest.replace(n.re, ' '); break }
  }
  // "index fund" alone names two funds here: ask which, rather than choosing one
  const indexOnly = !instrumentId && /\bindex\s*fund\b/i.test(t)
  if (park && !instrumentId && ids.includes('amfi:118701')) { instrumentId = 'amfi:118701'; heard.push('the liquid fund') }
  const amount = amountOf(rest)
  if (amount !== null) heard.push(`₹${(amount / 100).toLocaleString('en-IN')}`)
  const monthly = /\b(sip|monthly|every month|each month|a month|per month|month by month)\b/i.test(t)
  const once = /\b(once|one[- ]time|one[- ]off|lump[- ]?sum|today|right now|now)\b/i.test(t)
  const cadence: IdeaPlan['cadence'] = monthly && !once ? 'monthly' : once && !monthly ? 'once' : park ? 'once' : null
  if (cadence) heard.push(cadence === 'monthly' ? 'every month' : 'once')
  const questions: Question[] = []
  const choicesOf = (filter: (i: IdeaInstrument) => boolean) => investable.filter(filter).map((i) => ({ value: i.id, label: i.name.replace(/ \(.*\)$/, '') }))
  if (!instrumentId) questions.push({ key: 'instrument', text: indexOnly ? 'Which index fund?' : 'Into what?', choices: indexOnly ? choicesOf((i) => i.category === 'index') : choicesOf(() => true) })
  // idle cash is what is free; how much of it to move is the owner's choice (the server offers the figures)
  if (amount === null) questions.push({ key: 'amount', text: park ? 'How much of your free money?' : monthly ? 'How much each month?' : 'How much?' })
  if (!cadence) questions.push({ key: 'cadence', text: 'Once, or every month?', choices: [{ value: 'once', label: 'Once' }, { value: 'monthly', label: 'Every month' }] })
  return { plan: { action: park ? 'park' : 'buy', instrumentId, amount, cadence }, heard, questions, refusal: null }
}

/** The ideas offered to pick, as a person would write them. */
export const PICKS = [
  '₹50,000 into the Nifty 50 index fund',
  'A monthly SIP of ₹5,000 in the flexi cap fund',
  'Buy ₹2,000 of bitcoin',
  'Move idle cash to a liquid fund',
] as const
