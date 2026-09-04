import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { acquireInjectLock, extractEventId } from '../src/commands/hook-inject.js'

/**
 * Review of #1017, O4: the per-session `.injecting` guard (#519) was
 * stat-then-write, so two hook-inject processes spawned a millisecond apart
 * both passed it and both ran the full injection — one concrete source of the
 * #975 duplicate pairs. The guard now creates the lock with O_EXCL, which
 * makes the create itself the decision.
 *
 * These are unit tests on the acquisition function: the property is
 * atomicity of one syscall, which a spawn test can only sample.
 */
describe('acquireInjectLock is atomic (#519, #975, #1017 O4)', () => {
  let dir: string
  let lock: string
  const STALE_MS = 1_000

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-lock-'))
    lock = join(dir, '12345.injecting')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('takes a free lock and leaves it in place for the caller to release', () => {
    expect(acquireInjectLock(lock, STALE_MS)).toBe('acquired')
    expect(existsSync(lock)).toBe(true)
  })

  it('bails on a fresh lock without touching it', () => {
    writeFileSync(lock, 'holder')
    const before = statSync(lock).mtimeMs
    expect(acquireInjectLock(lock, STALE_MS)).toBe('held')
    expect(readFileSync(lock, 'utf8')).toBe('holder')
    expect(statSync(lock).mtimeMs).toBe(before)
  })

  it('exactly one of N contenders wins a free lock', () => {
    const results = Array.from({ length: 20 }, () => acquireInjectLock(lock, STALE_MS))
    expect(results.filter(r => r === 'acquired')).toHaveLength(1)
    expect(results.filter(r => r === 'held')).toHaveLength(19)
    expect(results[0]).toBe('acquired')
  })

  it('claims a stale lock, and exactly one of N contenders wins it', () => {
    writeFileSync(lock, 'crashed holder')
    const old = new Date(Date.now() - STALE_MS * 10)
    utimesSync(lock, old, old)
    const results = Array.from({ length: 20 }, () => acquireInjectLock(lock, STALE_MS))
    expect(results.filter(r => r === 'acquired')).toHaveLength(1)
    expect(results.filter(r => r === 'held')).toHaveLength(19)
    // Recreated fresh, not the stale file with a new mtime.
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(STALE_MS)
    // The rename claim leaves nothing behind.
    expect(existsSync(`${lock}.stale.${process.pid}`)).toBe(false)
  })

  it('fails open when the state directory is not writable', () => {
    // A path under a directory that does not exist: ENOENT, not EEXIST. The
    // hook must proceed unguarded rather than block the prompt on bookkeeping.
    expect(acquireInjectLock(join(dir, 'missing', 'x.injecting'), STALE_MS)).toBe('unavailable')
  })
})

describe('extractEventId reads the per-event identity Claude Code sends (#1017 O3)', () => {
  it('PreToolUse payloads carry tool_use_id', () => {
    expect(extractEventId({ tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_01ABC' })).toBe('toolu_01ABC')
  })

  it('SubagentStart payloads carry agent_id', () => {
    expect(extractEventId({ agent_name: 'Explore', agent_id: 'agent_7f3a' })).toBe('agent_7f3a')
  })

  it('prefers the tool call over the agent when both are present', () => {
    expect(extractEventId({ tool_use_id: 'toolu_1', agent_id: 'agent_1' })).toBe('toolu_1')
  })

  it('UserPromptSubmit-shaped payloads have none', () => {
    expect(extractEventId({ prompt: 'hello', session_id: 's' })).toBeUndefined()
  })

  it('rejects anything that is not a non-empty string', () => {
    expect(extractEventId({ tool_use_id: '' })).toBeUndefined()
    expect(extractEventId({ tool_use_id: 42 })).toBeUndefined()
    expect(extractEventId({ tool_use_id: null })).toBeUndefined()
    expect(extractEventId({ agent_id: { id: 'x' } })).toBeUndefined()
  })

  it('caps an oversized id so a hostile payload cannot bloat the provenance log', () => {
    const id = extractEventId({ tool_use_id: 'a'.repeat(10_000) })
    expect(id).toHaveLength(128)
  })
})
