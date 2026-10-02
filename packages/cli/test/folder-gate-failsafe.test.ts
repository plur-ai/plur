/**
 * The editor hooks fail SAFE on a folder decision they cannot read (audit F4
 * of #1517, owner decision): a resolver that throws, or a folders.yaml that
 * does not parse, means ask with no memory, never `on` because the folder
 * has a project marker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let throwing = false
vi.mock('@plur-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plur-ai/core')>()
  return {
    ...actual,
    resolveFolderPolicy: (...a: Parameters<typeof actual.resolveFolderPolicy>) => {
      if (throwing) throw new Error('boom')
      return actual.resolveFolderPolicy(...a)
    },
  }
})
const { hookFolderPolicy } = await import('../src/lib/folder-gate.js')

let home: string
let repo: string
beforeEach(() => {
  throwing = false
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gate-failsafe-home-')))
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'gate-failsafe-repo-')))
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('hookFolderPolicy fails safe', () => {
  it('a resolver that throws gives ask (resolver-error), not on from the marker', () => {
    throwing = true
    const errs = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const p = hookFolderPolicy(repo, { path: home })
    errs.mockRestore()
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('resolver-error')
  })

  it('a malformed folders.yaml gives ask (malformed-map), not on from the marker', () => {
    writeFileSync(join(home, 'folders.yaml'), 'folders: [[[ not yaml\n')
    const p = hookFolderPolicy(repo, { path: home })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
  })
})
