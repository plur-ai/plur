/**
 * A folder map that cannot be read fails SAFE (audit F4 of #1517, owner
 * decision): the folder is treated like `ask` — no memory — and the answer
 * names the file and the line, never falls back to a project marker's `on`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveFolderPolicy, folderMapPath, folderAskOnce, folderMapProblem } from '../src/index.js'
import { logger } from '../src/logger.js'

let root: string
let repo: string
beforeEach(() => {
  vi.spyOn(logger, 'warning').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'failsafe-home-')))
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'failsafe-repo-')))
  // A project marker: before, a malformed map plus this meant `on`.
  writeFileSync(join(repo, '.plur.yaml'), '# plur\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('malformed folders.yaml fails safe', () => {
  it('a YAML syntax error: ask, naming the file and the line, even with a project marker', () => {
    writeFileSync(folderMapPath(root), `version: 1\nfolders:\n  - path: ${repo}\n    plur: off\n  - path: [unclosed\n`)
    const p = resolveFolderPolicy(repo, { root })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
    expect(p.mapError?.file).toBe(folderMapPath(root))
    expect(p.mapError?.line).toBeGreaterThan(0)
  })

  it('a schema error: ask with reason malformed-map', () => {
    writeFileSync(folderMapPath(root), `version: 1\nfolders:\n  - path: ${repo}\n    plur: maybe\n`)
    const p = resolveFolderPolicy(repo, { root })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
  })

  it('the question for it offers no command and names the file and line', () => {
    writeFileSync(folderMapPath(root), 'folders: [[[ not yaml\n')
    const policy = resolveFolderPolicy(repo, { root })
    const text = folderAskOnce({ dir: repo, policy, sessionId: 'failsafe-s1', root, claim: () => true })!
    expect(text).toContain('folders.yaml')
    expect(text).toMatch(/line \d+/)
    expect(text).not.toContain('--nonce')
  })

  // The MCP gate (#1519) and the hooks/plugin must agree: a folders.yaml that
  // exists but cannot be read is not "no map". existsSync() answers false for
  // a dangling symlink, so a project marker used to turn memory on here.
  it.skipIf(process.platform === 'win32')('a dangling symlink: ask with reason malformed-map, like the MCP gate', () => {
    symlinkSync(join(root, 'missing-target.yaml'), folderMapPath(root))
    expect(folderMapProblem(root)).not.toBeNull()
    const p = resolveFolderPolicy(repo, { root })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
    expect(p.mapError?.file).toBe(folderMapPath(root))
  })
})
