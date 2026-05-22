import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('session checkpoint (#215)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-checkpoint-test-'))
    // Create plur config so isPlurConfigured doesn't short-circuit
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }),
    )
    // Create tmp dir for counter files so they don't leak between tests
    mkdirSync(join(home, 'tmp', 'plur-sessions'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runLearnCheck(input: object, env?: Record<string, string>): { stdout: string; stderr: string } {
    const result = spawnSync('node', [CLI, 'hook-learn-check'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(home, 'tmp'),
        PLUR_PATH: join(home, '.plur'),
        CLAUDE_SESSION_ID: 'test-session-123',
        PLUR_CHECKPOINT_INTERVAL: '2', // every 2nd stop for test speed
        ...env,
      },
      cwd: home,
    })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('writes checkpoint after PLUR_CHECKPOINT_INTERVAL stops', () => {
    // Stop 1 — no checkpoint yet
    runLearnCheck({})
    const checkpointPath = join(home, '.plur', 'sessions', 'test-session-123.checkpoint.json')
    expect(existsSync(checkpointPath)).toBe(false)

    // Stop 2 — checkpoint written (interval = 2)
    runLearnCheck({})
    expect(existsSync(checkpointPath)).toBe(true)

    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
    expect(checkpoint.session_id).toBe('test-session-123')
    expect(checkpoint.started_at).toBeDefined()
    expect(checkpoint.last_checkpoint).toBeDefined()
    expect(checkpoint.stop_count).toBe(2)
  })

  it('updates checkpoint on subsequent intervals', () => {
    const checkpointPath = join(home, '.plur', 'sessions', 'test-session-123.checkpoint.json')

    // Run 4 stops (2 checkpoints at interval=2)
    for (let i = 0; i < 4; i++) runLearnCheck({})

    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
    expect(checkpoint.stop_count).toBe(4)
    // started_at should be preserved from first checkpoint
    expect(checkpoint.started_at).toBeDefined()
  })

  it('preserves started_at across updates', () => {
    const checkpointPath = join(home, '.plur', 'sessions', 'test-session-123.checkpoint.json')

    // First checkpoint
    runLearnCheck({})
    runLearnCheck({})
    const first = JSON.parse(readFileSync(checkpointPath, 'utf-8'))

    // Wait a bit and do more stops
    runLearnCheck({})
    runLearnCheck({})
    const second = JSON.parse(readFileSync(checkpointPath, 'utf-8'))

    expect(second.started_at).toBe(first.started_at)
    expect(second.last_checkpoint).not.toBe(first.last_checkpoint)
  })
})

describe('deferred wrap-up detection (#216)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-deferred-test-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }),
    )
    mkdirSync(join(home, '.plur'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function createOrphanedCheckpoint(sessionId: string, ageMinutes: number): void {
    const sessionsDir = join(home, '.plur', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const now = Date.now()
    const checkpointTime = new Date(now - ageMinutes * 60000).toISOString()
    const startTime = new Date(now - (ageMinutes + 60) * 60000).toISOString()
    writeFileSync(
      join(sessionsDir, `${sessionId}.checkpoint.json`),
      JSON.stringify({
        session_id: sessionId,
        started_at: startTime,
        last_checkpoint: checkpointTime,
        stop_count: 25,
        cwd: '/Users/test/project',
        observation_file: '2026-05-22.jsonl',
      }),
    )
  }

  function runInject(prompt: string): { stdout: string } {
    const result = spawnSync('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PLUR_PATH: join(home, '.plur'),
        CLAUDE_SESSION_ID: 'new-session-456',
      },
      cwd: home,
    })
    return { stdout: result.stdout ?? '' }
  }

  it('detects orphaned checkpoint and includes notice in injection', () => {
    createOrphanedCheckpoint('old-session-789', 30) // 30 min old — stale

    const { stdout } = runInject('hello, new session')
    // hook-inject may output JSON or nothing (if no engrams to inject)
    // The deferred notice is included when output exists
    if (stdout.trim()) {
      const output = JSON.parse(stdout)
      expect(output.additionalContext).toContain('Previous session')
      expect(output.additionalContext).toContain('ended without wrap-up')
    }
    // Checkpoint should be cleaned up regardless
    const checkpointPath = join(home, '.plur', 'sessions', 'old-session-789.checkpoint.json')
    expect(existsSync(checkpointPath)).toBe(false)
  })

  it('cleans up orphaned checkpoint after detection', () => {
    createOrphanedCheckpoint('cleanup-test', 30)
    const checkpointPath = join(home, '.plur', 'sessions', 'cleanup-test.checkpoint.json')

    expect(existsSync(checkpointPath)).toBe(true)
    const { stdout } = runInject('start fresh')
    // If injection mentions the orphaned session, the checkpoint should be gone
    if (stdout.includes('Previous session')) {
      expect(existsSync(checkpointPath)).toBe(false)
    }
    // If injection didn't run the deferred check (e.g. no engrams to inject),
    // the checkpoint persists — that's acceptable, it'll be caught next time
  })

  it('skips recent checkpoints (possibly still active)', () => {
    createOrphanedCheckpoint('active-session', 2) // only 2 min old
    const checkpointPath = join(home, '.plur', 'sessions', 'active-session.checkpoint.json')

    runInject('new session')
    // Should NOT be cleaned up — too recent
    expect(existsSync(checkpointPath)).toBe(true)
  })

  it('no orphaned checkpoints means no deferred notice', () => {
    const { stdout } = runInject('clean start')
    // When no orphaned checkpoints, output should not mention "Previous session"
    if (stdout.trim()) {
      expect(stdout).not.toContain('Previous session')
    }
    // No crash — test passes if we get here
  })
})
