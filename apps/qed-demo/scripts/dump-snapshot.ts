/** Writes a snapshot of the review account's live API responses for design sketches. node scripts/dump-snapshot.ts <out.js> */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = `http://127.0.0.1:${process.env.QED_API_PORT ?? 5175}`
const cred = JSON.parse(readFileSync(join(app, 'data', 'review-account.json'), 'utf8')) as { handle: string; password: string }
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qed-client': 'web' }, body: JSON.stringify({ handle: cred.handle, password: cred.password }) })
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const get = async (p: string) => (await fetch(base + p, { headers: { cookie } })).json() as Promise<Record<string, unknown>>
const programs = (await get('/api/programs')) as { programs: { id: string; kind: string }[] }
const details: Record<string, unknown> = {}
for (const p of programs.programs) details[p.id] = await get(`/api/programs/${p.id}`)
const out = { takenAt: Date.now(), home: await get('/api/home'), programs, details, activity: await get('/api/activity'), ledger: await get('/api/ledger?limit=40'), market: await get('/api/market'), receipts: await get('/api/receipts?limit=10'), system: await get('/api/system'), liquidity: await get('/api/liquidity'), passbook: await get('/api/passbook?limit=12') }
writeFileSync(process.argv[2]!, `window.DATA = ${JSON.stringify(out)};\n`)
console.log(`wrote ${process.argv[2]} (${programs.programs.length} instructions)`)
