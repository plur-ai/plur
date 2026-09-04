import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { codexHome, codexHooksConfigPath, knownConfigFiles } from '../src/mcp-config.js'
import { buildCodexHooks, mergeCodexHooks, writeCodexHooksConfig, readCodexHooksConfig } from '../src/codex-hooks.js'

describe('codexHome', () => {
  it('honours CODEX_HOME so a relocated install is not written past', () => {
    expect(codexHome({ CODEX_HOME: '/somewhere/else' })).toBe('/somewhere/else')
  })

  it('falls back to ~/.codex', () => {
    expect(codexHome({})).toMatch(/\.codex$/)
  })

  it('derives the hooks path from the same home', () => {
    expect(codexHooksConfigPath({ CODEX_HOME: '/x' })).toBe('/x/hooks.json')
  })
})

describe('knownConfigFiles', () => {
  it('reports on both Codex files so doctor can see them', () => {
    const labels = knownConfigFiles().map(c => c.label)
    expect(labels).toContain('Codex (~/.codex/hooks.json)')
    expect(labels).toContain('Codex (~/.codex/config.toml)')
  })

  it('marks config.toml as TOML, not JSON', () => {
    // doctor must not run readConfig() on it — that returns {} for TOML and
    // would report "no plur MCP" on a correctly-registered install.
    const toml = knownConfigFiles().find(c => c.label === 'Codex (~/.codex/config.toml)')
    expect(toml?.kind).toBe('codex-toml')
  })
})

describe('install into a scratch CODEX_HOME', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-home-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('produces a hooks.json Codex can parse, in the shape it expects', () => {
    const path = join(home, 'hooks.json')
    writeCodexHooksConfig(path, mergeCodexHooks(readCodexHooksConfig(path), buildCodexHooks('/bin/plur-hook')))

    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw).toHaveProperty('hooks')
    // Codex's own shape: hooks[event] is an array of {matcher?, hooks: []}.
    for (const [event, entries] of Object.entries(raw.hooks as Record<string, unknown[]>)) {
      expect(event).toMatch(/^[A-Z]/)
      for (const entry of entries as Array<{ hooks: unknown[] }>) {
        expect(Array.isArray(entry.hooks)).toBe(true)
      }
    }
  })

  it('leaves an unrelated Codex hook alone across an upgrade', () => {
    const path = join(home, 'hooks.json')
    writeFileSync(path, JSON.stringify({
      description: 'my hooks',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }],
      },
    }))

    writeCodexHooksConfig(path, mergeCodexHooks(readCodexHooksConfig(path), buildCodexHooks('/bin/plur-hook')))
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.description).toBe('my hooks')
    expect(raw.hooks.Stop[0].hooks[0].command).toBe('./notify.sh')
    expect(raw.hooks.SessionStart).toBeDefined()
  })
})

/**
 * The trust step is the difference between an install that works and one that
 * looks perfect and does nothing. Verified on codex-cli 0.149.1: hooks that
 * ran under --dangerously-bypass-hook-trust were silently inert without it —
 * no output, no warning, exit 0. Nothing on disk distinguishes the two states,
 * so the only defence is telling the user.
 */
describe('trust notice', () => {
  it('is present in the init source and names /hooks', async () => {
    const src = readFileSync(new URL('../src/commands/init.ts', import.meta.url), 'utf8')
    expect(src).toContain('/hooks')
    expect(src).toMatch(/trust/i)
    expect(src).toMatch(/SILENTLY|silently/)
  })
})
