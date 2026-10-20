// applyMcpEnv reads the config once, plans the edit, then reads it again just
// before the atomic write: an editor that saved the file in between must not
// be overwritten (#1638). The window cannot be hit from one process through
// the public API, so readFileSync is wrapped: the second read of the config
// first lets "an editor" save a change.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const hook: { path: string | null; reads: number; edit: (() => void) | null } = { path: null, reads: 0, edit: null }

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>()
  const readFileSync = ((p: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
    if (hook.path !== null && p === hook.path) {
      hook.reads += 1
      if (hook.reads === 2 && hook.edit) hook.edit()
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof real.readFileSync
  return { ...real, readFileSync, default: { ...real, readFileSync } }
})

const { applyMcpEnv } = await import('../src/enterprise/wire.js')
const { isolatedHomeEnv } = await import('./helpers/isolated-env.js')

let home: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-wire-recheck-')))
  hook.path = null
  hook.reads = 0
  hook.edit = null
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('applyMcpEnv: the file changes while PLUR edits it', () => {
  it('an editor save between the read and the write is kept, and the result is refused', () => {
    const path = join(home, '.claude.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { plur: { command: '/h/.plur/bin/plur-mcp' } } }))
    const saved = JSON.stringify({ editorSetting: true, mcpServers: { plur: { command: '/h/.plur/bin/plur-mcp' } } })
    hook.path = path
    hook.edit = () => writeFileSync(path, saved)
    const r = applyMcpEnv('claude-code', { NODE_EXTRA_CA_CERTS: '/h/.plur/company-ca.pem' }, { home, env: isolatedHomeEnv(home) })
    expect(r.status).toBe('refused')
    expect(r.detail).toMatch(/changed while PLUR was editing/)
    expect(readFileSync(path, 'utf8')).toBe(saved)
  })

  it('with no change in between, the same edit goes through', () => {
    const path = join(home, '.cursor', 'mcp.json')
    mkdirSync(join(home, '.cursor'))
    writeFileSync(path, JSON.stringify({ mcpServers: { plur: { command: '/h/.plur/bin/plur-mcp' } } }))
    hook.path = path
    const r = applyMcpEnv('cursor', { NODE_EXTRA_CA_CERTS: '/h/.plur/company-ca.pem' }, { home, env: isolatedHomeEnv(home) })
    expect(r.status).toBe('updated')
    expect(hook.reads).toBeGreaterThanOrEqual(2)
  })
})
