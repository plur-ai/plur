import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, platform } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
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

    // Hooks installed
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks?.UserPromptSubmit).toBeDefined()
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain('@plur-ai/cli hook-inject')

    // MCP server registered
    expect(settings.mcpServers).toBeDefined()
    expect(settings.mcpServers?.plur).toBeDefined()
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
})
