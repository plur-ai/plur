import { describe, it, expect } from 'vitest'
import {
  cursorProjectMcpConfigPath,
  cursorProjectHooksConfigPath,
  cursorRulesPath,
  cursorContextRulePath,
  buildMcpServerEntry,
  mergePlurMcp,
} from '../src/mcp-config.js'
import { join } from 'path'

describe('Cursor config paths', () => {
  it('resolves .cursor/mcp.json under the given cwd', () => {
    expect(cursorProjectMcpConfigPath('/tmp/proj')).toBe(join('/tmp/proj', '.cursor', 'mcp.json'))
  })

  it('resolves .cursor/hooks.json under the given cwd', () => {
    expect(cursorProjectHooksConfigPath('/tmp/proj')).toBe(join('/tmp/proj', '.cursor', 'hooks.json'))
  })

  it('resolves .cursor/rules/plur-memory.mdc under the given cwd', () => {
    expect(cursorRulesPath('/tmp/proj')).toBe(join('/tmp/proj', '.cursor', 'rules', 'plur-memory.mdc'))
  })

  it('resolves .cursor/rules/plur-context.mdc under the given cwd (distinct from the static rule)', () => {
    expect(cursorContextRulePath('/tmp/proj')).toBe(join('/tmp/proj', '.cursor', 'rules', 'plur-context.mdc'))
    expect(cursorContextRulePath('/tmp/proj')).not.toBe(cursorRulesPath('/tmp/proj'))
  })
})

describe('buildMcpServerEntry with env', () => {
  it('includes env when passed', () => {
    const entry = buildMcpServerEntry({ env: { PLUR_TOOL_PROFILE: 'cursor' } })
    expect(entry.env).toEqual({ PLUR_TOOL_PROFILE: 'cursor' })
  })

  it('omits env when not passed (unchanged Claude Code behavior)', () => {
    const entry = buildMcpServerEntry()
    expect(entry.env).toBeUndefined()
  })
})

describe('mergePlurMcp with env', () => {
  it('stamps the plur entry with the given env', () => {
    const config: Record<string, unknown> = {}
    mergePlurMcp(config, { env: { PLUR_TOOL_PROFILE: 'cursor' } })
    const servers = config.mcpServers as Record<string, { env?: Record<string, string> }>
    expect(servers.plur.env).toEqual({ PLUR_TOOL_PROFILE: 'cursor' })
  })
})
