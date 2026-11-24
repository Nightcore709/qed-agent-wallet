/**
 * Two simulated paywalled services (R13, S2), started by QED's own API process on the loopback address, each on a port the
 * system chooses. They exist so that QED's agent commerce can be shown and tested end to end on one computer.
 *
 * What they are: local test doubles. They sell synthetic digests, they are labelled simulated in every reply, and no real
 * money, merchant or institution is behind them. Nothing here is a payment service.
 *
 * The pattern: a request without payment is answered HTTP 402 with a priced quote; the buyer pays, then asks again with the
 * payment's reference in an X-PAYMENT header and gets the goods with an X-PAYMENT-RESPONSE header. The quote's field names
 * (x402Version, accepts, scheme, network, maxAmountRequired, payTo, resource) follow the shape published for the x402
 * pattern; the payment itself is a paper-rail payment inside QED, and the service checks it with QED through the `settled`
 * function it is given. This is "in the style of" that pattern. It has NOT been tested against an x402 client, facilitator
 * or any other implementation, and no compatibility with one is claimed.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'

export interface Product { sku: string; title: string; blurb: string }
export const PRODUCTS: Product[] = [
  { sku: 'fund-digest', title: 'Fund fact-sheet digest', blurb: 'A one-page digest of a mutual fund\'s published fact sheet. Synthetic text.' },
  { sku: 'filing-pack', title: 'Filing checklist pack', blurb: 'A checklist of household tax filings by month. Synthetic text.' },
]
interface Offer { id: string; name: string; payTo: string; prices: Record<string, number> }
/** Prices in paise. Service B is cheaper for the digest and dearer for the pack, so neither is always the cheaper. */
export const OFFERS: Offer[] = [
  { id: 'sim-alpha', name: 'Alpha Digest (simulated)', payTo: 'alpha-digest@simservice', prices: { 'fund-digest': 3500, 'filing-pack': 9500 } },
  { id: 'sim-beta', name: 'Beta Briefs (simulated)', payTo: 'beta-briefs@simservice', prices: { 'fund-digest': 2800, 'filing-pack': 11000 } },
]
/** The network name the quotes carry: a paper rail inside QED, not a chain. */
export const NETWORK = 'qed-paper-rail'
export const QUOTE_TTL_MS = 120_000

export interface SimService { id: string; name: string; payTo: string; url: string; prices: Record<string, number> }
export interface SimServices { services: SimService[]; close(): Promise<void> }
export interface Settled { (ref: string, amountPaise: number, payTo: string): boolean }

/** A quote as a service sent it (the body of its 402 reply), kept as received. */
export interface X402Quote { x402Version: number; simulated: true; error: string; accepts: { scheme: string; network: string; maxAmountRequired: string; asset: string; resource: string; description: string; mimeType: string; payTo: string; maxTimeoutSeconds: number; extra: { quoteId: string; expiresAt: number; service: string; simulated: true; unit: string } }[] }

const body = (res: import('node:http').ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-qed-simulated': '1', ...headers })
  res.end(JSON.stringify(json))
}

function serve(offer: Offer, settled: Settled, now: () => number): Server {
  const quotes = new Map<string, { sku: string; amount: number; expiresAt: number; used: boolean }>()
  const refs = new Set<string>()
  return createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const m = /^\/resource\/([a-z0-9-]{1,40})$/.exec(url.pathname)
    const product = m ? PRODUCTS.find((p) => p.sku === m[1]) : undefined
    if (req.method !== 'GET' || !product || offer.prices[product.sku] === undefined) return body(res, 404, { simulated: true, error: 'not found' })
    const amount = offer.prices[product.sku]!
    const paid = req.headers['x-payment']
    const quote = (error: string): void => {
      const quoteId = `q_${randomBytes(6).toString('hex')}`
      const expiresAt = now() + QUOTE_TTL_MS
      quotes.set(quoteId, { sku: product.sku, amount, expiresAt, used: false })
      const q: X402Quote = { x402Version: 1, simulated: true, error, accepts: [{ scheme: 'exact', network: NETWORK, maxAmountRequired: String(amount), asset: 'INR-paise (paper)', resource: `http://${req.headers.host ?? '127.0.0.1'}${url.pathname}`, description: `${product.title}. A simulated service: nothing real is sold.`, mimeType: 'application/json', payTo: offer.payTo, maxTimeoutSeconds: QUOTE_TTL_MS / 1000, extra: { quoteId, expiresAt, service: offer.id, simulated: true, unit: 'paise' } }] }
      body(res, 402, q)
    }
    if (typeof paid !== 'string') return quote('payment required')
    let p: { quoteId?: unknown; paymentRef?: unknown; amount?: unknown; payTo?: unknown }
    try { p = JSON.parse(Buffer.from(paid, 'base64').toString('utf8')) as typeof p } catch { return quote('the X-PAYMENT header could not be read') }
    const q = typeof p.quoteId === 'string' ? quotes.get(p.quoteId) : undefined
    if (!q || q.used || q.sku !== product.sku) return quote('that quote is unknown or already used')
    if (now() > q.expiresAt) return quote('that quote has expired')
    if (p.payTo !== offer.payTo || Number(p.amount) !== q.amount) return quote('the payment does not match the quote')
    if (typeof p.paymentRef !== 'string' || !settled(p.paymentRef, q.amount, offer.payTo)) return quote('no settled payment was found for that reference')
    if (refs.has(p.paymentRef)) return quote('that payment has already been delivered against')
    refs.add(p.paymentRef)
    q.used = true
    body(res, 200, { simulated: true, sku: product.sku, title: product.title, service: offer.name, content: `${product.title} (synthetic). This text stands in for what a real service would deliver. Delivered by ${offer.name}, which is simulated.` },
      { 'x-payment-response': Buffer.from(JSON.stringify({ success: true, simulated: true, network: NETWORK, transaction: p.paymentRef, payTo: offer.payTo })).toString('base64') })
  })
}

/** Start both services. `settled` tells a service whether a paper-rail payment for that amount to its address has settled. */
export async function startSimServices(settled: Settled, now: () => number = Date.now): Promise<SimServices> {
  const servers: Server[] = []
  const services: SimService[] = []
  for (const offer of OFFERS) {
    const s = serve(offer, settled, now)
    await new Promise<void>((ok, bad) => { s.once('error', bad); s.listen(0, '127.0.0.1', ok) })
    servers.push(s)
    services.push({ id: offer.id, name: offer.name, payTo: offer.payTo, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, prices: offer.prices })
  }
  return { services, close: () => Promise.all(servers.map((s) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections() }))).then(() => undefined) }
}

let running: SimServices | null = null
export const simServices = (): SimServices | null => running
export const setSimServices = (s: SimServices | null): void => { running = s }
