import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, utimesSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { acquireInjectLock, injectSessionKey } from '../src/commands/hook-inject.js'
import { ticketCounter } from '../src/lib/codex-hook-io.js'

/**
 * Formal round 2, cli#7 (session identity + inject lock) and cli#11
 * (append-then-stat counters). spec/formal/PlurSpec/R2CLI.lean §3–§4,
 * findings/r2-cli.md items 3–4.
 */

const CLI = process.env.PLUR_R2_CLI ?? builtCliPath(join(__dirname, '..'))

describe('cli#7 session identity and inject lock (formal r2)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-r2-inj-'))
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function inject(input: object, extra: Record<string, string> = {}) {
    return runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(home, 'tmp'),
        PLUR_PATH: join(home, '.plur'),
        PLUR_DISABLE_EMBEDDINGS: '1',
        ...extra,
      },
    })
  }

  it('/clear (same process, new session_id) gets its own session-start injection', () => {
    const a = inject({ prompt: 'first session', session_id: 'sess-A' })
    expect(JSON.parse(a.stdout).additionalContext).toContain('session started')
    // Same ppid (this runner), new Claude session: before the fix the ppid
    // marker made this a mid-session prompt — no injection at all.
    const b = inject({ prompt: 'after clear', session_id: 'sess-B' })
    expect(b.status).toBe(0)
    expect(b.stdout).not.toBe('')
    expect(JSON.parse(b.stdout).additionalContext).toContain('session started')
  }, 60_000)

  it('a second prompt in the SAME session is not re-injected', () => {
    inject({ prompt: 'first', session_id: 'sess-C' })
    const again = inject({ prompt: 'second', session_id: 'sess-C' })
    expect(again.stdout).not.toContain('session started')
  }, 60_000)

  it('the inject lock is released when injection throws', () => {
    // A store path that is a FILE makes createPlur throw after the lock is taken.
    const notADir = join(home, 'store-is-a-file')
    writeFileSync(notADir, 'x')
    inject({ prompt: 'boom', session_id: 'sess-L' }, { PLUR_PATH: notADir })
    const dir = join(home, 'tmp', 'plur-sessions')
    const locks = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.injecting')) : []
    expect(locks).toEqual([])
  }, 60_000)
})

describe('acquireInjectLock (O_EXCL)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2-lock-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exactly one of two acquirers wins; a stale lock is taken over', () => {
    const p = join(dir, 'k.injecting')
    expect(acquireInjectLock(p, 55_000)).toBe('acquired')
    expect(acquireInjectLock(p, 55_000)).toBe('busy')
    const old = Date.now() / 1000 - 120
    utimesSync(p, old, old)
    expect(acquireInjectLock(p, 55_000)).toBe('acquired')
  })

  it('no trustworthy dir → unavailable (proceed unlocked, fail open)', () => {
    expect(acquireInjectLock(null)).toBe('unavailable')
    expect(acquireInjectLock(join(dir, 'missing', 'k.injecting'))).toBe('unavailable')
  })

  it('the key is the payload session id, falling back to ppid', () => {
    expect(injectSessionKey({ session_id: 'abc/../x' }, 42)).toBe('sid-abc____x')
    expect(injectSessionKey({}, 42)).toBe('42')
    expect(injectSessionKey({ session_id: '' }, 42)).toBe('42')
  })
})

describe('cli#11 ticket counter', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2-ticket-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sequential calls count 1..n', () => {
    const p = join(dir, 'c')
    expect([1, 2, 3, 4].map(() => ticketCounter(p))).toEqual([1, 2, 3, 4])
  })

  it('continues from a legacy append-a-dot file without throwing', () => {
    const p = join(dir, 'legacy')
    writeFileSync(p, '...')
    expect(ticketCounter(p)).toBe(1)
    expect(ticketCounter(p)).toBe(2)
  })

  it('concurrent Cursor stop hooks: every value 1..n handed out exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plur-r2-stops-'))
    mkdirSync(join(root, 'tmp'))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    const N = 12
    const outs = await Promise.all(Array.from({ length: N }, () => new Promise<string>((resolve) => {
      const child = spawn('node', [CLI, 'hook-cursor-stop'], {
        cwd: root,
        env: { ...process.env, HOME: root, TMPDIR: join(root, 'tmp') },
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', () => resolve(out))
      child.stdin.end(JSON.stringify({ conversation_id: 'race', status: 'completed' }))
    })))
    rmSync(root, { recursive: true, force: true })
    // NUDGE_EVERY_N_STOPS = 3 → multiples of 3 in 1..12: exactly four nudges.
    expect(outs.filter(o => o.includes('followup_message'))).toHaveLength(N / 3)
  }, 120_000)
})
