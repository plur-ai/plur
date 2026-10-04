/**
 * #1267 — unit coverage for the Windows pieces of `plur init`: hook command
 * quoting, recognising our own hooks in every slash/quote style, and the
 * MCP entry shape (node.exe + js entry, never a `.cmd`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hookCommandPrefix, isPlurHookCommand } from '../src/lib/hook-command.js'
import { buildMcpServerEntry, isOwnWin32NodeEntry, missingNodeEntryPaths, upgradePlurMcpEntry } from '../src/mcp-config.js'
import { CLI_VERSION } from '../src/version.js'
import { buildCursorHooks, mergeCursorHooks, hasPlurCursorHooks } from '../src/cursor-hooks.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'

const WIN_SHIM = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'
const SHORT_SHIM = 'C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd'

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p })
}

/**
 * Make `os.homedir()` the home WIN_SHIM lives in. The unquoted spaced shim
 * path is claimed only when it is this home's own shim (#1270 review).
 */
function pinWinHome(): void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  beforeEach(() => {
    process.env.HOME = 'C:\\Users\\Test User'
    process.env.USERPROFILE = 'C:\\Users\\Test User'
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

// darwin/linux only since decision H3: Windows hooks never use a quoted
// prefix (see windowsHookCommand / claudeHookSpec, hook-decisions-h2-h3.test.ts).
describe('hookCommandPrefix (#1267)', () => {
  it('leaves a darwin/linux path without whitespace byte-identical', () => {
    expect(hookCommandPrefix('/Users/a/.plur/bin/plur-hook')).toBe('/Users/a/.plur/bin/plur-hook')
    expect(hookCommandPrefix('/home/a/.plur/bin/plur-hook')).toBe('/home/a/.plur/bin/plur-hook')
  })

  it('quotes a darwin/linux path that contains a space', () => {
    expect(hookCommandPrefix('/Users/Test User/.plur/bin/plur-hook')).toBe('"/Users/Test User/.plur/bin/plur-hook"')
  })
})

describe('isPlurHookCommand (#1267)', () => {
  pinWinHome()
  it.each([
    ['/home/a/.plur/bin/plur-hook hook-inject'],
    ['"/Users/Test User/.plur/bin/plur-hook" hook-inject'],
    [`${WIN_SHIM} hook-inject`],
    [`"${WIN_SHIM}" hook-inject`],
    ['C:/Users/a/.plur/bin/plur-hook.cmd hook-inject'],
    ['C:\\Users\\A\\.PLUR\\BIN\\PLUR-HOOK.CMD hook-inject'],
    ['npx -y @plur-ai/cli@0.20.1 hook-inject'],
  ])('recognises %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
  })

  // Every legacy form an earlier `plur init` wrote must still be recognised,
  // or re-init would leave it behind next to the new set.
  it.each([
    ['npx @plur-ai/cli hook-inject'],
    ['npx @plur-ai/cli hook-inject --rehydrate'],
    ['npx @plur-ai/cli hook-observe --post'],
    ['npx -y @plur-ai/cli@0.9.1 hook-learn-check'],
    ['/Users/a/.plur/bin/plur-hook hook-session-remind'],
    ['/Users/a/.plur/bin/plur-hook hook-session-guard'],
    ['/Users/a/.plur/bin/plur-hook hook-session-mark'],
    ['/Users/a/.plur/bin/plur-hook hook-session-end'],
    [`${WIN_SHIM} hook-inject --event plan_mode`],
    [`"${WIN_SHIM}" hook-observe --post`],
  ])('recognises the legacy form %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
  })

  it.each([
    ['C:\\tools\\my-own-hook.exe'],
    ['/usr/local/bin/lint.sh'],
    ['echo plur'],
    // The #1267 review's reproductions: a bare substring test claimed these.
    ['C:\\Users\\Me\\.plur\\bin\\plur-hook-backup.ps1'],
    ['C:\\Users\\Me\\.plur\\bin\\plur-hook-backup.ps1 hook-inject'],
    ['C:\\Users\\Me\\.PLUR\\BIN\\Plur-Hook-logger.bat'],
    ['"C:\\Users\\Me\\.PLUR\\BIN\\Plur-Hook-logger.bat" hook-inject'],
    // PLUR's binary, but not a subcommand init writes.
    [`"${WIN_SHIM}" my-own-subcommand`],
    ['/Users/a/.plur/bin/plur-hook'],
    ['npx @plur-ai/cli doctor'],
    ['npx @plur-ai/cli-extras hook-inject'],
  ])('does not claim %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(false)
  })
})

