/**
 * Formal-verification run (Adapters cluster, candidate 4): the Cursor
 * installer's merges keep what they do not own — unknown top-level keys of
 * hooks.json (cli#2) and the user's env keys on a healed MCP entry (cli#3).
 */
import { describe, it, expect } from 'vitest'
import { mergeCursorHooks, buildCursorHooks } from '../src/cursor-hooks.js'
import { upgradePlurMcpEntry } from '../src/mcp-config.js'

describe('Cursor merges preserve foreign data (formal Adapters #4)', () => {
  it('mergeCursorHooks keeps unknown top-level keys, and stays idempotent', () => {
    const cfg = { version: 1, hooks: {}, $schema: 'https://example.test/hooks.json', teamPolicy: { strict: true } } as any
    const once = mergeCursorHooks(cfg, buildCursorHooks('/h/.plur/bin/plur-hook'))
    expect((once as any).$schema).toBe('https://example.test/hooks.json')
    expect((once as any).teamPolicy).toEqual({ strict: true })
    expect(mergeCursorHooks(once, buildCursorHooks('/h/.plur/bin/plur-hook'))).toEqual(once)
  })

  it('upgradePlurMcpEntry with a caller env keeps the user\'s other env keys', () => {
    const config = { mcpServers: { plur: {
      command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'],
      env: { PLUR_PATH: '/data/team-plur', PLUR_TOOL_PROFILE: 'full' },
    } } } as Record<string, unknown>
    expect(upgradePlurMcpEntry(config, { env: { PLUR_TOOL_PROFILE: 'cursor' } })).toBe(true)
    const env = (config.mcpServers as any).plur.env
    expect(env).toEqual({ PLUR_PATH: '/data/team-plur', PLUR_TOOL_PROFILE: 'cursor' })
  })
})
