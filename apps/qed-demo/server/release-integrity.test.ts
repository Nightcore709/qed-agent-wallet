/**
 * The release-unchanged check (R13 SE5; R7-003): detects a changed, added or removed file, never writes under the
 * release, and the recorded manifest is consistent. The real release folder is checked by `npm run release:check`,
 * not here, so this suite does not depend on a folder outside the workspace.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertOutsideRelease, buildManifest, checkRelease, hashTree, isUnchanged, readManifest, treeDigest, writeManifest } from './release-integrity.ts'

const made: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'qed-rel-'))
  made.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'alpha')
  writeFileSync(join(root, 'src', 'b.txt'), 'beta')
  writeFileSync(join(root, 'node_modules', 'x', 'c.txt'), 'ignored')
  symlinkSync('a.txt', join(root, 'link'))
  return root
}
afterEach(() => {
  for (const r of made.splice(0)) {
    try { chmodSync(r, 0o755) } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true })
  }
})

describe('release integrity check', () => {
  it('is unchanged when nothing moved, and leaves node_modules out', () => {
    const root = fixture()
    const m = buildManifest(root, '2026-11-24T00:00:00Z')
    expect(Object.keys(m.files)).toEqual(['a.txt', 'link', 'src/b.txt'])
    expect(isUnchanged(checkRelease(root, m))).toBe(true)
  })

  it('reports a changed, an added and a removed file, and a retargeted link', () => {
    const root = fixture()
    const m = buildManifest(root, 't')
    writeFileSync(join(root, 'a.txt'), 'alpha!')
    writeFileSync(join(root, 'new.txt'), 'n')
    rmSync(join(root, 'src', 'b.txt'))
    rmSync(join(root, 'link'))
    symlinkSync('src', join(root, 'link'))
    expect(checkRelease(root, m)).toEqual({ added: ['new.txt'], removed: ['src/b.txt'], changed: ['a.txt', 'link'] })
    writeFileSync(join(root, 'node_modules', 'x', 'c.txt'), 'still ignored')
  })

  it('changes the tree digest if any byte changes', () => {
    const root = fixture()
    const before = treeDigest(hashTree(root))
    writeFileSync(join(root, 'src', 'b.txt'), 'betA')
    expect(treeDigest(hashTree(root))).not.toBe(before)
  })

  it('reads only: a release that cannot be written to is hashed, and its files and times are untouched', () => {
    const root = fixture()
    const mtimes = () => [root, join(root, 'src')].map((p) => statSync(p).mtimeMs).concat(readdirSync(root).map((n) => statSync(join(root, n)).mtimeMs))
    const before = mtimes()
    chmodSync(join(root, 'a.txt'), 0o444)
    chmodSync(join(root, 'src'), 0o555)
    chmodSync(root, 0o555)
    const m = buildManifest(root, 't')
    expect(isUnchanged(checkRelease(root, m))).toBe(true)
    chmodSync(root, 0o755)
    chmodSync(join(root, 'src'), 0o755)
    expect(mtimes()).toEqual(before)
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'link', 'node_modules', 'src'])
  })

  it('refuses to record the manifest inside the release', () => {
    const root = fixture()
    const m = buildManifest(root, 't')
    expect(() => writeManifest(root, join(root, 'manifest.json'), m)).toThrow(/inside the release/)
    expect(() => assertOutsideRelease(root, join(root, 'src', 'm.json'))).toThrow(/inside the release/)
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'link', 'node_modules', 'src'])
    const elsewhere = mkdtempSync(join(tmpdir(), 'qed-man-'))
    made.push(elsewhere)
    writeManifest(root, join(elsewhere, 'm.json'), m)
    expect(readManifest(join(elsewhere, 'm.json')).treeSha256).toBe(m.treeSha256)
  })

  it('rejects a manifest that does not agree with itself', () => {
    const root = fixture()
    const m = buildManifest(root, 't')
    const elsewhere = mkdtempSync(join(tmpdir(), 'qed-man-'))
    made.push(elsewhere)
    writeManifest(root, join(elsewhere, 'm.json'), { ...m, fileCount: m.fileCount + 1 })
    expect(() => readManifest(join(elsewhere, 'm.json'))).toThrow(/not consistent/)
  })

  it('the recorded manifest of the approved release is well formed and has its date', () => {
    const m = readManifest(new URL('../register/approved-release-manifest.json', import.meta.url).pathname)
    expect(m.recordedAt).toMatch(/^2026-11-24T/)
    expect(m.fileCount).toBeGreaterThan(1000)
    expect(Object.keys(m.files).some((p) => p.startsWith('node_modules/') || p.startsWith('.git/'))).toBe(false)
    expect(Object.values(m.files).every((e) => /^[0-9a-f]{64}$/.test(e.sha256) || e.sha256.startsWith('link:'))).toBe(true)
  })
})