describe('Cursor and Codex hook merges on Windows (#1267)', () => {
  pinWinHome()
  it('Cursor: re-init over an older unquoted backslash set leaves one set', () => {
    const oldSet = buildCursorHooks(WIN_SHIM)
    const doubled = {
      version: 1,
      hooks: Object.fromEntries(Object.entries(oldSet).map(([ev, es]) => [ev, [...es, ...es]])),
    }
    expect(hasPlurCursorHooks(doubled)).toBe(true)
    // Decision H3: the new set is the unquoted short path.
    const next = mergeCursorHooks(doubled, buildCursorHooks(SHORT_SHIM))
    for (const entries of Object.values(next.hooks)) {
      expect(entries).toHaveLength(1)
      expect(entries[0].command.startsWith(`${SHORT_SHIM} `)).toBe(true)
    }
  })

  it('Codex: re-init over an older unquoted backslash set leaves one set', () => {
    const old = mergeCodexHooks({ hooks: {} }, buildCodexHooks(WIN_SHIM))
    const next = mergeCodexHooks(old, buildCodexHooks(SHORT_SHIM))
    for (const entries of Object.values(next.hooks ?? {})) {
      const specs = entries.flatMap((e) => e.hooks)
      expect(specs).toHaveLength(1)
      expect(specs[0].command.startsWith(`${SHORT_SHIM} `)).toBe(true)
    }
  })
})

