/**
 * Decision H3, end to end (built CLI, win32 platform stub): Codex, Cursor and
 * Antigravity hook commands are one unquoted forward-slash string; when the
 * path has whitespace and no 8.3 short name can be had, the fallback is
 * written and `plur doctor` reports it. Also the PLUR_HOOK_PROBE switch the
 * Windows CI job uses to prove each generated hook string reached the CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

function collectCommands(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) collectCommands(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' && typeof v === 'string') out.push(v)
      else collectCommands(v, out)
    }
  }
  return out
}

describe('decision H3: string editors on win32', { timeout: 60000 }, () => {
  let home: string
  let bin: string

  function setup(prefix: string): void {
    home = mkdtempSync(join(tmpdir(), prefix))
    bin = join(home, 'fakebin')
    mkdirSync(bin)
    // A stand-in `codex` so the Codex leg never reaches a real install.
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  }
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function run(args: string[]): string {
    try {
      return execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, ...args], {
        encoding: 'utf-8', timeout: 30000, cwd: home,
        env: { ...isolatedHomeEnv(home), PATH: `${bin}:${process.env.PATH}` },
      })
    } catch (err: unknown) {
      return String((err as { stdout?: Buffer | string }).stdout ?? '')
    }
  }
  const init = () => run(['init', '--global', '--no-desktop', '--no-opencode', '--cursor', '--codex', '--antigravity'])
  const hookFiles = () => ({
    Cursor: join(home, '.cursor', 'hooks.json'),
    Codex: join(home, '.codex', 'hooks.json'),
    Antigravity: join(home, '.gemini', 'config', 'hooks.json'),
  })

  it('a home without whitespace: every command is the unquoted forward-slash shim path', () => {
    setup('plur-h3-')
    init()
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd').replace(/\\/g, '/')
    for (const [editor, file] of Object.entries(hookFiles())) {
      const cmds = collectCommands(JSON.parse(readFileSync(file, 'utf-8')))
      expect(cmds.length, editor).toBeGreaterThan(0)
      for (const c of cmds) {
        expect(c.startsWith(`${shim} hook-`), `${editor}: ${c}`).toBe(true)
        expect(c).not.toContain('"')
      }
    }
    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.windowsHookFallback).toEqual([])
  })

  it('a spaced home without short names: fallback per editor, and doctor names each one', () => {
    setup('Test User-')
    init()
    const shim = join(home, '.plur', 'bin', 'plur-hook.cmd').replace(/\\/g, '/')
    const files = hookFiles()
    for (const c of collectCommands(JSON.parse(readFileSync(files.Codex, 'utf-8')))) {
      expect(c.startsWith(`& "${shim}" hook-codex-`)).toBe(true)
    }
    for (const c of collectCommands(JSON.parse(readFileSync(files.Antigravity, 'utf-8')))) {
      expect(c.startsWith(`${shim} hook-agy-`)).toBe(true)
    }
    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.windowsHookFallback.sort()).toEqual(['Antigravity', 'Codex', 'Cursor'])
  })
})

describe('PLUR_HOOK_PROBE (Windows CI probe)', { timeout: 30000 }, () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-probe-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('records the hook subcommand and exits 0 without running the hook', () => {
    const probe = join(dir, 'probe.txt')
    execFileSync(process.execPath, [CLI, 'hook-inject', '--event', 'skill'], {
      encoding: 'utf-8', timeout: 10000, input: '{}',
      env: { ...process.env, HOME: dir, PLUR_PATH: join(dir, 'store'), PLUR_HOOK_PROBE: probe },
    })
    expect(readFileSync(probe, 'utf-8')).toBe('hook-inject\n')
    expect(existsSync(join(dir, 'store'))).toBe(false)
  })

  it('does nothing for non-hook commands', () => {
    const probe = join(dir, 'probe.txt')
    execFileSync(process.execPath, [CLI, '--version'], {
      encoding: 'utf-8', timeout: 10000, env: { ...process.env, PLUR_HOOK_PROBE: probe },
    })
    expect(existsSync(probe)).toBe(false)
  })
})
