import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * hook-session-mark is the PostToolUse sentinel-writer that lets
 * hook-session-guard allow tools once plur_session_start has run. It
 * interpolates the raw session_id into a filesystem path, so it shares the
 * same path-traversal exposure the guard has — and had no test at all.
 */
describe('hook-session-mark', () => {
  let home: string
  let tmp: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-mark-test-'))
    tmp = join(home, 'tmp')
    mkdirSync(tmp, { recursive: true })
    // Mark the project plur-configured so the hook doesn't silently no-op (#95).
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runMark(input: object): { stdout: string; status: number } {
    const result = spawnSync('node', [CLI, 'hook-session-mark'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp },
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  it('writes the session sentinel for a well-formed session_id', () => {
    const { status } = runMark({ session_id: 'good-123' })
    expect(status).toBe(0)
    expect(existsSync(join(tmp, 'plur-session-good-123'))).toBe(true)
  })

  // MISSING (security, PROVEN): like hook-session-guard, this hook interpolates
  // the RAW session_id into a path (hook-session-mark.ts:50, join(tmpdir(),
  // `plur-session-${sessionId}`) → writeFileSync). The Cursor port sanitizes with
  // safeSessionKey and has a regression test (hook-cursor-guard.test.ts:116-131);
  // this one does not. A `../`-laden session_id escapes $TMPDIR entirely. Correct
  // behaviour: a traversal id must NOT write the sentinel outside the temp dir
  // (and must not crash). it.fails until the CC hooks sanitize session_id like the
  // Cursor port does; flip to it() when green.
  it('does not let a path-traversal session_id escape the temp dir', () => {
    // $TMPDIR is <home>/tmp; `plur-session-` + `../../../PWNED` normalises up out
    // of tmp, landing the sentinel directly in <home> — outside the temp dir.
    const escaped = join(home, 'PWNED')
    expect(existsSync(escaped)).toBe(false)

    const { status } = runMark({ session_id: '../../../PWNED' })
    expect(status).toBe(0) // hostile id must not crash the hook
    // The sanitized id must keep the sentinel inside $TMPDIR, never in <home>.
    expect(existsSync(escaped)).toBe(false)
  })
})
