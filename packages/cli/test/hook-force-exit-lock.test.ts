import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SLOW_LOCK = join(__dirname, 'helpers', 'slow-store-lock.mjs')

/**
 * #1343: every hook that force-exits must not leave the store lock behind.
 *
 * `process.exit()` does not wait for in-flight async work. When the process is
 * inside a store write at that moment, the lock file stays — and an EMPTY one
 * (the O_EXCL create landed, the token write had not) cannot be attributed to
 * anyone, so core waits out its 60s stale threshold on the next write. On the
 * Claude Code hook that cost every later first prompt its memory (#1313).
 *
 * The race is made deterministic with a preload (helpers/slow-store-lock.mjs)
 * that slows each lock acquisition. For the injection hooks the first
 * acquisition is the BM25 pass that serves the turn (hybrid is still loading
 * its embedder), held 6s; the abandoned hybrid search queues behind it in the
 * same process and takes the lock the moment BM25 releases — so the hook
 * exits while that second, empty lock is on disk. Its hold (1.5s) fits inside
 * the bounded wait the exit now does.
 *
 * Every test runs against a temp HOME / PLUR_PATH / TMPDIR — never ~/.plur.
 */

let dir: string
let store: string

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store,
  }
  // The hybrid leg must be real for there to be an abandoned search.
  delete env.PLUR_DISABLE_EMBEDDINGS
  delete env.PLUR_HOOK_HYBRID
  delete env.PLUR_CODEX_HYBRID
  delete env.PLUR_HOOK_NO_EXIT
  return { ...env, ...extra }
}

function locksLeft(): string[] {
  if (!existsSync(store)) return []
  return readdirSync(store).filter(f => f.endsWith('.lock'))
}

