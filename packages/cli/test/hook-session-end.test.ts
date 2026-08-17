import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * Integration tests for the SessionEnd hook (#217).
 *
 * Confirms the hook fires end-to-end: given a session checkpoint left behind by
 * a session that never called plur_session_end, `plur hook-session-end`
 * captures a durable closing episode and cleans up the checkpoint.
 */
describe('hook-session-end (#217 — SessionEnd auto-close)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-session-end-test-'))
    // A plur config so isPlurConfigured() does not short-circuit the hook.
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }),
    )
    mkdirSync(join(home, 'tmp'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function writeCheckpoint(sessionId: string, overrides: Record<string, unknown> = {}): string {
    const sessionsDir = join(home, '.plur', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const now = Date.now()
    const path = join(sessionsDir, `${sessionId}.checkpoint.json`)
    writeFileSync(
      path,
      JSON.stringify({
        session_id: sessionId,
        started_at: new Date(now - 90 * 60000).toISOString(),
        last_checkpoint: new Date(now - 1 * 60000).toISOString(),
        stop_count: 30,
        cwd: '/Users/test/project',
        observation_file: '2026-07-04.jsonl',
        ...overrides,
      }),
    )
    return path
  }

  function runSessionEnd(
    input: object,
    env?: Record<string, string>,
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync('node', [CLI, 'hook-session-end'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(home, 'tmp'),
        PLUR_PATH: join(home, '.plur'),
        CLAUDE_SESSION_ID: 'end-test-session',
        ...env,
      },
      cwd: home,
    })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
  }

  function readEpisodes(): string {
    const path = join(home, '.plur', 'episodes.yaml')
    return existsSync(path) ? readFileSync(path, 'utf-8') : ''
  }

  it('captures a closing episode and cleans up the checkpoint', () => {
    const cpPath = writeCheckpoint('end-test-session')

    const { status } = runSessionEnd({ session_id: 'end-test-session', cwd: '/Users/test/project', reason: 'clear' })
    expect(status).toBe(0)

    // Checkpoint removed — lifecycle closed.
    expect(existsSync(cpPath)).toBe(false)

    // A durable episode was captured with the auto-close marker.
    const episodes = readEpisodes()
    expect(episodes).toContain('auto-closed on SessionEnd')
    expect(episodes).toContain('auto-close')
    // Metadata is carried through (stop count).
    expect(episodes).toContain('30 responses')
  })

  it('resolves the checkpoint from CLAUDE_SESSION_ID when payload omits session_id', () => {
    const cpPath = writeCheckpoint('end-test-session')

    // No session_id in the SessionEnd payload — falls back to CLAUDE_SESSION_ID.
    const { status } = runSessionEnd({ reason: 'other' })
    expect(status).toBe(0)
    expect(existsSync(cpPath)).toBe(false)
    expect(readEpisodes()).toContain('auto-closed on SessionEnd')
  })

  it('is a no-op when no checkpoint exists (clean close already happened)', () => {
    const { status } = runSessionEnd({ session_id: 'end-test-session', reason: 'clear' })
    expect(status).toBe(0)
    // No episode captured — nothing to close.
    expect(readEpisodes()).not.toContain('auto-closed on SessionEnd')
  })

  // BUG-ENCODING (#217): the original test asserted that an unparseable
  // checkpoint is DELETED (existsSync === false). That encodes a data-loss bug:
  // writeCheckpoint (hook-learn-check.ts:96) is a plain, NON-atomic writeFileSync,
  // so a concurrent reader that catches a mid-write PARTIAL read cannot tell it
  // apart from genuine corruption — and this hook then permanently unlinks a LIVE
  // session's checkpoint (hook-session-end.ts:97). Correct behaviour: unparseable
  // content is RETAINED (or quarantined via rename), never silently destroyed.
  // it.fails until the parse-failure branch stops unlinking; flip to it() when green.
  it('retains (does not delete) an unparseable checkpoint', () => {
    const sessionsDir = join(home, '.plur', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const cpPath = join(sessionsDir, 'end-test-session.checkpoint.json')
    writeFileSync(cpPath, '{ not valid json')

    const { status } = runSessionEnd({ session_id: 'end-test-session' })
    expect(status).toBe(0)
    // A partial read of a live session's checkpoint is indistinguishable from
    // corruption — it must not be destroyed on an unparse.
    expect(existsSync(cpPath)).toBe(true)
    // And nothing is captured from unparseable content.
    expect(readEpisodes()).not.toContain('auto-closed on SessionEnd')
  })

  // MISSING (data loss, #217): there was NO test where plur.capture() THROWS.
  // hook-session-end.ts:128-142 swallows the throw with catch{} and then
  // unlinkSync(checkpoint) UNCONDITIONALLY — so on a full disk (or any capture
  // failure) the session's ONLY durable record is destroyed with nothing
  // captured in its place. Correct behaviour: if capture fails, the checkpoint
  // is RETAINED so the next session_start's deferred wrap-up (#216) can recover it.
  // it.fails until the unlink is gated on capture success; flip to it() when green.
  it('retains the checkpoint when capture fails (#217)', () => {
    const cpPath = writeCheckpoint('end-test-session')
    const plurDir = join(home, '.plur')
    // Make the plur root read-only so episode capture (atomicWrite → writeFileSync
    // into this dir) fails, while the sessions/ subdir it contains stays writable
    // so the unlink can still fire — this isolates "capture failed" from "couldn't
    // unlink" and reproduces the full-disk data-loss path faithfully.
    chmodSync(plurDir, 0o500)
    try {
      const { status } = runSessionEnd({ session_id: 'end-test-session', reason: 'clear' })
      expect(status).toBe(0) // a SessionEnd hook must never fail the session
      // The session's only durable record must survive a failed capture.
      expect(existsSync(cpPath)).toBe(true)
    } finally {
      chmodSync(plurDir, 0o700)
    }
  })

  it('silently passes through when plur is not configured', () => {
    // Remove the plur config so isPlurConfigured() is false.
    rmSync(join(home, '.claude', 'settings.json'))
    const cpPath = writeCheckpoint('end-test-session')

    const { status } = runSessionEnd({ session_id: 'end-test-session' })
    expect(status).toBe(0)
    // Checkpoint untouched — the hook did nothing in an unconfigured project.
    expect(existsSync(cpPath)).toBe(true)
    expect(readEpisodes()).not.toContain('auto-closed on SessionEnd')
  })

  it('does not double-capture when run twice for the same session', () => {
    writeCheckpoint('end-test-session')

    runSessionEnd({ session_id: 'end-test-session', reason: 'clear' })
    const afterFirst = readEpisodes()
    const firstCount = (afterFirst.match(/auto-closed on SessionEnd/g) ?? []).length
    expect(firstCount).toBe(1)

    // Second SessionEnd (e.g. the mcp-scaffolded hook also firing) finds no
    // checkpoint and captures nothing further.
    runSessionEnd({ session_id: 'end-test-session', reason: 'clear' })
    const afterSecond = readEpisodes()
    const secondCount = (afterSecond.match(/auto-closed on SessionEnd/g) ?? []).length
    expect(secondCount).toBe(1)
  })
})
