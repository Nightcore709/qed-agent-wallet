/**
 * R13 review fix F3 (i): QED_KEK stays in no process's initial environment (server/kek-handoff.ts), and the container's
 * isolation check reads /proc correctly (scripts/deploy/isolation-check.ts, its logic on a fake /proc here; the check
 * itself runs only inside the Linux container: NOT VERIFIED on this QED installation).
 *
 * On macOS `ps -E` prints the environment the kernel recorded when a process started, like /proc/<pid>/environ on Linux.
 * The control shows the finding (deleting the variable leaves it there); the hand-off shows the fix (the re-executed
 * process, same pid, no longer has it).
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { kekHandoff } from './kek-handoff.ts'
import { kekHolders, kekSecrets, readProcs, treeOf } from '../scripts/deploy/isolation-check.ts'

const RECORD = 'qedkek1:test-id:' + 'K'.repeat(43) + ':chk'
const dirs: string[] = []
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'qed-kek-handoff-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** The kernel's record of a process's starting environment (Linux /proc; macOS ps -E). */
const kernelEnv = (pid: number): string => (existsSync(`/proc/${pid}/environ`) ? readFileSync(`/proc/${pid}/environ`, 'utf8') : execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))

/** Starts `code` with QED_KEK set; resolves with the pid it reports and the kernel's record of its environment then. */
function run(code: string, secrets: string): Promise<{ firstPid: number; pid: number; env: string; keyFile: string | null }> {
  const file = join(temp(), 'child.mts')
  writeFileSync(file, code)
  return new Promise((done, fail) => {
    const c = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? '', QED_KEK: RECORD, QED_SECRETS_DIR: secrets }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    c.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /^ready (\d+) (\d+) (\S+)$/m.exec(out)
      if (m) {
        const env = kernelEnv(Number(m[2]))
        c.kill()
        done({ firstPid: Number(m[1]), pid: Number(m[2]), env, keyFile: m[3] === '-' ? null : m[3]! })
      }
    })
    c.on('error', fail)
  })
}

const handoff = new URL('./kek-handoff.ts', import.meta.url).pathname

describe('R13 review fix F3: QED_KEK is handed off, not kept in any initial environment', () => {
  it('the finding: deleting QED_KEK from process.env leaves it in the environment the kernel recorded', async () => {
    const r = await run(`import { writeSync } from 'node:fs'
delete process.env.QED_KEK
writeSync(1, 'ready ' + process.pid + ' ' + process.pid + ' -\\n'); setInterval(() => {}, 1000)`, temp())
    expect(r.env).toContain(RECORD)
  })

  it('the fix: the entry point writes it to a private file and re-executes itself, same pid, without it', async () => {
    const secrets = join(temp(), 'run-qed')
    const r = await run(`import { writeSync } from 'node:fs'
import { reexecWithoutKek } from ${JSON.stringify(handoff)}
const first = process.env.FIRST_PID ?? String(process.pid)
if (!process.env.FIRST_PID) process.env.FIRST_PID = first
reexecWithoutKek(process.env.QED_SECRETS_DIR)
writeSync(1, 'ready ' + first + ' ' + process.pid + ' ' + (process.env.QED_KEY_FILE ?? '-') + '\\n'); setInterval(() => {}, 1000)`, secrets)
    expect(r.pid).toBe(r.firstPid) // execve: the same process
    expect(r.env).not.toContain(RECORD)
    expect(r.env).not.toContain('QED_KEK=')
    expect(r.env).toContain(`QED_KEY_FILE=${join(secrets, 'qed.kek')}`)
    expect(r.keyFile).toBe(join(secrets, 'qed.kek'))
    expect(readFileSync(r.keyFile!, 'utf8')).toBe(`${RECORD}\n`)
    expect(statSync(r.keyFile!).mode & 0o777).toBe(0o600)
    expect(statSync(secrets).mode & 0o777).toBe(0o700)
  })

  it('refuses a malformed record and QED_KEY_FILE set as well; does nothing without QED_KEK', () => {
    const d = temp()
    expect(kekHandoff({ PATH: '/bin' }, d)).toBeNull()
    expect(() => kekHandoff({ QED_KEK: 'not a record' }, d)).toThrow(/not a key-encryption key record/)
    expect(() => kekHandoff({ QED_KEK: RECORD, QED_KEY_FILE: '/k' }, d)).toThrow(/both QED_KEK and QED_KEY_FILE/)
    const h = kekHandoff({ QED_KEK: ` ${RECORD}\n`, PATH: '/bin' }, d)!
    expect(h.env).toEqual({ PATH: '/bin', QED_KEY_FILE: join(d, 'qed.kek') })
  })

  it('the isolation check reads a /proc: the tree under process 1, and every environment that holds QED_KEK or the key', () => {
    const root = temp()
    const proc = (pid: number, ppid: number, uid: number, cmd: string, env: string[], caps = '0000000000000000') => {
      mkdirSync(join(root, String(pid)))
      writeFileSync(join(root, String(pid), 'status'), `Name:\tnode\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapPrm:\t${caps}\nCapEff:\t${caps}\nCapAmb:\t${caps}\nNoNewPrivs:\t1\n`)
      writeFileSync(join(root, String(pid), 'cmdline'), cmd.split(' ').join('\0'))
      writeFileSync(join(root, String(pid), 'environ'), env.join('\0'))
    }
    const key = 'K'.repeat(43)
    proc(1, 0, 0, '/usr/bin/tini -- entrypoint.sh', ['PATH=/bin', 'QED_KEY_FILE=/run/qed/qed.kek'])
    proc(7, 1, 1000, 'node supervise.ts', ['PATH=/bin'], '00000000000000c0')
    proc(9, 7, 1000, 'node /app/chain/serve.ts', ['PATH=/bin', `LEAKED=${key}`])
    proc(11, 9, 999, 'node --import tsx /app/chain/rail/cosigner-main.ts', ['HOME=/tmp/x'])
    proc(40, 0, 0, 'node isolation-check.ts', [`QED_KEK=${RECORD}`]) // a docker exec: not under process 1
    const procs = readProcs(root)
    expect(procs.map((p) => p.pid).sort((a, b) => a - b)).toEqual([1, 7, 9, 11, 40])
    const sup = procs.find((p) => p.pid === 7)!
    expect([sup.capEff, sup.capAmb, sup.uid, sup.noNewPrivs]).toEqual([0xc0n, 0xc0n, 1000, true])
    const tree = treeOf(procs, 1)
    expect([...tree].sort((a, b) => a - b)).toEqual([1, 7, 9, 11])
    expect(kekSecrets(RECORD)).toEqual([key, RECORD])
    expect(kekSecrets('nonsense')).toEqual([])
    // the key itself is found under another name; the exec'd check's own environment is not scanned
    expect(kekHolders(tree, kekSecrets(RECORD), root)).toEqual({ holders: [9], unread: [] })
    writeFileSync(join(root, '9', 'environ'), ['PATH=/bin', `QED_KEK=x`].join('\0'))
    expect(kekHolders(tree, [], root).holders).toEqual([9])
    writeFileSync(join(root, '9', 'environ'), 'PATH=/bin')
    expect(kekHolders(tree, kekSecrets(RECORD), root)).toEqual({ holders: [], unread: [] })
  })
})
