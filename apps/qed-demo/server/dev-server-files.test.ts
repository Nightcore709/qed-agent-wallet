/**
 * The development server (Vite, `npm run dev`; the owner's review build on 5174) serves every file under the app
 * folder by its path. data/ holds the running service's state: the database and its copies, the rail token, the
 * review account's sign-in and fixture sessions. Until 23 Nov 2026 the dev server returned them byte for byte
 * (`/data/review-account.json`, `/data/qed.db`); vite.config.ts now refuses the folder. This starts a dev server
 * with the project's own config and asks for a file placed in data/ by every path that reached it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'

const app = join(import.meta.dirname, '..')
const probeName = `.deny-probe-${process.pid}.json`
const probe = join(app, 'data', probeName)
let server: ViteDevServer
let base = ''

beforeAll(async () => {
  mkdirSync(join(app, 'data'), { recursive: true })
  writeFileSync(probe, '{"probe":"must not be served"}\n')
  server = await createServer({
    configFile: join(app, 'vite.config.ts'),
    root: app,
    logLevel: 'silent',
    clearScreen: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, ws: false },
  })
  await server.listen()
  base = (server.resolvedUrls?.local[0] ?? '').replace(/\/$/, '')
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(probe, { force: true })
})

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const r = await fetch(`${base}${path}`)
  return { status: r.status, body: await r.text() }
}

it('refuses a file in data/ by its path, by /@fs/, encoded and with a query', async () => {
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  for (const path of [
    `/data/${probeName}`,
    `/@fs${join(app, 'data', probeName)}`,
    `/%64ata/${probeName}`,
    `/data/${probeName}?raw`,
    `/data/${probeName}?import`,
  ]) {
    const r = await get(path)
    expect(r.body, path).not.toContain('must not be served')
    expect(r.status, path).toBe(403)
  }
})

// /DATA/ names data/ itself only where the volume ignores letter case (macOS's default APFS): there it is refused like
// /data/. On a case-sensitive volume (Linux's ext4, as on GitHub's ubuntu-24.04 runner) it names a folder that does not
// exist, and the server answers 200 with the app page, as for any unknown address; the body shows no file was served.
it('in another case: refused where the volume finds data/ by that name; elsewhere the app page, never the file', async () => {
  const path = `/DATA/${probeName}`
  const r = await get(path)
  expect(r.body, path).not.toContain('must not be served')
  if (existsSync(join(app, 'DATA', probeName))) expect(r.status, path).toBe(403)
  else expect(r.body, path).toContain('<div id="root">')
})

it('a doubled slash gets the app page, not the file', async () => {
  const r = await get(`//data/${probeName}`)
  expect(r.body).not.toContain('must not be served')
  expect(r.body).toContain('<div id="root">')
})

it('still serves the interface itself', async () => {
  expect((await get('/')).status).toBe(200)
  expect((await get('/src/main.tsx')).status).toBe(200)
  expect((await get('/src/styles/app.css')).status).toBe(200)
})
