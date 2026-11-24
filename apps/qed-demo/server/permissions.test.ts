/**
 * docs/PERMISSIONS.md is the API's permission table as the code enforces it (ASVS 5.0 V8.1.1: documented rules, enforced
 * from one table in code). It is generated from the routes (server/api.ts routeTable); this test fails if the committed
 * document and the code differ, and holds a few rows the R13 hardening decided.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeTable } from './api.ts'
import { permissionsDocument } from '../scripts/permissions.ts'

describe('the permission table', () => {
  it('the committed document is what the code enforces', async () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'docs', 'PERMISSIONS.md'), 'utf8')).toBe(await permissionsDocument())
  })

  it('resuming, clearing a pause and giving members authority need a passkey past its cool-off; reads take no transaction', () => {
    const at = (m: string, p: string) => routeTable().find((r) => r.method === m && r.path === p)!
    expect(at('POST', '/api/programs/:id/resume')).toMatchObject({ least: 'approver', checks: ['fresh passkey, past its cool-off'], transaction: 'one' })
    expect(at('POST', '/api/stop/clear').checks).toContain('fresh passkey, past its cool-off')
    expect(at('POST', '/api/vault/signers/add').checks).toContain('fresh passkey, past its cool-off')
    expect(at('POST', '/api/workspace/members')).toMatchObject({ least: 'admin', checks: ['fresh passkey'] })
    expect(at('GET', '/api/home').transaction).toBe('reads')
    expect(at('POST', '/api/auth/login')).toMatchObject({ session: false, transaction: 'own' })
    // every changing route is either one transaction or an async handler with its own
    expect(routeTable().filter((r) => r.method !== 'GET').every((r) => r.transaction === 'one' || r.transaction === 'own')).toBe(true)
  })
})
