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
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

interface HookSpec { command: string; args?: string[]; timeout?: number; async?: boolean }
interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: HookSpec[] }>>
  mcpServers?: Record<string, { command: string; args: string[] }>
}

function allCommands(settings: Settings): string[] {
  return Object.values(settings.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => [h.command, ...(h.args ?? [])].join(' '))))
}

function allSpecs(settings: Settings): HookSpec[] {
  return Object.values(settings.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks))
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
      env: isolatedHomeEnv(home),
      cwd: home,
    })
  }
  const settingsPath = () => join(home, '.claude', 'settings.json')
  const readSettings = (): Settings => JSON.parse(readFileSync(settingsPath(), 'utf-8'))
  /** ~/.claude.json — where Claude Code reads user-scoped MCP servers (#1561). */
  const readUserConfig = (): Settings => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))

  // F4 follow-up: a CLI install that moved (npm prefix change, upgrade into a
  // new directory) left exec-form hooks naming the OLD js entry. Re-init must
  // replace them, not add a second set; a foreign checkout stays the user's.
  it('re-init after the CLI entry changed leaves exactly one hook set per event', () => {
    runInit()
    const current = readSettings()
    const oldEntry = 'C:\\old-prefix\\node_modules\\@plur-ai\\cli\\dist\\index.js'
    const foreign = 'C:\\src\\someone\\packages\\cli\\dist\\index.js'
    // Rewrite every PLUR hook to the old entry, as the earlier install wrote
    // them, with the legacy single-entry meta file that install left behind.
    const moved = JSON.parse(JSON.stringify(current)) as Settings
    for (const h of allSpecs(moved)) if (h.args) h.args[0] = oldEntry
    moved.hooks!.UserPromptSubmit!.push({ hooks: [{ command: process.execPath, args: [foreign, 'hook-inject'] }] })
    writeFileSync(settingsPath(), JSON.stringify(moved, null, 2))
    writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), JSON.stringify({ entrypoint: oldEntry }))

    runInit()
    const after = readSettings()
    const specs = allSpecs(after)
    expect(specs.some((h) => h.args?.[0] === oldEntry)).toBe(false)
    // Exactly the fresh set plus the foreign hook, which is kept.
    expect(specs.filter((h) => h.args?.[0] === foreign)).toHaveLength(1)
    expect(specs.length).toBe(allSpecs(current).length + 1)
    for (const [event, entries] of Object.entries(current.hooks ?? {})) {
      expect(after.hooks?.[event]?.filter((e) => e.hooks.every((h) => h.args?.[0] !== foreign))).toHaveLength(entries.length)
    }
    const meta = JSON.parse(readFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), 'utf-8'))
    expect(meta.entrypoints[0]).toBe(oldEntry)
    expect(meta.entrypoints[meta.entrypoints.length - 1]).toBe(meta.entrypoint)
  })

  // Decision H3: Claude Code hooks use the documented exec form on Windows
  // (https://code.claude.com/docs/en/hooks) — no shell, so no quoting.
  it('writes every Claude Code hook in exec form: node + the CLI js entry + hook-*', () => {
    runInit()
    const specs = allSpecs(readSettings())
    expect(specs.length).toBeGreaterThan(5)
    for (const h of specs) {
      expect(h.command).toBe(process.execPath)
      expect(h.args?.[0]).toMatch(/[\\/]cli[\\/]dist[\\/]index\.js$/)
      expect(h.args?.[1]).toMatch(/^hook-/)
    }
  })

  // Decision H3: string editors get the unquoted short path. This host has no
  // cmd.exe to ask for one, so Cursor (a PowerShell editor) gets the
  // `& "<path>"` fallback, and doctor reports it (below).
  it('Cursor on a spaced home without short names: the & "<path>" fallback', () => {
    runInit(['--cursor'])
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd').replace(/\\/g, '/')
    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf-8'))
    const commands = Object.values(cursor.hooks as Record<string, HookSpec[]>).flat().map((h) => h.command)
    // Four hook-cursor-* hooks plus the auto-rate afterAgentResponse hook (#1310).
    expect(commands.length).toBe(5)
    for (const c of commands) expect(c.startsWith(`& "${shim}" hook-cursor-`) || c === `& "${shim}" hook-auto-rate cursor`, c).toBe(true)
  })

  it('two init runs leave exactly one PLUR hook set per event', () => {
    runInit()
    const first = readSettings()
    runInit()
    const second = readSettings()
    expect(second.hooks).toEqual(first.hooks)
    for (const entries of Object.values(second.hooks ?? {})) {
      const perMatcher = new Map<string, number>()
      // Keyed by matcher and the hooks' subcommands: Stop carries two '*'
      // entries by design, hook-learn-check and the auto-rate hook (#1310).
      for (const e of entries) {
        const key = `${e.matcher ?? ''}|${e.hooks.map((h) => h.args?.slice(1).join(' ')).join(',')}`
        perMatcher.set(key, (perMatcher.get(key) ?? 0) + 1)
      }
      // Every event's PLUR entries are distinct — nothing doubled.
      for (const n of perMatcher.values()) expect(n).toBe(1)
    }
  })

  it('cleans up the unquoted backslash hooks an older version wrote, keeping user hooks', () => {
    // What older inits wrote on Windows — twice, since each re-run duplicated:
    // this home's shim, unquoted, with backslashes.
    const winHome = home.replace(/\//g, '\\')
    const old = `${winHome}\\.plur\\bin\\plur-hook.cmd`
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
    expect(commands.some((c) => c.includes(winHome))).toBe(false)
    expect(settings.hooks?.UserPromptSubmit?.filter((e) => e.hooks[0].args?.[1] === 'hook-inject')).toHaveLength(1)
    // hook-session-remind once, the resume re-ask (#1347), plus (since #1274) the compact rehydrate.
    expect(settings.hooks?.SessionStart?.map((e) => e.hooks[0].args?.slice(1).join(' '))).toEqual(['hook-session-remind', 'hook-session-resume', 'hook-inject --rehydrate'])
    // hook-learn-check once (the two legacy copies are gone), plus #1310's auto-rate.
    expect(settings.hooks?.Stop?.map((e) => e.hooks[0].args?.slice(1).join(' '))).toEqual(['hook-learn-check', 'hook-auto-rate claude'])
    // The user's own hook survives.
    expect(commands).toContain('C:\\tools\\my-own-hook.exe')
  })

  it('removes only PLUR hooks from an entry and keeps hooks PLUR did not write', () => {
    // The #1267 review reproduced all three deletions under the first matcher.
    const legacy = `${home.replace(/\//g, '\\')}\\.plur\\bin\\plur-hook.cmd hook-inject`
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
    expect(allSpecs(settings).filter((h) => h.args?.length === 2 && h.args[1] === 'hook-inject')).toHaveLength(1)
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
    const plur = readUserConfig().mcpServers?.plur
    expect(plur?.command).toBe(process.execPath)
    expect(plur?.args).toHaveLength(1)
    expect(plur?.args[0]).toMatch(/[\\/]mcp[\\/]dist[\\/]index\.js$/)
  })

  it('registers the MCP server as node.exe + the @plur-ai/mcp js entry, never a .cmd', () => {
    runInit()
    const plur = readUserConfig().mcpServers?.plur
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
    const plur = readUserConfig().mcpServers?.plur
    expect(plur?.command).toBe(process.execPath)
    expect(plur?.args[0]).toMatch(/index\.js$/)
  })
})

