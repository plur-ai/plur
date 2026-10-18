/**
 * Codex round 2, finding 3: a cleanup rewrite keeps other servers' credentials,
 * so it must reach core's atomicWrite as a `secret` write (on Windows that is
 * what makes the temp file owner-only before the first byte when the config is
 * owner-only; core's own tests cover the mechanism).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const seen = vi.hoisted(() => ({ calls: [] as Array<{ path: string; opts: unknown }> }))
vi.mock('@plur-ai/core', async importOriginal => {
  const core = await importOriginal<typeof import('@plur-ai/core')>()
  return {
    ...core,
    atomicWrite: (path: string, content: string | Buffer, opts?: Parameters<typeof core.atomicWrite>[2]) => {
      seen.calls.push({ path, opts })
      return core.atomicWrite(path, content, opts)
    },
  }
})

const { cleanupLegacy } = await import('../src/enterprise/cleanup.js')

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-codex2-cleanup-'))
  mkdirSync(join(home, '.plur'), { recursive: true })
  seen.calls = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('cleanup rewrites are secret writes', () => {
  it('rewrites the editor config through atomicWrite with secret: true', () => {
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({
      mcpServers: {
        'plur-enterprise': { command: 'npx', args: [] },
        other: { command: 'other', env: { OTHER_TOKEN: 'fake_token_for_test' } },
      },
    }, null, 2) + '\n')
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '', CODEX_HOME: join(home, '.codex') }
    const results = cleanupLegacy({ tools: ['claude-code'], backupDir: join(home, 'backups'), plurDir: join(home, '.plur'), home, env })
    expect(results.find(r => r.target === claudeJson)?.status).toBe('removed')
    const write = seen.calls.find(c => c.path === claudeJson)
    expect(write).toBeDefined()
    expect(write!.opts).toMatchObject({ secret: true })
    expect(readFileSync(claudeJson, 'utf8')).toContain('fake_token_for_test')
  })
})
