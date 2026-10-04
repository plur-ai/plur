import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookSessionKey, legacyHookSessionKeys } from '../src/lib/session-key.js'

/**
 * Owner decision H1 = "payload" (docs/audits/2026-09-29-formal-decisions.yaml):
 * every Claude Code hook keys its state (inject marker, reminder, lock, stop
 * counter, checkpoint) with ONE shared helper — payload session_id, then
 * CLAUDE_SESSION_ID, then ppid — and readers also try the forms older writers
 * used (#1228's `sid-` prefix, the env-first stripped key), so nothing is lost
 * on upgrade. Resolves OPEN CONFLICT E of
 * spec/formal/survey/2026-09-29-field-report-drift.md.
 */

describe('hookSessionKey (H1: payload first, one helper)', () => {
  const saved = process.env.CLAUDE_SESSION_ID
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_SESSION_ID
    else process.env.CLAUDE_SESSION_ID = saved
  })

  it('prefers the payload session_id over CLAUDE_SESSION_ID', () => {
    process.env.CLAUDE_SESSION_ID = 'from-env'
    expect(hookSessionKey('from-payload')).toBe('from-payload')
  })

  it('falls back to CLAUDE_SESSION_ID, then ppid', () => {
    process.env.CLAUDE_SESSION_ID = 'from-env'
    expect(hookSessionKey(undefined)).toBe('from-env')
    delete process.env.CLAUDE_SESSION_ID
    expect(hookSessionKey('')).toBe(String(process.ppid))
  })

  it('is path-safe and at most 64 characters', () => {
    expect(hookSessionKey('../../x')).toBe('______x')
    expect(hookSessionKey('a'.repeat(100))).toHaveLength(64)
  })

  it('legacy keys include #1228 forms: the sid- prefix and the env-first stripped key', () => {
    process.env.CLAUDE_SESSION_ID = 'env:id'
    const legacy = legacyHookSessionKeys('pay:load')
    expect(legacy).toContain('sid-pay_load') // #1228 hook-inject
    expect(legacy).toContain('envid') // #1228 / main checkpoint + counter (env first, stripped)
    expect(legacy).not.toContain(hookSessionKey('pay:load')) // the current key is not "legacy"
  })
})

const CLI = builtCliPath(join(__dirname, '..'))

describe('hook-inject reads a marker written under #1228\'s sid- key (H1 upgrade path)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-h1-'))
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function inject(input: object) {
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
        CLAUDE_SESSION_ID: '',
      },
    })
  }

  it('a session already started under the sid- key is not re-injected after upgrade', () => {
    // Creates the vetted state dir the way a real run does.
    inject({ prompt: 'other session', session_id: 'sess-other' })
    const dir = join(home, 'tmp', 'plur-sessions')
    expect(existsSync(dir)).toBe(true)
    writeFileSync(join(dir, 'sid-sess-legacy.marker'), JSON.stringify({ task: 'old', sessionId: 'S-legacy' }), { mode: 0o600 })
    const r = inject({ prompt: 'next prompt', session_id: 'sess-legacy' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('session started')
  }, 60_000)
})

/**
 * #1395 carry-over: the legacy-key marker fallback follows the same state-dir
 * rule as every other hook path. A refused dir is neither written nor READ —
 * a legacy marker sitting behind a planted symlink must not mark the session
 * as started — and when both dirs are refused the hook persists nothing and
 * still exits 0.
 */