function runHook(hook: string, payload: Record<string, unknown>, extra: Record<string, string>) {
  return runCli('node', ['--import', SLOW_LOCK, CLI, hook], {
    input: JSON.stringify(payload),
    encoding: 'utf-8', timeout: 40_000, env: baseEnv(extra), cwd: dir,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-force-exit-lock-'))
  store = join(dir, '.plur')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  const seeded = runCli('node', [CLI, 'learn', 'codeword basalt-heron: at a general session start, check the force-exit lock', '--json'], {
    encoding: 'utf-8', timeout: 20_000, env: { ...baseEnv({}), PLUR_DISABLE_EMBEDDINGS: '1' }, cwd: dir,
  })
  expect(seeded.status).toBe(0)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const PAST_HYBRID_DEADLINE = {
  PLUR_HOOK_HYBRID_DEADLINE_MS: '1',
  PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '6000,1500',
}

describe('force-exiting hooks leave no store lock behind (#1343)', () => {
  it('hook-codex-inject, exiting past a missed hybrid deadline', () => {
    const r = runHook('hook-codex-inject',
      { session_id: 'codex-inject-1', hook_event_name: 'UserPromptSubmit', prompt: 'basalt-heron codeword' },
      PAST_HYBRID_DEADLINE)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('hybrid injection exceeded 1ms')
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('basalt-heron')
    expect(locksLeft()).toEqual([])
  }, 60_000)

  it('hook-codex-session-start, exiting past a missed hybrid deadline', () => {
    const r = runHook('hook-codex-session-start',
      { session_id: 'codex-start-1', hook_event_name: 'SessionStart', source: 'startup' },
      PAST_HYBRID_DEADLINE)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('hybrid injection exceeded 1ms')
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('session started')
    expect(locksLeft()).toEqual([])
  }, 60_000)

  it('hook-agy-pre-invocation, exiting past a missed hybrid deadline', () => {
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, JSON.stringify({
      step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nbasalt-heron codeword\n</USER_REQUEST>',
    }) + '\n')
    const r = runHook('hook-agy-pre-invocation',
      { conversationId: 'agy-1', invocationNum: 0, transcriptPath: transcript, workspacePaths: [dir] },
      PAST_HYBRID_DEADLINE)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('hybrid injection exceeded 1ms')
    expect(r.stdout).toContain('basalt-heron')
    expect(locksLeft()).toEqual([])
  }, 60_000)

  it('hook-codex-inject, exiting while its next lock acquisition is issued but not yet on disk', () => {
    // BM25 holds the lock 6s; the abandoned hybrid search queues behind it in
    // this process and is handed the lock the moment BM25 releases. Its O_EXCL
    // create is then in flight for 1.5s with NO file on disk — a disk-only
    // check passes, and exiting there lands an empty lock. Only an in-process
    // count of lock operations can see it (core's pendingStoreLockOps).
    const r = runHook('hook-codex-inject',
      { session_id: 'codex-inject-inflight', hook_event_name: 'UserPromptSubmit', prompt: 'basalt-heron codeword' },
      {
        PLUR_HOOK_HYBRID_DEADLINE_MS: '1',
        PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '6000,0',
        PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS: '0,1500',
      })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('hybrid injection exceeded 1ms')
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('basalt-heron')
    expect(locksLeft()).toEqual([])
  }, 60_000)

  it('hook-inject, when its watchdog fires mid-write', () => {
    // BM25 only, so the one store write is the awaited injection counter —
    // and the watchdog (1s) fires while its lock is still empty (1.8s — under the
    // 2s after which an empty lock is presumed someone else's).
    const r = runHook('hook-inject',
      { session_id: 'claude-watchdog-1', hook_event_name: 'UserPromptSubmit', prompt: 'basalt-heron codeword' },
      { PLUR_HOOK_HYBRID: '0', PLUR_HOOK_CEILING_MS: '1000', PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '1800' })
    expect(r.status).toBe(0)
    // A stopped run prints nothing, even though the watchdog now waits for the
    // write in flight before exiting.
    expect(r.stdout).toBe('')
    expect(locksLeft()).toEqual([])
  }, 60_000)
})

describe('the shared exit wait (#1343)', () => {
  it('runCodexHook — the exit of every Codex and Antigravity hook — waits for its own store lock', async () => {
    // Pins the hooks that never open the store today (codex guard / post-tool /
    // session-end, agy guard): they exit through the same wait, so a store
    // write added to any of them later is covered without remembering to.
    const { runCodexHook } = await import('../src/lib/codex-hook-io.js')
    const { createPlur } = await import('../src/plur.js')
    const saved = { HOME: process.env.HOME, NO_EXIT: process.env.PLUR_HOOK_NO_EXIT }
    process.env.HOME = dir
    process.env.PLUR_HOOK_NO_EXIT = '1'
    try {
      const plur = createPlur({ path: store })
      const lock = join(plur.storageRoot, 'engrams.yaml.lock')
      writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
      setTimeout(() => rmSync(lock, { force: true }), 300)
      const t = Date.now()
      await runCodexHook('test', async () => {})
      expect(Date.now() - t).toBeGreaterThanOrEqual(250)
      expect(locksLeft()).toEqual([])
    } finally {
      process.env.HOME = saved.HOME
      if (saved.NO_EXIT === undefined) delete process.env.PLUR_HOOK_NO_EXIT
      else process.env.PLUR_HOOK_NO_EXIT = saved.NO_EXIT
    }
  })

  it('the Claude Code watchdog, waiting for its lock, still exits before the harness kills the hook', async () => {
    const { HOOK_CEILING_DEFAULT_MS, WATCHDOG_LOCK_WAIT_MS } = await import('../src/commands/hook-inject.js')
    const { CLAUDE_INJECT_TIMEOUT_S } = await import('../src/lib/claude-inject-budget.js')
    expect(HOOK_CEILING_DEFAULT_MS + WATCHDOG_LOCK_WAIT_MS).toBeLessThanOrEqual(CLAUDE_INJECT_TIMEOUT_S * 1000 - 2_000)
  })
})
