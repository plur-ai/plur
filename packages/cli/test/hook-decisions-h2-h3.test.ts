/**
 * Owner decisions H2 and H3 (docs/audits/2026-09-29-formal-decisions.yaml).
 *
 * H2 "prefix": a hook is PLUR's when it runs ANY `hook-*` subcommand behind
 * PLUR's own launcher: the plur-hook shim (any slash, quote or case form),
 * the `@plur-ai/cli` npx command, or the Claude Code exec form (node + the
 * CLI's js entry). No subcommand allow-list, so a new hook needs no list
 * update. Hooks run by any other binary stay the user's.
 *
 * H3 "plan": Windows hooks never rely on shell quoting. Claude Code gets the
 * documented exec form (https://code.claude.com/docs/en/hooks, "exec form":
 * `command` + `args`, no shell). Codex, Cursor and Antigravity get one
 * unquoted forward-slash command string, using the 8.3 short path when the
 * path contains whitespace; without short names, PowerShell editors get
 * `& "<path>"` and `plur doctor` reports it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isPlurHookCommand,
  isPlurHookSpec,
  windowsHookCommand,
  claudeHookSpec,
  useClaudeExecForm,
  parseClaudeVersion,
} from '../src/lib/hook-command.js'
import { isPlurHookCommand as mcpIsPlurHookCommand } from '../../mcp/src/hook-command.js'
import { buildCursorHooks, mergeCursorHooks } from '../src/cursor-hooks.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'

const SHIM_POSIX = '/Users/a/.plur/bin/plur-hook'
const SHIM_WIN = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe'
const CLI_WIN = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'

describe('H2: any hook-* behind PLUR\'s launcher is PLUR\'s', () => {
  it.each([
    [`${SHIM_POSIX} hook-auto-rate`],
    [`${SHIM_POSIX} hook-some-future-hook --flag`],
    [`"${SHIM_WIN}" hook-auto-rate`],
    [`${SHIM_WIN} hook-auto-rate`],
    ['C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd hook-codex-new-event'],
    ['& "C:/Users/Test User/.plur/bin/plur-hook.cmd" hook-cursor-new-event'],
    ['npx -y @plur-ai/cli@0.21.0 hook-auto-rate'],
    ['npx @plur-ai/cli hook-anything-new'],
  ])('claims %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
  })

  it.each([
    // A user hook named hook-* run by another binary is the user's.
    ['/usr/local/bin/mytool hook-foo'],
    ['C:\\tools\\mytool.exe hook-foo'],
    ['node C:/scripts/runner.js hook-foo'],
    // PLUR's launcher, but not a hook-* subcommand.
    [`${SHIM_POSIX} status`],
    [`${SHIM_POSIX} hook-`],
    ['npx @plur-ai/cli doctor'],
    // Look-alike binaries.
    ['C:\\Users\\Me\\.plur\\bin\\plur-hook-backup.ps1 hook-inject'],
    ['npx @plur-ai/cli-extras hook-inject'],
  ])('leaves %s alone', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(false)
  })

  it('recognises the Claude Code exec form (node + the CLI js entry + hook-*)', () => {
    expect(isPlurHookSpec({ command: NODE_WIN, args: [CLI_WIN, 'hook-auto-rate'] })).toBe(true)
    expect(isPlurHookSpec({ command: NODE_WIN, args: [CLI_WIN, 'hook-inject', '--event', 'skill'] })).toBe(true)
    expect(isPlurHookSpec({ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/cli@0.21.0', 'hook-inject'] })).toBe(true)
    // Same shape, someone else's script or subcommand: the user's.
    expect(isPlurHookSpec({ command: NODE_WIN, args: ['C:\\scripts\\runner.js', 'hook-foo'] })).toBe(false)
    expect(isPlurHookSpec({ command: NODE_WIN, args: [CLI_WIN, 'status'] })).toBe(false)
    expect(isPlurHookSpec({ command: 'C:\\tools\\mytool.exe', args: ['hook-foo'] })).toBe(false)
    // A plain command string still goes through the string matcher.
    expect(isPlurHookSpec({ command: `${SHIM_POSIX} hook-auto-rate` })).toBe(true)
  })

  it('Cursor re-merge drops a PLUR hook it has no list entry for, keeps the user\'s hook-foo', () => {
    const config = {
      version: 1,
      hooks: {
        stop: [
          { command: `${SHIM_POSIX} hook-cursor-some-new-hook` },
          { command: '/usr/local/bin/mytool hook-foo' },
        ],
      },
    }
    const next = mergeCursorHooks(config, buildCursorHooks(SHIM_POSIX))
    const cmds = next.hooks.stop.map((e) => e.command)
    expect(cmds).not.toContain(`${SHIM_POSIX} hook-cursor-some-new-hook`)
    expect(cmds).toContain('/usr/local/bin/mytool hook-foo')
    expect(cmds).toContain(`${SHIM_POSIX} hook-cursor-stop`)
  })

  it('Codex re-merge drops a PLUR hook it has no list entry for, keeps the user\'s hook-foo', () => {
    const config = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command' as const, command: `${SHIM_POSIX} hook-codex-some-new-hook` }] },
          { hooks: [{ type: 'command' as const, command: '/usr/local/bin/mytool hook-foo' }] },
        ],
      },
    }
    const next = mergeCodexHooks(config, buildCodexHooks(SHIM_POSIX))
    const cmds = (next.hooks.Stop ?? []).flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).not.toContain(`${SHIM_POSIX} hook-codex-some-new-hook`)
    expect(cmds).toContain('/usr/local/bin/mytool hook-foo')
  })
})

describe('H2: the mcp package keeps an identical copy of the matcher', () => {
  const region = (path: string): string => {
    const src = readFileSync(path, 'utf8')
    const start = src.indexOf('// BEGIN shared hook matcher')
    const end = src.indexOf('// END shared hook matcher')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('the two source regions are byte-identical', () => {
    expect(region(join(__dirname, '..', '..', 'mcp', 'src', 'hook-command.ts')))
      .toBe(region(join(__dirname, '..', 'src', 'lib', 'hook-command.ts')))
  })

  it.each([
    [`${SHIM_POSIX} hook-auto-rate`], [`"${SHIM_WIN}" hook-inject`], ['npx @plur-ai/cli hook-x'],
    ['/usr/local/bin/mytool hook-foo'], [`${SHIM_POSIX} status`],
  ])('both copies agree on %s', (cmd) => {
    expect(mcpIsPlurHookCommand(cmd)).toBe(isPlurHookCommand(cmd))
  })
})

describe('H3: Windows hook commands never rely on shell quoting', () => {
  const noShort = () => null

  it('a path without whitespace: forward slashes, no quotes, for every string editor', () => {
    for (const host of ['codex', 'cursor', 'agy'] as const) {
      expect(windowsHookCommand('C:\\Users\\a\\.plur\\bin\\plur-hook.cmd', host, noShort))
        .toEqual({ command: 'C:/Users/a/.plur/bin/plur-hook.cmd', fallback: false })
    }
  })

  it('a path with a space uses the 8.3 short path when there is one', () => {
    const short = () => 'C:\\Users\\TESTUS~1\\.plur\\bin\\PLUR-H~1.CMD'
    for (const host of ['codex', 'cursor', 'agy'] as const) {
      expect(windowsHookCommand(SHIM_WIN, host, short))
        .toEqual({ command: 'C:/Users/TESTUS~1/.plur/bin/PLUR-H~1.CMD', fallback: false })
    }
  })

  it('without short names: & "<path>" for PowerShell editors, reported as a fallback', () => {
    expect(windowsHookCommand(SHIM_WIN, 'codex', noShort))
      .toEqual({ command: '& "C:/Users/Test User/.plur/bin/plur-hook.cmd"', fallback: true })
    expect(windowsHookCommand(SHIM_WIN, 'cursor', noShort))
      .toEqual({ command: '& "C:/Users/Test User/.plur/bin/plur-hook.cmd"', fallback: true })
    // Antigravity runs hooks through cmd /C and escapes quotes; no quoted form
    // works there, so the plain path is written and reported.
    expect(windowsHookCommand(SHIM_WIN, 'agy', noShort))
      .toEqual({ command: 'C:/Users/Test User/.plur/bin/plur-hook.cmd', fallback: true })
  })

  it('a short path that still contains whitespace counts as unavailable', () => {
    expect(windowsHookCommand(SHIM_WIN, 'codex', () => SHIM_WIN).fallback).toBe(true)
  })

  it('Claude Code on win32: exec form — node + CLI entry + subcommand, no shell string', () => {
    expect(claudeHookSpec({ plat: 'win32', shellCmd: 'unused', node: NODE_WIN, cliEntry: CLI_WIN }, 'hook-inject', '--event', 'skill'))
      .toEqual({ command: NODE_WIN, args: [CLI_WIN, 'hook-inject', '--event', 'skill'] })
  })

  it('Claude Code on win32 without a CLI entry: exec form through cmd.exe, still no shell string', () => {
    expect(claudeHookSpec({ plat: 'win32', shellCmd: 'npx -y @plur-ai/cli@0.21.0', node: NODE_WIN, cliEntry: null }, 'hook-inject'))
      .toEqual({ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/cli@0.21.0', 'hook-inject'] })
  })

  // Exec form (`args`) arrived in Claude Code 2.1.139 (anthropics/claude-code
  // CHANGELOG.md, 2.1.139: "Added hook `args: string[]` field (exec form)").
  it('Claude Code on win32 older than 2.1.139: the unquoted string form, not exec form', () => {
    expect(claudeHookSpec({ plat: 'win32', shellCmd: 'unused', node: NODE_WIN, cliEntry: CLI_WIN, execForm: false, stringCmd: 'C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd' }, 'hook-inject', '--rehydrate'))
      .toEqual({ command: 'C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd hook-inject --rehydrate' })
  })

  it.each([
    // [claude --version, string form is a fallback, use exec form?]
    ['2.1.139 (Claude Code)', false, true],
    ['2.2.0 (Claude Code)', false, true],
    ['10.0.1', true, true],
    ['2.1.138 (Claude Code)', false, false],
    ['2.0.99', true, false],
    // Version unknown (claude not on PATH): the short-path string runs in
    // every shell, so prefer it; exec form only when the string would be
    // the fallback.
    [null, false, false],
    [null, true, true],
  ])('claude %s, string fallback %s → exec form %s', (version, stringIsFallback, expected) => {
    expect(useClaudeExecForm(version, stringIsFallback)).toBe(expected)
  })

  it('parses the version out of `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.214 (Claude Code)\n')).toBe('2.1.214')
    expect(parseClaudeVersion('garbage')).toBeNull()
  })

  it('Claude Code on darwin/linux: the unchanged shell string', () => {
    expect(claudeHookSpec({ plat: 'darwin', shellCmd: SHIM_POSIX, node: '/usr/bin/node', cliEntry: '/x/index.js' }, 'hook-inject', '--rehydrate'))
      .toEqual({ command: `${SHIM_POSIX} hook-inject --rehydrate` })
  })
})
