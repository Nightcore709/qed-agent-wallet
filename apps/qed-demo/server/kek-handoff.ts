/**
 * R13 review fix F3 (i): no process keeps the key-encryption key in its initial environment.
 *
 * Deleting QED_KEK from process.env removes it from what a process passes on to its children, not from the environment
 * block the kernel recorded when the process started: on Linux /proc/<pid>/environ, which any other process of the same
 * user can read (on macOS `ps -E` shows the same block). So an entry point that finds QED_KEK writes it to a private file
 * (mode 600, in a folder of mode 700) and replaces itself (execve: the same process id, a new image) with an environment
 * that names the file in QED_KEY_FILE and no longer holds the key. Used by the supervisor (scripts/deploy/supervise.ts)
 * and by the wallet service's own start (chain/serve.ts). In the container the entrypoint does the same before any Node
 * process starts (scripts/deploy/entrypoint.sh), so that not even process 1 keeps it.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The form `npm run keys:init` gives a key-encryption key record. */
export const KEK_RECORD = /^qedkek1:[^\s:]+:[^\s:]+:[^\s:]+$/

/**
 * Writes QED_KEK to `<secretsDir>/qed.kek` and returns the environment to continue with (QED_KEY_FILE set, QED_KEK
 * absent), or null when QED_KEK is not set. Refuses a malformed record and a QED_KEY_FILE set as well.
 */
export function kekHandoff(env: Record<string, string | undefined>, secretsDir: string): { file: string; env: Record<string, string> } | null {
  const v = env.QED_KEK
  if (v === undefined || v === '') return null
  if (env.QED_KEY_FILE) throw new Error('both QED_KEK and QED_KEY_FILE are set; set one')
  if (!KEK_RECORD.test(v.trim())) throw new Error('QED_KEK is not a key-encryption key record (qedkek1:<id>:<key>:<check>, made by npm run keys:init)')
  const dir = resolve(secretsDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'qed.kek')
  writeFileSync(file, `${v.trim()}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  const next: Record<string, string> = {}
  for (const [k, x] of Object.entries(env)) if (k !== 'QED_KEK' && x !== undefined) next[k] = x
  next.QED_KEY_FILE = file
  return { file, env: next }
}

type Execve = (file: string, args: string[], env: Record<string, string>) => never

/**
 * If QED_KEK is set: writes it to the private file and re-executes this process (same pid, same arguments and Node
 * options) without it. Returns only when QED_KEK is not set, which is the case in the re-executed process.
 */
export function reexecWithoutKek(secretsDir: string): void {
  const h = kekHandoff(process.env, secretsDir)
  if (!h) return
  const execve = (process as unknown as { execve?: Execve }).execve
  if (typeof execve !== 'function') throw new Error('this platform cannot re-execute a process (process.execve); give the key-encryption key as a file (QED_KEY_FILE) instead of QED_KEK')
  execve.call(process, process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], h.env)
}
