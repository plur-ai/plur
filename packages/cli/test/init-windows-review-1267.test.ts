/**
 * #1267 review follow-ups:
 *  1. the "machine-local path in .cursor/hooks.json" warning must still fire
 *     now that the shim path is quoted;
 *  2. an old Windows `plur-mcp.cmd` registration in Codex's config.toml is
 *     healed in place without losing user settings (#1623)
 *     and flagged by `plur doctor`;
 *  3. the opencode skip line says why it skipped.
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
const OLD_CMD = 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd'

describe('readCodexPlurMcpEntry', () => {
  it('reads a basic-string command with escaped backslashes', () => {
    const toml = `model = "o3"\n\n[mcp_servers.plur]\ncommand = "C:\\\\Users\\\\Test User\\\\.plur\\\\bin\\\\plur-mcp.cmd"\n\n[mcp_servers.other]\ncommand = "x"\n`
    expect(readCodexPlurMcpEntry(toml)).toEqual({ command: OLD_CMD, args: [] })
  })

  it('reads a literal-string command and an args array', () => {
    const toml = `[mcp_servers.plur]\ncommand = 'C:\\Program Files\\nodejs\\node.exe'\nargs = ['C:\\x\\index.js']\n`
    expect(readCodexPlurMcpEntry(toml)).toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\x\\index.js'] })
  })

  it('ignores other servers, commented tables and a missing table', () => {
    expect(readCodexPlurMcpEntry('[mcp_servers.plurality]\ncommand = "a"\n')).toBeNull()
    expect(readCodexPlurMcpEntry('# [mcp_servers.plur]\n# command = "a"\n')).toBeNull()
    expect(readCodexPlurMcpEntry('')).toBeNull()
  })
})

describe('#1267 review follow-ups (spawned CLI, win32 stub, home with a space)', { timeout: 60000 }, () => {
  let home: string
  let bin: string
  let log: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    bin = join(home, 'fakebin')
    mkdirSync(bin)
    log = join(home, 'codex.log')
    // A stand-in `codex` binary: logs its argv, lists `plur` while state says
    // it is registered, and `mcp remove plur` clears that state.
    const state = join(home, 'codex.state')
    writeFileSync(join(bin, 'codex'), [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      `if [ "$1 $2" = "mcp list" ]; then [ -f "${state}" ] && echo "plur  C:/whatever"; exit 0; fi`,
      `if [ "$1 $2 $3" = "mcp remove plur" ]; then rm -f "${state}"; exit 0; fi`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function run(args: string[]): string {
    try {
      return execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, ...args], {
        encoding: 'utf-8', timeout: 30000, cwd: home,
        env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', PATH: `${bin}:${process.env.PATH}` },
      })
    } catch (err: any) {
      return err.stdout?.toString() ?? ''
    }
  }

  function seedCodex(command: string, args: string[] = []): void {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const esc = (s: string) => s.replace(/\\/g, '\\\\')
    writeFileSync(join(home, '.codex', 'config.toml'),
      `[mcp_servers.plur]\ncommand = "${esc(command)}"\n${args.length ? `args = [${args.map((a) => `"${esc(a)}"`).join(', ')}]\n` : ''}`)
    writeFileSync(join(home, 'codex.state'), 'registered')
  }

  it('1. warns about committing .cursor/ even though the shim path is quoted', () => {
    const out = run(['init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-opencode', '--cursor'])
    expect(out).toContain('Committing .cursor/mcp.json')
  })

  it('2a. init heals an old .cmd registration in Codex in place', () => {
    seedCodex(OLD_CMD)
    const out = run(['init', '--global', '--no-desktop', '--no-cursor', '--no-antigravity', '--no-opencode', '--codex'])
    const calls = existsSync(log) ? readFileSync(log, 'utf-8') : ''
    expect(calls).not.toContain('mcp remove')
    expect(calls).not.toContain('mcp add')
    const entry = readCodexPlurMcpEntry(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))!
    expect(entry.command).toBe(process.execPath)
    expect(entry.args[0]).toMatch(/index\.js$/)
    expect(entry.command).not.toContain('.cmd')
    expect(out).toMatch(/Codex[\s\S]*MCP server: .*updated Codex MCP registration in place/)

  })

  it('2b. init leaves a custom Codex registration alone', () => {
    seedCodex('C:\\custom\\run-plur.cmd')
    run(['init', '--global', '--no-desktop', '--no-cursor', '--no-antigravity', '--no-opencode', '--codex'])
    const calls = existsSync(log) ? readFileSync(log, 'utf-8') : ''
    expect(calls).not.toContain('mcp remove')
    expect(calls).not.toContain('mcp add')
  })

  it('2c. doctor flags the old .cmd registration in Codex', () => {
    seedCodex(OLD_CMD)
    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.codexCmdShimMcp).toBe(true)
    expect(report.codexWired).toBe(false)
  })

  it('2d. doctor does not flag a custom Codex registration', () => {
    seedCodex('C:\\custom\\run-plur.cmd')
    const report = JSON.parse(run(['doctor', '--no-handshake', '--json']))
    expect(report.codexCmdShimMcp).toBe(false)
  })

  it('3. the opencode skip line names --no-opencode when it was passed', () => {
    const out = run(['init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor', '--no-opencode'])
    const line = out.split('\n').find((l) => /opencode/i.test(l) && /skipped/i.test(l)) ?? ''
    expect(line).toContain('--no-opencode')
    expect(line).not.toContain('found')
    expect(line).not.toContain('to silence this')
  })
})
