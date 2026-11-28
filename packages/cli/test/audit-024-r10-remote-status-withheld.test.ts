/**
 * 0.24 review round 10 (part of #1947): `plur remote` (status) reads the
 * folder policy, which now judges a trusted repository's .plur.yaml server
 * with the same rule the hooks use. Under `pinning.agents: deny`, after an
 * agent trusted the folder through the one-time code, the status contacts
 * nothing on that server and shows it as withheld (remoteAllowed false, the
 * hooks' one-line note). Under `allow`, and for a server config.yaml lists,
 * it probes the server as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'r10-repo-token'
const SCOPE = 'group:test/app'
let server: StubServer
let url: string
let base: string, home: string, root: string, repo: string

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })
beforeEach(() => {
  server.reset()
  server.setMe({ username: 'alice', org_id: 'test', role: 'developer', scopes: [SCOPE] })
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-r10-remote-')))
  home = join(base, 'home'); root = join(home, '.plur'); repo = join(base, 'code', 'repo')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.plur.yaml'), `remote_url: ${url}\nremote_token: ${TOKEN}\nremote_scopes:\n  - ${SCOPE}\n`)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const config = (agents: 'allow' | 'request' | 'deny', stores = '') =>
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n${stores}`)
function cli(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ out: string; status: number | null }>(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: root, PLUR_DISABLE_EMBEDDINGS: '1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const t = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.on('close', status => { clearTimeout(t); resolve({ out, status }) })
  })
}
async function agentTrustByCode(): Promise<void> {
  const nonce = new Plur({ path: root, autoDiscover: false }).issueFolderNonce('session-1', repo, { trusted: true })
  const t = await cli(['trust', repo, '--nonce', nonce], { CLAUDECODE: '1' })
  expect(t.status, t.out).toBe(0)
}
const status = async () => {
  server.reset(); server.setMe({ username: 'alice', org_id: 'test', role: 'developer', scopes: [SCOPE] })
  const r = await cli(['remote', '--json'], { CLAUDECODE: '1' })
  return { ...r, json: JSON.parse(r.out.slice(r.out.indexOf('{'))) }
}

describe('round 10: plur remote status and a withheld .plur.yaml server', () => {
  it('deny: no request reaches the withheld server, and it shows as withheld', async () => {
    config('deny')
    await agentTrustByCode()
    const r = await status()
    expect(server.meCalls).toBe(0)
    expect(server.recallCalls).toBe(0)
    expect(r.json.policy.remoteAllowed).toBe(false)
    expect(JSON.stringify(r.json.stores)).not.toContain(url)
    expect(r.json.withheld_server?.note).toMatch(/only the owner adds a server/)
  }, 60_000)

  it('allow (default): the trusted server is probed as before', async () => {
    config('allow')
    await agentTrustByCode()
    const r = await status()
    expect(r.json.policy.remoteAllowed).toBe(true)
    expect(server.meCalls).toBeGreaterThan(0)
  }, 60_000)

  it('deny: a server config.yaml lists is still allowed', async () => {
    config('deny', `stores:\n  - url: ${url}\n    token: ${TOKEN}\n    scope: ${SCOPE}\n`)
    await agentTrustByCode()
    const r = await status()
    expect(r.json.policy.remoteAllowed).toBe(true)
    expect(r.json.withheld_server).toBeUndefined()
  }, 60_000)
})
