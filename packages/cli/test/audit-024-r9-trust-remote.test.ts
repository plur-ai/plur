/**
 * 0.24 review round 9 (part of #1947): a repository's `.plur.yaml` names a
 * server (remote_url + remote_token). Under `pinning.agents: request` or
 * `deny`, trusting the repository through the folder question's one-time
 * code (an agent relays it) records the trust, but the repository's server
 * is used only once the owner has added it to config.yaml at a terminal: the
 * hook does not dial it and injects none of its rows. The owner at a
 * terminal is offered to add it and, after yes, it is used. Under `allow`
 * the trusted server is used as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { AGENT_ENV_MARKERS } from '../src/plur.js'
import { TRUST_COVERS } from '../src/commands/trust.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'r9-repo-token'
const SCOPE = 'group:test/app'
const ROW = 'zebracrossing deployment conventions require canary verification'
let server: StubServer
let url: string
let base: string, home: string, root: string, repo: string, run = 0

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })
beforeEach(() => {
  server.reset()
  server.setMe({ username: 'alice', org_id: 'test', role: 'developer', scopes: [SCOPE] })
  server.recallRows = [{ id: 'ENG-2026-1128-901', scope: SCOPE, status: 'active', statement: ROW, score: 1 }]
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-r9-trust-')))
  home = join(base, 'home'); root = join(home, '.plur'); repo = join(base, 'code', 'repo')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.plur.yaml'), `remote_url: ${url}\nremote_token: ${TOKEN}\nremote_scopes:\n  - ${SCOPE}\n`)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const config = (agents: 'allow' | 'request' | 'deny') =>
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: root, PLUR_DISABLE_EMBEDDINGS: '1', ...extra }
  return e
}
function cli(args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) {
  const tmp = join(base, `tmp-${run++}`)
  mkdirSync(tmp, { recursive: true })
  return new Promise<{ out: string; status: number | null }>(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: env({ TMPDIR: tmp, ...extra }), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const t = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.on('close', status => { clearTimeout(t); resolve({ out, status }) })
    child.stdin.end(input ?? '')
  })
}
const trustByCode = () => {
  const nonce = new Plur({ path: root, autoDiscover: false }).issueFolderNonce('session-1', repo, { trusted: true })
  return cli(['trust', repo, '--nonce', nonce], { CLAUDECODE: '1' })
}
const hook = () => cli(['hook-inject'], { CLAUDECODE: '1' }, JSON.stringify({ prompt: 'what are the zebracrossing deployment conventions' }))

describe('round 9: a repository .plur.yaml server under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: trust through the one-time code does not make the hook dial the repository's server`, async () => {
      config(agents)
      const t = await trustByCode()
      expect(t.status, t.out).toBe(0)
      expect(t.out).toMatch(/not connected/)
      const r = await hook()
      expect(r.status, r.out).toBe(0)
      expect(server.recallCalls).toBe(0)
      expect(r.out).not.toContain('zebracrossing deployment conventions require')
    }, 90_000)
  }

  it.skipIf(!ptyAvailable)('deny: the owner at a terminal adds the repository\'s server after typing yes, and the hook uses it', async () => {
    config('deny')
    const e = env()
    for (const k of AGENT_ENV_MARKERS) delete e[k]
    delete e.PLUR_ACTOR
    const t = await runInPty([process.execPath, CLI, 'trust', repo], { env: e, cwd: repo, answer: 'yes' })
    expect(t.status, t.output).toBe(0)
    expect(t.output).toMatch(/Type yes/)
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toContain(url)
    const r = await hook()
    expect(r.status, r.out).toBe(0)
    expect(server.recallCalls).toBeGreaterThan(0)
  }, 90_000)

  it('allow (default): trust through the code makes the hook use the repository\'s server as before', async () => {
    config('allow')
    const t = await trustByCode()
    expect(t.status, t.out).toBe(0)
    const r = await hook()
    expect(r.status, r.out).toBe(0)
    expect(server.recallCalls).toBeGreaterThan(0)
  }, 90_000)

  it('the trust help text says what happens under request or deny', () => {
    expect(TRUST_COVERS).toMatch(/request or deny/)
    expect(TRUST_COVERS).toMatch(/owner/)
  })
})
