/**
 * R7-075: what the code gives each process and where secrets live (docs/LEAST-PRIVILEGE.md), checked against the source: the
 * schema holds no raw secret column; the co-signer is started with exactly the environment the document lists (no key
 * setting: R13) and opens no keyring, and the API process never names the co-signer's key file; no engine or API module
 * reads the vault service's private key variables. The real child's environment is checked on a running process by
 * chain/test/cosigner-key-pipe.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from './core.ts'
import { checkKeyFile, cosignerCommand, cosignerEnv, cosignerRecordsDir, KEYS_FD } from '../chain/rail/cosigner-env.ts'
import { withoutCaps } from '../chain/rail/caps.ts'

const here = new URL('.', import.meta.url).pathname
const read = (p: string): string => readFileSync(join(here, p), 'utf8')

describe('least privilege, per process', () => {
  it('no table holds a raw secret: no column is named for a private key, a secret, a seed or a token value', () => {
    const db = openDb(':memory:')
    const bad: string[] = []
    for (const t of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)) {
      for (const c of db.all<{ name: string }>(`PRAGMA table_info(${t.name})`)) if (/(^|_)(private_key|secret|seed|mnemonic|api_key|token)(_|$)/i.test(c.name) && !/(hash|digest|id|kind|state|expires|at|count|ref)$/i.test(c.name)) bad.push(`${t.name}.${c.name}`)
    }
    expect(bad).toEqual([])
  })

  it('the co-signer is started with exactly PATH, HOME, NODE_NO_WARNINGS, TSX_DISABLE_CACHE and its two paths: no key setting, whatever the rail holds; its HOME is an empty folder of its own (R13 review fix F3)', () => {
    // the rail's own environment as a sealing review build has it, with every key setting and a key-encryption key
    const rail = { PATH: '/usr/bin', HOME: '/home/q', QED_RAIL_SEAL: '1', QED_KEY_DIR: '/k', QED_KEY_FILE: '/k/qed.kek', QED_KEK: 'k'.repeat(64), QED_RAIL_TOKEN: 't', QED_DB: '/d/qed.db', NODE_OPTIONS: '--inspect' }
    const env = cosignerEnv({ stateFile: '/r/cosigner-state.json', vendorRoot: '/v', home: '/tmp/qed-cosigner-home-x' }, rail)
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_NO_WARNINGS', 'PATH', 'QED_COSIGNER_STATE', 'QED_COSIGNER_VENDOR_ROOT', 'TSX_DISABLE_CACHE'])
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/qed-cosigner-home-x', NODE_NO_WARNINGS: '1', QED_COSIGNER_STATE: '/r/cosigner-state.json', QED_COSIGNER_VENDOR_ROOT: '/v', TSX_DISABLE_CACHE: '1' })
    expect(JSON.stringify(env)).not.toMatch(/QED_KEY|QED_KEK|QED_RAIL_SEAL|kkkk|qed\.kek|cosigner\.key|\/home\/q/)
    // the spawn uses that function and nothing else for the environment, with a HOME made empty for it, and hands the
    // keys over on fd 4
    const src = readFileSync(join(here, '../chain/rail/cosigner-client.ts'), 'utf8') // the spawn itself
    expect(/env: cosignerEnv\(\{ \.\.\.this\.opts, home: this\.home \}\),/.test(src)).toBe(true)
    expect(/this\.home = mkdtempSync\(join\(tmpdir\(\), "qed-cosigner-home-"\)\)/.test(src)).toBe(true)
    expect(src).not.toMatch(/\benv: \{/) // no environment written inline beside it
    expect([...src.matchAll(/= spawn\(cmd\.file, cmd\.args/g)].length).toBe(1) // one child process, started in one place
    expect(src).toMatch(/cmd = cosignerCommand\(\["--import", "tsx"/)
    expect(src).toMatch(/stdio: \["ignore", "ignore", "inherit", "ipc", "pipe"\]/)
    expect(KEYS_FD).toBe(4)
  })

  it('R13 review fix F3: with QED_COSIGNER_UID and QED_COSIGNER_GID set, the co-signer starts through setpriv as that user with no capability; every other child of the container drops the two it keeps', () => {
    const entry = ['--import', 'tsx', '/app/chain/rail/cosigner-main.ts']
    // outside the container: as this process's own user, unchanged
    expect(cosignerCommand(entry, { PATH: '/usr/bin' })).toEqual({ file: process.execPath, args: entry })
    expect(withoutCaps('/usr/local/bin/anvil', ['--port', '1'], { PATH: '/usr/bin' })).toEqual({ file: '/usr/local/bin/anvil', args: ['--port', '1'] })
    // in the container: another user, no supplementary group, no capability, no new privileges
    const c = cosignerCommand(entry, { QED_COSIGNER_UID: '999', QED_COSIGNER_GID: '998' })
    expect(c).toEqual({ file: '/usr/bin/setpriv', args: ['--reuid=999', '--regid=998', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', process.execPath, ...entry] })
    expect(withoutCaps('/usr/local/bin/anvil', ['--port', '1'], { QED_COSIGNER_UID: '999' })).toEqual({ file: '/usr/bin/setpriv', args: ['--inh-caps=-all', '--ambient-caps=-all', '--', '/usr/local/bin/anvil', '--port', '1'] })
    // never root, never half set
    for (const bad of [{ QED_COSIGNER_UID: '0', QED_COSIGNER_GID: '998' }, { QED_COSIGNER_UID: '999' }, { QED_COSIGNER_UID: '999', QED_COSIGNER_GID: 'x' }]) expect(() => cosignerCommand(entry, bad)).toThrow(/unprivileged user/)
    // the supervisor keeps the two capabilities for the wallet service only; the API, the engine and one-off commands drop them
    const sup = readFileSync(join(here, '../scripts/deploy/supervise.ts'), 'utf8')
    expect(sup).toMatch(/const wallet = new Child\(\{ name: 'wallet'.*keepCaps: true \}\)/)
    expect(sup).not.toMatch(/const (engine|api) = new Child\(\{[^\n]*keepCaps/)
    expect(sup).toMatch(/withoutCaps\(process\.execPath, args, env\)/)
    // the wallet service's other children: the local chains and an economy's agent
    for (const f of ['anvil.ts', 'economies.ts']) expect(readFileSync(join(here, '../chain/rail', f), 'utf8')).toMatch(/const cmd = withoutCaps\(/)
    // the container: a separate user in the image; the entrypoint makes the co-signer's folder its own and starts the supervisor with only those two capabilities
    expect(readFileSync(join(here, '../Dockerfile'), 'utf8')).toMatch(/useradd --system --user-group [^\n]* qedcosign/)
    const ep = readFileSync(join(here, '../scripts/deploy/entrypoint.sh'), 'utf8')
    expect(ep).toMatch(/chown -R qedcosign:qedcosign "\$cosigner_dir"/)
    expect(ep).toMatch(/--ambient-caps=\+setuid,\+setgid/)
    expect(ep).toMatch(/--bounding-set=-all,\+setuid,\+setgid --no-new-privs/)
    expect(ep).toMatch(/exec env -u QED_KEK QED_KEY_FILE=/)
    // independent review of the fixes, M1 and M2: root follows no link the service's user left; no tsx file cache
    expect(ep).toMatch(/rm -rf "\$secrets"\n\s+mkdir -m 700 "\$secrets"/)
    expect(ep).toMatch(/set -C && printf/)
    expect(ep).toMatch(/refuse_link "\$data" "\$secrets" "\$secrets\/qed\.kek" "\$cosigner_dir"/)
    expect(ep).not.toMatch(/chown node:node "\$secrets/)
    expect(readFileSync(join(here, '../Dockerfile'), 'utf8')).toMatch(/TSX_DISABLE_CACHE=1/)
  })

  it('R14: a co-signer with a folder of its own keeps its decision records there, never in the wallet service\'s data folder, which its user cannot enter', () => {
    // the container (scripts/deploy/entrypoint.sh): /data/cosigner is the co-signer user's, /data/app (mode 700) the service's
    expect(cosignerRecordsDir('/data/cosigner', 'qed-be6628307fc62b0df071f7ce', '/data/app/rail/workspaces/qed-be6628307fc62b0df071f7ce/records')).toBe('/data/cosigner/records/qed-be6628307fc62b0df071f7ce')
    expect(cosignerRecordsDir('/data/cosigner/', 'baseline', '/data/app/rail/records')).toBe('/data/cosigner/records/baseline')
    // no folder of its own (a development machine, one user): the workspace's own records folder, as before
    for (const none of [null, undefined, '']) expect(cosignerRecordsDir(none, 'alice-home', '/r/workspaces/alice-home/records')).toBe('/r/workspaces/alice-home/records')
    // a scope is a single path component: nothing else is ever joined to the co-signer's folder
    for (const bad of ['../app', 'a/b', '', '.', 'A_b', 'x'.repeat(64)]) expect(() => cosignerRecordsDir('/data/cosigner', bad, '/r')).toThrow(/scope/)
    // the wallet service asks this rule for every workspace's co-signer configuration, the baseline's included
    const host = readFileSync(join(here, '../chain/rail/host.ts'), 'utf8')
    expect(host.match(/recordsDir: this\.cosignerRecords\(/g)?.length).toBe(2)
    expect(host).not.toMatch(/configure\(\{[^\n]*recordsDir: ws\.recordsDir/)
    // and the container's entrypoint gives the co-signer's user that folder, records included (chown -R; mode 700)
    const entry = readFileSync(join(here, '../scripts/deploy/entrypoint.sh'), 'utf8')
    expect(entry).toMatch(/chown -R qedcosign:qedcosign "\$cosigner_dir"/)
    expect(entry).toMatch(/QED_COSIGNER_STATE_DIR="\$cosigner_dir"/)
  })

  it('R14: the co-signer is never handed the chain\'s own socket when it has a door: the wallet service gives it the read-only door, in a folder of the service\'s user and the co-signer\'s group', () => {
    const host = readFileSync(join(here, '../chain/rail/host.ts'), 'utf8')
    // every co-signer configuration takes its socket from one place, which prefers the door
    expect(host).not.toMatch(/chainSocket: this\.anvil\.socketPath/)
    expect(host.match(/chainSocket: this\.cosignerChainSocket/g)?.length).toBe(2)
    expect(host).toMatch(/private get cosignerChainSocket\(\): string \{ return this\.chainDoor\?\.path \?\? this\.anvil\.socketPath; \}/)
    // a co-signer that runs as another user and has no door stops the start, in words
    expect(host).toMatch(/process\.env\.QED_COSIGNER_UID\) throw new Error\("The co-signer runs as its own user and has no way to read the chain/)
    // the door is opened before the co-signer exists
    expect(host.indexOf('await this.openChainDoor();')).toBeGreaterThan(0)
    expect(host.indexOf('await this.openChainDoor();')).toBeLessThan(host.indexOf('this.cosigner = await this.makeCosigner();'))
    const entry = readFileSync(join(here, '../scripts/deploy/entrypoint.sh'), 'utf8')
    expect(entry).toMatch(/door=\/run\/qed-chain-door\n  refuse_link "\$door"\n  rm -rf "\$door"\n  mkdir -m 750 "\$door"\n  chown node:qedcosign "\$door"\n  chmod 2750 "\$door"/)
    expect(entry).toMatch(/export QED_COSIGNER_UID QED_COSIGNER_GID QED_COSIGNER_STATE_DIR QED_COSIGNER_CHAIN_DIR/)
    // the co-signer still starts with no supplementary group: the door's group is its own primary group
    expect(cosignerCommand(['x'], { QED_COSIGNER_UID: '999', QED_COSIGNER_GID: '999' }).args).toContain('--clear-groups')
  })

  it('the co-signer\'s own code opens no keyring: it imports no key-handling module and reads its keys from the rail\'s pipe', () => {
    const src = readFileSync(join(here, '../chain/rail/cosigner-main.ts'), 'utf8')
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!)
    expect(imports.filter((i) => /sealed-at-rest|key-config|\/keys\.ts|keyring/.test(i))).toEqual([])
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).not.toMatch(/QED_KEY_DIR|QED_KEY_FILE|QED_KEK|QED_RAIL_SEAL|openKeyring|readSecret|writeSecret/)
    expect(code).toMatch(/readFileSync\(KEYS_FD\)/)
    expect(code).toMatch(/const KEYS_FD = 4;/)
  })

  it('a key file handed to the co-signer, or sent back by it, has the documented form or is refused', () => {
    const k = `0x${'ab'.repeat(32)}`
    expect(() => checkKeyFile(Buffer.from(JSON.stringify({ baseline: { 1: k }, 'ws-a': { 1: k, 2: k } })))).not.toThrow()
    expect(() => checkKeyFile(Buffer.from(JSON.stringify({ 1: k, 2: k })))).not.toThrow() // the legacy layout
    for (const bad of ['not json', '[]', JSON.stringify({ ws: { one: k } }), JSON.stringify({ ws: { 1: '0x12' } }), JSON.stringify({ ws: [k] })]) {
      expect(() => checkKeyFile(Buffer.from(bad))).toThrow(/key file/)
    }
  })

  it('no server module (the API, the engine, the tools) reads the co-signer\'s key file or the wallet-secret keyring directly', () => {
    const offenders: string[] = []
    for (const f of readdirSync(here).filter((n) => n.endsWith('.ts') && !/\.test\.|fixture|testkit/.test(n))) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      if (/QED_COSIGNER_KEYFILE|cosigner\.keys|cosigner-keys/.test(src)) offenders.push(`${f}: names the co-signer's key file`)
      if (/openKeyring\(\s*'wallet-secret'/.test(src)) offenders.push(`${f}: opens the wallet-secret keyring`)
    }
    expect(offenders).toEqual([])
  })
})