describe('buildMcpServerEntry (#1267)', () => {
  let home: string
  let savedHome: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    savedHome = process.env.HOME
    process.env.HOME = home
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  })
  afterEach(() => {
    setPlatform(realPlatform)
    process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  function writeWinShim(entrypoint: string | null): void {
    writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.cmd'), '@echo off\r\n')
    if (entrypoint !== null) {
      writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'),
        JSON.stringify({ entrypoint, node: 'C:\\old\\node.exe', installed: 'x' }))
    }
  }

  it('win32: launches node.exe with the @plur-ai/mcp js entry', () => {
    const entry = join(home, 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'mcp', 'dist'), { recursive: true })
    writeFileSync(entry, '')
    writeWinShim(entry)
    setPlatform('win32')
    expect(buildMcpServerEntry()).toEqual({ command: process.execPath, args: [entry] })
    expect(buildMcpServerEntry({ env: { PLUR_TOOL_PROFILE: 'cursor' } }))
      .toEqual({ command: process.execPath, args: [entry], env: { PLUR_TOOL_PROFILE: 'cursor' } })
  })

  it('win32: falls back to cmd.exe /c npx (pinned) when the js entry cannot be resolved — never the .cmd shim', () => {
    writeWinShim(join(home, 'gone', 'index.js'))
    setPlatform('win32')
    expect(buildMcpServerEntry()).toEqual({ command: 'cmd.exe', args: ['/c', 'npx', '-y', `@plur-ai/mcp@${CLI_VERSION}`] })
    rmSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'))
    expect(buildMcpServerEntry().command).toBe('cmd.exe')
  })

  it('win32: heals a .cmd entry an older init wrote', () => {
    const entry = join(home, 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'mcp', 'dist'), { recursive: true })
    writeFileSync(entry, '')
    writeWinShim(entry)
    setPlatform('win32')
    const config: Record<string, unknown> = {
      mcpServers: { plur: { command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [], cwd: 'keep' } },
    }
    expect(upgradePlurMcpEntry(config)).toBe(true)
    expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: process.execPath, args: [entry], cwd: 'keep' })
    // Idempotent.
    expect(upgradePlurMcpEntry(config)).toBe(false)
  })

  describe('win32: the node-form entry this init writes', () => {
    function resolvedEntry(): string {
      const entry = join(home, 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
      mkdirSync(join(home, 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
      writeFileSync(entry, '')
      writeWinShim(entry)
      return entry
    }

    it('heals it when node.exe and the js entry no longer exist (Node upgrade)', () => {
      const entry = resolvedEntry()
      setPlatform('win32')
      const stale = {
        command: 'C:\\Program Files\\nodejs-22.1.0\\node.exe',
        args: ['C:\\old\\node_modules\\@plur-ai\\mcp\\dist\\index.js'],
        cwd: 'keep',
      }
      expect(missingNodeEntryPaths(stale)).toEqual([stale.command, stale.args[0]])
      const config: Record<string, unknown> = { mcpServers: { plur: stale } }
      expect(upgradePlurMcpEntry(config)).toBe(true)
      expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: process.execPath, args: [entry], cwd: 'keep' })
      expect(upgradePlurMcpEntry(config)).toBe(false)
    })

    it('heals it when only node.exe is gone', () => {
      const entry = resolvedEntry()
      setPlatform('win32')
      const config: Record<string, unknown> = { mcpServers: { plur: { command: 'C:\\gone\\node.exe', args: [entry] } } }
      expect(upgradePlurMcpEntry(config)).toBe(true)
      expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: process.execPath, args: [entry] })
    })

    it('heals it when its js entry differs from the one resolved now', () => {
      const entry = resolvedEntry()
      const older = join(home, 'older', 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
      mkdirSync(join(home, 'older', 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
      writeFileSync(older, '')
      setPlatform('win32')
      const config: Record<string, unknown> = { mcpServers: { plur: { command: process.execPath, args: [older] } } }
      expect(upgradePlurMcpEntry(config)).toBe(true)
      expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: process.execPath, args: [entry] })
    })

    it('leaves a healthy, current entry alone', () => {
      const entry = resolvedEntry()
      setPlatform('win32')
      const config: Record<string, unknown> = { mcpServers: { plur: { command: process.execPath, args: [entry] } } }
      expect(missingNodeEntryPaths({ command: process.execPath, args: [entry] })).toEqual([])
      expect(upgradePlurMcpEntry(config)).toBe(false)
    })

    it.each([
      ['a node entry running another script', { command: 'C:\\gone\\node.exe', args: ['C:\\gone\\my-server.js'] }],
      ['a node entry with extra arguments', { command: 'C:\\gone\\node.exe', args: ['--inspect', 'C:\\gone\\node_modules\\@plur-ai\\mcp\\dist\\index.js'] }],
      ['another launcher running the entry', { command: 'C:\\gone\\bun.exe', args: ['C:\\gone\\node_modules\\@plur-ai\\mcp\\dist\\index.js'] }],
      ['a fork package', { command: 'C:\\gone\\node.exe', args: ['C:\\gone\\node_modules\\@plur-ai\\mcp-fork\\dist\\index.js'] }],
    ])('never rewrites %s', (_label, plur) => {
      resolvedEntry()
      setPlatform('win32')
      const config: Record<string, unknown> = { mcpServers: { plur: { ...plur } } }
      expect(isOwnWin32NodeEntry(plur)).toBe(false)
      expect(missingNodeEntryPaths(plur)).toEqual([])
      expect(upgradePlurMcpEntry(config)).toBe(false)
      expect((config.mcpServers as Record<string, unknown>).plur).toEqual(plur)
    })

    it('is not recognised off Windows', () => {
      resolvedEntry()
      setPlatform('linux')
      expect(isOwnWin32NodeEntry({ command: '/gone/node', args: ['/gone/node_modules/@plur-ai/mcp/dist/index.js'] })).toBe(false)
    })
  })

  it('win32: never touches a hand-rolled custom entry', () => {
    setPlatform('win32')
    const config: Record<string, unknown> = { mcpServers: { plur: { command: 'C:\\custom\\run-plur.cmd', args: [] } } }
    expect(upgradePlurMcpEntry(config)).toBe(false)
  })

  it('darwin/linux: shim entry unchanged', () => {
    const shim = join(home, '.plur', 'bin', 'plur-mcp')
    writeFileSync(shim, '#!/bin/sh\n')
    for (const p of ['darwin', 'linux'] as const) {
      setPlatform(p)
      expect(buildMcpServerEntry()).toEqual({ command: shim, args: [] })
    }
  })

  it('darwin/linux: npx fallback unchanged', () => {
    for (const p of ['darwin', 'linux'] as const) {
      setPlatform(p)
      expect(buildMcpServerEntry()).toEqual({ command: '/bin/sh', args: ['-lc', `exec npx -y @plur-ai/mcp@${CLI_VERSION}`] })
    }
  })
})
