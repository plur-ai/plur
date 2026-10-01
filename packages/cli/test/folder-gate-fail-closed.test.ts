/**
 * Re-audit of #1521, C-2: a folder-lookup error must fail CLOSED in the hooks.
 * It must never answer `on` (even with a project marker), and binding the
 * answer must leave the instance reading and writing nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@plur-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plur-ai/core')>()
  return { ...actual, resolveFolderPolicy: () => { throw new Error('simulated resolver failure') } }
})

describe('hookFolderPolicy on a resolver error', () => {
  it('does not answer on, even with a project marker, and binds the instance closed', async () => {
    const { hookFolderPolicy, bindHookFolder } = await import('../src/lib/folder-gate.js')
    const { Plur } = await import('@plur-ai/core')
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-gate-closed-')))
    try {
      const repo = join(base, 'repo')
      mkdirSync(repo)
      writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
      const policy = hookFolderPolicy(repo, { path: join(base, '.plur') })
      expect(policy.mode).not.toBe('on')
      const plur = new Plur({ path: join(base, '.plur') })
      bindHookFolder(plur, repo, policy)
      expect(plur.remoteOnlyFolder()?.blocked).toBeTruthy()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
