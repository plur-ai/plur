/**
 * The MCP server's folder question (#1525) answers through two additions to
 * `plur folders set`:
 *  - `--session <id>` names the session a nonce belongs to, as
 *    PLUR_FOLDER_SESSION does for the opencode plugin. The MCP server cannot
 *    set the agent's shell environment, so its commands carry the flag. When
 *    both are present they must agree.
 *  - `--not-now --nonce <n>` is the "not now" answer: it consumes its nonce
 *    and writes nothing to the folder map. It needs a nonce issued for exactly
 *    that answer, and a not-now nonce authorises no write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { issueFolderNonce, folderNonceOutstanding } from '@plur-ai/core'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur folders set --session and --not-now', () => {
  let dir: string
  let plurHome: string
  let target: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-not-now-')))
    mkdirSync(join(dir, 'tmp'))
    plurHome = join(dir, '.plur')
    target = join(dir, 'proj')
    mkdirSync(target)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[], envSession?: string): { status: number | null; out: any } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
    delete env.PLUR_FOLDER_SESSION
    if (envSession) env.PLUR_FOLDER_SESSION = envSession
    const r = runCli('node', [CLI, ...args, '--json'], { encoding: 'utf-8', env, cwd: dir })
    let out: any = null
    try { out = JSON.parse((r.stdout ?? '').trim()) } catch { /* not json */ }
    return { status: r.status, out }
  }

  it('--session names the session of a bound nonce: another session is refused, its own works', () => {
    const n = issueFolderNonce(plurHome, 'mcp-aaa', target, { mode: 'on' }, Date.now(), { bindSession: true })
    const other = run(['folders', 'set', target, '--on', '--nonce', n, '--session', 'mcp-bbb'])
    expect(other.status).toBe(1)
    expect(other.out.code).toBe('nonce-session')
    const own = run(['folders', 'set', target, '--on', '--nonce', n, '--session', 'mcp-aaa'])
    expect(own.status).toBe(0)
  }, 60_000)

  it('--session that disagrees with PLUR_FOLDER_SESSION is refused', () => {
    const n = issueFolderNonce(plurHome, 'mcp-aaa', target, { mode: 'on' }, Date.now(), { bindSession: true })
    const r = run(['folders', 'set', target, '--on', '--nonce', n, '--session', 'mcp-aaa'], 'ses_opencode')
    expect(r.status).toBe(1)
    expect(r.out.code).toBe('nonce-session')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
  }, 60_000)

  it('--not-now consumes its nonce and writes nothing to the folder map', () => {
    const n = issueFolderNonce(plurHome, 'mcp-aaa', target, { notNow: true } as any, Date.now(), { bindSession: true })
    expect(folderNonceOutstanding(plurHome, 'mcp-aaa', n)).toBe(true)
    const r = run(['folders', 'set', target, '--not-now', '--nonce', n, '--session', 'mcp-aaa'])
    expect(r.status, JSON.stringify(r.out)).toBe(0)
    expect(existsSync(join(plurHome, 'folders.yaml')) ? readFileSync(join(plurHome, 'folders.yaml'), 'utf8') : '').not.toContain(target)
    expect(folderNonceOutstanding(plurHome, 'mcp-aaa', n)).toBe(false)
  }, 60_000)

  it('--not-now needs a nonce', () => {
    const r = run(['folders', 'set', target, '--not-now'])
    expect(r.status).toBe(1)
  }, 60_000)

  it('a not-now nonce authorises no write, and a yes nonce is not a not-now', () => {
    const notNow = issueFolderNonce(plurHome, 'mcp-aaa', target, { notNow: true } as any, Date.now(), { bindSession: true })
    const write = run(['folders', 'set', target, '--on', '--nonce', notNow, '--session', 'mcp-aaa'])
    expect(write.status).toBe(1)
    expect(write.out.code).toBe('nonce-answer')
    const yes = issueFolderNonce(plurHome, 'mcp-aaa', target, { mode: 'on' }, Date.now(), { bindSession: true })
    const wrong = run(['folders', 'set', target, '--not-now', '--nonce', yes, '--session', 'mcp-aaa'])
    expect(wrong.status).toBe(1)
    expect(wrong.out.code).toBe('nonce-answer')
    expect(folderNonceOutstanding(plurHome, 'mcp-aaa', yes)).toBe(true)
  }, 60_000)
})
