/**
 * Formal-verification run (Adapters cluster, spec/formal/PlurSpec/Adapters.lean,
 * candidate 3): the Claude settings.json hook merge must be idempotent (also for
 * the Windows shim path), must preserve every spec that is not PLUR's — per
 * SPEC, not per entry — and must not throw on a command-less hook.
 */
import { describe, it, expect } from 'vitest'
import { _mergeClaudeHooks as mergeHooks, _isPlurClaudeHookSpec as isPlurHookSpec } from '../src/commands/init.js'

const WIN_SHIM = 'C:\\Users\\me\\.plur\\bin\\plur-hook.cmd'
const POSIX_SHIM = '/home/me/.plur/bin/plur-hook'
const plurMap = (cmd: string) => ({
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${cmd} hook-inject`, timeout: 90, async: true }] }],
  Stop: [{ hooks: [{ type: 'command', command: `${cmd} hook-learn-check`, timeout: 2 }] }],
})

describe('Claude settings.json hook merge (formal Adapters #3)', () => {
  it('is idempotent with the Windows shim path', () => {
    const once = mergeHooks({}, plurMap(WIN_SHIM))
    const twice = mergeHooks(once, plurMap(WIN_SHIM))
    expect(twice).toEqual(once)
    expect(twice.hooks!.UserPromptSubmit).toHaveLength(1)
  })

  it('is idempotent with the POSIX shim path and the npx fallback (good case)', () => {
    for (const cmd of [POSIX_SHIM, 'npx -y @plur-ai/cli@0.19.4']) {
      const once = mergeHooks({ other: 1 } as any, plurMap(cmd))
      expect(mergeHooks(once, plurMap(cmd))).toEqual(once)
    }
  })

  it('keeps a user spec that shares an entry with a PLUR spec', () => {
    const s = { hooks: { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'npx @plur-ai/cli hook-inject' },
      { type: 'command', command: './my-lint.sh' },
    ] }] } }
    const out = mergeHooks(s, plurMap(POSIX_SHIM))
    const cmds = out.hooks!.UserPromptSubmit.flatMap(e => e.hooks.map(h => h.command))
    expect(cmds).toContain('./my-lint.sh')
    expect(cmds).not.toContain('npx @plur-ai/cli hook-inject')
  })

  it('keeps a user hook that runs a non-hook plur subcommand', () => {
    const user = { type: 'command', command: 'npx @plur-ai/cli learn "session ended"' }
    const out = mergeHooks({ hooks: { Stop: [{ hooks: [user] }] } }, plurMap(POSIX_SHIM))
    expect(out.hooks!.Stop.flatMap(e => e.hooks)).toContainEqual(user)
  })

  it('does not throw on a command-less (type: "prompt") hook, and keeps it', () => {
    const prompt = { type: 'prompt', prompt: 'check' } as any
    const out = mergeHooks({ hooks: { Stop: [{ hooks: [prompt] }] } }, plurMap(POSIX_SHIM))
    expect(out.hooks!.Stop.flatMap(e => e.hooks)).toContainEqual(prompt)
    expect(isPlurHookSpec(prompt)).toBe(false)
  })

  it('still recognises every PLUR spec shape it installed', () => {
    expect(isPlurHookSpec({ type: 'command', command: `${WIN_SHIM} hook-inject` })).toBe(true)
    expect(isPlurHookSpec({ type: 'command', command: `${POSIX_SHIM} hook-inject --rehydrate` })).toBe(true)
    expect(isPlurHookSpec({ type: 'command', command: 'npx @plur-ai/cli hook-session-guard' })).toBe(true)
    expect(isPlurHookSpec({ type: 'command', command: './scripts/hook-inject.sh' })).toBe(false)
  })
})
