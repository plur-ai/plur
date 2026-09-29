/**
 * Decision H3: hook-learn-check's Stop counter and session checkpoint follow
 * the same proved directory rule as the rest of the hook state (formal
 * conflict H, spec/formal R2CLI §FR5 `Dir.conflict_H_unique`): a directory that
 * fails the ownership check is never written to. The counter uses
 * hookSessionDir() (shared dir if it passes, else the private fallback if it
 * passes, else nothing); the checkpoint stays where its readers look
 * (<PLUR root>/sessions) and is written only if that directory passes.
 *
 * Also: an empty PLUR_PATH means "unset" everywhere (`||`, not `??`), so a
 * blank value never resolves state paths against the working directory.
 *
 * TMPDIR, HOME and PLUR_PATH point into a temp dir; never the real ~/.plur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookSessionDir } from '../src/lib/session-task.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SID = 'aaaaaaaa-1111-4222-8333-444444444444'

describe.skipIf(process.platform === 'win32')('hook-learn-check state directories (H3)', () => {
  let root: string
  let home: string
  let store: string
  let tmp: string
  let evilShared: string
  let evilFallback: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-h3-'))
    home = join(root, 'home')
    store = join(root, 'store')
    tmp = join(root, 'tmp')
    evilShared = join(root, 'evil-shared')
    evilFallback = join(root, 'evil-fallback')
    for (const d of [home, store, tmp, evilShared, evilFallback]) mkdirSync(d)
    // plur-configured, so the hook does real work (#247)
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function stop(env: Record<string, string> = {}): { stdout: string; status: number } {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, PLUR_PATH: store, ...env }
    delete e.CLAUDE_SESSION_ID
    const r = runCli('node', [CLI, 'hook-learn-check'], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: home }),
      encoding: 'utf-8', timeout: 15_000, env: e, cwd: home,
    })
    return { stdout: r.stdout ?? '', status: r.status ?? 1 }
  }

  it('counts in the private fallback when the shared dir is planted, and still nudges', () => {
    symlinkSync(evilShared, join(tmp, 'plur-sessions'))
    stop(); stop()
    const third = stop()
    expect(third.stdout).toContain('hookSpecificOutput')
    expect(readdirSync(evilShared)).toEqual([])
    expect(existsSync(join(store, 'hook-sessions', `${SID}.stop-count`))).toBe(true)
  }, 60_000)

  it('persists nothing and stays silent when both hook dirs are refused', () => {
    symlinkSync(evilShared, join(tmp, 'plur-sessions'))
    symlinkSync(evilFallback, join(store, 'hook-sessions'))
    for (let i = 0; i < 3; i++) {
      const r = stop()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
    expect(readdirSync(evilShared)).toEqual([])
    expect(readdirSync(evilFallback)).toEqual([])
  }, 60_000)

  it('never writes the checkpoint into a refused checkpoint dir', () => {
    symlinkSync(evilShared, join(store, 'sessions'))
    const r = stop({ PLUR_CHECKPOINT_INTERVAL: '1' })
    expect(r.status).toBe(0)
    expect(readdirSync(evilShared)).toEqual([])
  }, 30_000)

  it('writes the checkpoint to <PLUR root>/sessions when that dir passes', () => {
    stop({ PLUR_CHECKPOINT_INTERVAL: '1' })
    expect(existsSync(join(store, 'sessions', `${SID}.checkpoint.json`))).toBe(true)
  }, 30_000)

  it('an empty PLUR_PATH puts the checkpoint under ~/.plur, not the working directory', () => {
    stop({ PLUR_PATH: '', PLUR_CHECKPOINT_INTERVAL: '1' })
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    expect(existsSync(join(home, '.plur', 'sessions', `${SID}.checkpoint.json`))).toBe(true)
  }, 30_000)

  it('an empty PLUR_PATH: hook-inject finds the checkpoint where hook-learn-check wrote it', () => {
    // Writer and reader must resolve the same root, or orphaned sessions are never reported.
    const sessions = join(home, '.plur', 'sessions')
    mkdirSync(sessions, { recursive: true, mode: 0o700 })
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    writeFileSync(join(sessions, 'orphan.checkpoint.json'), JSON.stringify({
      session_id: 'orphan', started_at: old, last_checkpoint: old, stop_count: 4, cwd: home,
    }))
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, PLUR_PATH: '', PLUR_DISABLE_EMBEDDINGS: '1' }
    const r = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'hello' }),
      encoding: 'utf-8', timeout: 20_000, env: e, cwd: home,
    })
    expect(r.stdout).toContain('ended without wrap-up')
  }, 30_000)

  it('an empty PLUR_PATH gives a fallback hook dir under ~/.plur, not a relative path', () => {
    const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME, PLUR_PATH: process.env.PLUR_PATH }
    try {
      process.env.TMPDIR = tmp
      process.env.HOME = home
      process.env.PLUR_PATH = ''
      symlinkSync(evilShared, join(tmp, 'plur-sessions'))
      expect(hookSessionDir()).toBe(join(home, '.plur', 'hook-sessions'))
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
