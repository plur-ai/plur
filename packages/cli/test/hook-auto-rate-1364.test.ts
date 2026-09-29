/**
 * #1364 — `hook-auto-rate` (a Stop hook, #1318) must count as PLUR's own hook
 * in both the CLI and the plur-mcp matcher, so re-running `plur init` never
 * keeps it as a user hook and appends another copy. Decision H2 matches any
 * `hook-*` behind PLUR's launcher, so no subcommand list needs the entry;
 * these tests pin that for the auto-rate hook specifically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { isPlurHookCommand, isPlurHookSpec } from '../src/lib/hook-command.js'
import { isPlurHookCommand as mcpIsPlurHookCommand } from '../../mcp/src/hook-command.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

interface HookSpec { command: string; args?: string[] }
interface Settings { hooks?: Record<string, Array<{ matcher?: string; hooks: HookSpec[] }>> }

describe('#1364: hook-auto-rate is one of PLUR\'s hooks', () => {
  it.each([
    ['/Users/a/.plur/bin/plur-hook hook-auto-rate claude'],
    ['"C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd" hook-auto-rate claude'],
    ['C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd hook-auto-rate claude'],
    ['npx -y @plur-ai/cli@0.21.0 hook-auto-rate claude'],
  ])('both matchers claim %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
    expect(mcpIsPlurHookCommand(cmd)).toBe(true)
  })

  // Decision F4: the exec form counts only when its js entry is the one init
  // recorded in ~/.plur/bin/plur-hook.meta.json, so the test records it.
  it('claims the Windows exec form of the auto-rate hook', () => {
    const entry = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'
    const saved = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), 'plur-1364-exec-'))
    try {
      process.env.HOME = home
      mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
      writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), JSON.stringify({ entrypoint: entry }))
      expect(isPlurHookSpec({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [entry, 'hook-auto-rate', 'claude'],
      })).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('#1364: re-init does not keep or duplicate a hook-auto-rate Stop entry', { timeout: 90000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-1364-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const settingsPath = () => join(home, '.claude', 'settings.json')
  const commands = (): string[] => {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Settings
    return Object.values(s.hooks ?? {}).flatMap((es) => es.flatMap((e) => e.hooks.map((h) => [h.command, ...(h.args ?? [])].join(' '))))
  }
  function runInit(win32: boolean): void {
    execFileSync(process.execPath, [...(win32 ? ['--import', WIN32_PRELOAD] : []), CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-opencode', '--no-prompt'], {
      encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
    })
  }

  it.each([[false], [true]])('win32=%s: the seeded auto-rate entry is PLUR\'s, never counted twice; the user hook stays', (win32) => {
    // How many auto-rate hooks init itself writes (0 before #1318, 1 after).
    runInit(win32)
    const own = commands().filter((c) => c.includes('hook-auto-rate')).length
    expect(commands().some((c) => c.includes('hook-inject'))).toBe(true)
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    const shim = join(home, '.plur', 'bin', win32 ? 'plur-hook.cmd' : 'plur-hook')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `${shim} hook-auto-rate claude` }] },
          { hooks: [{ type: 'command', command: '/usr/local/bin/mytool hook-foo' }] },
        ],
      },
    }, null, 2))
    runInit(win32)
    runInit(win32)
    const cmds = commands()
    // A seeded PLUR auto-rate entry is replaced, not kept beside init's own.
    expect(cmds.filter((c) => c.includes('hook-auto-rate')).length).toBe(own)
    expect(cmds.filter((c) => c === '/usr/local/bin/mytool hook-foo')).toHaveLength(1)
  })
})
