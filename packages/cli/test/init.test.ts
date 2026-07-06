import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir, platform } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number; async?: boolean }> }>>
  mcpServers?: Record<string, { command: string; args: string[] }>
}

describe('plur init', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-init-test-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runInit(extra: string = ''): string {
    return execSync(`node ${CLI} init --global --no-desktop ${extra}`, {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: home,
    })
  }

  function readSettings(): Settings {
    const path = join(home, '.claude', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  }

  it('writes settings.json with hooks and plur MCP server on a fresh install', () => {
    const output = runInit()
    expect(output).toContain('PLUR installed')

    const settings = readSettings()

    // Hooks installed — now using local shim instead of npx (#178)
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks?.UserPromptSubmit).toBeDefined()
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain('hook-inject')
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain('.plur/bin/plur-hook')

    // MCP server registered
    expect(settings.mcpServers).toBeDefined()
    expect(settings.mcpServers?.plur).toBeDefined()
  })

  it('installs injection hooks async with a 90s ceiling; event hooks stay sync', () => {
    runInit()
    const settings = readSettings()

    // The cold-start embedder load (~20s on stores past a few thousand
    // engrams) killed sync injection hooks at their old 15s timeout —
    // users got a timeout error and no injection. Async + 90s is the fix.
    const injectHook = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]
    expect(injectHook?.command).toContain('hook-inject')
    expect(injectHook?.async).toBe(true)
    expect(injectHook?.timeout).toBe(90)

    const rehydrateHook = settings.hooks?.PostCompact?.[0]?.hooks?.[0]
    expect(rehydrateHook?.command).toContain('--rehydrate')
    expect(rehydrateHook?.async).toBe(true)
    expect(rehydrateHook?.timeout).toBe(90)

    // Event hooks must deliver context BEFORE the tool runs — async would
    // defeat them. They fit their sync 10s window because hook-inject uses
    // BM25-only (no embedder load) for the --event path.
    const planModeEntry = settings.hooks?.PreToolUse?.find((e) => e.matcher === 'EnterPlanMode')
    expect(planModeEntry?.hooks?.[0]?.async).toBeUndefined()
    expect(planModeEntry?.hooks?.[0]?.timeout).toBe(10)
  })

  it('writes per-engram scope-selection guidance into CLAUDE.md (#296)', () => {
    runInit()
    const claudeMd = readFileSync(join(home, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('Scope selection')
    expect(claudeMd).toMatch(/per engram/i)
    expect(claudeMd).toContain('group:<org>/<team>')
    // The key anti-pattern the issue is about: omitting scope → global → never reaches the team store.
    expect(claudeMd).toMatch(/never reaches the team store/i)
  })

  it('registers the MCP server with a platform-appropriate command', () => {
    runInit()
    const settings = readSettings()
    const plur = settings.mcpServers?.plur
    expect(plur).toBeDefined()

    if (platform() === 'win32') {
      expect(plur?.command).toBe('cmd.exe')
      expect(plur?.args).toContain('npx')
      expect(plur?.args.join(' ')).toContain('@plur-ai/mcp')
    } else {
      // macOS/Linux: login shell wrapper so PATH (nvm/brew) loads under GUI launches
      expect(plur?.command).toBe('/bin/sh')
      expect(plur?.args).toContain('-lc')
      expect(plur?.args.join(' ')).toContain('npx -y @plur-ai/mcp')
    }
  })

  it('is idempotent — re-running does not duplicate hooks or mcp entries', () => {
    runInit()
    const first = readSettings()
    const firstHookCount = first.hooks?.UserPromptSubmit?.length ?? 0

    runInit()
    const second = readSettings()
    const secondHookCount = second.hooks?.UserPromptSubmit?.length ?? 0

    expect(secondHookCount).toBe(firstHookCount)
    // Still exactly one plur entry
    expect(Object.keys(second.mcpServers ?? {}).filter((k) => k === 'plur')).toHaveLength(1)
  })

  it('upgrade path: hooks-only install gets MCP added without re-adding hooks', () => {
    // Simulate an old (pre-0.8.1) install: hooks present, MCP missing
    const settingsPath = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject', timeout: 15 }] },
            ],
          },
        },
        null,
        2,
      ),
    )

    runInit()
    const settings = readSettings()

    // Hooks not duplicated — still exactly one entry under UserPromptSubmit
    expect(settings.hooks?.UserPromptSubmit?.length).toBe(1)
    // MCP server now registered
    expect(settings.mcpServers?.plur).toBeDefined()
  })

  it('preserves unrelated existing settings keys', () => {
    const settingsPath = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          mcpServers: { datacore: { command: 'node', args: ['/path/to/datacore.js'] } },
        },
        null,
        2,
      ),
    )

    runInit()
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))

    expect(raw.model).toBe('opus')
    expect(raw.mcpServers.datacore).toBeDefined()
    expect(raw.mcpServers.plur).toBeDefined()
    expect(raw.hooks).toBeDefined()
  })

  it('skips Claude Desktop registration when --no-desktop is passed', () => {
    runInit()
    // The desktop config path is platform-specific, but with HOME overridden
    // it would land under home/. Just assert no desktop file was created.
    const desktopOnDarwin = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    const desktopOnLinux = join(home, '.config', 'Claude', 'claude_desktop_config.json')
    expect(existsSync(desktopOnDarwin)).toBe(false)
    expect(existsSync(desktopOnLinux)).toBe(false)
  })

  it('--project installs enforcement hooks globally and injection hooks at project (issue #95)', () => {
    const project = mkdtempSync(join(tmpdir(), 'plur-init-project-'))
    try {
      execSync(`node ${CLI} init --project --no-desktop`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        cwd: project,
      })

      const globalSettings: Settings = JSON.parse(
        readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'),
      )
      const projectSettings: Settings = JSON.parse(
        readFileSync(join(project, '.claude', 'settings.json'), 'utf-8'),
      )

      // Enforcement hooks (SessionStart, session-guard PreToolUse, session-mark PostToolUse) live globally
      expect(globalSettings.hooks?.SessionStart).toBeDefined()
      const globalGuard = globalSettings.hooks?.PreToolUse?.find((h) =>
        h.hooks.some((c) => c.command.includes('hook-session-guard')),
      )
      expect(globalGuard).toBeDefined()
      const globalMark = globalSettings.hooks?.PostToolUse?.find((h) =>
        h.hooks.some((c) => c.command.includes('hook-session-mark')),
      )
      expect(globalMark).toBeDefined()

      // Injection hooks (UserPromptSubmit etc.) live at project, NOT globally
      expect(projectSettings.hooks?.UserPromptSubmit).toBeDefined()
      expect(globalSettings.hooks?.UserPromptSubmit).toBeUndefined()

      // Enforcement hooks NOT duplicated at project
      expect(projectSettings.hooks?.SessionStart).toBeUndefined()

      // MCP server registered at project (the path that does work in this project)
      expect(projectSettings.mcpServers?.plur).toBeDefined()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  // ── Local hook binary tests (#178) ──────────────────────────────────────

  it('creates ~/.plur/bin/plur-hook shim on init', () => {
    runInit()
    const shim = join(home, '.plur', 'bin', platform() === 'win32' ? 'plur-hook.cmd' : 'plur-hook')
    expect(existsSync(shim)).toBe(true)

    const content = readFileSync(shim, 'utf-8')
    expect(content).not.toContain('npx')
    expect(content).toContain('index.js')

    if (platform() !== 'win32') {
      expect(content).toContain('#!/bin/sh')
      expect(content).toContain('exec')
      // Shim should be executable
      const stat = statSync(shim)
      expect(stat.mode & 0o111).toBeGreaterThan(0)
    }
  })

  it('hooks use local shim path instead of npx (#178)', () => {
    runInit()
    const settings = readSettings()

    const hookCommands: string[] = []
    for (const entries of Object.values(settings.hooks ?? {})) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          hookCommands.push(h.command)
        }
      }
    }

    // No hook should reference npx
    for (const cmd of hookCommands) {
      expect(cmd).not.toContain('npx')
    }

    // All plur hooks should reference the local shim
    const plurCommands = hookCommands.filter((c) => c.includes('plur-hook') || c.includes('@plur-ai/cli'))
    expect(plurCommands.length).toBeGreaterThan(0)
    for (const cmd of plurCommands) {
      expect(cmd).toContain('.plur/bin/plur-hook')
    }
  })

  it('migration: re-init replaces npx hooks with local shim hooks (#178)', () => {
    // Simulate old npx-style hooks
    const settingsPath = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject', timeout: 15 }] },
          ],
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-session-guard', timeout: 3 }] },
          ],
        },
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }, null, 2),
    )

    runInit()
    const settings = readSettings()

    // Old npx hooks should be replaced
    const hookCommands: string[] = []
    for (const entries of Object.values(settings.hooks ?? {})) {
      for (const entry of entries) {
        for (const h of entry.hooks) hookCommands.push(h.command)
      }
    }

    for (const cmd of hookCommands) {
      expect(cmd).not.toContain('npx @plur-ai/cli')
    }
    expect(hookCommands.some((c) => c.includes('.plur/bin/plur-hook'))).toBe(true)
  })

  it('creates plur-hook.meta.json with entrypoint info (#178)', () => {
    runInit()
    const metaPath = join(home, '.plur', 'bin', 'plur-hook.meta.json')
    expect(existsSync(metaPath)).toBe(true)

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.entrypoint).toBeDefined()
    expect(meta.entrypoint).toContain('index.js')
    expect(meta.node).toBeDefined()
    expect(meta.installed).toBeDefined()
  })

  // ─── #234: MCP shim — mirror of #178 fix for MCP server launch ──────────
  // In the monorepo test env, packages/mcp/dist exists as a workspace sibling,
  // so resolveMcpEntrypoint() should find it. The walk also checks adjacent
  // node_modules layouts that npm uses post `npm install -g @plur-ai/mcp`.

  it('creates ~/.plur/bin/plur-mcp shim on init when @plur-ai/mcp is available (#234)', () => {
    runInit()
    const shim = join(home, '.plur', 'bin', platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp')

    if (!existsSync(shim)) {
      // Acceptable for CLI-only environments — the shim install gracefully
      // skips if @plur-ai/mcp is not discoverable. Doctor will warn.
      console.warn('plur-mcp shim not created — @plur-ai/mcp not discoverable from this test env')
      return
    }

    const content = readFileSync(shim, 'utf-8')
    expect(content).not.toContain('npx')
    expect(content).toContain('index.js')
    expect(content).toMatch(/@plur-ai[\\/]mcp/)

    if (platform() !== 'win32') {
      expect(content).toContain('#!/bin/sh')
      const stat = statSync(shim)
      expect(stat.mode & 0o111).toBeGreaterThan(0)
    }
  })

  it('MCP server entry uses local shim instead of npx (#234)', () => {
    runInit()
    const settings = readSettings()
    const plurMcp = settings.mcpServers?.plur
    expect(plurMcp).toBeDefined()

    const shimPath = join(home, '.plur', 'bin', platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp')
    if (!existsSync(shimPath)) {
      // No shim → entry falls back to npx (valid for CLI-only installs)
      const blob = plurMcp!.command + ' ' + (plurMcp!.args ?? []).join(' ')
      expect(blob).toMatch(/npx/)
      return
    }

    // Shim present → entry must point at it, no npx anywhere
    expect(plurMcp!.command).toBe(shimPath)
    expect(plurMcp!.command).not.toContain('npx')
    expect((plurMcp!.args ?? []).join(' ')).not.toContain('npx')
  })

  it('migration: re-init replaces npx-based MCP entry with local shim (#234)', () => {
    const settingsPath = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }, null, 2),
    )

    runInit()
    const settings = readSettings()
    const plurMcp = settings.mcpServers?.plur
    expect(plurMcp).toBeDefined()

    const shimPath = join(home, '.plur', 'bin', platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp')
    if (existsSync(shimPath)) {
      expect(plurMcp!.command).toBe(shimPath)
      expect((plurMcp!.args ?? []).join(' ')).not.toContain('npx')
    } else {
      // Acceptable: kept on npx if MCP not discoverable
      console.warn('plur-mcp shim unavailable — MCP entry kept on npx')
    }
  })

  it('creates plur-mcp.meta.json when MCP shim is installed (#234)', () => {
    runInit()
    const metaPath = join(home, '.plur', 'bin', 'plur-mcp.meta.json')
    if (!existsSync(metaPath)) return

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.entrypoint).toBeDefined()
    expect(meta.entrypoint).toMatch(/@plur-ai[\\/]mcp.*index\.js/)
    expect(meta.node).toBeDefined()
    expect(meta.installed).toBeDefined()
  })
})
