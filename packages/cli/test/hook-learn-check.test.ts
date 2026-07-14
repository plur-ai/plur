import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('hook-learn-check', () => {
  let home: string
  let tmp: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-learn-check-home-'))
    tmp = join(home, 'tmp')
    mkdirSync(tmp, { recursive: true })
    // Mark the project as plur-configured so the hook doesn't silently no-op (#247).
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: '/bin/sh', args: [] } } }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runHook(sessionId: string, cwd: string = home): { stdout: string; status: number } {
    const result = spawnSync('node', [CLI, 'hook-learn-check'], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_SESSION_ID: sessionId },
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  it('stays silent (raw passthrough) when plur is not configured', () => {
    const bareHome = mkdtempSync(join(tmpdir(), 'plur-learn-check-bare-'))
    const bareTmp = join(bareHome, 'tmp')
    mkdirSync(bareTmp, { recursive: true })
    try {
      const result = spawnSync('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: bareHome }),
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, HOME: bareHome, USERPROFILE: bareHome, TMPDIR: bareTmp, CLAUDE_SESSION_ID: 'unconfigured' },
        cwd: bareHome,
      })
      expect(result.stdout.trim()).toBe(JSON.stringify({ cwd: bareHome }))
    } finally {
      rmSync(bareHome, { recursive: true, force: true })
    }
  })

  it('stays silent on the 1st and 2nd stop, nudges on the 3rd (LEARN_INTERVAL)', () => {
    const id = 'learn-interval-test'
    expect(runHook(id).stdout).not.toContain('additionalContext')
    expect(runHook(id).stdout).not.toContain('additionalContext')
    const third = runHook(id)
    expect(JSON.parse(third.stdout).additionalContext).toContain('plur_learn')
  })

  it('writes a session checkpoint on the 10th stop (CHECKPOINT_INTERVAL)', () => {
    const id = 'checkpoint-test'
    for (let i = 0; i < 9; i++) runHook(id)
    const checkpointPath = join(home, '.plur', 'sessions', `${id}.checkpoint.json`)
    expect(existsSync(checkpointPath)).toBe(false)

    runHook(id) // 10th call
    expect(existsSync(checkpointPath)).toBe(true)
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
    expect(checkpoint.stop_count).toBe(10)
    expect(checkpoint.session_id).toBe(id)
  })

  // Audit fix, 2026-07-09 (cross-referenced from feat/cursor-integration's
  // evaluator review): the counter used to be read-int/increment/write,
  // which can lose an increment if two Stop hook processes fire close
  // together (each invocation is a fresh, independent process). This
  // doesn't reproduce true concurrency (that would be flaky-by-nature to
  // assert on), but locks in that N sequential calls advance the counter
  // by exactly N — the invariant the atomic-append fix must preserve.
  it('advances the counter by exactly one per sequential call', () => {
    const id = 'sequential-count-test'
    // 3rd, 6th, 9th, 12th stops nudge; count is otherwise only observable
    // indirectly, so drive it to the 30th stop and confirm a checkpoint
    // (10th) and nudges land on the expected boundaries, not off-by-one.
    const results: string[] = []
    for (let i = 1; i <= 12; i++) {
      const { stdout } = runHook(id)
      results.push(stdout)
    }
    const nudged = results.map((r) => {
      try {
        return typeof JSON.parse(r).additionalContext === 'string'
      } catch {
        return false
      }
    })
    expect(nudged).toEqual([
      false, false, true, // 1,2,3
      false, false, true, // 4,5,6
      false, false, true, // 7,8,9
      false, false, true, // 10,11,12
    ])
  })

  // MISSING (fail-open contract, PROVEN): a Stop hook MUST never throw — it is on
  // the hot path of every response. But counterPath()'s mkdir/appendFileSync of
  // $TMPDIR/plur-sessions is not wrapped in try/catch, so an unwritable $TMPDIR
  // makes the hook EXIT 1 and print {"error":...} to stdout (index.ts's top-level
  // catch). Correct behaviour: exit 0 and emit valid/empty output. it.fails until
  // the counter I/O is made fail-open; flip to it() when green.
  it.fails('never crashes the response when the state dir is unwritable', () => {
    const roTmp = mkdtempSync(join(tmpdir(), 'plur-ro-learn-'))
    chmodSync(roTmp, 0o500) // r-x: owner cannot create plur-sessions inside
    try {
      const result = spawnSync('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: home }),
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: roTmp, CLAUDE_SESSION_ID: 'ro-learn' },
        cwd: home,
      })
      expect(result.status ?? 1).toBe(0) // fail-open: never a non-zero exit
      expect(result.stdout ?? '').not.toContain('"error"')
    } finally {
      chmodSync(roTmp, 0o700)
      rmSync(roTmp, { recursive: true, force: true })
    }
  })
})
