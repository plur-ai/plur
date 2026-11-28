/**
 * 0.24 review round 8 (part of #1946): the one-time move of an old
 * ~/.plur/config.json sign-in into config.yaml adds a server entry, so under
 * `pinning.agents: request` or `deny` it needs the owner's terminal
 * confirmation. `plur login --status` (no confirmation step) and a run
 * without a terminal skip the move, keep config.json and say so in one
 * line. `plur login <url>` at a terminal asks once, before the move. Under
 * `allow` the move happens as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { AGENT_ENV_MARKERS } from '../src/plur.js'

const CLI = builtCliPath(join(__dirname, '..'))
const LEGACY = 'plur_sk_legacy_r8_0123456789abcdef'
let server: Server, url: string, home: string

beforeEach(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/api/v1/me' && req.headers.authorization === `Bearer ${LEGACY}`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice'], scopes_status: 'ok', scope_metadata: [], scope_metadata_status: 'ok', gitlab_host: null, project_paths: {} }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  home = mkdtempSync(join(tmpdir(), 'plur-r8-legacy-'))
  mkdirSync(join(home, '.plur'), { recursive: true })
  writeFileSync(join(home, '.plur', 'config.json'), JSON.stringify({ enterprise: { url, token: LEGACY } }))
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})

const cfg = () => join(home, '.plur', 'config.yaml')
const legacy = () => join(home, '.plur', 'config.json')
const config = (agents: 'allow' | 'request' | 'deny') => writeFileSync(cfg(), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
const ownerEnv = () => {
  const e: NodeJS.ProcessEnv = { ...isolatedHomeEnv(home), DISPLAY: '', WAYLAND_DISPLAY: '', PLUR_DISABLE_EMBEDDINGS: '1', PLUR_ACTOR: 'owner' }
  for (const k of AGENT_ENV_MARKERS) delete e[k]
  return e
}

function cli(args: string[]) {
  return new Promise<{ out: string; status: number | null }>(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: ownerEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', status => { clearTimeout(t); resolve({ out, status }) })
  })
}

describe('round 8: the config.json move under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: plur login --status as the owner without a terminal does not move it, and says so`, async () => {
      config(agents)
      const before = readFileSync(cfg(), 'utf8')
      const r = await cli(['login', '--status'])
      expect(r.out).toMatch(/was not moved into config\.yaml/)
      expect(r.out).toMatch(/plur login/)
      expect(r.out).not.toContain(LEGACY)
      expect(readFileSync(cfg(), 'utf8')).toBe(before)
      expect(existsSync(legacy())).toBe(true)
    }, 40_000)

    it(`${agents}: plur login <url> as the owner without a terminal moves nothing`, async () => {
      config(agents)
      const before = readFileSync(cfg(), 'utf8')
      const r = await cli(['login', url, '--no-open'])
      expect(r.status, r.out).toBe(1)
      expect(readFileSync(cfg(), 'utf8')).toBe(before)
      expect(existsSync(legacy())).toBe(true)
    }, 40_000)
  }

  it.skipIf(!ptyAvailable)('deny: at a terminal, the owner types yes once and the old sign-in is moved', async () => {
    config('deny')
    const e = ownerEnv()
    delete e.PLUR_ACTOR
    // --status at a terminal has no confirmation step: plur login <url> asks.
    const r = await runInPty([process.execPath, CLI, 'login', url, '--no-open', '--timeout', '1'], { env: e, cwd: home, answer: 'yes', timeoutMs: 30_000 })
    expect(r.output).toMatch(/Type yes/)
    expect(r.output.match(/Type yes/g)).toHaveLength(1)
    expect(r.output).toMatch(/was moved into config\.yaml/)
    expect(readFileSync(cfg(), 'utf8')).toContain(url)
    expect(existsSync(legacy())).toBe(false)
  }, 60_000)

  it('allow (default): plur login --status moves it as before', async () => {
    config('allow')
    const r = await cli(['login', '--status'])
    expect(r.out).toMatch(/was moved into config\.yaml/)
    expect(readFileSync(cfg(), 'utf8')).toContain(url)
    expect(existsSync(legacy())).toBe(false)
  }, 40_000)
})
