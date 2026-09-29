import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * #1278: the Claude Code session marker (first-message detection, the
 * 10-minute reminder, the concurrency lock) was keyed on the parent process
 * id. Claude Code runs every hook in a fresh `/bin/sh -c`, so the ppid is new
 * on every prompt: the "already started" check never matched, every prompt
 * ran the full injection, and the reminder never fired. Same root cause as
 * the Stop counter (#1266).
 *
 * These tests launch the hook through a shell, the way Claude Code does, so
 * each invocation really has a different ppid, and CLAUDE_SESSION_ID is unset
 * (Claude Code does not export it to hooks).
 */
describe('hook-inject session marker keyed on session_id (#1278)', () => {
  let dir: string
  let sessions: string
  let baseEnv: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-key-'))
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    sessions = join(dir, 'tmp', 'plur-sessions')
    baseEnv = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    delete baseEnv.CLAUDE_SESSION_ID
  })

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  beforeEach(() => { rmSync(sessions, { recursive: true, force: true }) })

  /** One prompt, launched through a fresh shell — a new ppid every time. */
  function prompt(
    payload: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
  ): { stdout: string; status: number } {
    // `; exit $?` stops sh from exec'ing node in place, so node's parent is
    // the shell — a different pid on every call, as under Claude Code.
    const r = runCli('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" hook-inject; exit $?`], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', ...payload }),
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...baseEnv, ...extraEnv },
      cwd: dir,
    })
    return { stdout: r.stdout ?? '', status: r.status ?? 1 }
  }

  function context(stdout: string): string {
    if (!stdout) return ''
    return (JSON.parse(stdout) as any).hookSpecificOutput?.additionalContext ?? ''
  }

  function backdateReminder(key: string, minutes: number): void {
    const t = (Date.now() - minutes * 60 * 1000) / 1000
    utimesSync(join(sessions, `${key}.reminded`), t, t)
  }

  it('the same session_id under different ppids sees one marker: the second prompt does not re-inject', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000001'
    const first = prompt({ session_id, prompt: 'first prompt' })
    expect(first.status).toBe(0)
    expect(context(first.stdout)).toContain('session started')

    const second = prompt({ session_id, prompt: 'second prompt' })
    expect(second.status).toBe(0)
    // Reminder not due yet (the first message resets it), so nothing at all.
    expect(second.stdout).toBe('')

    // One marker, named after the session, not after either shell's pid.
    expect(existsSync(join(sessions, `${session_id}.marker`))).toBe(true)
    expect(readdirSync(sessions).filter(f => f.endsWith('.marker'))).toEqual([`${session_id}.marker`])
  }, 60_000)

  it('a different session_id starts its own session', () => {
    prompt({ session_id: 'aaaaaaaa-0000-4000-8000-000000000002', prompt: 'one' })
    const other = prompt({ session_id: 'aaaaaaaa-0000-4000-8000-000000000003', prompt: 'two' })
    expect(context(other.stdout)).toContain('session started')
  }, 60_000)

  it('the 10-minute reminder fires on schedule, once, for the session', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000004'
    prompt({ session_id, prompt: 'start' })
    // 9 minutes later: not due.
    backdateReminder(session_id, 9)
    expect(prompt({ session_id, prompt: 'nine minutes on' }).stdout).toBe('')
    // 11 minutes later: due, and it is the reminder — not a fresh injection.
    backdateReminder(session_id, 11)
    const due = context(prompt({ session_id, prompt: 'eleven minutes on' }).stdout)
    expect(due).toContain('Memory Reminder')
    expect(due).not.toContain('session started')
    // The reminder resets the clock: the very next prompt is silent.
    expect(prompt({ session_id, prompt: 'right after' }).stdout).toBe('')
  }, 90_000)

  it('keeps the last prompt for rehydration, not only the first', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000005'
    prompt({ session_id, prompt: 'first task' })
    prompt({ session_id, prompt: 'latest task' })
    expect(readFileSync(join(sessions, `${session_id}.task`), 'utf8')).toBe('latest task')
  }, 60_000)

  it('sanitises an unsafe session_id with the shared helper and still matches', () => {
    const session_id = '../escape/x:y'
    expect(context(prompt({ session_id, prompt: 'one' }).stdout)).toContain('session started')
    expect(prompt({ session_id, prompt: 'two' }).stdout).toBe('')
    // safeSessionKey maps every unsafe byte to '_' — the file stays in the dir.
    expect(existsSync(join(sessions, '___escape_x_y.marker'))).toBe(true)
    expect(existsSync(join(dir, 'tmp', 'escape'))).toBe(false)
  }, 60_000)

  it('falls back to CLAUDE_SESSION_ID when the payload has no session_id', () => {
    const env = { CLAUDE_SESSION_ID: 'env-session-1' }
    expect(context(prompt({ prompt: 'one' }, env).stdout)).toContain('session started')
    expect(prompt({ prompt: 'two' }, env).stdout).toBe('')
    expect(existsSync(join(sessions, 'env-session-1.marker'))).toBe(true)
  }, 60_000)

  it('the concurrency lock is per session_id, not per ppid', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000006'
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, `${session_id}.injecting`), '') // fresh lock
    const r = prompt({ session_id, prompt: 'while another injection runs' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }, 60_000)

  it('writes the marker once the injection has been printed', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000007'
    const r = prompt({ session_id, prompt: 'first' })
    expect(context(r.stdout)).toContain('session started')
    expect(existsSync(join(sessions, `${session_id}.marker`))).toBe(true)
    // The lock is released on success too.
    expect(existsSync(join(sessions, `${session_id}.injecting`))).toBe(false)
  }, 60_000)

  // With the marker keyed correctly, one missed injection would otherwise
  // mean no memory for the whole session: the marker must only be written
  // after the context reached stdout, so a failed run is retried next prompt.
  it('a failed injection writes no marker, and the next prompt injects in full', () => {
    const session_id = 'aaaaaaaa-0000-4000-8000-000000000008'
    const store = join(dir, 'broken-store')
    mkdirSync(store, { recursive: true })
    // Invalid YAML: the store refuses to load, so the injection step throws.
    writeFileSync(join(store, 'engrams.yaml'), 'engrams: [\n  - {bad')
    const failed = prompt({ session_id, prompt: 'first' }, { PLUR_PATH: store })
    expect(context(failed.stdout)).toBe('')
    expect(existsSync(join(sessions, `${session_id}.marker`))).toBe(false)
    // The failed run must not leave its lock behind either, or the retry
    // would bail silently for the next minute.
    expect(existsSync(join(sessions, `${session_id}.injecting`))).toBe(false)

    const retry = prompt({ session_id, prompt: 'second' })
    expect(context(retry.stdout)).toContain('session started')
    expect(existsSync(join(sessions, `${session_id}.marker`))).toBe(true)
  }, 60_000)
})
