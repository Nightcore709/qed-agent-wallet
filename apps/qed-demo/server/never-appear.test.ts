/**
 * The published testnet keys must never appear in this repository (scripts/never-appear.ts; R13 hardening, brief item 1,
 * "dependency and secret hygiene"; DECISION-NOTES-SE6 section 1). The check is shown able to fail: a key made for this test
 * and planted in a file, with its address put on a list, is found, by file and line, without the key being printed; a
 * near miss (63 or 65 digits, or the key with one digit changed) is not. The list itself names the two published keys by
 * the addresses the release's own Sepolia evidence records for the honeypot vault's agent and co-signer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addressOf, NEVER_APPEAR, scan } from '../scripts/never-appear.ts'

describe('the must-never-appear check', () => {
  it('finds a planted key by its address, names the file and line, never the value, and ignores near misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-never-'))
    try {
      const key = randomBytes(32).toString('hex')
      const list = [{ name: 'a key made for this test', address: addressOf(key)!, source: 'this test' }]
      writeFileSync(join(dir, 'config.json'), `{\n  "agent": "0x${key}"\n}\n`)
      writeFileSync(join(dir, 'notes.md'), `copied without its prefix:\n\n${key.toUpperCase()}\n`)
      const flipped = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')
      writeFileSync(join(dir, 'near.txt'), `${key.slice(1)} ${key}a ${flipped}\n`)
      const r = scan(dir, ['config.json', 'notes.md', 'near.txt'], list)
      expect(r.hits).toEqual([{ file: 'config.json', line: 2, name: 'a key made for this test' }, { file: 'notes.md', line: 3, name: 'a key made for this test' }])
      expect(JSON.stringify(r)).not.toContain(key)
      // the published keys' list does not match this key
      expect(scan(dir, ['config.json'], NEVER_APPEAR).hits).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('names the two published keys by the addresses the release\'s Sepolia evidence gives the honeypot\'s agent and co-signer', () => {
    const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'chain', 'vendor', 'evidence', 'ethereum-sepolia', 'manifest.json'), 'utf8')) as { actors: Record<string, string>; steps: { id?: string; events?: { name: string; args: Record<string, string> }[] }[] }
    const d5 = m.steps.find((s) => s.id === 'D5')!.events!
    const fromEvents = [d5.find((e) => e.name === 'AgentSet')!.args.agent, d5.find((e) => e.name === 'CosignerSet')!.args.cosigner]
    expect(NEVER_APPEAR.map((x) => x.address)).toEqual([m.actors.hpAgent, m.actors.hpCosigner])
    expect(NEVER_APPEAR.map((x) => x.address)).toEqual(fromEvents)
  })

  it('a value that is not a key (zero, or past the curve\'s order) is read as nothing', () => {
    expect(addressOf('0'.repeat(64))).toBeNull()
    expect(addressOf('f'.repeat(64))).toBeNull()
  })
})
