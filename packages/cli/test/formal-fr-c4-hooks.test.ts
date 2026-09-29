/**
 * Formal cluster 4 (field report, 2026-09-29) — replays for the H2/H3
 * sections of spec/formal/PlurSpec/Adapters.lean (§10, §11). Findings:
 * spec/formal/findings/adapters.md.
 *
 * "holds:" pins a property the model proves. "NEEDS-OWNER evidence:" pins
 * CURRENT behaviour the model shows breaks the stated guarantee ("user hooks
 * stay untouched", decision H2); left unfixed on purpose — flip on decision.
 */
import { describe, it, expect } from 'vitest'
import {
  isPlurHookCommand, isPlurHookSpec, windowsHookCommand, claudeHookSpec, useClaudeExecForm, hookCommandPrefix,
} from '../src/lib/hook-command.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'
import { buildCursorHooks, mergeCursorHooks } from '../src/cursor-hooks.js'
import { buildAgyHookSet, mergeAgyHooks } from '../src/antigravity-hooks.js'
import { _isPlurClaudeHookSpec } from '../src/commands/init.js'

const SHIM = '/Users/a/.plur/bin/plur-hook'
const SHIM_WIN = 'C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd'

/** Every launcher form some version of init wrote (git log of init.ts, mcp index.ts, the editor installers). */
const HISTORIC_LAUNCHERS = [
  'npx @plur-ai/cli',                                  // 2026-04 first init
  'npx -y @plur-ai/cli@0.9.13',                        // pinned fallback (#1069)
  'npx -y @plur-ai/cli@latest',
  SHIM,                                                // shim, unquoted
  '/Users/John Smith/.plur/bin/plur-hook',             // shim with a space, pre-quoting
  '"/Users/John Smith/.plur/bin/plur-hook"',           // hookCommandPrefix quoting
  SHIM_WIN,                                            // pre-#1267 Windows, backslashes, unquoted
  `"${SHIM_WIN}"`,
  'C:/Users/TESTUS~1/.plur/bin/plur-hook.cmd',         // H3 short path
  'C:/Users/TESTUS~1/PLUR~1/bin/PLUR-H~1.CMD',         // H3 short path, every component shortened
  '& "C:/Users/Test User/.plur/bin/plur-hook.cmd"',    // H3 PowerShell fallback
  'C:/Users/Test User/.plur/bin/plur-hook.cmd',        // H3 Antigravity fallback
]
const SUBS = ['hook-inject', 'hook-inject --rehydrate', 'hook-auto-rate claude', 'hook-codex-session-end', 'hook-some-future-hook']

describe('H2 matcher (Adapters.lean §10)', () => {
  it('holds: every historic launcher + any hook-* is PLUR\'s (written_forms_claimed)', () => {
    for (const l of HISTORIC_LAUNCHERS) for (const s of SUBS) expect(isPlurHookCommand(`${l} ${s}`), `${l} ${s}`).toBe(true)
  })

  it('holds: the exec forms H3 writes are PLUR\'s — node + entry only once `plur init` recorded that entry (decision F4)', () => {
    // Decision F4 (#1270): an exec-form spec is PLUR's only for a CLI entry
    // plur-hook.meta.json records. None is recorded in this test's HOME.
    expect(isPlurHookSpec(claudeHookSpec({ plat: 'win32', shellCmd: 'npx -y @plur-ai/cli@0.21.0', node: 'C:/n/node.exe', cliEntry: 'C:/g/node_modules/@plur-ai/cli/dist/index.js' }, 'hook-inject'))).toBe(false)
    expect(isPlurHookSpec(claudeHookSpec({ plat: 'win32', shellCmd: 'npx -y @plur-ai/cli@0.21.0', node: 'C:/n/node.exe', cliEntry: null }, 'hook-inject'))).toBe(true)
  })

  it('holds: look-alikes and other binaries are the user\'s (lookalike_not_claimed)', () => {
    for (const c of [
      '/Users/a/.plur/bin/plur-hook-backup.ps1 hook-inject',
      'npx @plur-ai/cli-extras hook-inject',
      '/usr/local/bin/mytool hook-inject',
      `${SHIM} status`,
      `${SHIM}x hook-inject`,
    ]) expect(isPlurHookCommand(c), c).toBe(false)
  })

  it('holds: the Claude guard never throws on a non-string or missing command', () => {
    expect(_isPlurClaudeHookSpec(null)).toBe(false)
    expect(_isPlurClaudeHookSpec({ command: 42 as unknown as string })).toBe(false)
    expect(_isPlurClaudeHookSpec({ args: ['x'] })).toBe(false)
  })

  it('decision F4 applied: a user command that CONTAINS a PLUR invocation is the user\'s (was embedded_claimed)', () => {
    for (const c of [
      `${SHIM} hook-inject && /Users/a/bin/notify.sh`,        // user chained their own step
      `/usr/bin/nice -n 10 ${SHIM} hook-inject`,              // user wrapper
      `echo ${SHIM} hook-inject >> /Users/a/hooks.log`,       // mentions it as data
      'echo run npx @plur-ai/cli hook-inject later',
    ]) expect(isPlurHookCommand(c), c).toBe(false)
    expect(isPlurHookCommand(`echo "${SHIM} hook-inject" >> /Users/a/hooks.log`)).toBe(false)
    // Exec form: only a recorded CLI entry, not any checkout's dist/index.js.
    expect(isPlurHookSpec({ command: 'C:/n/node.exe', args: ['C:/work/mytool/packages/cli/dist/index.js', 'hook-deploy'] })).toBe(false)
  })

  it('decision F4 applied: re-running the Codex install keeps the user\'s chained step', () => {
    const userCmd = `${SHIM} hook-codex-session-end && /Users/a/bin/notify.sh`
    const next = mergeCodexHooks(
      { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: userCmd }] }] } },
      buildCodexHooks(SHIM),
    )
    const cmds = Object.values(next.hooks ?? {}).flatMap(es => es.flatMap(e => e.hooks.map(h => h.command)))
    expect(cmds).toContain(userCmd)
  })
})

