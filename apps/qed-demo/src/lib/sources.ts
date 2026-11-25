/**
 * Where a figure comes from (R7-031, R7-032; R13 audit GL4). Every page that shows money names, under its content, the
 * sources of its figures in these words; a figure of test tokens is named beside itself as well. The words live here,
 * once, so that a screen cannot describe its own source in kinder terms than the others.
 *
 * R7-031 lists six sources (actual local-chain execution, real market observation, provider sandbox, synthetic scenario,
 * historical evidence, unavailable). QED's own paper bank, a published fund value and a worked-out estimate are none of
 * those, so they have kinds of their own. Nothing here is real money, and none of it says so by implication.
 */
export type SourceKind = 'paper' | 'chain' | 'market' | 'fund' | 'modelled' | 'historical' | 'synthetic' | 'sandbox' | 'unavailable'

export const SOURCES: Record<SourceKind, { label: string; says: string }> = {
  paper: { label: 'Paper bank', says: 'QED\'s own record of simulated money for practice. No real bank or institution holds it.' },
  chain: { label: 'Test chain', says: 'Test tokens on a chain that runs on this QED installation. They have no value, are not rupees and are not a security.' },
  market: { label: 'Market price', says: 'A price observed from a market source, shown with its time. It moves, and it can be out of date.' },
  fund: { label: 'Fund value', says: 'A mutual fund\'s published value for a stated day (its NAV). Not a live price.' },
  modelled: { label: 'Modelled', says: 'Worked out by QED from assumptions it states. Not a quote, a promise or a published term.' },
  historical: { label: 'Past data', says: 'What happened in the past. It does not predict what will happen.' },
  synthetic: { label: 'Scenario', says: 'Made up for the example. It is not an observation.' },
  sandbox: { label: 'Provider sandbox', says: 'From a provider\'s test environment, not its live service.' },
  unavailable: { label: 'Not available', says: 'No source has this figure, so none is shown.' },
}

/**
 * The sources of the money figures on each screen file, in the order the page names them. The page note names exactly
 * these (src/ui/kit.tsx SourceNote), and a scan (src/lib/sources.test.ts) fails when a screen file that formats money is
 * missing here, or does not name the source its code reads from (chain figures, market prices, fund values).
 */
export const SCREEN_SOURCES: Record<string, SourceKind[]> = {
  'Home.tsx': ['paper', 'market', 'fund', 'chain', 'modelled'],
  'Passbook.tsx': ['paper'],
  'Pay.tsx': ['paper', 'chain', 'market'],
  'Commerce.tsx': ['paper', 'synthetic'],
  'Desk.tsx': ['paper', 'fund', 'synthetic', 'modelled'],
  'Holdings.tsx': ['market', 'fund', 'paper', 'modelled'],
  'GrowCompare.tsx': ['market', 'fund', 'modelled'],
  'Idea.tsx': ['market', 'fund', 'modelled', 'historical'],
  'Lab.tsx': ['historical', 'synthetic', 'modelled'],
  'Save.tsx': ['paper', 'modelled', 'market'],
  'Safeguards.tsx': ['paper', 'modelled'],
  'Protect.tsx': ['paper', 'modelled'],
  'Earn.tsx': ['paper', 'chain'],
  'Record.tsx': ['paper', 'market', 'fund', 'chain'],
  'Compose.tsx': ['paper', 'market', 'fund', 'modelled'],
  'Instructions.tsx': ['paper', 'modelled'],
  'DisputePack.tsx': ['paper'],
  'Security.tsx': ['paper'],
  'Subscriptions.tsx': ['paper'],
  'Abroad.tsx': ['paper', 'market'],
  'Vault.tsx': ['chain'],
  'WalletInline.tsx': ['chain'],
  'Workspace.tsx': ['paper'],
  'Tax.tsx': ['paper', 'modelled'],
  'Activity.tsx': ['paper', 'chain'],
  'Bounties.tsx': ['paper', 'chain'],
  'Evidence.tsx': ['paper'],
  'Notifications.tsx': ['paper'],
  'Readiness.tsx': ['paper'],
  'Ask.tsx': ['paper', 'modelled'],
  'YourData.tsx': ['paper'],
  'Judge.tsx': ['paper', 'chain'],
}

/** The screen file each route shows (for the page note). Routes not listed show no money. */
export function screenFileOf(path: string): string | null {
  const exact: Record<string, string> = { '/': 'Home.tsx', '/passbook': 'Passbook.tsx', '/tax': 'Tax.tsx', '/save': 'Save.tsx', '/protect': 'Protect.tsx', '/evidence': 'Evidence.tsx', '/judge': 'Judge.tsx', '/activity': 'Activity.tsx', '/pay': 'Pay.tsx', '/instructions': 'Instructions.tsx', '/instructions/new': 'Compose.tsx', '/holdings': 'Holdings.tsx', '/holdings/lab': 'Lab.tsx', '/holdings/idea': 'Idea.tsx', '/earn': 'Earn.tsx', '/earn/bounties': 'Bounties.tsx', '/safeguards': 'Safeguards.tsx', '/readiness': 'Readiness.tsx', '/security': 'Security.tsx', '/workspace': 'Workspace.tsx', '/notifications': 'Notifications.tsx', '/vault': 'Vault.tsx', '/ask': 'Ask.tsx' }
  if (exact[path]) return exact[path]!
  if (/^\/instructions\/[^/]+\/amend$/.test(path)) return 'Compose.tsx'
  if (/^\/instructions\/[^/]+$/.test(path)) return 'Instructions.tsx'
  if (/^\/holdings\/idea\/[^/]+$/.test(path)) return 'Idea.tsx'
  if (/^\/vault\//.test(path)) return 'Vault.tsx'
  if (/^\/record\/[^/]+\/pack$/.test(path)) return 'DisputePack.tsx'
  if (/^\/record\/[^/]+$/.test(path)) return 'Record.tsx'
  if (/^\/evidence\/[^/]+$/.test(path)) return 'Evidence.tsx'
  return null
}
export const sourcesOfPath = (path: string): SourceKind[] => { const f = screenFileOf(path); return f ? SCREEN_SOURCES[f] ?? [] : [] }

/**
 * A test token must never read as rupees or as the security it stands for (R7-032). The words that go beside a figure of
 * test tokens: used by the wallet's rows on Home and Pay, and checked by the scan.
 */
export const TEST_TOKEN_WORDS = 'test rupees, no value'
