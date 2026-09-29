/**
 * #1267 — `plur init` on Windows, end to end.
 *
 * The built CLI is spawned with a preload that makes `process.platform`
 * report 'win32', under a HOME that contains a space (the shape of
 * `C:\Users\Test User`). Three failures were reported from an enterprise
 * deployment: unquoted hook commands break on the space, re-running init
 * does not recognise the backslash hooks an older version wrote and
 * duplicates them, and the MCP entry launches a `.cmd` that current Node
 * refuses to spawn directly (`spawn EINVAL`).
 *
 * The darwin/linux snapshot at the bottom pins today's output byte for byte:
 * the fix must not change it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

interface HookSpec { command: string; timeout?: number; async?: boolean }
interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: HookSpec[] }>>
  mcpServers?: Record<string, { command: string; args: string[] }>
}

function allCommands(settings: Settings): string[] {
  return Object.values(settings.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)))
}

describe('plur init on win32 with a home dir containing a space (#1267)', { timeout: 60000 }, () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    expect(home).toContain(' ')
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function runInit(extra: string[] = [], win32 = true): string {
    const nodeArgs = win32 ? ['--import', WIN32_PRELOAD] : []
    return execFileSync(process.execPath, [...nodeArgs, CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', ...extra], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: home,
    })
  }
  const settingsPath = () => join(home, '.claude', 'settings.json')
  const readSettings = (): Settings => JSON.parse(readFileSync(settingsPath(), 'utf-8'))

  it('quotes every hook command around the shim path', () => {
    runInit()
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd')
    const commands = allCommands(readSettings())
    expect(commands.length).toBeGreaterThan(5)
    for (const c of commands) expect(c.startsWith(`"${shim}" hook-`)).toBe(true)
  })

  it('quotes Cursor hook commands too', () => {
    runInit(['--cursor'])
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd')
    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf-8'))
    const commands = Object.values(cursor.hooks as Record<string, HookSpec[]>).flat().map((h) => h.command)
    expect(commands.length).toBe(4)
    for (const c of commands) expect(c.startsWith(`"${shim}" hook-cursor-`)).toBe(true)
  })

  it('two init runs leave exactly one PLUR hook set per event', () => {
    runInit()
    const first = readSettings()
    runInit()
    const second = readSettings()
    expect(second.hooks).toEqual(first.hooks)
    for (const entries of Object.values(second.hooks ?? {})) {
      const perMatcher = new Map<string, number>()
      for (const e of entries) perMatcher.set(e.matcher ?? '', (perMatcher.get(e.matcher ?? '') ?? 0) + 1)
      // Every event's PLUR entries are distinct matchers — nothing doubled.
      for (const n of perMatcher.values()) expect(n).toBe(1)
    }
  })

  it('cleans up the unquoted backslash hooks an older version wrote, keeping user hooks', () => {
    // What older inits wrote on Windows — twice, since each re-run duplicated.
    const old = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'
    const legacy = (sub: string) => ({ hooks: [{ type: 'command', command: `${old} ${sub}`, timeout: 90 }] })
    const userHook = { hooks: [{ type: 'command', command: 'C:\\tools\\my-own-hook.exe', timeout: 5 }] }
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        UserPromptSubmit: [legacy('hook-inject'), legacy('hook-inject'), userHook],
        SessionStart: [legacy('hook-session-remind'), legacy('hook-session-remind')],
        Stop: [{ matcher: '*', ...legacy('hook-learn-check') }, { matcher: '*', ...legacy('hook-learn-check') }],
      },
    }, null, 2))

    runInit()
    const settings = readSettings()
    const commands = allCommands(settings)
    expect(commands.some((c) => c.includes('C:\\Users'))).toBe(false)
    expect(settings.hooks?.UserPromptSubmit?.filter((e) => e.hooks[0].command.includes('hook-inject'))).toHaveLength(1)
    expect(settings.hooks?.SessionStart).toHaveLength(1)
    expect(settings.hooks?.Stop).toHaveLength(1)
    // The user's own hook survives.
    expect(commands).toContain('C:\\tools\\my-own-hook.exe')
  })

  it('removes only PLUR hooks from an entry and keeps hooks PLUR did not write', () => {
    // The #1267 review reproduced all three deletions under the first matcher.
    const legacy = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd hook-inject'
    const backup = 'C:\\Users\\Me\\.plur\\bin\\plur-hook-backup.ps1'
    const logger = 'C:\\Users\\Me\\.PLUR\\BIN\\Plur-Hook-logger.bat'
    const audit = 'C:\\tools\\my-audit.exe'
    const cmd = (command: string) => ({ type: 'command', command, timeout: 5 })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [cmd(legacy), cmd(audit)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [cmd(backup)] }],
        Stop: [{ hooks: [cmd(logger)] }],
        SessionStart: [{ hooks: [cmd('npx @plur-ai/cli hook-session-remind')] }],
      },
    }, null, 2))

    runInit()
    const settings = readSettings()
    const commands = allCommands(settings)
    for (const own of [backup, logger, audit]) expect(commands).toContain(own)
    // The user's hook keeps its entry; only the legacy PLUR hook left it.
    const auditEntry = settings.hooks?.UserPromptSubmit?.find((e) => e.hooks.some((h) => h.command === audit))
    expect(auditEntry?.hooks.map((h) => h.command)).toEqual([audit])
    expect(settings.hooks?.PreToolUse?.find((e) => e.hooks[0].command === backup)?.matcher).toBe('Bash')
    // Legacy PLUR hooks are gone: no unquoted shim, no npx form.
    expect(commands).not.toContain(legacy)
    expect(commands.some((c) => c.includes('npx @plur-ai/cli'))).toBe(false)
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd')
    expect(commands.filter((c) => c === `"${shim}" hook-inject`)).toHaveLength(1)
  })

  it('heals a node-form MCP entry whose node.exe and js entry no longer exist', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({
      mcpServers: { plur: {
        command: 'C:\\Program Files\\nodejs-22.1.0\\node.exe',
        args: ['C:\\old\\node_modules\\@plur-ai\\mcp\\dist\\index.js'],
      } },
    }, null, 2))
    const out = runInit()
    expect(out).not.toMatch(/already registered/)
    const plur = readSettings().mcpServers?.plur
    expect(plur?.command).toBe(process.execPath)
    expect(plur?.args).toHaveLength(1)
    expect(plur?.args[0]).toMatch(/[\\/]mcp[\\/]dist[\\/]index\.js$/)
  })

  it('registers the MCP server as node.exe + the @plur-ai/mcp js entry, never a .cmd', () => {
    runInit()
    const plur = readSettings().mcpServers?.plur
    expect(plur?.command).toBe(process.execPath)
    expect(plur?.args).toHaveLength(1)
    expect(plur?.args[0]).toMatch(/[\\/]mcp[\\/]dist[\\/]index\.js$/)
    expect(JSON.stringify(plur)).not.toMatch(/\.cmd|cmd\.exe/)
  })

  it('heals a .cmd MCP entry an older version wrote', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({
      mcpServers: { plur: { command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [] } },
    }, null, 2))
    runInit()
    const plur = readSettings().mcpServers?.plur
    expect(plur?.command).toBe(process.execPath)
    expect(plur?.args[0]).toMatch(/index\.js$/)
  })
})

describe('plur doctor sees Windows hooks (#1267)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'Test User-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it.each([
    ['unquoted backslash (older init)', 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd hook-inject'],
    ['quoted backslash (this init)', '"C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd" hook-inject'],
  ])('reports hooksInstalled for a %s hook', (_label, command) => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
    }, null, 2))
    let stdout: string
    try {
      stdout = execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, 'doctor', '--no-handshake', '--json'], {
        encoding: 'utf-8', timeout: 30000, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home,
      })
    } catch (err: any) {
      stdout = err.stdout?.toString() ?? ''
    }
    expect(JSON.parse(stdout).hooksInstalled).toBe(true)
  })
})

describe('plur doctor flags a broken node-form MCP entry (#1267)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'Test User-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function doctor(plur: { command: string; args: string[] }): { brokenNodeMcp: Array<{ missing: string[] }>; overall: string } {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: { plur },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"C:\\x\\.plur\\bin\\plur-hook.cmd" hook-inject' }] }] },
    }, null, 2))
    let stdout: string
    try {
      stdout = execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, 'doctor', '--no-handshake', '--json'], {
        encoding: 'utf-8', timeout: 30000, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home,
      })
    } catch (err: any) {
      stdout = err.stdout?.toString() ?? ''
    }
    return JSON.parse(stdout)
  }

  it('reports the missing node.exe and js entry and fails overall', () => {
    const plur = {
      command: 'C:\\Program Files\\nodejs-22.1.0\\node.exe',
      args: ['C:\\old\\node_modules\\@plur-ai\\mcp\\dist\\index.js'],
    }
    const report = doctor(plur)
    expect(report.brokenNodeMcp).toHaveLength(1)
    expect(report.brokenNodeMcp[0].missing).toEqual([plur.command, plur.args[0]])
    expect(report.overall).toBe('fail')
  })

  it('reports nothing for an entry whose paths exist', () => {
    const entry = join(home, 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
    writeFileSync(entry, '')
    expect(doctor({ command: process.execPath, args: [entry] }).brokenNodeMcp).toEqual([])
  })
})

describe('plur init on darwin/linux output is unchanged (#1267)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-init-posix-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('hook commands match the pre-#1267 snapshot', () => {
    execFileSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor'], {
      encoding: 'utf-8', timeout: 30000, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home,
    })
    const raw = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')
    const settings = JSON.parse(raw) as Settings
    expect(JSON.stringify(settings.hooks, null, 2).split(home).join('<HOME>')).toMatchSnapshot()
    const plur = settings.mcpServers?.plur
    // The shim when @plur-ai/mcp is built alongside; the pinned login-shell npx otherwise.
    if (plur?.command === join(home, '.plur', 'bin', 'plur-mcp')) {
      expect(plur.args).toEqual([])
    } else {
      expect(plur?.command).toBe('/bin/sh')
      expect(plur?.args[0]).toBe('-lc')
    }
  })
})
