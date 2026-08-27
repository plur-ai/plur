import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  codexSessionId,
  isPlurSessionStartTool,
  sentinelPath,
  counterPath,
  markSessionStarted,
  isSessionStarted,
  incrementCounter,
  cleanupStaleSessionFiles,
  sessionDir,
  emitContext,
  runCodexHook,
  injectWithFallback,
  hybridEnabled,
} from '../src/lib/codex-hook-io.js'

const SID = 'codex-io-test-session'

function clean() {
  for (const p of [sentinelPath(SID), counterPath(SID, 'a'), counterPath(SID, 'b')]) {
    try { rmSync(p, { force: true }) } catch { /* ignore */ }
  }
}
beforeEach(clean)
afterEach(clean)

describe('codexSessionId', () => {
  it('reads session_id — the field Codex actually sends', () => {
    expect(codexSessionId({ session_id: 'abc' })).toBe('abc')
  })

  it('falls back to conversation_id', () => {
    expect(codexSessionId({ conversation_id: 'xyz' })).toBe('xyz')
  })

  it('prefers session_id when both are present', () => {
    expect(codexSessionId({ session_id: 'a', conversation_id: 'b' })).toBe('a')
  })

  it('returns empty and warns on stderr when neither is present', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(codexSessionId({})).toBe('')
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0][0])).toContain('no session_id')
    spy.mockRestore()
  })
})

describe('isPlurSessionStartTool', () => {
  it('matches the bare name', () => {
    expect(isPlurSessionStartTool('plur_session_start')).toBe(true)
  })

  // Codex prefixes MCP tools with the server name and is actively changing
  // the scheme (there is a `non_prefixed_mcp_tool_names` feature flag), so
  // the match is on the suffix rather than any one spelling of the prefix.
  it.each([
    'plur__plur_session_start',
    'mcp__plur__plur_session_start',
    'plur.plur_session_start',
    'plur/plur_session_start',
  ])('matches the prefixed form %s', (name) => {
    expect(isPlurSessionStartTool(name)).toBe(true)
  })

  it.each([
    'plur_session_end',
    'plur_learn',
    'plur_session_started',
    'superplur_session_start',
    '',
  ])('does not match %s', (name) => {
    // `plur_session_started` and `superplur_session_start` are the two that
    // matter: the suffix anchor must not fire on a longer identifier that
    // merely contains the name, in either direction.
    expect(isPlurSessionStartTool(name)).toBe(false)
  })
})

describe('sentinel + counters', () => {
  it('marks and detects a started session', () => {
    expect(isSessionStarted(SID)).toBe(false)
    markSessionStarted(SID)
    expect(isSessionStarted(SID)).toBe(true)
  })

  it('sanitizes ids so a traversal attempt cannot escape the session dir', () => {
    const p = sentinelPath('../../etc/passwd')
    expect(p.startsWith(sessionDir())).toBe(true)
    expect(p).not.toContain('..')
  })

  it('builds counter paths without string-munging the sentinel path', () => {
    expect(counterPath(SID, 'guard-count')).toBe(join(sessionDir(), `${SID}.guard-count`))
  })

  it('increments from absent, then monotonically', () => {
    const p = counterPath(SID, 'a')
    expect(incrementCounter(p)).toBe(1)
    expect(incrementCounter(p)).toBe(2)
    expect(incrementCounter(p)).toBe(3)
  })

  it('treats a corrupt counter file as zero rather than NaN', () => {
    const p = counterPath(SID, 'b')
    mkdirSync(sessionDir(), { recursive: true })
    writeFileSync(p, 'not a number')
    expect(incrementCounter(p)).toBe(1)
  })
})

describe('cleanupStaleSessionFiles', () => {
  it('deletes markers past the age limit and keeps fresh ones', () => {
    markSessionStarted(SID)
    const stale = counterPath(SID, 'a')
    writeFileSync(stale, '1')
    const old = Date.now() / 1000 - 8 * 24 * 60 * 60
    utimesSync(stale, old, old)

    cleanupStaleSessionFiles()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(sentinelPath(SID))).toBe(true)
  })

  // Points at a path that does not exist rather than deleting the shared
  // session dir: other hook test files run in parallel against the same
  // tmpdir, and nuking it out from under them made their sentinels vanish
  // mid-assertion.
  it('does not throw when the session dir does not exist', () => {
    const missing = join(tmpdir(), 'plur-codex-sessions-does-not-exist')
    rmSync(missing, { recursive: true, force: true })
    expect(() => cleanupStaleSessionFiles(Date.now(), missing)).not.toThrow()
  })
})

describe('emitContext', () => {
  it('writes the exact envelope Codex expects, and nothing else', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    emitContext('UserPromptSubmit', 'hello')
    expect(spy).toHaveBeenCalledOnce()
    // Codex parses stdout as the whole hook result — a stray byte around the
    // JSON invalidates the output ("hook returned invalid ... JSON output").
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hello' },
    })
    spy.mockRestore()
  })
})

