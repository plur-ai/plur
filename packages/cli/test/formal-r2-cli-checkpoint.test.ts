import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

/**
 * Formal round 2, cli#6 — session checkpoint lifecycle
 * (spec/formal/PlurSpec/R2CLI.lean §2, findings/r2-cli.md item 2).
 *
 * Property: a checkpoint is removed only after a durable capture.
 * The deferred wrap-up in hook-inject used to unlink a valid orphan after a
 * transient notice (no episode), unlink a corrupt one outright, and treat a
 * session still running in another terminal as an orphan after 5 idle
 * minutes. The writer read PLUR_PATH only while hook-session-end honoured
 * --path.
 */

const CLI = process.env.PLUR_R2_CLI ?? builtCliPath(join(__dirname, '..'))

describe('cli#6 checkpoint lifecycle (formal r2)', () => {
  let home: string
  let store: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-r2-ckpt-'))
    store = join(home, '.plur')
    mkdirSync(join(home, 'tmp'), { recursive: true })
    mkdirSync(join(store, 'sessions'), { recursive: true })
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function env(extra: Record<string, string> = {}) {
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: join(home, 'tmp'),
      PLUR_PATH: store,
      PLUR_DISABLE_EMBEDDINGS: '1',
      ...extra,
    }
  }

  function checkpoint(key: string, ageMin: number, dir = join(store, 'sessions')) {
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    writeFileSync(join(dir, `${key}.checkpoint.json`), JSON.stringify({
      session_id: key,
      started_at: new Date(now - (ageMin + 60) * 60000).toISOString(),
      last_checkpoint: new Date(now - ageMin * 60000).toISOString(),
      stop_count: 25,
      cwd: '/work/proj',
      observation_file: 'x.jsonl',
    }))
    return join(dir, `${key}.checkpoint.json`)
  }

  function inject(extra: Record<string, string> = {}) {
    return runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ prompt: 'hello', session_id: 'new-session' }),
      encoding: 'utf-8',
      env: env(extra),
      cwd: home,
    })
  }

  function episodes(): string {
    const p = join(store, 'episodes.yaml')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  it('a stale orphan is captured as an episode BEFORE its checkpoint is removed', () => {
    const cp = checkpoint('old-session', 30)
    const r = inject()
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('ended without wrap-up')
    expect(existsSync(cp)).toBe(false)
    expect(episodes()).toContain('deferred-wrapup')
    expect(episodes()).toContain('old-session')
  }, 60_000)

  it('a corrupt checkpoint is kept (moved out of the scan), never deleted', () => {
    const dir = join(store, 'sessions')
    writeFileSync(join(dir, 'broken.checkpoint.json'), '{"session_id": "bro')
    const r = inject()
    expect(r.status).toBe(0)
    const left = readdirSync(dir)
    expect(left.some(f => f.startsWith('broken.checkpoint.json'))).toBe(true)
    expect(readFileSync(join(dir, left.find(f => f.startsWith('broken'))!), 'utf8')).toBe('{"session_id": "bro')
  }, 60_000)

  it('a pid-keyed checkpoint whose process is alive is a live session, not an orphan', () => {
    // This test runner is alive; a checkpoint keyed by its pid is a session
    // that simply has not reached its next checkpoint.
    const cp = checkpoint(String(process.pid), 30)
    const r = inject()
    expect(r.status).toBe(0)
    expect(existsSync(cp)).toBe(true)
    expect(r.stdout).not.toContain('ended without wrap-up')
  }, 60_000)

  it('a pid-keyed checkpoint whose process is gone is recovered', () => {
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' })
    const cp = checkpoint(dead.stdout.trim(), 30)
    const r = inject()
    expect(r.status).toBe(0)
    expect(existsSync(cp)).toBe(false)
    expect(episodes()).toContain('deferred-wrapup')
  }, 60_000)

  it('a failed capture keeps the checkpoint', () => {
    const cp = checkpoint('keep-me', 30)
    mkdirSync(join(store, 'episodes.yaml')) // capture cannot write → throws
    const r = inject()
    expect(r.status).toBe(0)
    expect(existsSync(cp)).toBe(true)
  }, 60_000)

  it('the checkpoint writer honours --path like the closer does', () => {
    const other = join(home, 'other-store')
    for (let i = 0; i < 2; i++) {
      runCli('node', [CLI, '--path', other, 'hook-learn-check'], {
        input: JSON.stringify({ session_id: 'p', cwd: home }),
        encoding: 'utf-8',
        env: env({ PLUR_CHECKPOINT_INTERVAL: '2', CLAUDE_SESSION_ID: 'path-sess' }),
        cwd: home,
      })
    }
    // Owner decision H1 ("payload"): the checkpoint is keyed by the payload
    // session_id ('p') first, CLAUDE_SESSION_ID only as a fallback.
    expect(existsSync(join(other, 'sessions', 'p.checkpoint.json'))).toBe(true)
    expect(existsSync(join(store, 'sessions', 'p.checkpoint.json'))).toBe(false)
    expect(existsSync(join(other, 'sessions', 'path-sess.checkpoint.json'))).toBe(false)
  }, 60_000)
})
