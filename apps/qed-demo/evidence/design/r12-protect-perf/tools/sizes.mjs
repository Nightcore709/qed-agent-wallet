// Per endpoint: status, raw JSON bytes, Brotli bytes on the wire, server time (best of 3), for one fixture file.
import { readFileSync } from 'node:fs'
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const paths = ['/api/session', '/api/programs', '/api/liquidity', '/api/home', '/api/security', '/api/vault', '/api/payees', '/api/engine', '/api/notify', '/api/vault/signers']
for (const p of paths) {
  let best = Infinity, status = 0, wire = 0, raw = 0
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const r = await fetch(fx.base + p, { headers: { cookie: fx.cookie, 'accept-encoding': 'br' } })
    const body = Buffer.from(await r.arrayBuffer())
    best = Math.min(best, performance.now() - t0)
    status = r.status; wire = Number(r.headers.get('content-length') ?? 0); raw = body.length
  }
  console.log(`${p.padEnd(20)} ${status}  raw ${String(raw).padStart(7)} B  wire ${String(wire).padStart(6)} B  ${best.toFixed(1)} ms`)
}
