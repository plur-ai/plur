/**
 * Formal-verification gap closure, 2026-09-26 (R2-CLI residual): the session
 * guard exempts any `mcp__<server>__plur_session_start`, but `plur init`
 * installed the PostToolUse session-mark hook with the exact matcher
 * `mcp__plur__plur_session_start`. Under a plugin-named server the session
 * was never marked started, so the next tool call got a nudge. The matcher
 * now follows the guard's rule. spec/formal/findings/r2-cli.md.
 */
import { describe, it, expect } from 'vitest'
import * as init from '../src/commands/init.js'

const build = (init as any)._buildEnforcementHooks as ((cmd: string) => Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>) | undefined

function markMatcher(): RegExp {
  expect(build).toBeTypeOf('function')
  const post = build!('plur').PostToolUse ?? []
  const entry = post.find(e => e.hooks.some(h => (h.command ?? '').includes('hook-session-mark')))
  expect(entry?.matcher).toBeTruthy()
  // Claude Code tests a hook matcher as a regular expression against the tool name.
  return new RegExp(`^(?:${entry!.matcher})$`)
}

describe('session-mark matcher follows the guard exemption', () => {
  it('matches the plain server name (good case)', () => {
    expect(markMatcher().test('mcp__plur__plur_session_start')).toBe(true)
  })
  it('matches a plugin-prefixed server name', () => {
    expect(markMatcher().test('mcp__plugin_plur_plur__plur_session_start')).toBe(true)
  })
  it('does not match other plur tools', () => {
    const m = markMatcher()
    expect(m.test('mcp__plur__plur_learn')).toBe(false)
    expect(m.test('mcp__plur__plur_session_start_extra')).toBe(false)
  })
})
