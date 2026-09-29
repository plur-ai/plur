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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isPlurHookCommand,
  isPlurHookSpec,
  windowsHookCommand,
  claudeHookSpec,
  useClaudeExecForm,
  parseClaudeVersion,
  nextRecordedEntries,
  RECORDED_ENTRIES_MAX,
} from '../src/lib/hook-command.js'
import { isPlurHookCommand as mcpIsPlurHookCommand } from '../../mcp/src/hook-command.js'
import { buildCursorHooks, mergeCursorHooks } from '../src/cursor-hooks.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'

const SHIM_POSIX = '/Users/a/.plur/bin/plur-hook'
const SHIM_WIN = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe'
const CLI_WIN = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'

/** Run `fn` with a temp HOME whose plur-hook.meta.json records `entry` (none when null). */
function withRecordedEntry(entry: string | null, fn: () => void): void {
  const saved = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'plur-f4-'))
  try {
    process.env.HOME = home
    if (entry !== null) {
      mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
      writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), JSON.stringify({ entrypoint: entry }))
    }
    fn()
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

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

  // Decision F4 narrowed this: the exec form is PLUR's only when its js entry
  // is the one `plur init` recorded in ~/.plur/bin/plur-hook.meta.json.
  it('recognises the Claude Code exec form (node + the recorded CLI js entry + hook-*)', () => {
    withRecordedEntry(CLI_WIN, () => {
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

/**
 * Decision F4 (round-2 board; spec/formal/findings/adapters.md on
 * formal/field-report-2026-09-29): the matcher is anchored. A hook is PLUR's
 * only if the WHOLE command is PLUR's launcher, then a `hook-*` subcommand,
 * then nothing but plain arguments. Chained or wrapped commands, and an
 * `echo <shim> hook-x`, are the user's.
 */
/**
 * F4 follow-up (idempotent init): plur-hook.meta.json keeps every CLI js
 * entry PLUR itself has recorded, so an exec-form hook written by an earlier
 * install location is still PLUR's and re-init replaces it. A foreign
 * checkout that was never recorded is still not claimed.
 */
describe('F4: recorded CLI entries are a bounded history', () => {
  const A = 'C:\\old\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'
  const B = 'C:\\new\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'

  function withMeta(meta: unknown, fn: () => void): void {
    const saved = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), 'plur-f4-hist-'))
    try {
      process.env.HOME = home
      mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
      writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), JSON.stringify(meta))
      fn()
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('migrates a single-entry meta file to a list of one, then appends the new entry', () => {
    expect(nextRecordedEntries({ entrypoint: A }, B)).toEqual([A, B])
    expect(nextRecordedEntries(null, B)).toEqual([B])
    expect(nextRecordedEntries('garbage', B)).toEqual([B])
  })

  it('does not duplicate an entry already recorded (in any slash or case form)', () => {
    expect(nextRecordedEntries({ entrypoint: B, entrypoints: [A, B] }, B)).toEqual([A, B])
    expect(nextRecordedEntries({ entrypoints: [A, B] }, A.toUpperCase().replace(/\\/g, '/'))).toEqual([B, A.toUpperCase().replace(/\\/g, '/')])
  })

  it('is bounded: keeps the most recent entries, always including the current one', () => {
    const many = Array.from({ length: 15 }, (_, i) => `C:\\p${i}\\@plur-ai\\cli\\dist\\index.js`)
    const out = nextRecordedEntries({ entrypoints: many }, B)
    expect(out.length).toBe(RECORDED_ENTRIES_MAX)
    expect(out[out.length - 1]).toBe(B)
    expect(out).toContain(many[14])
    expect(out).not.toContain(many[0])
  })

  it('claims an exec-form hook whose entry was recorded earlier', () => {
    withMeta({ entrypoint: B, entrypoints: [A, B] }, () => {
      expect(isPlurHookSpec({ command: NODE_WIN, args: [A, 'hook-inject'] })).toBe(true)
      expect(isPlurHookSpec({ command: NODE_WIN, args: [B, 'hook-inject'] })).toBe(true)
    })
  })

  it('still claims the entry of a legacy single-entry meta file', () => {
    withMeta({ entrypoint: A }, () => {
      expect(isPlurHookSpec({ command: NODE_WIN, args: [A, 'hook-inject'] })).toBe(true)
    })
  })

  it('never claims a foreign checkout that was never recorded', () => {
    withMeta({ entrypoint: B, entrypoints: [A, B] }, () => {
      expect(isPlurHookSpec({ command: NODE_WIN, args: ['C:\\src\\someone\\packages\\cli\\dist\\index.js', 'hook-inject'] })).toBe(false)
    })
  })
})

describe('F4: the PLUR-hook matcher is anchored', () => {
  const WIN_SHIM_F = 'C:\\Users\\me\\.plur\\bin\\plur-hook.cmd'
  const POSIX_SHIM_F = '/home/me/.plur/bin/plur-hook'

  // Every layout init has ever written, including the formal test's list
  // (packages/cli/test/formal-adapters-hooks.test.ts on the formal branch).
  it.each([
    [`${WIN_SHIM_F} hook-inject`],
    [`${POSIX_SHIM_F} hook-inject --rehydrate`],
    [`${POSIX_SHIM_F} hook-learn-check`],
    ['npx @plur-ai/cli hook-session-guard'],
    ['npx @plur-ai/cli hook-inject'],
    ['npx @plur-ai/cli hook-observe --post'],
    ['npx -y @plur-ai/cli@0.19.4 hook-inject'],
    ['npx -y @plur-ai/cli@0.9.1 hook-learn-check'],
    [`${POSIX_SHIM_F} hook-inject --event plan_mode`],
    [`${SHIM_WIN} hook-inject --event plan_mode`],
    [`"${SHIM_WIN}" hook-observe --post`],
    ['"/Users/Test User/.plur/bin/plur-hook" hook-inject'],
    ['C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd hook-codex-inject'],
    ['C:/Users/RUNNER~1/AppData/Local/Temp/TESTUS~1/PLUR~1/bin/PLUR-H~1.CMD hook-cursor-stop'],
    ['& "C:/Users/Test User/.plur/bin/plur-hook.cmd" hook-cursor-guard'],
    ['plur-hook hook-inject'],
    ['/tmp/Test User-x/.plur/bin/plur-hook.cmd hook-agy-guard'],
  ])('still claims the layout %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(true)
    expect(mcpIsPlurHookCommand(cmd)).toBe(true)
  })

  it.each([
    [`echo ${POSIX_SHIM_F} hook-inject`],
    [`echo ${SHIM_WIN} hook-inject`],
    [`${POSIX_SHIM_F} hook-inject && rm -rf ~/x`],
    [`${POSIX_SHIM_F} hook-inject; curl example.invalid`],
    [`${POSIX_SHIM_F} hook-inject | tee /tmp/log`],
    [`${POSIX_SHIM_F} hook-inject > /tmp/out`],
    [`${POSIX_SHIM_F} hook-inject \`whoami\``],
    [`${POSIX_SHIM_F} hook-inject $(whoami)`],
    [`nice ${POSIX_SHIM_F} hook-inject`],
    [`/usr/bin/env ${POSIX_SHIM_F} hook-inject`],
    [`C:\\Windows\\env.exe ${WIN_SHIM_F} hook-inject`],
    ['/home/me/tools/plur-hook hook-inject extra "quoted arg"'],
    [`env FOO=1 ${POSIX_SHIM_F} hook-inject`],
    ['npx @plur-ai/cli hook-inject && echo done'],
    ['sh -c "npx @plur-ai/cli hook-inject"'],
    ['npx @plur-ai/cli learn "session ended"'],
    ['./scripts/hook-inject.sh'],
  ])('does not claim %s', (cmd) => {
    expect(isPlurHookCommand(cmd)).toBe(false)
    expect(mcpIsPlurHookCommand(cmd)).toBe(false)
  })

  it('exec form: an index.js that merely ends in packages/cli/dist is not claimed', () => {
    withRecordedEntry(CLI_WIN, () => {
      expect(isPlurHookSpec({ command: NODE_WIN, args: ['C:\\someone\\packages\\cli\\dist\\index.js', 'hook-inject'] })).toBe(false)
      expect(isPlurHookSpec({ command: NODE_WIN, args: ['C:\\other\\node_modules\\@plur-ai\\cli\\dist\\index.js', 'hook-inject'] })).toBe(false)
      expect(isPlurHookSpec({ command: NODE_WIN, args: [CLI_WIN.toUpperCase(), 'hook-inject'] })).toBe(true)
    })
  })

  it('exec form: nothing is claimed when no entry is recorded', () => {
    withRecordedEntry(null, () => {
      expect(isPlurHookSpec({ command: NODE_WIN, args: [CLI_WIN, 'hook-inject'] })).toBe(false)
    })
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
