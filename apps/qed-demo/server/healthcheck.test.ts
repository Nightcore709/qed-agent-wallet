import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_ROOT } from './core.ts'
import { probe, probeTarget } from '../scripts/deploy/healthcheck.ts'

const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close() })
async function api(answer: (host: string, path: string) => number): Promise<number> {
  const s = createServer((req, res) => { res.statusCode = answer(String(req.headers.host), req.url ?? ''); res.end('{}') })
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok)); servers.push(s)
  return (s.address() as { port: number }).port
}

describe('the container health check', () => {
  it('chooses a Host the API accepts: the health host first, else the public origin, else none', () => {
    expect(probeTarget({ PORT: '8080', QED_EXTRA_HOSTS: 'healthcheck.railway.app', QED_PUBLIC_ORIGIN: 'https://q.example.com' })).toEqual({ port: 8080, host: 'healthcheck.railway.app', path: '/api/live' })
    expect(probeTarget({ PORT: '8080', QED_PUBLIC_ORIGIN: 'https://q.example.com' }).host).toBe('q.example.com')
    expect(probeTarget({ QED_API_PORT: '9000', PORT: '8080' })).toEqual({ port: 9000, host: undefined, path: '/api/live' })
  })
  it('answers the status of /api/live with the Host it chose, and 0 when nothing listens', async () => {
    const port = await api((host, path) => (host === 'q.example.com' && path === '/api/live' ? 200 : 421))
    expect(await probe({ PORT: String(port), QED_PUBLIC_ORIGIN: 'https://q.example.com' })).toBe(200)
    expect(await probe({ PORT: String(port) })).toBe(421)
    expect(await probe({ PORT: '1' }, 500)).toBe(0)
  })
  it('exits 0 on a 2xx and 1 otherwise, run as the image runs it', async () => {
    const good = await api(() => 200), bad = await api(() => 503)
    // asynchronous: the fake API is in this process and must keep answering while the child runs
    const run = (port: number) => new Promise<number | null>((done) => spawn(process.execPath, [join(APP_ROOT, 'scripts', 'deploy', 'healthcheck.ts')], { env: { PATH: process.env.PATH, PORT: String(port) } }).on('exit', (c) => done(c)))
    expect(await run(good)).toBe(0)
    expect(await run(bad)).toBe(1)
  })
})
