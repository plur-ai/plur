/**
 * Decision H3 follow-up (#1270 re-review): on a spaced Windows home with 8.3
 * names (the default on C:), `windowsHookCommand` writes the shim's short
 * path, and `%~sI` shortens the file name too. The windows-init CI job logged
 * `C:/Users/RUNNER~1/AppData/Local/Temp/TESTUS~1/PLUR~1/bin/PLUR-H~1.CMD
 * hook-inject`. The matcher accepted only `plur-hook(.cmd)` as the last
 * segment, so re-running init kept those hooks as the user's and appended a
 * new set every time, and doctor reported no PLUR hooks.
 *
 * Exercised with the win32 platform stub and a stand-in `cmd.exe` on PATH
 * that answers the short-name query with that CI value; not on real Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { isPlurHookCommand } from '../src/lib/hook-command.js'
import { isPlurHookCommand as mcpIsPlurHookCommand } from '../../mcp/src/hook-command.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href
// The value the windows-latest runner produced (windows-init-hooks CI log).
const SHORT = 'C:/Users/RUNNER~1/AppData/Local/Temp/TESTUS~1/PLUR~1/bin/PLUR-H~1.CMD'

describe('the matcher claims the 8.3 short path of the shim', () => {
  it.each([
    [`${SHORT} hook-inject`],
    [`${SHORT.replace(/\//g, '\\')} hook-session-end`],
    [`${SHORT.toLowerCase()} hook-auto-rate claude`],
    ['C:/Users/TESTUS~1/.plur/bin/PLUR-H~2.CMD hook-inject'],
    [`& "${SHORT}" hook-inject`],
  ])('claims %s (cli and mcp copies)', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
    expect(mcpIsPlurHookCommand(cmd)).toBe(true)
  })

  it.each([
    // An 8.3 alias outside PLUR's bin directory is someone else's file.
    ['C:/tools/PLUR-H~1.CMD hook-inject'],
    ['C:/Users/A/.plur/bin/PLUR-H~1.PS1 hook-inject'],
    [`${SHORT} status`],
  ])('leaves %s alone', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(false)
    expect(mcpIsPlurHookCommand(cmd)).toBe(false)
  })
})

describe('re-running init with 8.3 short names keeps one set of hooks (win32 stub)', { timeout: 120000 }, () => {
  let home: string
  let bin: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    bin = join(home, 'fakebin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // resolveShortPath spawns cmd.exe with `for %I in (...) do @echo %~sI`.
    writeFileSync(join(bin, 'cmd.exe'), `#!/bin/sh\nprintf '%s\\n' '${SHORT.replace(/\//g, '\\')}'\n`, { mode: 0o755 })
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const env = () => ({ ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', PATH: `${bin}:${process.env.PATH}` })
  function run(args: string[]): string {
    try {
      return execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, ...args], { encoding: 'utf-8', timeout: 30000, cwd: home, env: env() })
    } catch (err: unknown) {
      return String((err as { stdout?: Buffer | string }).stdout ?? '')
    }
  }
  function commands(file: string): string[] {
    const out: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'command' && typeof x === 'string') out.push(x)
          else walk(x)
        }
      }
    }
    walk(JSON.parse(readFileSync(file, 'utf-8')))
    return out
  }
  const files = () => ({
    'Claude Code': join(home, '.claude', 'settings.json'),
    Cursor: join(home, '.cursor', 'hooks.json'),
    Codex: join(home, '.codex', 'hooks.json'),
    Antigravity: join(home, '.gemini', 'config', 'hooks.json'),
  })
  const counts = () => Object.fromEntries(Object.entries(files()).map(([k, f]) => [k, commands(f).length]))

  it('the short path is what init writes, and three runs leave the hook counts unchanged', () => {
    const init = ['init', '--global', '--no-desktop', '--no-opencode', '--cursor', '--codex', '--antigravity', '--no-prompt']
    run(init)
    expect(commands(files().Cursor).every((c) => c.startsWith(`${SHORT} hook-`))).toBe(true)
    const first = counts()
    for (const n of Object.values(first)) expect(n).toBeGreaterThan(0)
    run(init)
    run(init)
    expect(counts()).toEqual(first)

    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.hooksInstalled).toBe(true)
    const HOOK_FILES = ['Claude Code (global)', 'Cursor (.cursor/hooks.json)', 'Codex (~/.codex/hooks.json)', 'Antigravity (~/.gemini/config/hooks.json)']
    const hookConfigs = (report.configs as Array<{ label: string; exists: boolean; hasPlurHooks: boolean }>)
      .filter((c) => HOOK_FILES.includes(c.label))
    expect(hookConfigs.map((c) => c.label).sort()).toEqual([...HOOK_FILES].sort())
    for (const c of hookConfigs) expect(c.hasPlurHooks, c.label).toBe(true)
  })
})