/**
 * The exit-code guarantee. Codex reads a hook's exit code as its verdict: a
 * non-zero code discards the output entirely, and on PreToolUse an exit code
 * of 2 BLOCKS the tool with stderr as the reason. Verified 2026-08-27 that an
 * unrelated engine fault (a corrupt PGLite index aborting during WASM
 * teardown) made every plur command exit 1 — long after the hook had written
 * valid JSON. Without this wrapper that reads to Codex as "SessionStart
 * Failed", and the engrams are dropped.
 */
describe('runCodexHook', () => {
  it('swallows a throwing body and reports it on stderr, never stdout', async () => {
    process.env.PLUR_HOOK_NO_EXIT = '1'
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await runCodexHook('codex test', async () => { throw new Error('engine exploded') })

    expect(String(err.mock.calls.at(-1)?.[0])).toContain('engine exploded')
    // Only the zero-length flush may reach stdout — anything else would be
    // parsed by Codex as the hook result.
    expect(out.mock.calls.every(c => String(c[0]).length === 0)).toBe(true)
    out.mockRestore(); err.mockRestore()
  })

  it('forces exitCode to 0 even when something else set it non-zero', async () => {
    process.env.PLUR_HOOK_NO_EXIT = '1'
    process.exitCode = 1
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await runCodexHook('codex test', async () => { /* clean run */ })

    expect(process.exitCode).toBe(0)
    out.mockRestore()
  })

  it('still delivers output written before the body threw', async () => {
    process.env.PLUR_HOOK_NO_EXIT = '1'
    const chunks: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      if (String(c).length) chunks.push(String(c))
      return true
    }) as never)

    await runCodexHook('codex test', async () => {
      emitContext('SessionStart', 'partial but useful')
      throw new Error('failed after writing')
    })

    expect(JSON.parse(chunks[0])).toMatchObject({
      hookSpecificOutput: { additionalContext: 'partial but useful' },
    })
    out.mockRestore()
  })
})

/**
 * Hybrid-first injection with a bounded BM25 fallback. The point is that a
 * turn NEVER loses its memory: a slow or broken hybrid leg degrades to BM25
 * rather than to a hook Codex kills at its timeout (which injects nothing).
 */
describe('injectWithFallback', () => {
  const R = (count: number, tag: string) =>
    ({ directives: tag, constraints: '', consider: '', count })

  beforeEach(() => { process.env.PLUR_CODEX_HYBRID = '1' })
  afterEach(() => { delete process.env.PLUR_CODEX_HYBRID })

  it('uses hybrid when it beats the deadline', async () => {
    const plur = {
      injectHybrid: async () => R(5, 'hybrid'),
      inject: async () => R(3, 'bm25'),
    }
    const out = await injectWithFallback(plur, 'q', {}, 1000)
    expect(out.mode).toBe('hybrid')
    expect(out.result.count).toBe(5)
  })

  it('falls back to BM25 when hybrid misses the deadline', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const plur = {
      injectHybrid: () => new Promise<never>(() => { /* never settles */ }),
      inject: async () => R(3, 'bm25'),
    }
    const out = await injectWithFallback(plur, 'q', {}, 20)
    expect(out.mode).toBe('bm25')
    expect(out.result.count).toBe(3)
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('falling back to BM25')
    err.mockRestore()
  })

  it('falls back to BM25 when hybrid throws — a dead embedder must not cost the turn', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const plur = {
      injectHybrid: async () => { throw new Error('embedder unavailable') },
      inject: async () => R(3, 'bm25'),
    }
    const out = await injectWithFallback(plur, 'q', {}, 1000)
    expect(out.mode).toBe('bm25')
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('embedder unavailable')
    err.mockRestore()
  })

  it('does not leave the deadline timer holding the event loop open', async () => {
    // The timer is unref()ed and cleared; a leaked one would delay every hook
    // exit by the full deadline.
    const plur = { injectHybrid: async () => R(1, 'h'), inject: async () => R(1, 'b') }
    const t0 = Date.now()
    await injectWithFallback(plur, 'q', {}, 30_000)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('hybridEnabled (#1040 kill switch)', () => {
  it('is off unless explicitly opted in', () => {
    expect(hybridEnabled({})).toBe(false)
    expect(hybridEnabled({ PLUR_CODEX_HYBRID: '0' })).toBe(false)
    expect(hybridEnabled({ PLUR_CODEX_HYBRID: 'true' })).toBe(false)
    expect(hybridEnabled({ PLUR_CODEX_HYBRID: '1' })).toBe(true)
  })

  it('injectWithFallback never touches injectHybrid while the switch is off', async () => {
    // The crash is caused by LOADING the embedder, not by using its result —
    // so "call it and fall back" is not a safe posture. It must not be called.
    delete process.env.PLUR_CODEX_HYBRID
    let hybridCalled = false
    const plur = {
      injectHybrid: async () => { hybridCalled = true; return { count: 9 } },
      inject: async () => ({ count: 3 }),
    }
    const out = await injectWithFallback(plur, 'q', {}, 5000)
    expect(hybridCalled).toBe(false)
    expect(out.mode).toBe('bm25')
    expect(out.result.count).toBe(3)
  })
})
