import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * Verifies the per-session concurrency guard added in #519:
 * a fresh inject-lock file must cause hook-inject to exit 0 with no output.
 */
describe('hook-inject concurrency guard (#519)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-lock-test-'))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    // Mark this directory as a plur-configured project so hook-inject runs
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function runHook(input: object, extraEnv: Record<string, string> = {}): {
    stdout: string
    stderr: string
    status: number
  } {
    const result = spawnSync('node', [CLI, 'hook-inject'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        TMPDIR: join(dir, 'tmp'),
        PLUR_PATH: join(dir, '.plur'),
        ...extraEnv,
      },
      cwd: dir,
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 1,
    }
  }

  it('bails silently when a fresh inject lock exists for this session', () => {
    // The spawned hook-inject process's ppid equals this test process's pid.
    // Pre-create a fresh lock to simulate a concurrently running inject.
    const sessionDir = join(dir, 'tmp', 'plur-sessions')
    mkdirSync(sessionDir, { recursive: true })
    const lockPath = join(sessionDir, `${process.pid}.injecting`)
    writeFileSync(lockPath, '') // mtime = now → fresh

    const result = runHook({ prompt: 'hello world' })
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })

  // Was VACUOUS: it set PLUR_LOCK_STALE_MS='-1', which makes the staleness
  // comparison (Date.now() - mtime < -1) always false — a tautology that never
  // exercises the real mtime logic (any lock, fresh or old, is treated as stale).
  // Now age a REAL lock: write it, then wait past a small, real staleness window
  // so Date.now() - mtime genuinely exceeds it, and confirm injection proceeds.
  // The sibling test above ("bails silently when a fresh inject lock exists")
  // covers the fresh-within-window bail against the real comparison (default 55s
  // window, fresh mtime), so together they exercise both sides of the branch.
  it('proceeds when a real lock has aged past PLUR_LOCK_STALE_MS', async () => {
    const sessionDir = join(dir, 'tmp', 'plur-sessions')
    mkdirSync(sessionDir, { recursive: true })
    const lockPath = join(sessionDir, `${process.pid}.injecting`)
    writeFileSync(lockPath, '') // mtime = now

    // Real wait, no utimesSync backdating: a 250ms sleep against a 50ms window
    // guarantees Date.now() - mtime >= window by the time the hook stats it.
    await new Promise((resolve) => setTimeout(resolve, 250))

    const result = runHook(
      { prompt: 'hello world' },
      { PLUR_LOCK_STALE_MS: '50', PLUR_DISABLE_EMBEDDINGS: '1' },
    )
    // With an empty store the output is still a session-start header (0 engrams).
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string }
    expect(parsed.additionalContext).toContain('session started')
  }, 30_000)

  // MISSING (fail-open contract, PROVEN): a hook MUST never throw or block the
  // prompt. But hook-inject's mkdir/write of its state dir ($TMPDIR/plur-sessions)
  // is not wrapped in try/catch, so an unwritable $TMPDIR makes the process EXIT 1
  // and print {"error":...} to stdout (index.ts's top-level catch) — a hard
  // failure on the hot path of every prompt. Correct behaviour: exit 0 and emit
  // valid/empty output. it.fails until the state-dir I/O is made fail-open; flip
  // to it() when green.
  it.fails('never crashes the prompt when the state dir is unwritable', () => {
    const roTmp = mkdtempSync(join(tmpdir(), 'plur-ro-tmp-'))
    chmodSync(roTmp, 0o500) // r-x: owner cannot create plur-sessions inside
    try {
      const result = runHook({ prompt: 'hello world' }, { TMPDIR: roTmp })
      expect(result.status).toBe(0) // fail-open: never a non-zero exit
      expect(result.stdout).not.toContain('"error"')
    } finally {
      chmodSync(roTmp, 0o700)
      rmSync(roTmp, { recursive: true, force: true })
    }
  })
})