describe.skipIf(process.platform === 'win32')('legacy marker fallback when the state dir is refused (#1395)', () => {
  let root: string
  let evilShared: string
  let evilFallback: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-h1-refused-'))
    for (const d of ['tmp', 'home', 'store', 'evil-shared', 'evil-fallback']) mkdirSync(join(root, d))
    evilShared = join(root, 'evil-shared')
    evilFallback = join(root, 'evil-fallback')
    writeFileSync(join(root, 'home', '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    // A planted legacy marker for the session, in both attacker dirs.
    for (const d of [evilShared, evilFallback]) {
      writeFileSync(join(d, 'sid-sess-refused.marker'), JSON.stringify({ task: 'planted', sessionId: 'S-planted' }))
    }
    symlinkSync(evilShared, join(root, 'tmp', 'plur-sessions'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function inject(input: object, args: string[] = []) {
    return runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 20_000,
      cwd: join(root, 'home'),
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        PLUR_PATH: join(root, 'store'),
        PLUR_DISABLE_EMBEDDINGS: '1',
        CLAUDE_SESSION_ID: '',
      },
    })
  }

  it('a legacy marker behind a refused shared dir is not read; the verified fallback is used', () => {
    const r = inject({ prompt: 'first prompt', session_id: 'sess-refused' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('session started') // the planted legacy marker did not count
    expect(r.stdout).not.toContain('S-planted')
    expect(readdirSync(evilShared)).toEqual(['sid-sess-refused.marker'])
    expect(existsSync(join(root, 'store', 'hook-sessions', 'sess-refused.marker'))).toBe(true)
  }, 60_000)

  it('both dirs refused: the legacy fallback reads nothing, writes nothing, and the hook exits 0', () => {
    symlinkSync(evilFallback, join(root, 'store', 'hook-sessions'))
    for (const args of [[], ['--rehydrate'], ['--event', 'skill']]) {
      const r = inject({ prompt: 'first prompt', session_id: 'sess-refused', tool_input: { skill: 'x' } }, args)
      expect(r.status).toBe(0)
      expect(r.stdout ?? '').not.toContain('S-planted')
      expect(r.stdout ?? '').not.toContain('planted')
    }
    const first = inject({ prompt: 'first prompt', session_id: 'sess-refused' })
    expect(first.stdout).toContain('session started')
    expect(readdirSync(evilShared)).toEqual(['sid-sess-refused.marker'])
    expect(readdirSync(evilFallback)).toEqual(['sid-sess-refused.marker'])
  }, 90_000)
})

/**
 * #1396 review: a stale ppid-named marker must not make a NEW payload session
 * look already started. Releases before #1278 wrote a ppid-keyed marker on
 * every prompt and markers are never deleted, so `<digits>.marker` files pile
 * up; under payload-first keying none of them can belong to the current
 * session. With a payload session_id, only payload-derived legacy forms count.
 */
describe('stale ppid-keyed markers do not suppress a payload session\'s injection (#1396 review)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-h1-ppid-'))
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function inject(input: object, extraEnv: Record<string, string> = {}) {
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
        CLAUDE_SESSION_ID: '',
        ...extraEnv,
      },
    })
  }

  function plant(dir: string, key: string, sessionId: string) {
    writeFileSync(join(dir, `${key}.marker`), JSON.stringify({ task: 'another session', sessionId }), { mode: 0o600 })
  }

  it('a new payload session still gets its session-start injection', () => {
    inject({ prompt: 'warm', session_id: 'sess-warm' }) // creates the verified dir
    const dir = join(home, 'tmp', 'plur-sessions')
    // The spawned hook's ppid is this process (spawnSync, no shell); plant our
    // own ppid too in case a runner interposes.
    plant(dir, String(process.pid), 'S-STALE-PID')
    plant(dir, String(process.ppid), 'S-STALE-PPID')
    const r = inject({ prompt: 'brand new session', session_id: '2b1f0c9e-fresh-session' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('session started')
    expect(r.stdout).not.toContain('S-STALE')
    expect(existsSync(join(dir, '2b1f0c9e-fresh-session.marker'))).toBe(true)
  }, 60_000)

  it('without a payload session_id the env key still marks a started session (main\'s behaviour)', () => {
    inject({ prompt: 'warm', session_id: 'sess-warm' })
    const dir = join(home, 'tmp', 'plur-sessions')
    plant(dir, 'env-session', 'S-ENV')
    const r = inject({ prompt: 'next prompt' }, { CLAUDE_SESSION_ID: 'env-session' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('session started')
  }, 60_000)
})