describe('plur doctor sees Windows hooks (#1267)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'Test User-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it.each([
    ['unquoted backslash (older init)', { command: 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd hook-inject' }],
    ['quoted backslash (#1267 first round)', { command: '"C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd" hook-inject' }],
    ['exec form (decision H3)', {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js', 'hook-inject'],
    }],
  ])('reports hooksInstalled for a %s hook', (_label, fixture) => {
    // An older init wrote this home's own shim path (#1270 review: the
    // unquoted spaced form is claimed only as this home's shim).
    const spec = { ...fixture, command: fixture.command.replace('C:\\Users\\Test User', home.replace(/\//g, '\\')) }
    // Decision F4: an exec-form hook is PLUR's only when its js entry is the
    // one init recorded next to the shim.
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
    writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'),
      JSON.stringify({ entrypoint: 'C:\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js' }))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', ...spec }] }] },
    }, null, 2))
    let stdout: string
    try {
      stdout = execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, 'doctor', '--no-handshake', '--json'], {
        encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
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
        encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
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
      encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
    })
    const raw = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')
    const settings = JSON.parse(raw) as Settings
    expect(JSON.stringify(settings.hooks, null, 2).split(home).join('<HOME>')).toMatchSnapshot()
    // #1561: the MCP server is registered in ~/.claude.json, not settings.json.
    expect(settings.mcpServers?.plur).toBeUndefined()
    const plur = (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as Settings).mcpServers?.plur
    // The shim when @plur-ai/mcp is built alongside; the pinned login-shell npx otherwise.
    if (plur?.command === join(home, '.plur', 'bin', 'plur-mcp')) {
      expect(plur.args).toEqual([])
    } else {
      expect(plur?.command).toBe('/bin/sh')
      expect(plur?.args[0]).toBe('-lc')
    }
  })
})
