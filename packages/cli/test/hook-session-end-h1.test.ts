import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookSessionKey, legacyHookSessionKeys } from '../src/lib/session-key.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * Owner decision H1 = "payload" (docs/audits/2026-09-29-formal-decisions.yaml):
 * the SessionEnd checkpoint reader tries the shared writer key
 * (hookSessionKey), then the legacy keys older writers used
 * (legacyHookSessionKeys), then its own earlier per-candidate forms.
 */
describe('hook-session-end reads checkpoints under the H1 key and legacy keys', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-session-end-h1-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] } } }),
    )
    mkdirSync(join(home, 'tmp'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function writeCheckpoint(key: string): string {
    const dir = join(home, '.plur', 'sessions')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const path = join(dir, `${key}.checkpoint.json`)
    writeFileSync(path, JSON.stringify({
      session_id: key,
      started_at: new Date(now - 30 * 60000).toISOString(),
      last_checkpoint: new Date(now - 60000).toISOString(),
      stop_count: 12,
      cwd: '/tmp/project',
    }))
    return path
  }

  function runSessionEnd(input: object, env: Record<string, string>) {
    return runCli('node', [CLI, 'hook-session-end'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(home, 'tmp'),
        PLUR_PATH: join(home, '.plur'),
        PLUR_HOOK_OUTBOX_FLUSH: '0',
        ...env,
      },
      cwd: home,
    })
  }

  it('finds a checkpoint an older writer left under "default" (env id with no safe characters)', () => {
    // main's and #1228's writer: env first, unsafe characters stripped, and
    // 'default' when nothing is left. The reader never tried 'default'.
    const cp = writeCheckpoint('default')
    const r = runSessionEnd({ reason: 'exit' }, { CLAUDE_SESSION_ID: '@@@' })
    expect(r.status).toBe(0)
    expect(existsSync(cp), 'the legacy checkpoint was not closed').toBe(false)
  }, 60_000)

  it('finds a checkpoint under the H1 writer key (payload first)', () => {
    const cp = writeCheckpoint('pay_load')
    const r = runSessionEnd({ session_id: 'pay:load', reason: 'exit' }, { CLAUDE_SESSION_ID: 'env-id' })
    expect(r.status).toBe(0)
    expect(existsSync(cp)).toBe(false)
  }, 60_000)

  it('the helpers agree with the reader: writer key first, legacy keys for reading', () => {
    const saved = process.env.CLAUDE_SESSION_ID
    process.env.CLAUDE_SESSION_ID = '@@@'
    try {
      expect(hookSessionKey('pay:load')).toBe('pay_load')
      expect(legacyHookSessionKeys(undefined)).toContain('default')
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID
      else process.env.CLAUDE_SESSION_ID = saved
    }
  })
})
