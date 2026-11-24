/**
 * What the API sends to browsers (R13 hardening; ASVS 5.0 V3.4, V3.4.7, V4.1.1, V13.4.2, V13.4.7), against a stand-in build
 * folder (the real one is checked by scripts/security.ts on the built interface):
 *   - the page has a Content-Security-Policy made for that one response, with a nonce in every tag the build marked, no
 *     'unsafe-inline', a report address, and Trusted Types reported; it is never stored;
 *   - API answers allow nothing to load or run (default-src 'none');
 *   - only the interface's own kinds of file are served: a source map and an unknown kind are 404, and text types carry
 *     their character set;
 *   - browsers' violation reports are taken without the interface's headers, limited, and logged, never stored.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NONCE_PLACEHOLDER, REPORTS_PER_IP_MINUTE, startApi } from './api.ts'
import { loadConfig } from './core.ts'

const PORT = 20000 + Math.floor(Math.random() * 20000)
const dir = mkdtempSync(join(tmpdir(), 'qed-headers-'))
const dist = join(dir, 'dist')
const base = `http://127.0.0.1:${PORT}`
let api: ReturnType<typeof startApi>
beforeAll(() => {
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), `<!doctype html><html><head><meta property="csp-nonce" nonce="${NONCE_PLACEHOLDER}"><script type="module" crossorigin src="/assets/index-a.js" nonce="${NONCE_PLACEHOLDER}"></script><link rel="stylesheet" href="/assets/index-a.css" nonce="${NONCE_PLACEHOLDER}"></head><body><div id="root"></div></body></html>`)
  writeFileSync(join(dist, 'assets', 'index-a.js'), 'console.log(1)\n//# sourceMappingURL=index-a.js.map\n')
  writeFileSync(join(dist, 'assets', 'index-a.js.map'), '{"version":3,"sources":["../src/secret-source.ts"]}')
  writeFileSync(join(dist, 'assets', 'index-a.css'), 'body{color:red}')
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dist, 'notes.bak'), 'left behind by an editor')
  api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_WEB_DIST: dist, QED_PRESENTATION: '1' }))
})
afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
/** A GET with the Host header the page is opened at (fetch cannot set Host), as a small Response-like answer. */
function get(path: string): Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: `localhost:${PORT}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, headers: { get: (n: string) => { const v = res.headers[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v) } }, text: async () => body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the page\'s policy', () => {
  it('has a nonce of its own in every marked tag and the policy, no unsafe-inline, a report address, and is not stored', async () => {
    const [a, b] = [await get('/'), await get('/instructions/new')]
    const [ha, hb] = [await a.text(), await b.text()]
    const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9_-]{20,})'/.exec(csp)?.[1]
    const na = nonceOf(a.headers.get('content-security-policy') ?? ''), nb = nonceOf(b.headers.get('content-security-policy') ?? '')
    expect(na).toBeTruthy()
    expect(na).not.toBe(nb)
    expect(ha).not.toContain(NONCE_PLACEHOLDER)
    expect(ha.match(new RegExp(`nonce="${na}"`, 'g'))).toHaveLength(3)
    expect(hb).toContain(`nonce="${nb}"`)
    const csp = a.headers.get('content-security-policy')!
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/)
    expect(csp).toMatch(/script-src 'nonce-[^']+';/)
    expect(csp).toMatch(/style-src 'self' 'nonce-/)
    expect(csp).toMatch(/object-src 'none'/)
    expect(csp).toMatch(/base-uri 'none'/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    expect(csp).toMatch(/report-uri \/api\/csp-report/)
    expect(a.headers.get('content-security-policy-report-only')).toMatch(/require-trusted-types-for 'script'/)
    // report-uri only: given a report-to group too, Chrome batches reports up to a minute late (api.ts FILE_HEADERS)
    expect(csp).not.toMatch(/report-to/)
    expect(a.headers.get('cache-control')).toBe('no-store')
    expect(a.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('answers from the API allow nothing to load or run', async () => {
    const r = await get('/api/session')
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    expect(r.headers.get('permissions-policy')).toMatch(/camera=\(\).*usb=\(\).*publickey-credentials-get=\(self\)/)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
})

describe('files', () => {
  it('serves the interface\'s own kinds, never a source map or an unknown kind, and names text types\' character set', async () => {
    expect((await get('/assets/index-a.js')).status).toBe(200)
    const map = await get('/assets/index-a.js.map')
    expect(map.status).toBe(404)
    expect(await map.text()).not.toContain('secret-source')
    expect((await get('/notes.bak')).status).toBe(404)
    expect((await get('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    const js = await get('/assets/index-a.js')
    expect(js.headers.get('content-security-policy')).toMatch(/^default-src 'self'; script-src 'self'; style-src 'self';/)
    expect(js.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('the build writes the placeholder the server replaces (vite.config.ts html.cspNonce) and hides its source maps', () => {
    const vite = readFileSync(join(import.meta.dirname, '..', 'vite.config.ts'), 'utf8')
    expect(vite).toContain(`const CSP_NONCE_PLACEHOLDER = '${NONCE_PLACEHOLDER}'`)
    expect(vite).toMatch(/html: \{ cspNonce: CSP_NONCE_PLACEHOLDER \}/)
    expect(vite).toMatch(/sourcemap: 'hidden'/)
  })
})

describe('violation reports (V3.4.7)', () => {
  it('takes both formats without the interface\'s headers, logs each, and limits an address', async () => {
    const log = await import('./log.ts')
    const spy = vi.spyOn(log, 'log')
    const send = (type: string, body: unknown) => fetch(`${base}/api/csp-report`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })
    expect((await send('application/csp-report', { 'csp-report': { 'document-uri': `http://localhost:${PORT}/home?token=abc`, 'violated-directive': 'script-src', 'blocked-uri': 'inline' } })).status).toBe(204)
    expect((await send('application/reports+json', [{ type: 'csp-violation', body: { documentURL: `http://localhost:${PORT}/spend`, effectiveDirective: 'style-src-elem', blockedURL: 'https://evil.example/x.css' } }])).status).toBe(204)
    expect((await send('text/plain', {})).status).toBe(415)
    const lines = spy.mock.calls.filter((c) => c[2] === 'csp-violation').map((c) => c[3] as Record<string, unknown>)
    expect(lines.map((l) => l.directive)).toEqual(['script-src', 'style-src-elem'])
    expect(api.ctx.db.get(`SELECT COUNT(*) n FROM audit`)).toEqual({ n: 0 })
    let limited = 0
    for (let i = 0; i < REPORTS_PER_IP_MINUTE + 3; i++) if ((await send('application/csp-report', { 'csp-report': {} })).status === 429) limited++
    expect(limited).toBeGreaterThan(0)
    spy.mockRestore()
  })
})
