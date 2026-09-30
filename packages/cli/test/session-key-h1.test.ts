import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
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
