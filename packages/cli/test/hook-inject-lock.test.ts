import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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

  it('proceeds when the inject lock is stale', () => {
    // Pre-create a lock that belongs to this pid (same as ppid in the spawned
    // subprocess). With PLUR_LOCK_STALE_MS=-1 the staleness condition
    // (Date.now() - mtime < -1) is always false, so the lock is always treated
    // as stale. This avoids relying on utimesSync mtime precision, which can be
    // unreliable on CI runners (observed silent no-op on Linux tmpfs variants).
    const sessionDir = join(dir, 'tmp', 'plur-sessions')
    mkdirSync(sessionDir, { recursive: true })
    const lockPath = join(sessionDir, `${process.pid}.injecting`)
    writeFileSync(lockPath, '')

    const result = runHook({ prompt: 'hello world' }, { PLUR_LOCK_STALE_MS: '-1' })
    // With an empty store the output is still a session-start header (0 engrams).
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string }
    expect(parsed.additionalContext).toContain('session started')
  }, 30_000)
})
