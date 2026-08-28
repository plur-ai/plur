import { describe, it, expect } from 'vitest'
import {
  cursorProjectMcpConfigPath,
  cursorProjectHooksConfigPath,
  cursorRulesPath,
  cursorContextRulePath,
  cursorReminderRulePath,
  buildMcpServerEntry,
  mergePlurMcp,
  upgradePlurMcpEntry,
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

  // Audit fix (Codex adversarial review, 2026-07-08): reminders and recalled
  // session context must land in different files so one can't clobber the
  // other — see writeContextRule()'s docstring.
  it('resolves .cursor/rules/plur-reminder.mdc under the given cwd (distinct from the context rule)', () => {
    expect(cursorReminderRulePath('/tmp/proj')).toBe(join('/tmp/proj', '.cursor', 'rules', 'plur-reminder.mdc'))
    expect(cursorReminderRulePath('/tmp/proj')).not.toBe(cursorContextRulePath('/tmp/proj'))
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

describe('buildMcpServerEntry npx fallback (#1069)', () => {
  it('never writes an @latest entry — a pinned spec is what keeps the npx cache immutable', () => {
    // Without the shim installed in this test env, the fallback must pin THIS
    // build's version: @latest makes npx rewrite cached native binaries on
    // every publish, and macOS SIGKILLs (CODESIGNING Invalid Page) whatever
    // pages one in mid-rewrite — the #1069 cold-start death.
    const entry = buildMcpServerEntry()
    const blob = `${entry.command} ${(entry.args ?? []).join(' ')}`
    expect(blob).not.toContain('@latest')
    if (blob.includes('npx')) {
      expect(blob).toMatch(/@plur-ai\/mcp@\d+\.\d+\.\d+/)
    }
  })
})

describe('upgradePlurMcpEntry (#1069 healer)', () => {
  const stale = () => ({
    mcpServers: {
      plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    },
  }) as Record<string, unknown>

  it('heals an @latest entry init itself wrote — "exists" is not "correct"', () => {
    const config = stale()
    expect(upgradePlurMcpEntry(config)).toBe(true)
    const entry = (config.mcpServers as Record<string, { command: string; args?: string[] }>).plur
    expect(`${entry.command} ${(entry.args ?? []).join(' ')}`).not.toContain('@latest')
    // Neighbours untouched.
    expect((config.mcpServers as Record<string, unknown>).github).toEqual((stale().mcpServers as Record<string, unknown>).github)
  })

  it('never touches a hand-rolled custom entry', () => {
    const config = {
      mcpServers: { plur: { command: '/opt/my/own/plur-server', args: ['--flag'] } },
    } as Record<string, unknown>
    expect(upgradePlurMcpEntry(config)).toBe(false)
    expect((config.mcpServers as Record<string, { command: string }>).plur.command).toBe('/opt/my/own/plur-server')
  })

  it('preserves an existing env block through the upgrade', () => {
    const config = {
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'], env: { PLUR_TOOL_PROFILE: 'cursor' } },
      },
    } as Record<string, unknown>
    expect(upgradePlurMcpEntry(config)).toBe(true)
    expect((config.mcpServers as Record<string, { env?: Record<string, string> }>).plur.env).toEqual({ PLUR_TOOL_PROFILE: 'cursor' })
  })

  it('is a no-op when the entry already matches what init would write today', () => {
    const config = {} as Record<string, unknown>
    mergePlurMcp(config)
    expect(upgradePlurMcpEntry(config)).toBe(false)
  })
})

describe('upgradePlurMcpEntry ownership narrowing (0.19.1 audits)', () => {
  const heal = (entry: Record<string, unknown>): { healed: boolean; entry: Record<string, unknown> } => {
    const config = { mcpServers: { plur: entry } } as Record<string, unknown>
    const healed = upgradePlurMcpEntry(config)
    return { healed, entry: (config.mcpServers as Record<string, Record<string, unknown>>).plur }
  }

  it('preserves a deliberate old-version pin — only @latest/bare carries the #1069 race', () => {
    const pinned = { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.18.2'] }
    expect(heal(pinned).healed).toBe(false)
  })

  it('never claims a fork or sibling package', () => {
    expect(heal({ command: 'npx', args: ['-y', '@plur-ai/mcp-experimental'] }).healed).toBe(false)
  })

  it('never claims a custom command that merely MENTIONS npx and the package', () => {
    const custom = {
      command: '/opt/wrap',
      args: ['--note=replaces npx @plur-ai/mcp with audited build', '--', '/opt/real-server'],
    }
    const { healed, entry } = heal(custom)
    expect(healed).toBe(false)
    expect(entry.command).toBe('/opt/wrap')
  })

  it('heals the racey shapes and preserves unmodeled fields through the merge', () => {
    const stale = {
      command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'],
      type: 'stdio', timeout: 30, disabled: false,
    }
    const { healed, entry } = heal(stale)
    expect(healed).toBe(true)
    expect(`${entry.command} ${(entry.args as string[]).join(' ')}`).not.toContain('@latest')
    expect(entry.type).toBe('stdio')
    expect(entry.timeout).toBe(30)
    expect(entry.disabled).toBe(false)
  })

  it('heals the bare-npx form too — no tag means latest to npm', () => {
    expect(heal({ command: 'npx', args: ['-y', '@plur-ai/mcp'] }).healed).toBe(true)
    expect(heal({ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@latest'] }).healed).toBe(true)
  })
})
