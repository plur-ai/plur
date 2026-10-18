/**
 * `plur folders set` / `rm` / `trust` honour the session the agent host names
 * in PLUR_FOLDER_SESSION (audit F5 of #1517): a session-bound nonce (issued by
 * the opencode plugin) works only from its own session; an unbound nonce (the
 * editor hooks) still works with no session named, as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { issueFolderNonce } from '@plur-ai/core'

const CLI = builtCliPath(join(__dirname, '..'))

describe('folder nonces and PLUR_FOLDER_SESSION', () => {
  let dir: string
  let plurHome: string
  let target: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-nonce-session-')))
    mkdirSync(join(dir, 'tmp'))
    plurHome = join(dir, '.plur')
    target = join(dir, 'proj')
    mkdirSync(target)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[], session?: string): { status: number | null; out: any } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
    delete env.PLUR_FOLDER_SESSION
    if (session) env.PLUR_FOLDER_SESSION = session
    const r = runCli('node', [CLI, ...args, '--json'], { encoding: 'utf-8', env, cwd: dir })
    let out: any = null
    try { out = JSON.parse((r.stdout ?? '').trim()) } catch { /* not json */ }
    return { status: r.status, out }
  }

  it('a bound nonce is refused from another session, and works from its own', () => {
    const n = issueFolderNonce(plurHome, 'ses_A', target, { mode: 'on' }, Date.now(), { bindSession: true })
    const other = run(['folders', 'set', target, '--on', '--nonce', n], 'ses_B')
    expect(other.status).toBe(1)
    expect(other.out.code).toBe('nonce-session')
    const none = run(['folders', 'set', target, '--on', '--nonce', n])
    expect(none.out.code).toBe('nonce-session')
    const own = run(['folders', 'set', target, '--on', '--nonce', n], 'ses_A')
    expect(own.status).toBe(0)
  }, 60_000)

  it('plur trust: a bound nonce is refused from another session', () => {
    const n = issueFolderNonce(plurHome, 'ses_A', target, { trusted: true }, Date.now(), { bindSession: true })
    const other = run(['trust', target, '--nonce', n], 'ses_B')
    expect(other.status).toBe(1)
    const own = run(['trust', target, '--nonce', n], 'ses_A')
    expect(own.status).toBe(0)
  }, 60_000)

  it('an unbound (hook) nonce still works with no session named', () => {
    const n = issueFolderNonce(plurHome, 'hook-session', target, { mode: 'off' })
    expect(run(['folders', 'set', target, '--off', '--nonce', n]).status).toBe(0)
  }, 60_000)
})
