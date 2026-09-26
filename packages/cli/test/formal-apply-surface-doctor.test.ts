/**
 * Formal-verification apply phase, decision S4 (2), 2026-09-26.
 *
 * `plur doctor` recognises a PLUR hook installed through the Windows shim
 * (`C:\Users\me\.plur\bin\plur-hook.cmd hook-inject`). It tested the literal
 * `.plur/bin/plur-hook`, so on Windows a working install read as "no hooks".
 * Same normalisation as init.ts `isPlurHookSpec` (findings/adapters.md §3).
 */
import { describe, it, expect } from 'vitest'
import { _hasAnyPlurHook } from '../src/commands/doctor.js'

const settings = (command: unknown) => ({
  hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
})

describe('doctor hasAnyPlurHook (S4.2)', () => {
  it('recognises the Windows shim path (backslashes)', () => {
    expect(_hasAnyPlurHook(settings('C:\\Users\\me\\.plur\\bin\\plur-hook.cmd hook-inject'))).toBe(true)
  })
  it('still recognises the POSIX shim and the npx form (good case)', () => {
    expect(_hasAnyPlurHook(settings('/home/me/.plur/bin/plur-hook hook-inject'))).toBe(true)
    expect(_hasAnyPlurHook(settings('npx @plur-ai/cli hook-inject'))).toBe(true)
  })
  it('a user hook or a non-command hook is not PLUR', () => {
    expect(_hasAnyPlurHook(settings('./my-lint.sh'))).toBe(false)
    expect(_hasAnyPlurHook({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }] } })).toBe(false)
  })
})