describe('re-running init is idempotent from older layouts (Adapters.lean §10)', () => {
  it('holds: Codex — one PLUR set per event after any older layout, user hooks kept', () => {
    for (const old of HISTORIC_LAUNCHERS) {
      const start = {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command' as const, command: `${old} hook-codex-session-start` }] }],
          Stop: [{ hooks: [{ type: 'command' as const, command: '/usr/local/bin/mytool hook-foo' }] }],
        },
      }
      const once = mergeCodexHooks(start, buildCodexHooks(SHIM))
      const twice = mergeCodexHooks(once, buildCodexHooks(SHIM))
      expect(twice, old).toEqual(once)
      const fresh = buildCodexHooks(SHIM)
      for (const [ev, entries] of Object.entries(fresh)) {
        const plur = (once.hooks![ev] ?? []).filter(e => e.hooks.some(h => isPlurHookCommand(h.command)))
        expect(plur, `${old} ${ev}`).toEqual(entries)
      }
      expect(once.hooks!.Stop.some(e => e.hooks.some(h => h.command === '/usr/local/bin/mytool hook-foo'))).toBe(true)
    }
  })

  it('holds: Cursor — idempotent from every older layout', () => {
    for (const old of HISTORIC_LAUNCHERS) {
      const start = { version: 1, hooks: { stop: [{ command: `${old} hook-cursor-stop` }, { command: '/usr/local/bin/mytool hook-foo' }] } }
      const once = mergeCursorHooks(start, buildCursorHooks(SHIM))
      expect(mergeCursorHooks(once, buildCursorHooks(SHIM)), old).toEqual(once)
      expect(once.hooks.stop.filter(e => isPlurHookCommand(e.command)), old).toEqual(buildCursorHooks(SHIM).stop)
    }
  })

  it('holds: Antigravity — the named set is replaced, other sets untouched', () => {
    const start = { mine: { enabled: true } } as Record<string, unknown>
    const once = mergeAgyHooks(start as never, buildAgyHookSet(SHIM))
    expect(mergeAgyHooks(once, buildAgyHookSet(SHIM))).toEqual(once)
    expect((once as Record<string, unknown>).mine).toEqual({ enabled: true })
  })
})

describe('H3 command form table (Adapters.lean §11)', () => {
  const short = (s: string | null) => () => s
  it('holds: darwin/linux quote only a spaced shim path', () => {
    expect(hookCommandPrefix(SHIM)).toBe(SHIM)
    expect(hookCommandPrefix('/Users/J S/.plur/bin/plur-hook')).toBe('"/Users/J S/.plur/bin/plur-hook"')
  })
  it('holds: Windows string editors — no quotes unless the documented PowerShell fallback (win_no_quote_except_fallback)', () => {
    for (const host of ['codex', 'cursor', 'agy'] as const) {
      expect(windowsHookCommand(SHIM_WIN.replace('Test User', 'TestUser'), host, short(null))).toEqual({ command: 'C:/Users/TestUser/.plur/bin/plur-hook.cmd', fallback: false })
      expect(windowsHookCommand(SHIM_WIN, host, short('C:\\Users\\TESTUS~1\\.plur\\bin\\PLUR-H~1.CMD'))).toEqual({ command: 'C:/Users/TESTUS~1/.plur/bin/PLUR-H~1.CMD', fallback: false })
      const fb = windowsHookCommand(SHIM_WIN, host, short(null))
      expect(fb.fallback).toBe(true)
      expect(fb.command.includes('"')).toBe(host !== 'agy')
    }
  })
  it('holds: Claude exec form never for a known-old Claude Code (exec_needs_support)', () => {
    for (const fb of [false, true]) {
      expect(useClaudeExecForm('2.1.138', fb)).toBe(false)
      expect(useClaudeExecForm('2.1.139', fb)).toBe(true)
    }
    expect(useClaudeExecForm(null, false)).toBe(false)
    expect(useClaudeExecForm(null, true)).toBe(true)
  })
})
