/** The built interface is sent compressed when the browser accepts it (server/api.ts encodingFor, compressed). */
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compressed, compressibleRead, encodingFor } from './api.ts'

describe('static compression', () => {
  it('prefers Brotli, falls back to gzip, and leaves binaries and fonts alone', () => {
    expect(encodingFor('gzip, deflate, br, zstd', '/x/app.js')).toBe('br')
    expect(encodingFor('gzip, deflate', '/x/app.css')).toBe('gzip')
    expect(encodingFor('', '/x/app.js')).toBeNull()
    expect(encodingFor('br', '/x/font.woff2')).toBeNull()
    expect(encodingFor('br', '/x/photo.png')).toBeNull()
    expect(encodingFor('identity', '/x/index.html')).toBeNull()
  })
  it('round-trips exactly, and a changed file is compressed again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-static-'))
    const file = join(dir, 'app.js')
    const text = 'export const a = 1;\n'.repeat(400)
    writeFileSync(file, text)
    expect(brotliDecompressSync(compressed(file, 'br')).toString()).toBe(text)
    expect(gunzipSync(compressed(file, 'gzip')).toString()).toBe(text)
    expect(compressed(file, 'br').length).toBeLessThan(Buffer.byteLength(text) / 10)
    const changed = text + 'export const b = 2;\n'
    writeFileSync(file, changed)
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(brotliDecompressSync(compressed(file, 'br')).toString()).toBe(changed)
  })
  it('compresses reads of data, never the session, sign-in or step-up, nor a change (BREACH: a secret beside page-influenced data)', () => {
    for (const p of ['/api/home', '/api/vault', '/api/market', '/api/activity']) expect(compressibleRead('GET', p), p).toBe(true)
    for (const p of ['/api/session', '/api/auth/passkey/login/begin', '/api/security/stepup', '/api/events', '/api/health']) expect(compressibleRead('GET', p), p).toBe(false)
    expect(compressibleRead('POST', '/api/home')).toBe(false)
  })
})
