/**
 * #1366 — `plur init --codex` heals the old `plur-mcp.cmd` registration
 * through `codex mcp remove` + `codex mcp add`, which re-adds only the
 * command and args. A table that carries anything else (env, another key, a
 * subtable, a multi-line args array) is therefore not treated as PLUR's own
 * entry and is left alone, so nothing in it is lost.
 *
 * Windows behaviour is exercised with the win32 platform preload and a
 * stand-in `codex` binary, not on real Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { readCodexPlurMcpEntry } from '../src/mcp-config.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href
const HEAD = `[mcp_servers.plur]\ncommand = 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd'\n`

const SHAPES: Array<[string, string]> = [
  ['an [mcp_servers.plur.env] subtable', `${HEAD}args = []\n\n[mcp_servers.plur.env]\nPLUR_PATH = 'D:\\\\memory'\n`],
  ['a subtable further down the file', `${HEAD}\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.plur.env]\nPLUR_PATH = "D:/memory"\n`],
  ['an inline env table', `${HEAD}env = { PLUR_PATH = "D:/memory" }\n`],
  ['another key', `${HEAD}startup_timeout_sec = 30\n`],
  ['a dotted env key', `${HEAD}env.PLUR_PATH = "D:/memory"\n`],
  ['a multi-line args array', `${HEAD}args = [\n  "--profile",\n  "work",\n]\n`],
]

describe('readCodexPlurMcpEntry: only a bare command + args table is PLUR\'s (#1366)', () => {
  it.each(SHAPES)('returns null for %s', (_label, toml) => {
    expect(readCodexPlurMcpEntry(toml)).toBeNull()
  })

  it('still reads the plain shim entry, with comments and blank lines', () => {
    expect(readCodexPlurMcpEntry(`${HEAD}# written by plur init\n\nargs = [] # none\n`))
      .toEqual({ command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [] })
    expect(readCodexPlurMcpEntry(`${HEAD}args = ["a", 'b']\n\n[mcp_servers.other]\nenv = { X = "1" }\n`))
      .toEqual({ command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: ['a', 'b'] })
  })
})

describe('plur init --codex leaves a shim entry with extra settings alone (#1366, win32 stub)', { timeout: 90000 }, () => {
  let home: string
  let bin: string
  let log: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-1366-'))
    bin = join(home, 'fakebin')
    mkdirSync(bin)
    log = join(home, 'codex.log')
    const state = join(home, 'codex.state')
    writeFileSync(join(bin, 'codex'), [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      `if [ "$1 $2" = "mcp list" ]; then [ -f "${state}" ] && echo "plur  C:/whatever"; exit 0; fi`,
      `if [ "$1 $2 $3" = "mcp remove plur" ]; then rm -f "${state}"; exit 0; fi`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
    writeFileSync(state, 'registered')
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function run(args: string[]): string {
    try {
      return execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, ...args], {
        encoding: 'utf-8', timeout: 30000, cwd: home,
        env: { ...isolatedHomeEnv(home), PATH: `${bin}:${process.env.PATH}` },
      })
    } catch (err: any) { return err.stdout?.toString() ?? '' }
  }

  it.each(SHAPES)('does not remove + re-add %s, and prints the lines to change by hand', (_label, toml) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), toml)
    const out = run(['init', '--global', '--no-desktop', '--no-cursor', '--no-antigravity', '--no-opencode', '--codex', '--no-prompt'])
    const calls = existsSync(log) ? readFileSync(log, 'utf-8') : ''
    expect(calls).toContain('mcp list')
    expect(calls).not.toContain('mcp remove')
    expect(calls).not.toContain('mcp add')
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toBe(toml)
    // Refs #1366 (re-review): the refusal names the fault and the manual fix.
    expect(out).toContain('old plur-mcp.cmd entry, which fails to start (spawn EINVAL)')
    expect(out).toMatch(/under \[mcp_servers\.plur\], replace the command and args lines with\s+command = /)
    expect(out).toContain('keep every other setting (env included)')
  })

  it.each(SHAPES)('doctor still flags %s as the broken shim (codexCmdShimMcp, not wired)', (_label, toml) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), toml)
    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.codexCmdShimMcp).toBe(true)
    expect(report.codexWired).toBe(false)
  })

  it('doctor does not flag a custom command that merely has env', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.plur]\ncommand = 'C:\\custom\\run-plur.cmd'\n\n[mcp_servers.plur.env]\nPLUR_PATH = "D:/memory"\n`)
    expect(JSON.parse(run(['doctor', '--no-handshake', '--json'])).codexCmdShimMcp).toBe(false)
  })
})
