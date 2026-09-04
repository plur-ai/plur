import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildAgyHookSet,
  mergeAgyHooks,
  hasPlurAgyHooks,
  readAgyHooksConfig,
  writeAgyHooksConfig,
  AGY_HOOK_SET_NAME,
} from '../src/antigravity-hooks.js'
import { lastUserInput } from '../src/lib/agy-hook-io.js'

const SHIM = '/home/u/.plur/bin/plur-hook'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-agy-hooks-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('buildAgyHookSet', () => {
  it('uses exactly the two events the adapter needs', () => {
    const set = buildAgyHookSet(SHIM)
    expect(Object.keys(set).sort()).toEqual(['PreInvocation', 'PreToolUse', 'enabled'])
    expect(set.enabled).toBe(true)
  })

  it('shapes tool events with a matcher group and lifecycle events flat — agy rejects the other way round', () => {
    const set = buildAgyHookSet(SHIM)
    // PreInvocation: flat handler array, straight to {type, command}.
    expect(set.PreInvocation![0].command).toContain('hook-agy-pre-invocation')
    expect(set.PreInvocation![0]).not.toHaveProperty('matcher')
    expect(set.PreInvocation![0]).not.toHaveProperty('hooks')
    // PreToolUse: {matcher, hooks:[]} wrapper.
    expect(set.PreToolUse![0].matcher).toBe('*')
    expect(set.PreToolUse![0].hooks[0].command).toContain('hook-agy-guard')
  })

  // agy's Stop can only BLOCK termination (decision:"continue" re-enters the
  // loop) and PostToolUse can only output {} — neither can carry a nudge, and
  // wiring them anyway would either force extra turns or do nothing.
  it('never registers Stop or PostToolUse', () => {
    const set = buildAgyHookSet(SHIM)
    expect(set.Stop).toBeUndefined()
    expect(set.PostToolUse).toBeUndefined()
  })

  it('keeps timeouts within agy seconds semantics and the hybrid worst case', () => {
    const set = buildAgyHookSet(SHIM)
    expect(set.PreInvocation![0].timeout).toBeGreaterThanOrEqual(15)
    expect(set.PreInvocation![0].timeout).toBeLessThanOrEqual(30)
    expect(set.PreToolUse![0].hooks[0].timeout).toBeLessThanOrEqual(10)
  })
})

describe('mergeAgyHooks — ownership is the named key, nothing else', () => {
  it('is idempotent', () => {
    const once = mergeAgyHooks({}, buildAgyHookSet(SHIM))
    const twice = mergeAgyHooks(once, buildAgyHookSet(SHIM))
    expect(twice).toEqual(once)
  })

  it('replaces a stale PLUR set on upgrade rather than duplicating', () => {
    const old = mergeAgyHooks({}, buildAgyHookSet('/old/plur-hook'))
    const upgraded = mergeAgyHooks(old, buildAgyHookSet(SHIM))
    expect(Object.keys(upgraded)).toEqual([AGY_HOOK_SET_NAME])
    expect(upgraded[AGY_HOOK_SET_NAME].PreInvocation![0].command).toContain(SHIM)
  })

  it('passes a user’s own hook sets through byte-identical', () => {
    const mine = {
      'my-linter': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
      },
      'safety-gate': { enabled: false, PreToolUse: [{ matcher: '*', hooks: [{ command: './gate.sh' }] }] },
    }
    const merged = mergeAgyHooks(mine as never, buildAgyHookSet(SHIM))
    expect(merged['my-linter']).toEqual(mine['my-linter'])
    expect(merged['safety-gate']).toEqual(mine['safety-gate'])
    expect(hasPlurAgyHooks(merged)).toBe(true)
  })

  it('does not claim a user set that happens to mention plur in a command', () => {
    const mine = { 'my-thing': { PreInvocation: [{ command: 'echo plur-memory' }] } }
    expect(hasPlurAgyHooks(mine as never)).toBe(false)
  })
})

describe('read/write round trip', () => {
  it('reads back what it wrote', () => {
    const p = join(dir, 'hooks.json')
    const config = mergeAgyHooks({}, buildAgyHookSet(SHIM))
    writeAgyHooksConfig(p, config)
    expect(readAgyHooksConfig(p)).toEqual(config)
    expect(() => JSON.parse(readFileSync(p, 'utf8'))).not.toThrow()
  })

  it('treats malformed and wrong-shaped files as empty when reading', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, '{ not json')
    expect(readAgyHooksConfig(p)).toEqual({})
    writeFileSync(p, '["an", "array"]')
    expect(readAgyHooksConfig(p)).toEqual({})
    writeFileSync(p, '"a string"')
    expect(readAgyHooksConfig(p)).toEqual({})
  })
})

describe('lastUserInput — transcript parsing', () => {
  function transcript(lines: unknown[]): string {
    const p = join(dir, 'transcript.jsonl')
    writeFileSync(p, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n'))
    return p
  }

  it('finds the LAST user turn and strips the USER_REQUEST wrapper', () => {
    const p = transcript([
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nfirst question\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'thinking...' },
      { step_index: 5, type: 'USER_INPUT', content: '<USER_REQUEST>\nsecond question\n</USER_REQUEST>' },
      { step_index: 6, type: 'EPHEMERAL_MESSAGE', content: 'USER_INPUT mentioned here as a decoy' },
    ])
    expect(lastUserInput(p)).toEqual({ stepIndex: 5, text: 'second question' })
  })

  it('returns null for a missing file — the caller degrades, never throws', () => {
    expect(lastUserInput(join(dir, 'nope.jsonl'))).toBeNull()
  })

  it('returns null when no user turn exists', () => {
    expect(lastUserInput(transcript([{ step_index: 0, type: 'PLANNER_RESPONSE', content: 'x' }]))).toBeNull()
  })

  it('survives a torn final line — the file is written live by agy', () => {
    const p = transcript([
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>real question</USER_REQUEST>' },
      '{"step_index": 3, "type": "USER_INPUT", "content": "<USER_REQ', // torn mid-write
    ])
    expect(lastUserInput(p)).toEqual({ stepIndex: 0, text: 'real question' })
  })

  it('handles content without the wrapper', () => {
    const p = transcript([{ step_index: 2, type: 'USER_INPUT', content: 'bare text' }])
    expect(lastUserInput(p)).toEqual({ stepIndex: 2, text: 'bare text' })
  })
})
